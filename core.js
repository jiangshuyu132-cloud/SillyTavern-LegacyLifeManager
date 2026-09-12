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

export function currentBodySummary(statData = {}) {
    const main = asObject(statData?.主角);
    const profile = asObject(main.载体档案);
    const hp = asObject(main.生命值);
    const effects = Object.keys(asObject(main.状态效果));
    let health = profile.伤病与健康;
    if (!health && (hp.当前 != null || resourceMaximum(hp) != null)) {
        const current = formatSummaryValue(hp.当前);
        const maximum = resourceMaximum(hp);
        health = `生命值 ${current}/${maximum ?? '当前变量未提供'}`;
        health += effects.length ? ` · 状态：${effects.join('、')}` : ' · 无状态效果';
    }
    return {
        name: formatSummaryValue(profile.姓名 || main.姓名, '当前变量未提供姓名'),
        main,
        rows: [
            ['原主', formatSummaryValue(profile.原主姓名 || main.原主姓名)],
            ['年龄', formatSummaryValue(profile.年龄 || main.年龄)],
            ['性别', formatSummaryValue(profile.性别 || main.性别)],
            ['种族', formatSummaryValue(main.种族)],
            ['身份', formatSummaryValue(main.身份, '暂无身份')],
            ['职业', formatSummaryValue(main.职业, '暂无职业')],
            ['地点', formatSummaryValue(profile.当前地点与处境 || getPath(statData, '世界.地点'))],
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
