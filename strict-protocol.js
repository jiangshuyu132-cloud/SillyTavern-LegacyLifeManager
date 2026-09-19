// Migration compatibility only. Pure helpers; never writes chat or MVU data.
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const copy = value => structuredClone(value);
const RECOVERABLE_PROTOCOL_PATHS = [
    ['主角', '换身状态'],
    ['主角', '载体档案'],
    ['主角', '本世经历草稿'],
    ['历代记忆摘要'],
];
export function isDiscussion(message) {
    return /<(?:discussion_record|destined_discussion)\b/.test(String(message?.mes || ''));
}
export function messageStat(message) {
    const candidates = [
        Array.isArray(message?.variables) ? message.variables.at(-1)?.stat_data : null,
        message?.variables?.stat_data, message?.extra?.variables?.stat_data,
        message?.extra?.stat_data, message?.data?.stat_data, message?.stat_data,
    ];
    for (let candidate of candidates) {
        if (typeof candidate === 'string') { try { candidate = JSON.parse(candidate); } catch { continue; } }
        if (record(candidate)) return candidate;
    }
    return null;
}
function parts(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) return null;
    const result = path.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (result[0] === 'stat_data') result.shift();
    if (result[0] === '最新动态') result[0] = '主角';
    if (!['主角', '历代记忆摘要', '世界'].includes(result[0])) return null;
    if (result.some(x => ['__proto__', 'constructor', 'prototype'].includes(x))) return null;
    return result;
}
function hasPath(root, keys) {
    let value = root;
    for (const key of keys) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
        value = value[key];
    }
    return true;
}
function readPath(root, keys) {
    let value = root;
    for (const key of keys) value = value?.[key];
    return value;
}
function writePath(root, keys, value) {
    let parent = root;
    for (let index = 0; index < keys.length - 1; index += 1) {
        parent[keys[index]] ??= {};
        parent = parent[keys[index]];
    }
    parent[keys.at(-1)] = copy(value);
}
function recoverablePath(path) {
    const keys = parts(path);
    return keys && RECOVERABLE_PROTOCOL_PATHS.some(prefix => prefix.every((key, index) => keys[index] === key));
}
function patchOperations(message) {
    const raw = String(message?.mes || '').replace(/```[\s\S]*?```/g, '');
    const operations = [];
    for (const match of raw.matchAll(/<UpdateVariable\b[^>]*>[\s\S]*?<JSONPatch\b[^>]*>\s*([\s\S]*?)\s*<\/JSONPatch>[\s\S]*?<\/UpdateVariable>/gi)) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed)) operations.push(...parsed);
        } catch { /* incomplete generation is not a commit */ }
    }
    return operations;
}
function locate(root, path, create) {
    const keys = parts(path);
    if (!keys?.length) return null;
    let parent = root;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!parent[keys[i]] || typeof parent[keys[i]] !== 'object') {
            if (!create) return null;
            parent[keys[i]] = keys[i+1] === '-' || /^\d+$/.test(keys[i+1]) ? [] : {};
        }
        parent = parent[keys[i]];
    }
    return { parent, key: keys.at(-1) };
}
export function applyProtocolPatch(root, operation) {
    if (!operation || !['insert','add','replace','remove','delta','move'].includes(operation.op)) return;
    if (operation.op === 'move') {
        const from = locate(root, operation.from, false);
        const toPath = operation.to ?? operation.path;
        if (!from || !Object.hasOwn(from.parent, from.key) || !parts(toPath)) return;
        const value = copy(from.parent[from.key]);
        applyProtocolPatch(root, { op: 'remove', path: operation.from });
        applyProtocolPatch(root, { op: 'insert', path: toPath, value });
        return;
    }
    const target = locate(root, operation.path, ['insert','add','replace'].includes(operation.op));
    if (!target) return;
    const {parent,key} = target;
    if (operation.op === 'delta') {
        if (typeof parent[key] === 'number' && Number.isFinite(operation.value)) parent[key] += operation.value;
        return;
    }
    if (Array.isArray(parent)) {
        const index = key === '-' ? parent.length : Number(key);
        if (!Number.isInteger(index) || index < 0 || index > parent.length) return;
        if (operation.op === 'remove') parent.splice(index, 1);
        else if (['insert','add'].includes(operation.op)) parent.splice(index, 0, copy(operation.value));
        else parent[index] = copy(operation.value);
    } else if (operation.op === 'remove') delete parent[key];
    else parent[key] = copy(operation.value);
}
// A stored snapshot is already the result for that floor: do not replay its deltas.
export function protocolTimeline(messages = [], {storedOnly = false, recoverMissingProtocol = false} = {}) {
    let state = {};
    return messages.map(message => {
        if (message && !message.is_system && !isDiscussion(message)) {
            const stored = messageStat(message);
            const previous = state;
            if (stored) {
                state = copy(stored);
                if (recoverMissingProtocol) {
                    for (const path of RECOVERABLE_PROTOCOL_PATHS) {
                        if (!hasPath(state, path) && hasPath(previous, path)) writePath(state, path, readPath(previous, path));
                    }
                }
            }
            if (!message.is_user && !storedOnly) {
                for (const operation of patchOperations(message)) {
                    if (!stored || (recoverMissingProtocol && recoverablePath(operation?.path))) applyProtocolPatch(state, operation);
                }
            }
        }
        return copy(state);
    });
}

function numberAt(stat, path) {
    const value = readPath(stat, path);
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function comparable(value) {
    if (Array.isArray(value)) return value.map(comparable).filter(Boolean).join('、');
    return String(value ?? '').replace(/\s+/g, '').trim();
}
function looselyMatches(left, right) {
    const a = comparable(left), b = comparable(right);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

/**
 * Recovery evidence for chats whose MVU schema silently strips extension-only
 * fields. Text output alone is never enough: the persisted standard MVU
 * snapshot must also prove a dead body became a live body matching the card.
 */
export function schemaStrippedCommitEvidence(messages, cardIndex, commitIndex, profile = {}) {
    let before = null;
    for (let index = cardIndex; index >= 0; index -= 1) {
        before = messageStat(messages[index]);
        if (before) break;
    }
    const after = messageStat(messages[commitIndex]);
    if (!before || !after) return false;
    const beforeHp = numberAt(before, ['主角', '生命值', '当前']);
    const afterHp = numberAt(after, ['主角', '生命值', '当前']);
    if (beforeHp == null || beforeHp > 0 || afterHp == null || afterHp <= 0) return false;
    return [
        [after?.主角?.种族, profile?.种族],
        [after?.主角?.职业, profile?.职业],
        [after?.世界?.地点, profile?.地点],
    ].some(([stored, expected]) => looselyMatches(stored, expected));
}
export function confirmationGate(stat, input, card = '') {
    const s = stat?.主角?.换身状态;
    if (String(input || '').trim() !== '确认换身') return false;
    if (s?.阶段 !== '等待确认' || s.当前身体死亡已确认 !== true) return false;
    if (!Number.isInteger(s.当前世代编号) || s.当前世代编号 < 1) return false;
    if (typeof s.待确认人物卡 !== 'string' || !s.待确认人物卡.trim()) return false;
    if (s.归档写入状态 === '待写入世界书' && String(s.待归档人生词条 || '').trim()) return false;
    if (card && !s.待确认人物卡.includes(card.trim())) return false;
    return true;
}
/**
 * Recovery gate for MVU schemas that preserve protocol fields but shorten the
 * pending character card. The caller must also require persisted death-to-life
 * evidence before accepting the following assistant reply as a commit.
 */
export function schemaStrippedConfirmationGate(stat, input, profile = {}, generation = 0) {
    const s = stat?.主角?.换身状态;
    if (String(input || '').trim() !== '确认换身') return false;
    if (s?.阶段 !== '等待确认' || s.当前身体死亡已确认 !== true) return false;
    if (!Number.isInteger(s.当前世代编号) || s.当前世代编号 < 1) return false;
    if (!Number.isInteger(generation) || generation !== s.当前世代编号 + 1) return false;
    const pending = String(s.待确认人物卡 || '').trim();
    if (!pending) return false;
    if (s.归档写入状态 === '待写入世界书' && String(s.待归档人生词条 || '').trim()) return false;
    const normalizedPending = comparable(pending);
    const name = comparable(profile?.姓名);
    if (!name || !normalizedPending.includes(name)) return false;
    const species = comparable(profile?.种族);
    return !species || normalizedPending.includes(species);
}
export function commitGate(before, after, profile, generation) {
    const a = before?.主角?.换身状态, b = after?.主角?.换身状态;
    if (!a || !b || generation !== a.当前世代编号 + 1 || b.当前世代编号 !== generation) return false;
    if (b.阶段 !== '当前身体生效' || b.当前身体死亡已确认 !== false || b.待确认人物卡 !== '' || b.当前身体死亡信息 !== '') return false;
    if (after?.主角?.载体档案?.姓名 !== profile?.姓名) return false;
    const indexes = Array.isArray(after.历代记忆摘要) ? after.历代记忆摘要 : [];
    const previous = Array.isArray(before.历代记忆摘要) ? before.历代记忆摘要 : [];
    if (indexes.length !== previous.length + 1 || JSON.stringify(indexes.slice(0,-1)) !== JSON.stringify(previous)) return false;
    const row = indexes.at(-1);
    if (row?.世代编号 !== a.当前世代编号 || indexes.filter(x => x?.世代编号 === row.世代编号).length !== 1) return false;
    if (before?.主角?.载体档案?.姓名 && row.身体姓名 !== before.主角.载体档案.姓名) return false;
    const title = `第${row.世代编号}世·${row.身体姓名}`;
    return row.详细词条名称 === title
        && ((b.归档写入状态 === '待写入世界书' && typeof b.待归档人生词条 === 'string' && b.待归档人生词条.includes(title))
            || (b.归档写入状态 === '已写入世界书' && b.待归档人生词条 === '')); // verified cleanup must not erase the confirmed carrier
}
export function archiveGate(stat) {
    const state = stat?.主角?.换身状态;
    const draft = String(state?.待归档人生词条 || '').trim();
    if (state?.归档写入状态 !== '待写入世界书' || !draft) return null;
    const generation = state.当前世代编号 - 1;
    const rows = (Array.isArray(stat.历代记忆摘要) ? stat.历代记忆摘要 : []).filter(x => x?.世代编号 === generation);
    if (state.阶段 !== '当前身体生效' || state.当前身体死亡已确认 !== false || rows.length !== 1) return null;
    const row = rows[0], title = `第${generation}世·${row.身体姓名}`;
    if (generation < 1 || row.详细词条名称 !== title || !draft.includes(title)) return null;
    return { draft, title, generation };
}
export function specialGeneration(messages = [], stat = {}) {
    let user;
    for (let i=messages.length-1; i>=0; i--) if (messages[i]?.is_user && !messages[i].is_system) { user=messages[i]; break; }
    if (isDiscussion(user)) return '场外讨论';
    if (String(user?.mes || '').trim() === '确认换身') return '确认交接或重复确认';
    const stage = stat?.主角?.换身状态?.阶段;
    if (['等待换身','等待确认'].includes(stage)) return stage;
    const lastAssistant = [...messages].reverse().find(x => x && !x.is_user && !x.is_system);
    if (!stage && /【当前载体人物设定开始】|【换身待定】/.test(lastAssistant?.mes || '')) return '待核对候选状态';
    return '';
}
