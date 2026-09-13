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

export function formatSummaryValue(value, fallback = '当前变量未提供') {
    if (Array.isArray(value)) {
        const text = value.map(item => String(item ?? '').trim()).filter(Boolean).join('、');
        return text || fallback;
    }
    if (value == null) return fallback;
    const text = String(value).trim();
    return text || fallback;
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
    let health = liveProfile.伤病与健康;
    if (!health && (hp.当前 != null || resourceMaximum(hp) != null)) {
        const current = formatSummaryValue(hp.当前);
        const maximum = resourceMaximum(hp);
        health = `生命值 ${current}/${maximum ?? '当前变量未提供'}`;
        health += effects.length ? ` · 状态：${effects.join('、')}` : ' · 无状态效果';
    }
    if (!health) health = supplemental.伤病与健康;
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
            ['地点', formatSummaryValue(liveProfile.当前地点与处境 || getPath(statData, '世界.地点') || supplemental.地点)],
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

export function carrierCardSections(card) {
    const text = carrierCardText(card);
    if (!text) return [];
    const headings = [...text.matchAll(/^\s*[—-]\s*([^\n—-]{2,40}?)\s*[—-]\s*$/gm)];
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

export function isCarrierConfirmation(value) {
    const text = String(value || '').trim();
    if (text === '确认换身') return true;
    return /^发送\s*["“']确认换身["”']\s*[，,、。:]\s*正式接管[^\n]{0,160}$/u.test(text);
}

export function extractCarrierCards(text) {
    const source = String(text || '');
    return [...source.matchAll(/【当前载体人物设定开始】([\s\S]*?)【当前载体人物设定结束】/g)]
        .map(match => match[1]?.trim())
        .filter(Boolean);
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

export function confirmedCarrierRecords(messages = []) {
    const records = [];
    for (let index = 0; index < messages.length; index += 1) {
        const confirmation = messages[index];
        if (!confirmation?.is_user || confirmation?.is_system || !isCarrierConfirmation(confirmation.mes)) continue;
        for (let cardIndex = index - 1; cardIndex >= 0; cardIndex -= 1) {
            const message = messages[cardIndex];
            if (message?.is_user && isCarrierConfirmation(message.mes)) break;
            if (!message || message.is_user || message.is_system) continue;
            const cards = extractCarrierCards(message.mes);
            const card = cards.at(-1);
            const profile = parseCarrierCard(card);
            if (!Object.keys(profile).length) continue;
            records.push({ profile, card, confirmationIndex: index, cardIndex });
            break;
        }
    }
    return records;
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
        || `${record.confirmationIndex}:${String(confirmation.mes || '').trim()}`;
    return `${stableTextFingerprint(record.card)}:${stableTextFingerprint(confirmationIdentity)}`;
}

export function carrierGeneration(card, fallback = 1) {
    const text = carrierCardText(card);
    const arabic = text.match(/世代(?:编号)?[：:]\s*第?\s*(\d+)\s*世/);
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
        if (!message || message.is_user || message.is_system) continue;
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

export function rebuildConversationLives(messages = [], records = confirmedCarrierRecords(messages)) {
    const byGeneration = new Map();
    const put = item => {
        const generation = Number(item?.generation);
        if (!Number.isFinite(generation) || !item?.name) return;
        const previous = byGeneration.get(generation);
        if (!previous || String(item.summary || '').length >= String(previous.summary || '').length) {
            byGeneration.set(generation, item);
        }
    };

    for (const record of records) inferredLivesFromCarrierCard(record.card).forEach(put);
    for (let index = 1; index < records.length; index += 1) {
        const previous = records[index - 1];
        const current = records[index];
        put(buildLifeRecord({
            profile: previous.profile,
            rawCard: previous.card,
            generation: carrierGeneration(previous.card, index + 1),
            startMessageIndex: previous.confirmationIndex,
        }, messages, Math.max(previous.confirmationIndex, current.cardIndex - 1)));
    }

    return [...byGeneration.values()].sort((a, b) => Number(a.generation) - Number(b.generation));
}

export function conversationLedgerTruth(messages = [], suppressedRecordKeys = []) {
    const suppressed = new Set(suppressedRecordKeys || []);
    const records = confirmedCarrierRecords(messages)
        .filter(record => !suppressed.has(carrierRecordKey(record, messages)));
    return {
        records,
        currentRecord: records.at(-1) || null,
        lives: rebuildConversationLives(messages, records),
    };
}

export function confirmedCarrierProfile(messages = []) {
    return confirmedCarrierRecords(messages).at(-1)?.profile || {};
}

export function lifeSummariesFromCarrierCard(card) {
    const text = decodeHtmlText(card);
    const section = text.match(/历代经历记忆(?:简短索引)?[：:]\s*([\s\S]*?)(?=上一具身体死亡信息[：:]|※\s*历代旧人格|$)/)?.[1] || '';
    const summaries = [];
    for (const line of section.split('\n')) {
        const match = line.trim().match(/^[·•\-]?\s*第\s*(\d+)\s*世[：:·・]\s*(.+?)\s*(?:——|--|—)\s*(.+)$/);
        if (!match) continue;
        summaries.push({
            generation: Number(match[1]),
            name: match[2].trim(),
            title: `第${match[1]}世·${match[2].trim()}`,
            summary: match[3].trim(),
            source: 'confirmed-card',
        });
    }
    return summaries;
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
        if (!previous || String(item.summary || '').length >= String(previous.summary || '').length) collected.set(key, item);
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
    const expectedComment = `${ARCHIVE_PREFIX}${title}`;
    const existing = Object.values(next.entries).find(entry => entry?.comment === expectedComment || entry?.comment === title);
    if (existing) {
        if (String(existing.content || '').trim() === String(content || '').trim()) {
            return { status: 'duplicate', book: next, uid: existing.uid };
        }
        return { status: 'conflict', book: next, uid: existing.uid };
    }
    let uid = 0;
    while (Object.hasOwn(next.entries, uid)) uid += 1;
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
