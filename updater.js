import { acceptReceipt, parseUpdaterResult, updaterRequest } from './dossier-store.js';

// One queue for all calls using the currently configured ST provider. No API
// keys, quiet prompts, chat appends, global preset changes or parallel retries.
export function createDossierUpdater({ capture, current, save, onStatus = () => {}, timeoutMs = 120000 }) {
    let flight = null;
    let cancelled = 0;
    let providerPending = false;
    const run = async ({ limit = 3 } = {}) => {
        if (flight) return flight;
        if (providerPending) throw new Error('上一条整理请求尚未结束，请稍后再试；不会重复计费重发');
        const ticket = cancelled;
        flight = (async () => {
            let completed = 0;
            const owner = capture();
            while (completed < limit) {
                const snapshot = capture();
                if (!snapshot || !owner || !current(owner) || ticket !== cancelled) return { stale: true, completed };
                const { body, result, generate } = snapshot;
                const task = result.tasks[0];
                if (!task) return { completed, remaining: 0 };
                if (typeof generate !== 'function') throw new Error('当前酒馆没有 generateRaw 接口，无法独立整理；请更新酒馆，原档案未改动');
                if (task.narrative.length + result.text.length > 180000) throw new Error('单次档案与正文过长，已暂停整理，未截断原文；请缩短该回复或使用更大上下文的流程');
                onStatus('running', task);
                let timer;
                try {
                    providerPending = true;
                    const request = Promise.resolve().then(() => generate(updaterRequest(body, result, task)));
                    request.then(() => { providerPending = false; }, () => { providerPending = false; });
                    const output = await Promise.race([request, new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('整理请求超时，未提交任何修改。等待接口结束后可重试')), timeoutMs);
                    })]);
                    if (!current(snapshot) || ticket !== cancelled) return { stale: true, completed };
                    const fresh = capture();
                    if (fresh?.result.tasks[0]?.key !== task.key) return { stale: true, completed };
                    const changes = parseUpdaterResult(output, task, body, result.document);
                    acceptReceipt(fresh.body, fresh.result, task, changes);
                    await save(fresh);
                    completed++;
                    onStatus('saved', task);
                } catch (error) {
                    if (current(snapshot) && ticket === cancelled) {
                        snapshot.body.dynamicDossier = snapshot.result.state;
                        snapshot.body.dynamicDossier.failure = { key: task.key, message: error.message || String(error) };
                        await save(snapshot);
                        onStatus('failed', task, error);
                        throw error;
                    }
                    return { stale: true, completed };
                } finally { clearTimeout(timer); }
            }
            return { completed, remaining: capture()?.result.tasks.length || 0 };
        })();
        try { return await flight; } finally { flight = null; }
    };
    return { run, cancel() { cancelled++; }, get busy() { return Boolean(flight || providerPending); } };
}
