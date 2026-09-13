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

    async function writeMessagePath(path, value) {
        const option = { type: 'message', message_id: 'latest' };
        const updateVariablesWith = callable(env, 'updateVariablesWith');
        if (updateVariablesWith) {
            await Promise.resolve(updateVariablesWith.fn.call(updateVariablesWith.owner, variables => {
                if (!statDataFromVariables(variables)) throw new Error('最新消息楼层没有 MVU 的 stat_data');
                return setPath(variables, path, value);
            }, option));
            return;
        }

        const getVariables = callable(env, 'getVariables');
        const replaceVariables = callable(env, 'replaceVariables');
        if (getVariables && replaceVariables) {
            const current = getVariables.fn.call(getVariables.owner, option);
            if (!statDataFromVariables(current)) throw new Error('最新消息楼层没有 MVU 的 stat_data');
            const next = setPath(clone(current, env), path, value);
            await Promise.resolve(replaceVariables.fn.call(replaceVariables.owner, next, option));
            return;
        }

        const mvu = env?.Mvu;
        if (typeof mvu?.getMvuData === 'function' && typeof mvu?.replaceMvuData === 'function') {
            const current = mvu.getMvuData(option);
            if (!statDataFromVariables(current)) throw new Error('最新消息楼层没有 MVU 的 stat_data');
            const next = setPath(clone(current, env), path, value);
            await Promise.resolve(mvu.replaceMvuData(next, option));
            return;
        }

        const setMessageVar = callable(env, 'setMessageVar');
        if (setMessageVar) {
            await Promise.resolve(setMessageVar.fn.call(setMessageVar.owner, path, value));
            return;
        }

        const ctx = getContext();
        const message = ctx?.chat?.[getLatestMessageIndex()];
        if (!message) throw new Error('找不到可写入的最新消息变量');
        const statData = statDataFromMessage(message) || readStatData();
        if (!Object.keys(statData).length) throw new Error('没有检测到 MVU 的 stat_data；请确认已安装并启用酒馆助手/MVU');
        const next = clone(statData, env);
        setPath(next, path.replace(/^stat_data\.?/, ''), value);
        message.variables ??= {};
        message.variables.stat_data = next;
        await Promise.resolve(ctx.saveChat?.());
    }

    return { readStatData, writeMessagePath };
}
