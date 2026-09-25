function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
}

function asRecord(value) {
    const parsed = parseMaybeJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function callable(env, name) {
    if (typeof env?.[name] === 'function') return { owner: env, fn: env[name] };
    if (typeof env?.TavernHelper?.[name] === 'function') {
        return { owner: env.TavernHelper, fn: env.TavernHelper[name] };
    }
    return null;
}

function clone(value, env) {
    if (typeof env?.structuredClone === 'function') return env.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function setPath(root, path, value) {
    const parts = path.split('.').filter(Boolean);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
        if (!parent[part] || typeof parent[part] !== 'object' || Array.isArray(parent[part])) parent[part] = {};
        parent = parent[part];
    }
    parent[parts.at(-1)] = value;
    return root;
}

export function statDataFromVariables(variables) {
    const table = asRecord(variables);
    return table ? asRecord(table.stat_data) : null;
}

export function statDataFromMessage(message) {
    const candidates = [
        Array.isArray(message?.variables) ? message.variables.at(-1)?.stat_data : null,
        message?.variables?.stat_data,
        message?.extra?.variables?.stat_data,
        message?.extra?.stat_data,
        message?.data?.stat_data,
        message?.stat_data,
    ];
    for (const candidate of candidates) {
        const value = asRecord(candidate);
        if (value) return value;
    }
    return null;
}

export function createMvuAdapter({ env = globalThis, getContext, getLatestMessageIndex }) {
    function readStatData() {
        const ctx = getContext();
        if (!Array.isArray(ctx?.chat)) return {};

        // Tavern Helper's public extension API. Unlike getMessageVar, this can
        // address an exact message floor and returns the complete variable table.
        const getVariables = callable(env, 'getVariables');
        if (getVariables) {
            for (let index = getLatestMessageIndex(); index >= 0; index -= 1) {
                try {
                    const value = getVariables.fn.call(getVariables.owner, { type: 'message', message_id: index });
                    const statData = statDataFromVariables(value);
                    if (statData) return statData;
                } catch { /* try the preceding floor */ }
            }
        }

        // MVU's own public API is the authoritative fallback for MVU data.
        const mvu = env?.Mvu;
        if (typeof mvu?.getMvuData === 'function') {
            for (let index = getLatestMessageIndex(); index >= 0; index -= 1) {
                try {
                    const value = mvu.getMvuData({ type: 'message', message_id: index });
                    const statData = statDataFromVariables(value);
                    if (statData) return statData;
                } catch { /* try the preceding floor */ }
            }
        }

        // Compatibility with older Tavern Helper builds. getMessageVar always
        // targets the current/latest floor, so it must not receive a message index.
        const getMessageVar = callable(env, 'getMessageVar');
        if (getMessageVar) {
            try {
                const value = asRecord(getMessageVar.fn.call(getMessageVar.owner, 'stat_data', { defaults: undefined }));
                if (value) return value;
            } catch { /* try SillyTavern's stored message object */ }
        }

        for (let index = ctx.chat.length - 1; index >= 0; index -= 1) {
            const value = statDataFromMessage(ctx.chat[index]);
            if (value) return value;
        }
        return {};
    }

    async function writeMessagePath(path, value, { messageIndex, assertContext = () => {} } = {}) {
        assertContext();
        const option = { type: 'message', message_id: messageIndex ?? 'latest' };
        const updateVariablesWith = callable(env, 'updateVariablesWith');
        if (updateVariablesWith) {
            await Promise.resolve(updateVariablesWith.fn.call(updateVariablesWith.owner, variables => {
                assertContext();
                if (!statDataFromVariables(variables)) throw new Error('最新消息楼层没有 MVU 的 stat_data');
                return setPath(variables, path, value);
            }, option));
            assertContext();
            return;
        }

        const getVariables = callable(env, 'getVariables');
        const replaceVariables = callable(env, 'replaceVariables');
        if (getVariables && replaceVariables) {
            const current = getVariables.fn.call(getVariables.owner, option);
            if (!statDataFromVariables(current)) throw new Error('最新消息楼层没有 MVU 的 stat_data');
            const next = setPath(clone(current, env), path, value);
            await Promise.resolve(replaceVariables.fn.call(replaceVariables.owner, next, option));
            assertContext();
            return;
        }

        const mvu = env?.Mvu;
        if (typeof mvu?.getMvuData === 'function' && typeof mvu?.replaceMvuData === 'function') {
            const current = mvu.getMvuData(option);
            if (!statDataFromVariables(current)) throw new Error('最新消息楼层没有 MVU 的 stat_data');
            const next = setPath(clone(current, env), path, value);
            await Promise.resolve(mvu.replaceMvuData(next, option));
            assertContext();
            return;
        }

        const setMessageVar = callable(env, 'setMessageVar');
        if (setMessageVar) {
            if (messageIndex !== undefined) throw new Error('旧版变量接口不能锁定精确楼层，请更新酒馆助手后重试资金继承');
            await Promise.resolve(setMessageVar.fn.call(setMessageVar.owner, path, value));
            return;
        }

        const ctx = getContext();
        const message = ctx?.chat?.[messageIndex ?? getLatestMessageIndex()];
        if (!message) throw new Error('找不到可写入的最新消息变量');
        const statData = statDataFromMessage(message) || readStatData();
        if (!Object.keys(statData).length) throw new Error('没有检测到 MVU 的 stat_data；请确认已安装并启用酒馆助手/MVU');
        const next = clone(statData, env);
        setPath(next, path.replace(/^stat_data\.?/, ''), value);
        message.variables ??= {};
        message.variables.stat_data = next;
        await Promise.resolve(ctx.saveChat?.());
        assertContext();
    }

    function readStatDataAt(index) {
        const opt = { type: 'message', message_id: index };
        const getter = callable(env, 'getVariables');
        if (getter) { try { const data=statDataFromVariables(getter.fn.call(getter.owner,opt)); if(data) return data; } catch {} }
        if (typeof env?.Mvu?.getMvuData === 'function') { try { const data=statDataFromVariables(env.Mvu.getMvuData(opt)); if(data) return data; } catch {} }
        return statDataFromMessage(getContext()?.chat?.[index]);
    }
    async function completeArchive({ messageIndex, chatId, draft, generation, assertContext }) {
        const opt = { type: 'message', message_id: messageIndex };
        const transform = variables => {
            assertContext();
            const stat = statDataFromVariables(variables);
            const state=stat?.主角?.换身状态;
            if (!state || state.当前世代编号 !== generation+1 || state.待归档人生词条 !== draft || state.归档写入状态 !== '待写入世界书') throw new Error('归档期间MVU草稿或世代改变，已保留当前资料');
            const next=clone(variables,env);
            next.stat_data.主角.换身状态.归档写入状态='已写入世界书';
            next.stat_data.主角.换身状态.待归档人生词条='';
            return next;
        };
        const updater=callable(env,'updateVariablesWith');
        if (updater) { await Promise.resolve(updater.fn.call(updater.owner,transform,opt)); return; }
        const getter=callable(env,'getVariables'), replacer=callable(env,'replaceVariables');
        if (getter && replacer) { const next=transform(getter.fn.call(getter.owner,opt)); await Promise.resolve(replacer.fn.call(replacer.owner,next,opt)); return; }
        if (typeof env?.Mvu?.getMvuData === 'function' && typeof env?.Mvu?.replaceMvuData === 'function') {
            const next=transform(env.Mvu.getMvuData(opt)); await Promise.resolve(env.Mvu.replaceMvuData(next,opt)); return;
        }
        // A latest-only API cannot safely clear a captured draft after asynchronous I/O.
        throw new Error('缺少按消息地址写入的MVU接口，世界书已保留；草稿不自动清空，请升级酒馆助手后重试');
    }
    return { readStatData, readStatDataAt, writeMessagePath, completeArchive };
}
