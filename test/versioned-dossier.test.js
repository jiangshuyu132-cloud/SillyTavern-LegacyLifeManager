import test from 'node:test';
import assert from 'node:assert/strict';
import { observeSources, projectSources, refsPresent, sourceRef, SOURCE_ID } from '../source-ledger.js';
import { resolveDossier, acceptReceipt, parseUpdaterResult, updaterRequest, installRestoreCheckpoint } from '../dossier-store.js';
import { createDossierUpdater } from '../updater.js';

const original = '— 当前形态基础 —\n姓名：林晓\n种族：人类\n年龄：28\n— 外貌详述 —\n妆容：无\n头发：黑色长发\n面容：左眉有痣\n— 当前穿着 —\n上衣：灰衫\n— 人生背景 —\n出生：河畔村庄';
const body = () => ({ rawCard: original, text: original, profile: { 姓名: '林晓' }, generation: 1, startMessageIndex: -1 });
const message = text => ({ mes: `<gametxt>${text}</gametxt>`, is_user: false, send_date: 'same-date' });
const changes = [{ op: 'set', section: '外貌详述', field: '妆容', value: '淡红唇妆', evidence: '林晓涂好了淡红色唇膏。' }];
function response(task, patch = changes) {
    return JSON.stringify({ version: 1, bodyId: task.bodyId, sourceId: task.sourceId, sourceHash: task.sourceHash, baseVersion: task.inputVersion, reviewed: true, changes: patch });
}
function fixture(texts = ['林晓涂好了淡红色唇膏。']) {
    const b = body(); let messages = texts.map(message), ledger;
    const scan = (opts = {}) => { ledger = observeSources(ledger, messages, opts).state; const r = resolveDossier(b, ledger.active); b.dynamicDossier = r.state; return r; };
    const submit = (patch = changes) => { const r = scan(), t = r.tasks[0]; acceptReceipt(b, r, t, parseUpdaterResult(response(t, patch), t, b, r.document)); return scan(); };
    return { b, scan, submit, get messages() { return messages; }, set messages(value) { messages = value; }, get ledger() { return ledger; } };
}

test('persistent IDs are not timestamps or moving floors; duplicate IDs get repaired', () => {
    const f = fixture(['one', 'two', 'three']); f.scan();
    const ids = f.messages.map(m => m[SOURCE_ID]); assert.equal(new Set(ids).size, 3);
    f.messages.splice(1, 1); f.scan(); assert.deepEqual(f.ledger.active.map(s => s.id), [ids[0], ids[2]]);
    f.messages.push(structuredClone(f.messages[0])); f.scan(); assert.equal(new Set(f.ledger.active.map(s => s.id)).size, 3);
});
test('HTTP context without randomUUID still creates stable IDs', () => {
    let next = 0;
    const messages = [message('a'), message('b')];
    const first = observeSources(null, messages, { idFactory: () => `http-${++next}` });
    assert.deepEqual(observeSources(first.state, messages).state.active.map(s => s.id), ['http-1', 'http-2']);
});
test('independent update changes one field, retains every other chapter and fixed original', () => {
    const f = fixture(), r = f.submit();
    assert.match(r.text, /妆容：淡红唇妆/); assert.match(r.text, /面容：左眉有痣/); assert.match(r.text, /出生：河畔村庄/);
    assert.equal(r.tasks.length, 0); assert.equal(f.b.rawCard, original);
    assert.equal(f.scan().changed, false);
});
test('summary/hide, hidden replacement text, serialized reload preserve accepted facts and revisions', () => {
    const f = fixture(); const before = f.submit();
    f.messages[0].is_system = true; f.messages[0].mes = '已总结';
    const hidden = f.scan(); assert.equal(hidden.text, before.text); assert.equal(hidden.state.revision, before.state.revision);
    const b = JSON.parse(JSON.stringify(f.b)); const ledger = JSON.parse(JSON.stringify(f.ledger));
    assert.equal(resolveDossier(b, ledger.active).text, before.text);
    assert.match(projectSources(f.messages, ledger.active)[0].mes, /涂好了/);
});
test('tail deletion automatically rolls back and refresh cannot resurrect the receipt', () => {
    const f = fixture(); f.submit(); f.messages.pop();
    assert.doesNotMatch(f.scan({ reason: 'MESSAGE_DELETED' }).text, /淡红唇妆/);
    for (let i = 0; i < 3; i++) assert.doesNotMatch(f.scan().text, /淡红唇妆/);
    assert.equal(Object.keys(f.b.dynamicDossier.receipts).length, 1); // audit only
});
test('middle deletion invalidates dependent receipts; later unchanged prose must be re-reviewed', () => {
    const f = fixture(['林晓涂好了淡红色唇膏。', '林晓走到了广场。']); f.submit(); f.submit([]);
    f.messages.splice(0, 1);
    const r = f.scan({ reason: 'MESSAGE_DELETED' });
    assert.doesNotMatch(r.text, /淡红唇妆/); assert.equal(r.tasks.length, 1);
    f.submit([]); assert.equal(f.scan().tasks.length, 0);
});
test('editing a user turn invalidates subsequent receipt dependency even when assistant text is unchanged', () => {
    const f = fixture(); f.messages.unshift({ is_user: true, mes: '去化妆' }); f.submit();
    f.messages[0].mes = '不去化妆';
    const r = f.scan({ reason: 'MESSAGE_EDITED', targetIndex: 0 });
    assert.equal(r.tasks.length, 1); assert.doesNotMatch(r.text, /淡红唇妆/);
});
test('swipe switch retracts old branch; switching back reuses only its matching receipt', () => {
    const f = fixture(); f.messages[0].swipes = [f.messages[0].mes, '<gametxt>林晓没有化妆。</gametxt>'];
    f.messages[0].swipe_id = 0; f.submit();
    f.messages[0].swipe_id = 1; f.messages[0].mes = f.messages[0].swipes[1];
    assert.doesNotMatch(f.scan({ reason: 'MESSAGE_SWIPED', targetIndex: 0 }).text, /淡红唇妆/);
    f.submit([]);
    f.messages[0].swipe_id = 0; f.messages[0].mes = f.messages[0].swipes[0];
    const r = f.scan({ reason: 'MESSAGE_SWIPED', targetIndex: 0 }); assert.match(r.text, /淡红唇妆/); assert.equal(r.tasks.length, 0);
});
test('new identity starts a clean dynamic dossier', () => {
    const f = fixture(); f.submit(); f.b.generation = 2;
    assert.doesNotMatch(f.scan().text, /淡红唇妆/); assert.equal(f.scan().tasks.length, 1);
});
test('proof guard rejects malformed, wrong body, wrong revision, fabricated evidence and numeric writes atomically', () => {
    const f = fixture(), r = f.scan(), task = r.tasks[0];
    for (const patch of [{}, { bodyId: 'another' }, { baseVersion: 'old' }, { reviewed: false },
        { changes: [{ ...changes[0], evidence: '不存在的句子' }] }, { changes: [{ ...changes[0], field: '金钱' }] },
        { changes: [{ ...changes[0], field: '__proto__' }] }, { changes: [{ ...changes[0], field: '完整描述' }] }]) {
        const data = { ...JSON.parse(response(task)), ...patch };
        if (!Object.keys(patch).length) delete data.changes;
        assert.throws(() => parseUpdaterResult(JSON.stringify(data), task, f.b, r.document));
    }
    assert.throws(() => parseUpdaterResult('unclosed {', task, f.b, r.document));
    assert.equal(f.b.rawCard, original); assert.equal(r.state.frames.length, 0);
});
test('NPC/image/thinking material is not evidence; semantic subject checking is explicitly requested', () => {
    const f = fixture(); f.messages[0].mes = '<gametxt>林晓走到了门前。</gametxt><image>林晓涂好了淡红色唇膏。</image>';
    const r = f.scan(), t = r.tasks[0];
    assert.throws(() => parseUpdaterResult(response(t), t, f.b, r.document));
    assert.match(updaterRequest(f.b, r, t).systemPrompt, /NPC、未来计划/);
});
test('stale MVU body mirror never overwrites or revives the dossier', () => {
    const f = fixture(); f.submit();
    let r = resolveDossier(f.b, f.ledger.active, { variablesAt: () => ({ 主角: { 当前妆容: '无', 载体档案: { 当前穿着: '旧衣服' } } }) });
    // A variable revision can request a review, but is never an ungrounded writer.
    assert.doesNotMatch(r.text, /旧衣服/);
    f.messages.pop(); f.scan(); r = resolveDossier(f.b, f.ledger.active, { variablesAt: () => ({ 主角: { 当前妆容: '淡红唇妆' } }) });
    assert.doesNotMatch(r.text, /淡红唇妆/);
});
test('explicit backup restore creates a versioned checkpoint; deletion of prerequisite revokes it', () => {
    const f = fixture(); f.submit(); const restored = JSON.parse(JSON.stringify(f.b));
    installRestoreCheckpoint(restored, f.ledger.active);
    assert.match(resolveDossier(restored, f.ledger.active).text, /淡红唇妆/);
    assert.doesNotMatch(resolveDossier(restored, []).text, /淡红唇妆/);
    assert.equal(refsPresent(restored.sourceAnchors, []), false);
});
test('new embedded protocols cannot bypass the independent updater', () => {
    const f = fixture([]); f.scan();
    f.messages.push(message('林晓涂好了淡红色唇膏。'));
    const r = f.scan(), t = r.tasks[0]; f.messages[0].mes += `<LegacyBodyUpdate>${response(t)}</LegacyBodyUpdate>`;
    const next = f.scan(); assert.equal(next.tasks.length, 1); assert.doesNotMatch(next.text, /淡红唇妆/);
});

test('middle deletion fences cumulative snapshots until their variables change', () => {
    const messages = [message('初始'), message('化妆'), message('散步')];
    messages.forEach((m, i) => { m.data = { stat_data: { 主角: { 当前妆容: i ? '红唇' : '无' } } }; });
    const first = observeSources(null, messages).state;
    assert.equal(projectSources(messages, first.active)[0].stat_data.主角.当前妆容, '无');
    messages.splice(1, 1);
    const next = observeSources(first, messages).state;
    assert.equal(Object.keys(next.staleSnapshots).length, 1);
    assert.equal(projectSources(messages, next.active, next.staleSnapshots)[1].stat_data, undefined);
    assert.equal(projectSources(messages, next.active, next.staleSnapshots)[1].data, undefined);
    messages[1].data.stat_data.主角.当前妆容 = '无';
    assert.deepEqual(observeSources(next, messages).state.staleSnapshots, {});
});
test('hidden MESSAGE_UPDATED retains source facts; explicit hidden edit revises them', () => {
    const f = fixture(); f.submit();
    f.messages[0].is_system = true; f.messages[0].mes = '已总结';
    assert.equal(f.scan({ reason: 'MESSAGE_UPDATED', targetIndex: 0 }).tasks.length, 0);
    f.messages[0].mes = '<gametxt>林晓卸了妆。</gametxt>';
    assert.equal(f.scan({ reason: 'MESSAGE_EDITED', targetIndex: 0 }).tasks.length, 1);
});
test('backup with pending work preserves queue and last confirmed document', () => {
    const f = fixture(); f.submit(); f.messages.push(message('林晓换上了蓝色外套。')); f.scan();
    const restored = structuredClone(f.b);
    installRestoreCheckpoint(restored, f.ledger.active);
    const next = resolveDossier(restored, f.ledger.active);
    assert.match(next.text, /妆容：淡红唇妆/);
    assert.equal(next.tasks.length, 1);
    assert.match(next.tasks[0].narrative, /蓝色外套/);
});
test('unmatched pending backup cannot masquerade as a complete checkpoint', () => {
    const f = fixture(); f.scan(); const restored = structuredClone(f.b);
    assert.throws(() => installRestoreCheckpoint(restored, []), /尚未核对/);
    assert.deepEqual(restored, f.b);
    installRestoreCheckpoint(restored, f.ledger.active);
    assert.equal(resolveDossier(restored, f.ledger.active).tasks.length, 1);
});
test('editing the takeover receipt invalidates later dossier dependencies even with unchanged card', () => {
    const f = fixture(['接管已经完成。', '林晓涂好了淡红色唇膏。']); f.scan();
    f.b.sourceAnchors = [sourceRef(f.ledger.active[0])]; f.submit();
    assert.match(f.scan().text, /淡红唇妆/);
    f.messages[0].mes = '<gametxt>接管完成，姿态发生变化。</gametxt>'; f.scan();
    f.b.sourceAnchors = [sourceRef(f.ledger.active[0])];
    assert.equal(f.scan().tasks.length, 1);
    assert.doesNotMatch(f.scan().text, /淡红唇妆/);
});

function updaterFixture(generator, options = {}) {
    const f = fixture(); let chat = 'a', saves = 0;
    const capture = () => ({ body: f.b, result: f.scan(), signature: f.ledger.signature, chat, generate: generator });
    const updater = createDossierUpdater({ capture, current: s => { f.scan(); return chat === s.chat && f.ledger.signature === s.signature; }, save: async () => { saves++; }, ...options });
    return { f, updater, get saves() { return saves; }, changeChat() { chat = 'b'; } };
}
const generated = (config, patch = changes) => {
    const payload = JSON.parse(config.prompt);
    return response({ ...payload, inputVersion: payload.baseVersion }, patch);
};
test('single flight prevents duplicate billing and commits one receipt', async () => {
    let calls = 0;
    const h = updaterFixture(async config => { calls++; await new Promise(r => setTimeout(r, 8)); return generated(config); });
    await Promise.all([h.updater.run(), h.updater.run(), h.updater.run()]);
    assert.equal(calls, 1); assert.equal(h.saves, 1); assert.match(h.f.scan().text, /淡红唇妆/);
});
test('delete, edit, body cancellation or chat switch during AI request discards late answer', async () => {
    for (const change of [h => h.f.messages.pop(), h => { h.f.messages[0].mes = '新回复'; }, h => h.changeChat(), h => h.updater.cancel()]) {
        let finish;
        const h = updaterFixture(config => new Promise(resolve => { finish = () => resolve(generated(config)); }));
        const work = h.updater.run(); await new Promise(r => setTimeout(r, 0)); change(h); finish();
        const result = await work; assert.equal(result.stale, true); assert.equal(h.saves, 0);
    }
});
test('provider failure is visible, no infinite automatic retry; explicit retry can succeed', async () => {
    let fail = true, calls = 0;
    const h = updaterFixture(async config => { calls++; if (fail) throw new Error('network down'); return generated(config); });
    await assert.rejects(h.updater.run(), /network down/); assert.equal(calls, 1);
    assert.equal(h.f.scan().state.failure.message, 'network down');
    fail = false; await h.updater.run(); assert.equal(h.f.scan().tasks.length, 0);
});
test('historical request budget stops at configured limit without dropping pending sources', async () => {
    const h = updaterFixture(async config => generated(config, []));
    h.f.messages = Array.from({ length: 6 }, () => message('林晓走到广场。'));
    const result = await h.updater.run({ limit: 3 }); assert.equal(result.completed, 3); assert.equal(result.remaining, 3);
});
test('timeout cannot later commit or launch a duplicate request while provider remains pending', async () => {
    let finish;
    const h = updaterFixture(config => new Promise(resolve => { finish = () => resolve(generated(config)); }), { timeoutMs: 8 });
    await assert.rejects(h.updater.run(), /超时/);
    await assert.rejects(h.updater.run(), /尚未结束/);
    finish(); await new Promise(r => setTimeout(r, 0));
    assert.doesNotMatch(h.f.scan().text, /淡红唇妆/); assert.equal(h.f.scan().tasks.length, 1);
});
