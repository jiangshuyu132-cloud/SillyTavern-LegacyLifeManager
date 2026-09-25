import {
    protocolTimeline,
    confirmationGate,
    commitGate,
    isDiscussion,
    schemaStrippedCommitEvidence,
    schemaStrippedConfirmationGate,
    messageStat,
} from './strict-protocol.js';
export const ARCHIVE_PREFIX = '[历代记忆档案]';

export function clone(value) {
    return value == null ? value : structuredClone(value);
}

export function asObject(value, fallback = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
        } catch {
            return fallback;
        }
    }
    return fallback;
}

export function getPath(value, path, fallback) {
    const parts = Array.isArray(path) ? path : String(path || '').split('.').filter(Boolean);
    let current = value;
    for (const part of parts) {
        if (current == null || typeof current !== 'object' || !(part in current)) return fallback;
        current = current[part];
    }
    return current;
}

function decodeJsonPatchBlock(value) {
    return String(value || '')
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .trim();
}

export function extractJsonPatchOperations(value) {
    const operations = [];
    for (const block of String(value || '').matchAll(/<JSONPatch\b[^>]*>\s*([\s\S]*?)\s*<\/JSONPatch>/gi)) {
        try {
            const parsed = JSON.parse(decodeJsonPatchBlock(block[1]));
            if (Array.isArray(parsed)) operations.push(...parsed.filter(item => item && typeof item === 'object'));
        } catch { /* malformed variable output must not break the extension */ }
    }
    return operations;
}

function extractRuntimeUpdateOperations(value) {
    const source = String(value || '').replace(/```[\s\S]*?```/g, '');
    const operations = [];
    for (const block of source.matchAll(/<UpdateVariable\b[^>]*>([\s\S]*?)<\/UpdateVariable>/gi)) {
        operations.push(...extractJsonPatchOperations(block[1]));
    }
    return operations;
}

function jsonPointerParts(path) {
    const source = String(path || '').trim();
    if (!source.startsWith('/')) return [];
    const parts = source.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts[0] === 'stat_data') parts.shift();
    if (parts[0] === '最新动态') parts[0] = '主角';
    if (!['主角', '世界'].includes(parts[0])) return [];
    if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) return [];
    return parts;
}

function applyJsonPointerOperation(root, operation) {
    const parts = jsonPointerParts(operation?.path);
    if (!parts.length || !['add', 'insert', 'replace', 'remove', 'delta'].includes(operation?.op)) return false;
    let parent = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        const nextIsArray = parts[index + 1] === '-' || /^\d+$/.test(parts[index + 1]);
        if (!parent[part] || typeof parent[part] !== 'object') {
            if (!['add', 'insert', 'replace'].includes(operation.op)) return false;
            parent[part] = nextIsArray ? [] : {};
        }
        parent = parent[part];
    }
    const key = parts.at(-1);
    if (Array.isArray(parent)) {
        const index = key === '-' ? parent.length : Number(key);
        if (!Number.isInteger(index) || index < 0) return false;
        if (operation.op === 'delta') {
            if (!Number.isFinite(operation.value) || !Number.isFinite(parent[index])) return false;
            parent[index] += operation.value;
            return true;
        }
        if (operation.op === 'remove') {
            if (index >= parent.length) return false;
            parent.splice(index, 1);
        } else if (['add', 'insert'].includes(operation.op) && index < parent.length) {
            if (JSON.stringify(parent[index]) === JSON.stringify(operation.value)) return false;
            parent.splice(index, 0, clone(operation.value));
        } else if (['add', 'insert'].includes(operation.op) && key === '-' && parent.some(item => JSON.stringify(item) === JSON.stringify(operation.value))) {
            // The base snapshot may already contain this append. Keep replay idempotent.
            return false;
        } else {
            if (JSON.stringify(parent[index]) === JSON.stringify(operation.value)) return false;
            parent[index] = clone(operation.value);
        }
        return true;
    }
    if (!parent || typeof parent !== 'object') return false;
    if (operation.op === 'delta') {
        if (!Number.isFinite(operation.value) || !Number.isFinite(parent[key])) return false;
        parent[key] += operation.value;
        return true;
    }
    if (operation.op === 'remove') {
        if (!Object.hasOwn(parent, key)) return false;
        delete parent[key];
    } else {
        if (JSON.stringify(parent[key]) === JSON.stringify(operation.value)) return false;
        parent[key] = clone(operation.value);
    }
    return true;
}

/**
 * Replays body/world JSONPatch output that may not yet have reached MVU's stored
 * message snapshot. `/最新动态/*` is a legacy prompt alias for `/主角/*`.
 * The result is an in-memory view only; this never rewrites chat variables.
 */
export function replayDynamicStatData(statData = {}, messages = [], options = {}) {
    const result = clone(asObject(statData));
    const startIndex = Math.max(0, Number(options?.startIndex || 0));
    const allowOperation = typeof options?.allowOperation === 'function' ? options.allowOperation : () => true;
    let appliedOperations = 0;
    let ignoredOperations = 0;
    let lastMessageIndex = -1;
    for (let index = startIndex; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || message.is_user || message.is_system || isDiscussion(message)) continue;
        for (const operation of extractRuntimeUpdateOperations(message.mes)) {
            if (!allowOperation(operation)) {
                ignoredOperations += 1;
                continue;
            }
            if (applyJsonPointerOperation(result, operation)) {
                appliedOperations += 1;
                lastMessageIndex = index;
            }
        }
    }
    return { statData: result, appliedOperations, ignoredOperations, lastMessageIndex };
}

/**
 * Text JSONPatch output may temporarily be newer than MVU's stored snapshot.
 * It may improve the current turn's runtime view, but it must never be allowed
 * to prove or replace an identity. Identity and lifecycle changes continue to
 * require the persisted confirmation transaction.
 */
export function isSafeRuntimePatch(operation = {}) {
    const parts = jsonPointerParts(operation?.path);
    if (!parts.length) return false;
    if (parts[0] === '世界') return true;
    if (parts[0] !== '主角') return false;
    if (parts[1] === '换身状态') return false;
    if (parts.length === 1) return false;
    const identityFields = new Set(['姓名', '原主姓名', '世代编号', '年龄', '性别', '种族', '身份', '职业', '身份职业', '社会地位', '生命层级']);
    if (identityFields.has(parts[1])) return false;
    if (parts[1] === '载体档案') {
        if (parts.length < 3) return false;
        if (identityFields.has(parts[2])) return false;
    }
    return true;
}

const BODY_CHANGE_FIELD = /伤|病|健康|外貌|身体|体型|皮肤|四肢|器官|结构|生理|变异|改造|形态|植入|义体|血脉|特征|疤痕|气味|卫生|体毛|发色|瞳色|身高|体重|尺寸|标记|烙印|诅咒|祝福|穿着/;

export function liveBodyState(statData = {}, options = {}) {
    const main = asObject(statData?.主角);
    const carrier = asObject(main.载体档案);
    const fullCarrier = options?.fullCarrier === true;
    const carrierChanges = fullCarrier
        ? carrier
        : Object.fromEntries(Object.entries(carrier).filter(([key, value]) => BODY_CHANGE_FIELD.test(key) && value != null && value !== ''));
    const namedBodyChanges = Object.fromEntries(Object.entries(main).filter(([key, value]) =>
        key !== '载体档案'
        && key !== '换身状态'
        && BODY_CHANGE_FIELD.test(key)
        && value != null
        && value !== ''));
    const location = main.当前地点
        || carrier.当前地点与处境
        || getPath(statData, '世界.当前地点', '')
        || getPath(statData, '世界.地点', '');
    return {
        当前地点: location,
        种族: main.种族,
        身份: main.身份,
        职业: main.职业,
        等级: main.等级,
        属性: main.属性,
        生命值: main.生命值,
        法力值: main.法力值,
        体力值: main.体力值,
        状态效果: main.状态效果,
        ...(Object.keys(carrierChanges).length ? { [fullCarrier ? '实时载体档案' : '身体动态变化']: carrierChanges } : {}),
        ...namedBodyChanges,
    };
}

export function smartInjectionUsesFullCard(body, messages = []) {
    if (!body) return false;
    const anchor = Number(body.confirmationMessageIndex ?? body.startMessageIndex ?? body.sourceMessageIndex ?? 0);
    return !messages.slice(Math.max(0, anchor + 1)).some(message => message && !message.is_user && !message.is_system);
}

export function compactLifeIndex(lives = [], maxChars = 1200) {
    const limit = Math.max(160, Number(maxChars) || 1200);
    const records = mergeLifeRecords(lives).filter(item => !item.conflict);
    const lines = [];
    let used = 0;
    let omitted = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const item = records[index];
        const title = item.title || `第${item.generation}世·${item.name}`;
        const summary = String(item.summary || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 220);
        const line = `${title}：${summary || '已存档'}`;
        if (used + line.length + 1 > limit) {
            omitted += 1;
            continue;
        }
        lines.push(line);
        used += line.length + 1;
    }
    lines.reverse();
    if (omitted) lines.unshift(`更早 ${omitted} 世已存档，本轮不展开。`);
    return lines.join('\n');
}

export function formatSummaryValue(value, fallback = '当前变量未提供') {
    if (Array.isArray(value)) {
        const text = value.map(item => String(item ?? '').trim()).filter(Boolean).join('、');
        return text || fallback;
    }
    if (value == null) return fallback;
    const text = String(value).trim();
    return text || fallback;
}

export function normalizedMoney(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const source = value.trim().replace(/,/g, '');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source)) return null;
    const number = Number(source);
    return Number.isFinite(number) ? number : null;
}

/**
 * Money is the one body-independent resource managed by this extension.
 * The value immediately before the exact confirmation is authoritative; the
 * new body's cash remains part of its ordinary property instead of replacing
 * this cross-life balance.
 */
export function crossLifeMoneyTransition(messages = [], record = null) {
    if (!record || !Number.isInteger(record.confirmationIndex) || !Number.isInteger(record.commitIndex)) return null;
    const timeline = protocolTimeline(messages, { storedOnly: true });
    const before = timeline[record.confirmationIndex - 1] || messageStat(messages[record.cardIndex]) || {};
    const after = timeline[record.commitIndex] || messageStat(messages[record.commitIndex]) || {};
    const latest = timeline.at(-1) || after;
    const inheritedMoney = normalizedMoney(before?.主角?.金钱);
    const committedMoney = normalizedMoney(after?.主角?.金钱);
    const currentMoney = normalizedMoney(latest?.主角?.金钱);
    if (inheritedMoney == null || committedMoney == null || currentMoney == null) return null;
    let adjustedMoney = currentMoney;
    if (!Object.is(committedMoney, inheritedMoney) && !Object.is(currentMoney, inheritedMoney)) {
        const adjusted = inheritedMoney + (currentMoney - committedMoney);
        if (Number.isFinite(adjusted)) adjustedMoney = adjusted;
    }
    return {
        inheritedMoney,
        committedMoney,
        currentMoney,
        adjustedMoney,
        needsRestore: !Object.is(currentMoney, adjustedMoney),
    };
}

function resourceMaximum(resource) {
    const maximum = asObject(resource?.上限);
    const base = Number(maximum?._基础);
    const extra = Number(maximum?.额外);
    if (!Number.isFinite(base) && !Number.isFinite(extra)) return null;
    return (Number.isFinite(base) ? base : 0) + (Number.isFinite(extra) ? extra : 0);
}

export function currentBodySummary(statData = {}, supplementalProfile = {}, options = {}) {
    const main = asObject(statData?.主角);
    const profile = asObject(main.载体档案);
    const supplemental = asObject(supplementalProfile);
    const hasCarrierProfile = Object.keys(profile).length > 0;
    const preferSupplemental = options?.preferSupplemental === true;
    const profileMatchesSupplemental = !preferSupplemental
        || !profile.姓名
        || !supplemental.姓名
        || String(profile.姓名).trim() === String(supplemental.姓名).trim();
    const liveProfile = profileMatchesSupplemental ? profile : {};
    const hp = asObject(main.生命值);
    const effects = Object.keys(asObject(main.状态效果));
    let health = '';
    if (hp.当前 != null || resourceMaximum(hp) != null) {
        const current = formatSummaryValue(hp.当前);
        const maximum = resourceMaximum(hp);
        health = `生命值 ${current}/${maximum ?? '当前变量未提供'}`;
        health += effects.length ? ` · 状态：${effects.join('、')}` : ' · 无状态效果';
    }
    else if (effects.length) health = `状态：${effects.join('、')}`;
    if (!health) health = liveProfile.伤病与健康 || supplemental.伤病与健康;
    const identityFirst = preferSupplemental ? supplemental : liveProfile;
    const identitySecond = preferSupplemental ? liveProfile : supplemental;
    return {
        name: formatSummaryValue(identityFirst.姓名 || identitySecond.姓名 || main.姓名, '当前变量未提供姓名'),
        main,
        usedSupplementalProfile: Object.keys(supplemental).length > 0 && (preferSupplemental || !hasCarrierProfile),
        rows: [
            ['原主', formatSummaryValue(identityFirst.原主姓名 || identitySecond.原主姓名 || main.原主姓名)],
            ['年龄', formatSummaryValue(identityFirst.年龄 || identitySecond.年龄 || main.年龄)],
            ['性别', formatSummaryValue(identityFirst.性别 || identitySecond.性别 || main.性别)],
            ['种族', formatSummaryValue(preferSupplemental ? (supplemental.种族 || main.种族) : (hasCarrierProfile ? main.种族 : (supplemental.种族 || main.种族)))],
            ['身份', formatSummaryValue(preferSupplemental ? (supplemental.身份 || main.身份) : (hasCarrierProfile ? main.身份 : (supplemental.身份 || main.身份)), '暂无身份')],
            ['职业', formatSummaryValue(preferSupplemental ? (supplemental.职业 || main.职业) : (hasCarrierProfile ? main.职业 : (supplemental.职业 || main.职业)), '暂无职业')],
            ['跨世金钱', formatSummaryValue(main.金钱)],
            ['地点', formatSummaryValue(main.当前地点 || liveProfile.当前地点与处境 || getPath(statData, '世界.当前地点') || getPath(statData, '世界.地点') || supplemental.地点)],
            ['健康', formatSummaryValue(health)],
        ],
    };
}

export function normalizeStage(value) {
    return ['当前身体生效', '等待换身', '等待确认'].includes(value) ? value : '未知';
}

export function extractCharacterCard(text) {
    const source = String(text || '').trim();
    if (!source) return '';
    const tagged = [
        /<char_info\b[^>]*>([\s\S]*?)<\/char_info>/i,
        /<character_card\b[^>]*>([\s\S]*?)<\/character_card>/i,
        /<人物卡\b[^>]*>([\s\S]*?)<\/人物卡>/i,
    ].map(pattern => source.match(pattern)?.[1]?.trim()).filter(Boolean);
    if (tagged.length) return tagged.sort((a, b) => b.length - a.length)[0];

    const fenced = [...source.matchAll(/```(?:json|ya?ml)?\s*\n([\s\S]*?)```/gi)]
        .map(match => match[1].trim())
        .filter(block => /姓名|原主|年龄|性别|种族|身份|职业/.test(block));
    if (fenced.length) return fenced.sort((a, b) => b.length - a.length)[0];

    if (/人物卡|姓名[:：]|原主姓名[:：]/.test(source)) return source;
    return '';
}

export function extractCharacterCards(text) {
    const source = String(text || '');
    if (!source.trim()) return [];
    const cards = [];
    for (const pattern of [
        /<char_info\b[^>]*>([\s\S]*?)<\/char_info>/gi,
        /<character_card\b[^>]*>([\s\S]*?)<\/character_card>/gi,
        /<人物卡\b[^>]*>([\s\S]*?)<\/人物卡>/gi,
    ]) {
        for (const match of source.matchAll(pattern)) {
            const card = match[1]?.trim();
            if (card) cards.push(card);
        }
    }
    return cards;
}

function cleanInlineCardValue(value) {
    const text = String(value ?? '').trim();
    if (!text || ['|', '>', 'null', 'undefined'].includes(text.toLowerCase())) return '';
    return text.replace(/^['"]|['"]$/g, '').trim();
}

export function parseCharacterCard(card) {
    const source = String(card || '').replace(/\r/g, '');
    const result = {};
    for (const key of ['姓名', '生命层级', '等级', '种族', '身份', '职业', '性别', '年龄']) {
        const match = source.match(new RegExp(`^${key}\\s*[:：]\\s*(.*?)\\s*$`, 'm'));
        const value = cleanInlineCardValue(match?.[1]);
        if (value) result[key] = value;
    }
    return result;
}

function firstTopLevelField(text, key) {
    const source = String(text || '').replace(/\r/g, '');
    const match = source.match(new RegExp(`^\\s{0,4}${key}\\s*[:：]\\s*([^\\n]+)`, 'm'));
    return cleanInlineCardValue(match?.[1]);
}

export function initialPlayerProfile(messages = []) {
    for (const message of messages) {
        if (!message?.is_user || message?.is_system) continue;
        const text = String(message.mes || '');
        const name = firstTopLevelField(text, '姓名');
        if (!name) continue;
        const identity = firstTopLevelField(text, '身份');
        const gender = firstTopLevelField(text, '性别');
        const age = firstTopLevelField(text, '年龄');
        const location = firstTopLevelField(text, '起始地点');
        return {
            姓名: name,
            原主姓名: name,
            ...(identity ? { 身份: identity } : {}),
            ...(gender ? { 性别: gender } : {}),
            ...(age ? { 年龄: age } : {}),
            ...(location ? { 地点: location } : {}),
        };
    }
    return {};
}

export function supplementalPlayerProfile(messages = [], statData = {}) {
    const opening = initialPlayerProfile(messages);
    const main = asObject(statData?.主角);
    const carrier = asObject(main.载体档案);
    const preferredName = String(carrier.姓名 || main.姓名 || opening.姓名 || '').trim();
    let matched = {};

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.is_user || message.is_system) continue;
        const cards = extractCharacterCards(message.mes);
        for (let cardIndex = cards.length - 1; cardIndex >= 0; cardIndex -= 1) {
            const parsed = parseCharacterCard(cards[cardIndex]);
            if (parsed.姓名 && (!preferredName || parsed.姓名 === preferredName)) {
                matched = parsed;
                break;
            }
        }
        if (Object.keys(matched).length) break;
    }

    return { ...opening, ...matched };
}

function decodeHtmlText(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function carrierCardText(card) {
    return decodeHtmlText(card)
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const BEHAVIOR_PROFILE_FIELDS = [
    ['性格与价值观', ['当前原主性格与价值观', '性格与价值观', '人格与价值观']],
    ['思维方式与认知边界', ['思维方式与认知边界', '思维方式', '原主完整记忆与认知边界', '原主记忆与认知', '认知边界']],
    ['情绪模式与当前感情', ['情绪模式', '当前感情', '当前重要感情']],
    ['喜爱与厌恶', ['喜爱与厌恶', '喜好与厌恶', '喜恶']],
    ['愿望与恐惧', ['愿望与恐惧']],
    ['生活与行动习惯', ['生活习惯', '行动习惯', '情绪与生活习惯']],
    ['当前知识与语言', ['当前知识与语言', '知识与语言']],
    ['当前技能与身体经验', ['当前技能与能力', '技能与能力', '技能能力']],
];

/**
 * Keeps the current carrier's decision lens available without resending the
 * entire visual card. Strict mode can prefer the confirmed detailed card;
 * other modes preserve the older live-development-first merge.
 */
export function currentBehaviorProfile(card, statData = {}, options = {}) {
    const carrier = asObject(statData?.主角?.载体档案);
    const preferCard = options?.preferCard === true;
    const result = {};
    for (const [target, labels] of BEHAVIOR_PROFILE_FIELDS) {
        let value = '';
        const readCard = () => {
            for (const label of labels) {
                value = carrierField(card, label);
                if (value) break;
            }
        };
        const readLive = () => {
            for (const label of labels) {
                const liveValue = carrier[label];
                if (liveValue != null && liveValue !== '') {
                    value = typeof liveValue === 'string' ? liveValue.trim() : liveValue;
                    break;
                }
            }
        };
        if (preferCard) readCard(); else readLive();
        if (!value) { if (preferCard) readLive(); else readCard(); }
        if (value) result[target] = value;
    }
    if (!preferCard && statData?.主角?.技能 && typeof statData.主角.技能 === 'object') result.当前技能与身体经验 = structuredClone(statData.主角.技能);
    return result;
}

export function carrierCardSections(card) {
    const text = carrierCardText(card);
    if (!text) return [];
    let headings = [...text.matchAll(/^[ \t]*[—-][ \t]*([^\n—-]{2,40}?)[ \t]*[—-][ \t]*$/gm)];
    if (!headings.length) {
        const markdown = [...text.matchAll(/^[ \t]*(#{1,6})[ \t]+([^\n]+)$/gm)];
        // Some opening cards use ## 一、… followed by # 二、…. Their
        // numbered chapters are peers; skill/NPC subheadings stay inside them.
        const numbered = markdown.filter(m => /^[一二三四五六七八九十百\d]+[、.．][ \t]*\S/.test(m[2]));
        const depth = Math.min(...markdown.map(m => m[1].length));
        const selected = numbered.length >= 2 ? numbered : markdown.filter(m => m[1].length === depth);
        headings = selected.map(m => Object.assign([m[0], m[2].replace(/^[一二三四五六七八九十百\d]+[、.．][ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()], { index: m.index }));
    }
    if (!headings.length) return [{ title: '完整人物资料', content: text }];
    const sections = [];
    const preamble = text.slice(0, headings[0].index).trim();
    if (preamble) sections.push({ title: '人物卡说明', content: preamble });
    for (let index = 0; index < headings.length; index += 1) {
        const start = headings[index].index + headings[index][0].length;
        const end = headings[index + 1]?.index ?? text.length;
        const content = text.slice(start, end).trim();
        if (content) sections.push({ title: headings[index][1].trim(), content });
    }
    return sections;
}

/**
 * Reads the confirmed carrier's life story as a first-class dossier field.
 * New cards use the “人生背景” section, while aliases keep older or
 * hand-edited cards compatible.
 */
export function carrierBackgroundStory(card) {
    const sections = carrierCardSections(card);
    const section = sections.find(item => /^(?:人生背景|背景故事|生平经历|成长经历|人物小传|人物背景)$/.test(String(item?.title || '').trim()));
    if (section?.content) return section.content.trim();
    for (const label of ['人生背景', '背景故事', '原主关键人生', '生平经历', '成长经历']) {
        const value = carrierField(card, label);
        if (value) return value;
    }
    return '';
}

export function isCarrierConfirmation(value) {
    const text = String(value || '').trim();
    return text === '确认换身';
}

export function extractCarrierCards(text) {
    // The pending-card JSONPatch often serializes the complete card a second
    // time. That escaped copy is protocol data, not another visible card, and
    // selecting it breaks the confirmation fingerprint.
    const source = String(text || '').replace(/<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable>/gi, '');
    return [...source.matchAll(/【当前载体人物设定开始】([\s\S]*?)【当前载体人物设定结束】/g)]
        .map(match => match[1]?.trim())
        .filter(Boolean);
}

/**
 * SillyTavern does not always keep an older assistant reply in `mes` while a
 * chat is open.  Depending on the active swipe, extension stack and import
 * path, the same visible reply can live in `swipes`, `extra.reasoning` or one
 * of the compatibility fields below.  Treat those fields as alternate views
 * of the same message; never treat duplicate copies as separate cards.
 */
export function messageTextVariants(message = {}) {
    const values = [];
    const add = value => {
        if (typeof value === 'string' && value.trim()) values.push(value);
        else if (value && typeof value === 'object' && typeof value.mes === 'string') values.push(value.mes);
    };
    add(message.mes);
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    const activeSwipe = Number(message.swipe_id);
    if (Number.isInteger(activeSwipe) && activeSwipe >= 0) add(swipes[activeSwipe]);
    for (const swipe of swipes) add(swipe);
    add(message.original_mes);
    add(message.reasoning);
    add(message.extra?.original_mes);
    add(message.extra?.display_text);
    add(message.extra?.reasoning);
    add(message.data?.mes);
    return [...new Set(values)];
}

export function carrierCardsFromMessage(message = {}) {
    for (const text of messageTextVariants(message)) {
        const cards = extractCarrierCards(text);
        if (!cards.length) continue;
        const seen = new Set();
        return cards.filter(card => {
            const fingerprint = stableTextFingerprint(card);
            if (seen.has(fingerprint)) return false;
            seen.add(fingerprint);
            return true;
        });
    }
    return [];
}

function carrierField(card, label) {
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const htmlMatch = String(card || '').match(new RegExp(`<b>\\s*${escaped}\\s*[：:]\\s*</b>\\s*([\\s\\S]*?)(?=<br\\s*\\/?>|<\\/div>)`, 'i'));
    if (htmlMatch) return decodeHtmlText(htmlMatch[1]);
    const text = decodeHtmlText(card);
    return cleanInlineCardValue(text.match(new RegExp(`^\\s*${escaped}\\s*[：:]\\s*(.+)$`, 'm'))?.[1]);
}

export function parseCarrierCard(card) {
    const name = carrierField(card, '姓名');
    if (!name) return {};
    const identityOccupation = carrierField(card, '身份职业') || carrierField(card, '职业');
    const identity = carrierField(card, '身份');
    const socialStatus = carrierField(card, '社会地位').split(/[。；;]/)[0].trim();
    return {
        姓名: name,
        原主姓名: name,
        ...(carrierField(card, '年龄') ? { 年龄: carrierField(card, '年龄') } : {}),
        ...(carrierField(card, '性别') ? { 性别: carrierField(card, '性别') } : {}),
        ...(carrierField(card, '种族') ? { 种族: carrierField(card, '种族') } : {}),
        ...(identity || socialStatus || identityOccupation ? { 身份: identity || socialStatus || identityOccupation } : {}),
        ...(identityOccupation ? { 职业: identityOccupation } : {}),
        ...(carrierField(card, '当前地点') ? { 地点: carrierField(card, '当前地点') } : {}),
        ...((carrierField(card, '接管瞬间处境与健康') || carrierField(card, '健康'))
            ? { 伤病与健康: carrierField(card, '接管瞬间处境与健康') || carrierField(card, '健康') } : {}),
    };
}

export function unvalidatedCarrierRecords(messages = []) {
    const records = [];
    for (let index = 0; index < messages.length; index += 1) {
        const confirmation = messages[index];
        if (!confirmation?.is_user || confirmation?.is_system || !isCarrierConfirmation(confirmation.mes)) continue;
        for (let cardIndex = index - 1; cardIndex >= 0; cardIndex -= 1) {
            const message = messages[cardIndex];
            if (message?.is_user && isCarrierConfirmation(message.mes)) break;
            if (!message || message.is_user || message.is_system) continue;
            const cards = carrierCardsFromMessage(message);
            const card = cards.at(-1);
            const profile = parseCarrierCard(card);
            if (!Object.keys(profile).length) continue;
            records.push({ profile, card, confirmationIndex: index, cardIndex });
            break;
        }
    }
    return records;
}

function comparableCarrierValue(value) {
    if (Array.isArray(value)) return value.map(comparableCarrierValue).filter(Boolean).join('、');
    return String(value ?? '').replace(/\s+/g, '').trim();
}

function carrierValuesMatch(left, right) {
    const a = comparableCarrierValue(left), b = comparableCarrierValue(right);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function trustedCarrierMatchesCurrentState(stat, profile = {}) {
    const main = asObject(stat?.主角);
    const carrier = asObject(main.载体档案);
    const hp = Number(main?.生命值?.当前);
    if (Number.isFinite(hp) && hp <= 0) return false;

    let matched = 0;
    for (const [stored, expected] of [
        [carrier.姓名 || main.姓名, profile.姓名],
        [carrier.种族 || main.种族, profile.种族],
        [carrier.职业 || main.职业, profile.职业],
    ]) {
        if (!comparableCarrierValue(stored) || !comparableCarrierValue(expected)) continue;
        if (!carrierValuesMatch(stored, expected)) return false;
        matched += 1;
    }
    return matched > 0;
}

/**
 * Last-resort migration proof for old chats whose plugin metadata and message
 * snapshots were both stripped.  A visible card/confirmation/commit chain is
 * still insufficient on its own: the live MVU body must be alive and match at
 * least two stable identity fields.  Any available conflicting field rejects
 * the recovery.  Location is deliberately excluded because it normally
 * changes after the hand-off.
 */
function verifiedLegacyCarrierMatchesCurrentState(stat, profile = {}) {
    const main = asObject(stat?.主角);
    const carrier = asObject(main.载体档案);
    const hp = Number(main?.生命值?.当前);
    if (!Object.keys(main).length || !Number.isFinite(hp) || hp <= 0) return false;

    let matched = 0;
    for (const [stored, expected] of [
        [carrier.姓名 || main.姓名, profile.姓名],
        [carrier.种族 || main.种族, profile.种族],
        [carrier.职业 || main.职业, profile.职业],
    ]) {
        if (!comparableCarrierValue(stored) || !comparableCarrierValue(expected)) continue;
        if (!carrierValuesMatch(stored, expected)) return false;
        matched += 1;
    }
    return matched >= 2;
}

export function carrierProfileMatchesCurrentState(stat, profile = {}, minimumMatches = 2) {
    const main = asObject(stat?.主角);
    const carrier = asObject(main.载体档案);
    const hp = Number(main?.生命值?.当前);
    if (!Object.keys(main).length || (Number.isFinite(hp) && hp <= 0)) return false;

    let matched = 0;
    for (const [stored, expected] of [
        [carrier.姓名 || main.姓名, profile.姓名],
        [carrier.种族 || main.种族, profile.种族],
        [carrier.职业 || main.职业, profile.职业],
    ]) {
        if (!comparableCarrierValue(stored) || !comparableCarrierValue(expected)) continue;
        if (!carrierValuesMatch(stored, expected)) return false;
        matched += 1;
    }
    return matched >= Math.max(1, Number(minimumMatches) || 1);
}

export function confirmedCarrierRecords(messages = [], options = {}) {
    const protocolMessages = messages.map(message => {
        if (!message || message.is_user || message.is_system || extractCarrierCards(message.mes).length) return message;
        const compatibleText = messageTextVariants(message).find(text => extractCarrierCards(text).length);
        return compatibleText ? { ...message, mes: compatibleText } : message;
    });
    const timeline = protocolTimeline(protocolMessages, {storedOnly:true});
    const recoveredTimeline = protocolTimeline(protocolMessages, {recoverMissingProtocol:true});
    const trustedRecordKeys = new Set(options?.trustedRecordKeys || []);
    // In a live SillyTavern session the current MVU value can be available
    // through the public variable API even when old message objects do not
    // expose their stat_data snapshots. Prefer that live value for trusted
    // recovery; exported JSONL files can still fall back to their timeline.
    const suppliedCurrentState = asObject(options?.currentState);
    const currentStoredState = Object.keys(suppliedCurrentState).length
        ? suppliedCurrentState
        : (timeline.at(-1) || {});
    const accepted = [], consumed = new Set();
    for (const item of unvalidatedCarrierRecords(protocolMessages)) {
        if (isDiscussion(protocolMessages[item.cardIndex]) || isDiscussion(protocolMessages[item.confirmationIndex])) continue;
        const generation = carrierGeneration(item.card, 0);
        if (!generation || consumed.has(generation)) continue;
        let before = timeline[item.confirmationIndex - 1] || {};
        let recovery = false;
        if (!confirmationGate(before, protocolMessages[item.confirmationIndex]?.mes, item.card)) {
            before = recoveredTimeline[item.confirmationIndex - 1] || {};
            recovery = confirmationGate(before, protocolMessages[item.confirmationIndex]?.mes, item.card)
                || schemaStrippedConfirmationGate(before, protocolMessages[item.confirmationIndex]?.mes, item.profile, generation);
            if (!recovery) continue;
        }
        let committed = false;
        for (let i=item.confirmationIndex+1; i<protocolMessages.length; i++) {
            if (protocolMessages[i]?.is_user && !protocolMessages[i].is_system) break;
            if (protocolMessages[i]?.is_system || isDiscussion(protocolMessages[i])) continue;
            const after = recovery ? recoveredTimeline[i] : timeline[i];
            const recordKey = carrierRecordKey(item, protocolMessages);
            const trustedBackupEvidence = recovery
                && trustedRecordKeys.has(recordKey)
                && trustedCarrierMatchesCurrentState(currentStoredState, item.profile);
            const verifiedLegacyEvidence = recovery
                && !trustedBackupEvidence
                && Object.keys(suppliedCurrentState).length > 0
                && verifiedLegacyCarrierMatchesCurrentState(suppliedCurrentState, item.profile);
            const storedEvidence = !recovery
                || schemaStrippedCommitEvidence(protocolMessages,item.cardIndex,i,item.profile)
                || trustedBackupEvidence
                || verifiedLegacyEvidence;
            if (storedEvidence && commitGate(before,after,item.profile,generation)) {
                accepted.push({
                    ...item,
                    commitIndex:i,
                    recoveredFromTrustedBackup:trustedBackupEvidence,
                    recoveredFromVerifiedLegacyChain:verifiedLegacyEvidence,
                });
                consumed.add(generation); committed=true; break;
            }
        }
        // A bare confirmation message or an incomplete/failed MVU update is not a commit.
        if (!committed) continue;
    }
    return accepted;
}

export function stableTextFingerprint(value) {
    const text = String(value || '').replace(/\r/g, '').trim();
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

export function carrierRecordKey(record, messages = []) {
    if (!record?.card) return '';
    const confirmation = messages[record.confirmationIndex] || {};
    const confirmationIdentity = confirmation.send_date
        || confirmation.gen_started
        || confirmation.extra?.gen_id
        || confirmation.legacy_life_source_id
        || `${record.confirmationIndex}:${String(confirmation.mes || '').trim()}`;
    return `${stableTextFingerprint(record.card)}:${stableTextFingerprint(confirmationIdentity)}`;
}

export function carrierGeneration(card, fallback = 1) {
    const text = carrierCardText(card);
    const arabic = text.match(/世代(?:编号)?[：:]\s*第?\s*(\d+)\s*(?:世|$)/m);
    if (arabic) return Number(arabic[1]);
    const chinese = text.match(/世代(?:编号)?[：:]\s*第?\s*([一二三四五六七八九十]+)\s*世/);
    const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    return chinese ? (digits[chinese[1]] || fallback) : fallback;
}

export function responseSummaries(messages = [], startIndex = 0, endIndex = messages.length - 1) {
    const summaries = [];
    const seen = new Set();
    for (let index = Math.max(0, startIndex); index <= Math.min(endIndex, messages.length - 1); index += 1) {
        const message = messages[index];
        if (!message || message.is_user || message.is_system || isDiscussion(message)) continue;
        for (const match of String(message.mes || '').matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi)) {
            const text = carrierCardText(match[1]).replace(/\s+/g, ' ').trim();
            if (!text || seen.has(text)) continue;
            seen.add(text);
            summaries.push({ messageIndex: index, text });
        }
    }
    return summaries;
}

export function inferredLivesFromCarrierCard(card) {
    return lifeSummariesFromCarrierCard(card).map(item => ({
        ...item,
        archivedAt: null,
        source: 'imported-card',
    }));
}

export function buildLifeRecord(currentBody, messages = [], endIndex = messages.length - 1) {
    const profile = asObject(currentBody?.profile);
    const generation = Number(currentBody?.generation) || 1;
    const name = String(profile.姓名 || profile.原主姓名 || '未命名').trim();
    const summaries = responseSummaries(messages, Number(currentBody?.startMessageIndex || 0), endIndex);
    const combined = summaries.map(item => item.text).join('；').slice(0, 4000);
    return {
        generation,
        name,
        title: `第${generation}世·${name}`,
        summary: combined || `${name}这一世已经结束，暂无可提取的正文摘要。`,
        rawCard: String(currentBody?.rawCard || ''),
        startMessageIndex: Number(currentBody?.startMessageIndex || 0),
        endMessageIndex: Math.max(0, Number(endIndex || 0)),
        archivedAt: new Date().toISOString(),
        source: 'plugin-ledger',
    };
}

export function mergeLifeRecords(...collections) {
    const byGeneration = new Map();
    for (const collection of collections) {
        for (const item of collection || []) {
            const generation = Number(item?.generation);
            const name = String(item?.name || '').trim();
            if (!Number.isFinite(generation) || !name) continue;
            const normalized = {
                ...item,
                generation,
                name,
                title: item.title || `第${generation}世·${name}`,
                summary: String(item.summary || '').trim(),
            };
            const previous = byGeneration.get(generation);
            if (previous && previous.name !== normalized.name) {
                byGeneration.set(generation, { ...previous, conflict: true, summary: '【同世身份冲突，暂停记忆调用；请核对原始资料】', conflictingNames: [...new Set([...(previous.conflictingNames || [previous.name]), normalized.name])] });
                continue;
            }
            if (previous?.conflict) continue;
            if (!previous || normalized.summary.length >= String(previous.summary || '').length) {
                byGeneration.set(generation, normalized);
            }
        }
    }
    return [...byGeneration.values()].sort((a, b) => Number(a.generation) - Number(b.generation));
}

function hasConfirmedDeath(messages = [], endIndex = messages.length - 1) {
    for (let index = 0; index <= Math.min(endIndex, messages.length - 1); index += 1) {
        const message = messages[index];
        if (!message || message.is_user || message.is_system) continue;
        const text = carrierCardText(message.mes);
        if (/当场死亡|死亡已确认|已经死亡|确认死亡|生命值\s*[：:]?\s*0(?:\D|$)|尸体/.test(text)) return true;
    }
    return false;
}

export function rebuildConversationLives(messages = [], records = confirmedCarrierRecords(messages)) {
    const collected = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        collected.push(...inferredLivesFromCarrierCard(record.card));
        const updateEnd = Math.max(record.confirmationIndex, (records[index + 1]?.cardIndex ?? messages.length) - 1);
        for (let messageIndex = record.confirmationIndex + 1; messageIndex <= updateEnd; messageIndex += 1) {
            const message = messages[messageIndex];
            if (!message || message.is_user || message.is_system) continue;
            collected.push(...lifeSummariesFromUpdateVariable(message.mes));
        }
    }
    for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        collected.push(buildLifeRecord({
            profile: previous.profile,
            rawCard: previous.card,
            generation: carrierGeneration(previous.card, index + 1),
            startMessageIndex: previous.confirmationIndex,
        }, messages, Math.max(previous.confirmationIndex, current.cardIndex - 1)));
    }

    const first = records[0];
    const firstGeneration = first ? carrierGeneration(first.card, 1) : 1;
    const opening = initialPlayerProfile(messages);
    const hasFirstLife = collected.some(item => Number(item?.generation) === 1);
    if (first && firstGeneration > 1 && opening.姓名 && !hasFirstLife && hasConfirmedDeath(messages, first.confirmationIndex)) {
        collected.push(buildLifeRecord({
            profile: opening,
            generation: 1,
            startMessageIndex: 0,
        }, messages, Math.max(0, first.cardIndex - 1)));
    }

    return mergeLifeRecords(collected);
}

export function conversationLedgerTruth(messages = [], suppressedRecordKeys = [], options = {}) {
    const suppressed = new Set(suppressedRecordKeys || []);
    const records = confirmedCarrierRecords(messages, options)
        .filter(record => !suppressed.has(carrierRecordKey(record, messages)));
    return {
        records,
        currentRecord: records.at(-1) || null,
        lives: rebuildConversationLives(messages, records),
    };
}

export function confirmedCarrierProfile(messages = [], options = {}) {
    return confirmedCarrierRecords(messages, options).at(-1)?.profile || {};
}

export function lifeSummariesFromCarrierCard(card) {
    const text = decodeHtmlText(card);
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const headingText = line => line.replace(/^[\s=*#—–-]+|[\s=*#—–-]+$/g, '').trim();
    const start = lines.findIndex(line => /^历代经历记忆(?:简短索引)?\s*[：:]?$/.test(headingText(line)));
    if (start < 0) return [];
    const summaries = [];
    let current = null;
    for (const line of lines.slice(start + 1)) {
        const heading = headingText(line);
        if (/^(?:上一具身体死亡信息|不继承声明|历代旧人格)/.test(heading)) break;
        const source = line.replace(/^[·•]\s*/, '').trim();
        const match = source.match(/^第\s*(\d+)\s*世\s*[·・]\s*(.+?)\s*(?:——|--|—|[：:])\s*(.+)$/)
            || source.match(/^第\s*(\d+)\s*世\s*[：:]\s*(.+?)\s*(?:——|--|—)\s*(.+)$/);
        if (match) {
            current = {
                generation: Number(match[1]),
                name: match[2].trim(),
                title: `第${match[1]}世·${match[2].trim()}`,
                summary: match[3].trim(),
                source: 'confirmed-card',
            };
            summaries.push(current);
            continue;
        }
        if (current && /^(?:死亡原因|重要经历|关键经历|死亡信息)[：:]/.test(source)) {
            current.summary = `${current.summary}；${source}`;
        }
    }
    return summaries;
}

function summaryFromArchiveDraft(value) {
    const text = carrierCardText(value);
    const title = text.match(/[【[]?第\s*(\d+)\s*世\s*[·・:：—-]\s*([^】\]\n:：—-]{1,80})[】\]]?/);
    if (!title) return null;
    const summary = text
        .replace(title[0], '')
        .replace(/^\s*[：:]?\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);
    return {
        generation: Number(title[1]),
        name: title[2].trim(),
        title: `第${title[1]}世·${title[2].trim()}`,
        summary: summary || `${title[2].trim()}这一世已经结束。`,
        source: 'update-variable',
    };
}

export function lifeSummariesFromUpdateVariable(value) {
    const summaries = [];
    for (const block of String(value || '').matchAll(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/gi)) {
        let operations;
        try {
            operations = JSON.parse(block[1]);
        } catch {
            continue;
        }
        if (!Array.isArray(operations)) continue;
        for (const operation of operations) {
            const path = String(operation?.path || '');
            let summary = null;
            if (/\/历代记忆摘要(?:\/-|\/\d+)?$/.test(path)) summary = summaryFromIndex(operation.value);
            else if (/\/待归档人生词条$/.test(path) && typeof operation.value === 'string') {
                summary = summaryFromArchiveDraft(operation.value);
            }
            if (summary) summaries.push({
                ...summary,
                source: 'update-variable',
            });
        }
    }
    return mergeLifeRecords(summaries);
}

function summaryFromIndex(item) {
    if (!item || typeof item !== 'object') return null;
    const generation = Number(item.世代编号);
    const name = String(item.身体姓名 || item.姓名 || '').trim();
    if (!Number.isFinite(generation) || !name) return null;
    const parts = [item.身份, item.所处时期, item.最重要经历, item.死亡原因]
        .map(value => formatSummaryValue(value, ''))
        .filter(Boolean);
    return { generation, name, title: `第${generation}世·${name}`, summary: parts.join('；'), source: 'stat-data' };
}

function summaryFromArchiveEntry(entry) {
    const title = String(entry?.comment || '').replace(ARCHIVE_PREFIX, '').trim();
    const titleMatch = title.match(/^第\s*(\d+)\s*世[·・\-—:]\s*(.+)$/);
    if (!titleMatch || entry?.disable) return null;
    const text = decodeHtmlText(entry.content);
    const important = text.match(/重要事件[：:]\s*([\s\S]*?)(?=重要人物|关键人物|死亡信息|死亡原因|未解决事项|$)/)?.[1]?.trim();
    const death = text.match(/死亡原因[：:]\s*([^\n]+)/)?.[1]?.trim();
    const summary = [important, death && `死亡原因：${death}`].filter(Boolean).join('；').replace(/\n+/g, ' ').slice(0, 900);
    return {
        generation: Number(titleMatch[1]),
        name: titleMatch[2].trim(),
        title: `第${titleMatch[1]}世·${titleMatch[2].trim()}`,
        summary: summary || text.slice(0, 900),
        source: 'world-book',
    };
}

export function lifeHistorySummaries(messages = [], statData = {}, archiveEntries = [], localLives = []) {
    const collected = new Map();
    const put = item => {
        if (!item) return;
        const key = Number.isFinite(item.generation) ? `generation:${item.generation}` : item.title;
        const previous = collected.get(key);
        if (previous?.conflict) return;
        if (previous && previous.name && item.name && previous.name !== item.name) {
            collected.set(key,{...previous,conflict:true,summary:`同一世代姓名冲突：${previous.name} / ${item.name}；请核对，不能作为事实注入。`});
        } else if (!previous || String(item.summary || '').length >= String(previous.summary || '').length) collected.set(key, item);
    };
    const index = Array.isArray(statData?.历代记忆摘要) ? statData.历代记忆摘要 : [];
    index.map(summaryFromIndex).forEach(put);
    archiveEntries.map(summaryFromArchiveEntry).forEach(put);
    for (const record of confirmedCarrierRecords(messages)) lifeSummariesFromCarrierCard(record.card).forEach(put);
    localLives.forEach(item => put(item && {
        generation: Number(item.generation),
        name: String(item.name || '').trim(),
        title: item.title || `第${item.generation}世·${item.name}`,
        summary: String(item.summary || '').trim(),
        source: item.source || 'plugin-ledger',
        ...item,
    }));
    return [...collected.values()].sort((a, b) => (a.generation || 0) - (b.generation || 0));
}

export function archiveTitle(draft, statData = {}) {
    const source = String(draft || '');
    const explicit = source.match(/第\s*([〇零一二三四五六七八九十百千万\d]+)\s*世\s*[·・\-—:]\s*([^\n<]{1,80})/);
    if (explicit) return `第${explicit[1]}世·${explicit[2].trim()}`;
    const generation = Number(getPath(statData, '主角.换身状态.当前世代编号', 1)) || 1;
    const indexed = Array.isArray(statData.历代记忆摘要)
        ? statData.历代记忆摘要.find(item => Number(item?.世代编号) === generation - 1)
        : null;
    const name = indexed?.身体姓名 || source.match(/身体姓名[:：]\s*([^\n]+)/)?.[1]
        || source.match(/姓名[:：]\s*([^\n]+)/)?.[1] || '未命名';
    const number = indexed?.世代编号 || Math.max(1, generation - 1);
    return `第${number}世·${String(name).trim()}`;
}

export function archiveKeywords(title, draft, statData = {}) {
    const words = new Set([title]);
    const number = title.match(/第([^世]+)世/)?.[1];
    const name = title.split('·').slice(1).join('·').trim();
    if (number) words.add(`第${number}世`);
    if (name) words.add(name);

    const index = Array.isArray(statData.历代记忆摘要) ? statData.历代记忆摘要 : [];
    const row = index.find(item => item?.详细词条名称 === title || item?.身体姓名 === name);
    for (const value of [row?.身体姓名, row?.身份, row?.所处时期, row?.最重要经历]) {
        for (const token of String(value || '').split(/[、，,；;｜|/]/).map(x => x.trim())) {
            if (token.length >= 2 && token.length <= 40) words.add(token);
        }
    }

    for (const match of String(draft || '').matchAll(/(?:重要人物|关键地点|重大事件|别名)[:：]\s*([^\n]+)/g)) {
        for (const token of match[1].split(/[、，,；;｜|/]/).map(x => x.trim())) {
            if (token.length >= 2 && token.length <= 40) words.add(token);
        }
    }
    return [...words].filter(Boolean).slice(0, 30);
}

export function normalizeEntries(book) {
    const entries = book?.entries;
    if (Array.isArray(entries)) return Object.fromEntries(entries.filter(Boolean).map((entry, i) => [entry.uid ?? i, entry]));
    return entries && typeof entries === 'object' ? entries : {};
}

export function makeArchiveEntry(uid, title, content, keywords) {
    return {
        uid,
        key: keywords,
        keysecondary: [],
        comment: `${ARCHIVE_PREFIX}${title}`,
        content: String(content || '').trim(),
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '历代记忆档案',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
    };
}

export function upsertArchive(book, { title, content, keywords }) {
    const next = clone(book || {});
    next.entries = normalizeEntries(next);
    const expectedGeneration = title.match(/^第(\d+)世/)?.[1];
    if (expectedGeneration && Object.values(next.entries).some(entry => {
        const name=String(entry?.comment || '').replace(ARCHIVE_PREFIX,'').trim();
        return name.match(/^第(\d+)世/)?.[1]===expectedGeneration && name!==title;
    })) return {status:'conflict',book:next,uid:null};
    const expectedComment = `${ARCHIVE_PREFIX}${title}`;
    const existing = Object.values(next.entries).find(entry => entry?.comment === expectedComment || entry?.comment === title);
    if (existing) {
        if (String(existing.content || '').trim() === String(content || '').trim()) {
            return { status: 'duplicate', book: next, uid: existing.uid };
        }
        return { status: 'conflict', book: next, uid: existing.uid };
    }
    const generation = title.match(/^第(\d+)世/)?.[1];
    if (generation && Object.values(next.entries).some(entry => {
        const name = String(entry?.comment || '').replace(ARCHIVE_PREFIX, '').trim();
        return name.match(/^第(\d+)世/)?.[1] === generation;
    })) return { status: 'conflict', book: next, uid: null };
    let uid = 0;
    const usedUids = new Set(Object.values(next.entries).map(entry => Number(entry?.uid)));
    while (Object.hasOwn(next.entries, uid) || usedUids.has(uid)) uid += 1;
    next.entries[uid] = makeArchiveEntry(uid, title, content, keywords);
    return { status: 'created', book: next, uid };
}

function stable(value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
    if (typeof value !== 'object') return String(value).trim();
    const ordered = Array.isArray(value)
        ? value
        : Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    return JSON.stringify(ordered);
}

export function detectCarryover(previousMain, currentMain) {
    const checks = [
        ['载体档案.性格与价值观', '性格与价值观'],
        ['载体档案.当前重要感情', '当前重要感情'],
        ['载体档案.愿望与恐惧', '愿望与恐惧'],
        ['载体档案.当前知识与语言', '知识与语言'],
        ['技能', '技能'],
        ['属性', '属性'],
        ['登神长阶', '登神长阶'],
    ];
    return checks.flatMap(([path, label]) => {
        const before = stable(getPath(previousMain, path));
        const after = stable(getPath(currentMain, path));
        return before && before === after ? [`${label}与上一身体完全相同，请核对是否错误继承`] : [];
    });
}

export function safeFilename(value) {
    return String(value || 'backup').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100);
}
