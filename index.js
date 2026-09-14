import {
    ARCHIVE_PREFIX,
    archiveKeywords,
    archiveTitle,
    asObject,
    buildLifeRecord,
    carrierGeneration,
    carrierCardSections,
    carrierCardText,
    carrierRecordKey,
    compactLifeIndex,
    confirmedCarrierProfile,
    confirmedCarrierRecords,
    conversationLedgerTruth,
    currentBehaviorProfile,
    currentBodySummary,
    detectCarryover,
    extractCarrierCards,
    getPath,
    inferredLivesFromCarrierCard,
    lifeHistorySummaries,
    liveBodyState,
    mergeLifeRecords,
    normalizeEntries,
    parseCarrierCard,
    replayDynamicStatData,
    rebuildConversationLives,
    safeFilename,
    stableTextFingerprint,
    smartInjectionUsesFullCard,
    supplementalPlayerProfile,
    upsertArchive,
} from './core.js';
import { createMvuAdapter } from './mvu-adapter.js';

const EXTENSION_KEY = 'legacy_life_manager';
const METADATA_KEY = 'legacy_life_manager';
const PROMPT_KEY = 'legacy_life_manager_current_body';
const DEFAULT_SETTINGS = Object.freeze({ worldBookName: '', dataVersion: 5, injectionMode: 'smart' });
let initialized = false;
let refreshTimers = [];
let lastPromptStats = { characters: 0, tokenLow: 0, tokenHigh: 0, requestedMode: 'smart', effectiveMode: '等待当前身体' };

function context() {
    return globalThis.SillyTavern?.getContext?.();
}

function settings() {
    const ctx = context();
    if (!ctx) return { ...DEFAULT_SETTINGS };
    ctx.extensionSettings[EXTENSION_KEY] ??= { ...DEFAULT_SETTINGS };
    const current = ctx.extensionSettings[EXTENSION_KEY];
    if (Number(current.dataVersion || 0) < 5) {
        // 0.4.x and earlier defaulted to full. Migrate that legacy default once;
        // users can still explicitly select full again after the upgrade.
        if (!current.injectionMode || current.injectionMode === 'full') current.injectionMode = 'smart';
        current.dataVersion = 5;
        ctx.saveSettingsDebounced?.();
    }
    if (!['smart', 'full', 'compact', 'off'].includes(current.injectionMode)) current.injectionMode = 'smart';
    return current;
}

function chatData(create = true) {
    const ctx = context();
    if (!ctx?.chatMetadata) return null;
    if (!ctx.chatMetadata[METADATA_KEY] && create) {
        ctx.chatMetadata[METADATA_KEY] = { version: 5, currentBody: null, lives: [], suppressedRecordKeys: [], pendingSnapshot: null, backups: [] };
    }
    const data = ctx.chatMetadata[METADATA_KEY] || null;
    if (data) {
        data.version = 5;
        data.lives ??= [];
        data.currentBody ??= null;
        data.suppressedRecordKeys ??= [];
        data.backups ??= [];
    }
    return data;
}

function notify(level, message) {
    if (globalThis.toastr?.[level]) globalThis.toastr[level](message, '历代人生管理器');
    else console[level === 'error' ? 'error' : 'log'](`[历代人生管理器] ${message}`);
}

function saveSettings() {
    context()?.saveSettingsDebounced?.();
}

function saveChatMetadata() {
    context()?.saveMetadataDebounced?.();
}

function activeChat() {
    const ctx = context();
    return Boolean(ctx && Array.isArray(ctx.chat) && (ctx.chatId || ctx.groupId));
}

function latestMessageIndex() {
    const helper = globalThis.TavernHelper;
    if (typeof helper?.getLastMessageId === 'function') return Number(helper.getLastMessageId());
    return Math.max(0, (context()?.chat?.length || 1) - 1);
}

const mvu = createMvuAdapter({ env: globalThis, getContext: context, getLatestMessageIndex: latestMessageIndex });
const readStatData = () => mvu.readStatData();
const writeMessagePath = (path, value) => mvu.writeMessagePath(path, value);

function readEffectiveStatData() {
    const messages = context()?.chat || [];
    const bodyStart = Math.max(0, Number(currentImportedBody()?.startMessageIndex || 0));
    return replayDynamicStatData(readStatData(), messages, { startIndex: bodyStart });
}

function mergeLives(data, incoming) {
    data.lives = mergeLifeRecords(data.lives, incoming);
}

function saveImportedBody(card, profile, messageIndex, mode = 'sync', sourceType = 'manual') {
    const data = chatData();
    const messages = context()?.chat || [];
    const previous = data.currentBody;
    const inferred = inferredLivesFromCarrierCard(card);
    mergeLives(data, inferred);
    const generation = carrierGeneration(card, Math.max(1, ...data.lives.map(item => Number(item.generation) + 1).filter(Number.isFinite)));
    if (mode === 'confirm' && previous && previous.profile?.姓名 !== profile.姓名) {
        mergeLives(data, [buildLifeRecord(previous, messages, Math.max(0, messageIndex - 1))]);
    }
    data.currentBody = {
        profile,
        rawCard: card,
        text: carrierCardText(card),
        sections: carrierCardSections(card),
        sourceMessageIndex: messageIndex,
        sourceCardFingerprint: stableTextFingerprint(card),
        sourceType,
        startMessageIndex: mode === 'confirm' ? messageIndex : (previous?.startMessageIndex ?? messageIndex),
        generation,
        confirmed: mode === 'confirm' || previous?.confirmed === true,
        importedAt: new Date().toISOString(),
    };
    saveChatMetadata();
    updateCurrentBodyPrompt();
    return data.currentBody;
}

function backupLedger(data, reason) {
    if (!data?.currentBody && !(data?.lives || []).length) return;
    data.backups ??= [];
    data.backups.push({
        at: new Date().toISOString(),
        reason,
        currentBody: data.currentBody,
        lives: data.lives,
    });
    data.backups = data.backups.slice(-5);
}

function bodyFromConfirmedRecord(record, messages, lives, previous = null) {
    const sourceRecordKey = carrierRecordKey(record, messages);
    return {
        profile: record.profile,
        rawCard: record.card,
        text: carrierCardText(record.card),
        sections: carrierCardSections(record.card),
        sourceMessageIndex: record.cardIndex,
        confirmationMessageIndex: record.confirmationIndex,
        sourceCardFingerprint: stableTextFingerprint(record.card),
        sourceRecordKey,
        sourceType: 'conversation',
        startMessageIndex: record.confirmationIndex,
        generation: carrierGeneration(record.card, Math.max(1, ...lives.map(item => Number(item.generation) + 1).filter(Number.isFinite))),
        confirmed: true,
        importedAt: previous?.sourceRecordKey === sourceRecordKey ? previous.importedAt : new Date().toISOString(),
    };
}

function reconcileConversation({ force = false, reason = '自动对账' } = {}) {
    const data = chatData();
    const messages = context()?.chat || [];
    const truth = conversationLedgerTruth(messages, force ? [] : data.suppressedRecordKeys);
    const records = truth.records;
    const record = truth.currentRecord;
    const previous = data.currentBody;
    let nextLives = truth.lives;
    let nextBody = record ? bodyFromConfirmedRecord(record, messages, nextLives, previous) : null;

    if (!force && previous?.sourceType === 'manual') {
        const matching = availableCarrierCards().find(item => stableTextFingerprint(item.card) === previous.sourceCardFingerprint);
        const manualIsNewest = matching && (!record || matching.messageIndex >= record.cardIndex);
        if (manualIsNewest) {
            nextBody = { ...previous, sourceMessageIndex: matching.messageIndex };
            nextLives = mergeLifeRecords(data.lives, truth.lives, inferredLivesFromCarrierCard(matching.card));
        }
    }

    const previousKey = previous?.sourceRecordKey || previous?.sourceCardFingerprint
        || (previous?.rawCard ? stableTextFingerprint(previous.rawCard) : '');
    const nextKey = nextBody?.sourceRecordKey || nextBody?.sourceCardFingerprint || '';
    const changed = previousKey !== nextKey || JSON.stringify(data.lives || []) !== JSON.stringify(nextLives);
    if (!changed) return { changed: false, cleared: false, restored: false };

    backupLedger(data, reason);
    data.currentBody = nextBody;
    data.lives = nextLives;
    if (force) data.suppressedRecordKeys = [];
    saveChatMetadata();
    return { changed: true, cleared: Boolean(previous && !nextBody), restored: Boolean(nextBody), previous, current: nextBody };
}

function currentImportedBody() {
    return chatData(false)?.currentBody || null;
}

function dynamicContextText(statData, fullCarrier = false) {
    return JSON.stringify(liveBodyState(statData, { fullCarrier }), null, 2);
}

function buildCurrentBodyPrompt(body, statData, mode) {
    if (!body || mode === 'off') return { prompt: '', effectiveMode: body ? '已关闭' : '等待当前身体' };
    const messages = context()?.chat || [];
    const profile = JSON.stringify(body.profile || {}, null, 2);
    const behavior = JSON.stringify(currentBehaviorProfile(body.rawCard || body.text, statData), null, 2);
    const firstSmartTurn = mode === 'smart' && smartInjectionUsesFullCard(body, messages);
    const useFullCard = mode === 'full' || firstSmartTurn;
    const details = useFullCard ? body.text : profile;
    const detailTitle = useFullCard ? '完整当前身体档案' : '当前身体核心档案';
    const histories = (mode === 'smart' && !firstSmartTurn) || mode === 'compact'
        ? compactLifeIndex(mergeLifeRecords(chatData(false)?.lives || [], inferredLivesFromCarrierCard(body.rawCard)), 1200)
        : '';
    const historySection = histories
        ? `\n\n【历代经历压缩索引】\n以下只是历代重要经历记忆，不代表旧人格、感情、知识、技能或属性继承。\n${histories}`
        : '';
    const effectiveMode = mode === 'smart'
        ? (firstSmartTurn ? '智能·换身首轮完整' : '智能·日常精简')
        : mode === 'full' ? '完整' : '精简';
    const prompt = `<legacy_life_current_body>\n这是现实Participant已经确认、由“历代人生管理器”保存的当前身体档案。它是当前有效人物设定，不是候选，也不是前世。历代旧人格、旧感情、旧知识、旧语言、旧技能或旧属性不得回流；地点、资源、伤势、状态、身体变化与穿着等易变信息，以“正文实时状态”优先。\n\n【行动—人格协调规则｜每轮强制执行】\n- Participant输入决定“做什么”及最终选择；只要客观上可能，当前身体性格与恐惧不得否决、取消、偷换或强制判定该行动失败。\n- 当前身体的性格、价值观、感情、喜恶、愿望、恐惧、习惯、认知边界与思维方式决定“如何理解和执行”：注意力、风险评估、计划习惯、犹豫或决心、非意志性生理反应、语气与动作节奏都应一致。胆小者可以执行勇敢行动，但可在不撤销行动的前提下体现恐惧、谨慎准备、迟疑或身体紧张。\n- Recorder只能为实现Participant已明确内容，补充最低限度且不改变意图的当下体验与执行质感；不得新增目标、选择、台词、后续主动行动或替Participant改变决定。当前人格造成的是可信阻力与代价，不是行动否决权。\n- 思考与感知必须使用当前身体的词汇、知识边界、价值排序、认知习惯和身体经验；除已归档的重要经历记忆外，不得泄露历代旧人格或旧知识。\n\n【当前人格与思维方式｜每轮有效】\n${behavior}\n\n【${detailTitle}】\n${details}\n\n【正文实时状态】\n${dynamicContextText(statData, mode === 'full')}${historySection}\n</legacy_life_current_body>`;
    return { prompt, effectiveMode };
}

function recordPromptStats(prompt, requestedMode, effectiveMode) {
    const characters = prompt.length;
    lastPromptStats = {
        characters,
        tokenLow: characters ? Math.ceil(characters * 0.5) : 0,
        tokenHigh: characters,
        requestedMode,
        effectiveMode,
    };
    const meter = document.querySelector('#legacy-life-manager-root .llm-prompt-meter');
    if (meter) meter.textContent = promptStatsText();
}

function promptStatsText() {
    const stats = lastPromptStats;
    return `当前实际注入：${stats.effectiveMode} · ${stats.characters.toLocaleString()} 字符 · 约 ${stats.tokenLow.toLocaleString()}–${stats.tokenHigh.toLocaleString()} Token`;
}

async function updateCurrentBodyPrompt() {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt !== 'function') return;
    reconcileConversation({ reason: '生成前校验' });
    const { statData } = readEffectiveStatData();
    const requestedMode = settings().injectionMode || 'smart';
    const built = buildCurrentBodyPrompt(currentImportedBody(), statData, requestedMode);
    await ctx.setExtensionPrompt(PROMPT_KEY, built.prompt, 1, 0, false, 0);
    recordPromptStats(built.prompt, requestedMode, built.effectiveMode);
}

function currentWorldBookName() {
    const ctx = context();
    const preferred = String(settings().worldBookName || '').trim();
    const names = ctx?.getWorldInfoNames?.() || [];
    if (preferred && names.includes(preferred)) return preferred;
    const bound = String(ctx?.chatMetadata?.world_info || '').trim();
    if (bound && names.includes(bound)) return bound;
    return names.find(name => /历代记忆档案/.test(name)) || '';
}

function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeFilename(filename);
    link.click();
    URL.revokeObjectURL(url);
}

async function verifyWorldBook(name, title, content) {
    const ctx = context();
    if (typeof fetch !== 'function' || typeof ctx?.getRequestHeaders !== 'function') {
        const cached = await ctx?.loadWorldInfo?.(name);
        return Object.values(normalizeEntries(cached)).some(entry => entry?.comment === `${ARCHIVE_PREFIX}${title}` && String(entry.content || '').trim() === content.trim());
    }
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
    });
    if (!response.ok) return false;
    const saved = await response.json();
    return Object.values(normalizeEntries(saved)).some(entry => entry?.comment === `${ARCHIVE_PREFIX}${title}` && String(entry.content || '').trim() === content.trim());
}

async function archivePendingLife() {
    const ctx = context();
    const { statData } = readEffectiveStatData();
    const state = getPath(statData, '主角.换身状态', {});
    const content = String(state?.待归档人生词条 || '').trim();
    if (!content || state?.归档写入状态 !== '待写入世界书') {
        notify('warning', '没有处于“待写入世界书”状态的人生词条');
        return;
    }
    const name = currentWorldBookName();
    if (!name) {
        notify('error', '没有找到要写入的世界书；请在“设置与备份”中选择已有世界书');
        return;
    }
    const title = archiveTitle(content, statData);
    if (!globalThis.confirm(`即将把“${title}”写入现有世界书“${name}”。不会覆盖同名异文。继续吗？`)) return;
    const book = await ctx.loadWorldInfo?.(name);
    if (!book) throw new Error(`无法读取世界书：${name}`);
    const result = upsertArchive(book, { title, content, keywords: archiveKeywords(title, content, statData) });
    if (result.status === 'conflict') {
        notify('error', `发现同名但内容不同的词条“${title}”，已停止写入，请先人工核对`);
        return;
    }
    if (result.status === 'created') {
        const data = chatData();
        data.backups ??= [];
        data.backups.push({ at: new Date().toISOString(), worldBookName: name, title, statData });
        data.backups = data.backups.slice(-5);
        saveChatMetadata();
        await ctx.saveWorldInfo?.(name, result.book, true);
        const verified = await verifyWorldBook(name, title, content);
        if (!verified) throw new Error('世界书保存后回读校验失败；临时草稿已保留');
    }
    await writeMessagePath('stat_data.主角.换身状态.归档写入状态', '已写入世界书');
    await writeMessagePath('stat_data.主角.换身状态.待归档人生词条', '');
    notify('success', result.status === 'duplicate' ? '相同词条已经存在；已去重并完成状态清理' : `“${title}”已写入并回读验证成功`);
    render();
}

async function exportBackup() {
    const ctx = context();
    const { statData } = readEffectiveStatData();
    const name = currentWorldBookName();
    const book = name ? await ctx?.loadWorldInfo?.(name) : null;
    const transcript = (ctx?.chat || []).map((message, index) => ({
        index,
        role: message?.is_system ? 'system' : message?.is_user ? 'user' : 'assistant',
        name: message?.name || '',
        text: message?.mes || '',
        sendDate: message?.send_date || null,
    }));
    downloadJson(`历代人生备份-${Date.now()}.json`, {
        format: 'sillytavern-legacy-life-backup', version: 1, exportedAt: new Date().toISOString(),
        chatId: ctx?.chatId || ctx?.groupId || '', statData, worldBookName: name,
        archiveEntries: book ? Object.values(normalizeEntries(book)).filter(entry => String(entry?.comment || '').startsWith(ARCHIVE_PREFIX)) : [],
        transcript,
    });
    notify('success', '已导出当前身体、历代词条和完整聊天原文');
}

function capturePendingSnapshot(statData) {
    const state = getPath(statData, '主角.换身状态', {});
    const data = chatData();
    if (!data) return;
    if (state?.阶段 === '等待确认' && state?.当前身体死亡已确认 === true) {
        const generation = Number(state?.当前世代编号 || 1);
        if (data.pendingSnapshot?.generation !== generation) {
            data.pendingSnapshot = { generation, main: statData.主角, capturedAt: new Date().toISOString() };
            saveChatMetadata();
        }
    }
}

function carryoverWarnings(statData) {
    const snapshot = chatData(false)?.pendingSnapshot;
    const generation = Number(getPath(statData, '主角.换身状态.当前世代编号', 1));
    if (!snapshot || generation <= Number(snapshot.generation || 0)) return [];
    return detectCarryover(snapshot.main, statData.主角);
}

function createButton(text, handler, className = 'menu_button') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', async () => {
        try { await handler(); } catch (error) { console.error(error); notify('error', error.message || String(error)); }
    });
    return button;
}

function pretty(value) {
    return JSON.stringify(value ?? null, null, 2);
}

function availableCarrierCards() {
    const result = [];
    for (const [messageIndex, message] of (context()?.chat || []).entries()) {
        if (!message || message.is_user || message.is_system) continue;
        const cards = extractCarrierCards(message.mes);
        for (const [cardIndex, card] of cards.entries()) {
            const profile = parseCarrierCard(card);
            if (profile.姓名) result.push({ messageIndex, cardIndex, card, profile });
        }
    }
    return result;
}

function importSelectedCard(record, mode) {
    if (!record) return notify('warning', '没有选择可导入的人物卡');
    const verb = mode === 'confirm' ? '确认换身并导入' : '同步为当前身体';
    if (!globalThis.confirm(`${verb}“${record.profile.姓名}”？\n\n人物卡完整原文会保存到当前聊天；${mode === 'confirm' ? '旧身体会进入历代人生。' : '不会新增历代人生。'}`)) return;
    saveImportedBody(record.card, record.profile, record.messageIndex, mode);
    notify('success', `已${verb}：${record.profile.姓名}`);
    render();
}

async function rebuildFromCurrentChat() {
    if (!globalThis.confirm('根据当前仍然存在的正文楼层，重新建立当前身体和历代人生？\n\n已删除楼层产生的记录会从插件中撤销，但不会删除已经写入世界书的词条。')) return;
    const result = reconcileConversation({ force: true, reason: '手动从当前正文重建' });
    await updateCurrentBodyPrompt();
    await render();
    if (result.current) notify('success', `已按当前正文重建：${result.current.profile?.姓名 || '当前身体'}`);
    else notify('info', '当前正文没有有效的已确认换身记录；已撤销孤立身体和历代记录');
}

async function clearCurrentChatLedger() {
    if (!globalThis.confirm('清空本聊天由插件保存的当前身体、历代人生和 AI 注入？\n\n现有确认楼层会暂时忽略；以后新产生的确认记录仍可自动识别。世界书内容不会被删除。')) return;
    const data = chatData();
    const messages = context()?.chat || [];
    backupLedger(data, '手动清空本聊天插件记录');
    data.suppressedRecordKeys = confirmedCarrierRecords(messages).map(record => carrierRecordKey(record, messages));
    data.currentBody = null;
    data.lives = [];
    saveChatMetadata();
    await updateCurrentBodyPrompt();
    await render();
    notify('success', '已清空本聊天的插件记录和 AI 当前身体注入');
}

function renderFullBody(panel, body) {
    if (!body?.text) return;
    const heading = el('h3', 'llm-section-title', '接管时的完整身体档案');
    const intro = el('div', 'llm-muted', '这里保留接管时的完整人物卡原文；伤势、变异、改造、形态和穿着等后续变化，以上方“正文实时身体状态”为准。');
    const sections = el('div', 'llm-sections');
    for (const section of body.sections || carrierCardSections(body.rawCard)) {
        const details = document.createElement('details');
        details.className = 'llm-life llm-section';
        details.append(el('summary', '', section.title), el('div', 'llm-section-content', section.content));
        sections.append(details);
    }
    const raw = document.createElement('details');
    raw.className = 'llm-life';
    raw.append(el('summary', '', '查看完整原始人物卡文本'), el('pre', 'llm-json', body.text));
    panel.append(heading, intro, sections, raw);
}

function runtimeValueText(value) {
    if (value == null || value === '') return '';
    if (Array.isArray(value)) return value.map(runtimeValueText).filter(Boolean).join('、');
    if (typeof value !== 'object') return String(value);
    return Object.entries(value)
        .map(([key, item]) => `${key}：${runtimeValueText(item)}`)
        .filter(line => !line.endsWith('：'))
        .join(' · ');
}

function renderRuntimeBodyState(panel, statData, runtimeInfo = {}) {
    const main = asObject(statData?.主角);
    const carrier = asObject(main.载体档案);
    const effects = Object.entries(asObject(main.状态效果));
    const changes = [];
    const wanted = /伤|病|健康|外貌|身体|体型|皮肤|四肢|器官|变异|改造|形态|植入|义体|血脉|特征|穿着/;
    for (const [key, value] of Object.entries(carrier)) {
        if (wanted.test(key) && runtimeValueText(value)) changes.push([key, value]);
    }
    for (const [key, value] of Object.entries(main)) {
        if (key !== '载体档案' && key !== '状态效果' && wanted.test(key) && runtimeValueText(value)) changes.push([key, value]);
    }
    if (!effects.length && !changes.length && !runtimeInfo.appliedOperations) return;

    panel.append(el('h3', 'llm-section-title', '正文实时身体状态'));
    const note = runtimeInfo.appliedOperations
        ? `已从最新正文的变量更新中补全 ${runtimeInfo.appliedOperations} 项变化；当 MVU 楼层快照延迟或路径使用“最新动态”别名时仍会立即显示。`
        : '伤势、状态、变异、改造、形态和穿着会随最新正文变量更新。';
    panel.append(el('div', 'llm-runtime-note', note));
    const list = el('div', 'llm-runtime-list');
    for (const [name, value] of effects) {
        const card = el('article', 'llm-runtime-card llm-runtime-effect');
        card.append(el('span', 'llm-runtime-label', `状态效果 · ${name}`), el('div', 'llm-runtime-value', runtimeValueText(value) || '已生效'));
        list.append(card);
    }
    const seen = new Set();
    for (const [name, value] of changes) {
        const signature = `${name}:${runtimeValueText(value)}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        const card = el('article', 'llm-runtime-card');
        card.append(el('span', 'llm-runtime-label', name), el('div', 'llm-runtime-value', runtimeValueText(value)));
        list.append(card);
    }
    panel.append(list);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function renderCurrent(panel, statData, runtimeInfo = {}) {
    const messages = context()?.chat || [];
    const importedBody = currentImportedBody();
    const confirmedProfile = confirmedCarrierProfile(messages);
    const importedProfile = asObject(importedBody?.profile);
    const hasImportedProfile = Object.keys(importedProfile).length > 0;
    const hasConfirmedProfile = Object.keys(confirmedProfile).length > 0;
    const chatProfile = hasImportedProfile ? importedProfile : hasConfirmedProfile ? confirmedProfile : supplementalPlayerProfile(messages, statData);
    const summary = currentBodySummary(statData, chatProfile, { preferSupplemental: hasImportedProfile || hasConfirmedProfile });
    const main = summary.main;
    const rowMap = new Map(summary.rows);
    const hero = el('section', 'llm-profile-hero');
    const orbit = el('div', 'llm-orbit-avatar');
    orbit.append(el('div', 'llm-silhouette'));
    const heroInfo = el('div', 'llm-hero-info');
    heroInfo.append(el('div', 'llm-hero-name', summary.name));
    const chips = el('div', 'llm-chips');
    for (const label of ['年龄', '种族', '职业']) {
        const value = String(rowMap.get(label) || '').trim();
        if (value && value !== '—') chips.append(el('span', 'llm-chip', value));
    }
    heroInfo.append(chips);
    const healthText = String(rowMap.get('健康') || '—');
    const healthMatch = healthText.match(/(?:生命值\s*)?(\d+)\s*\/\s*(\d+)/);
    const healthPercent = healthMatch && Number(healthMatch[2]) > 0
        ? Math.max(0, Math.min(100, Math.round(Number(healthMatch[1]) / Number(healthMatch[2]) * 100)))
        : 0;
    const health = el('div', 'llm-health');
    const healthLabel = el('div', 'llm-health-label');
    healthLabel.append(el('span', '', '生命状态'), el('span', '', healthMatch ? `${healthMatch[1]} / ${healthMatch[2]}` : healthText));
    const healthTrack = el('div', 'llm-health-track');
    const healthFill = el('div', 'llm-health-fill');
    healthFill.style.setProperty('--llm-health', `${healthPercent}%`);
    healthTrack.append(healthFill);
    health.append(healthLabel, healthTrack);
    heroInfo.append(health);
    hero.append(orbit, heroInfo, el('div', 'llm-hero-quote', '每一次结束，\n都是另一段人生的开始。'));
    const grid = el('div', 'llm-summary-grid');
    for (const [label, value] of summary.rows) {
        if (['原主', '年龄', '种族', '职业'].includes(label)) continue;
        const item = el('div', 'llm-summary-item');
        item.dataset.field = label;
        item.append(el('span', '', label), el('strong', '', value));
        grid.append(item);
    }
    const details = document.createElement('details');
    details.append(el('summary', '', '查看完整 stat_data.主角'), el('pre', 'llm-json', pretty(main)));
    const warnings = carryoverWarnings(statData);
    panel.append(hero, grid);
    if (summary.usedSupplementalProfile) {
        panel.append(el('div', 'llm-muted', hasImportedProfile
            ? '完整身份资料来自插件保存的当前人物卡；地点、资源与状态读取最新 stat_data。'
            : hasConfirmedProfile
            ? '当前身份来自最近一次已确认换身的人物卡；地点、生命值与状态读取最新 stat_data。'
            : '人物资料来自当前聊天的人物卡；地点、生命值与状态读取最新 stat_data。'));
    }
    if (warnings.length) {
        const warning = el('div', 'llm-warning');
        warning.append(el('strong', '', '继承检查提醒'), ...warnings.map(item => el('div', '', `• ${item}`)));
        panel.append(warning);
    }
    panel.append(details);
    renderRuntimeBodyState(panel, statData, runtimeInfo);
    renderFullBody(panel, importedBody);
}

async function renderLives(panel, statData) {
    const name = currentWorldBookName();
    const book = name ? await context()?.loadWorldInfo?.(name) : null;
    const entries = book ? Object.values(normalizeEntries(book)) : [];
    const summaries = lifeHistorySummaries(context()?.chat || [], statData, entries, chatData(false)?.lives || []);
    const search = document.createElement('input');
    search.className = 'text_pole';
    search.placeholder = '搜索姓名或经历';
    const list = el('div', 'llm-life-list');
    const draw = () => {
        const needle = search.value.trim().toLowerCase();
        list.replaceChildren();
        const visible = summaries.filter(item => !needle || `${item.title}\n${item.summary}`.toLowerCase().includes(needle));
        if (!visible.length) list.append(el('div', 'llm-empty', summaries.length ? '没有匹配的历代经历。' : '尚无已经死亡并完成换身的前世记录。'));
        for (const item of visible) {
            const card = el('article', 'llm-life-card');
            card.append(el('div', 'llm-life-title', item.title), el('p', 'llm-life-summary', item.summary || '尚无经历摘要'));
            if (item.rawCard) {
                const details = document.createElement('details');
                details.append(el('summary', '', '查看该世人物卡'), el('pre', 'llm-life-content', carrierCardText(item.rawCard)));
                card.append(details);
            }
            list.append(card);
        }
    };
    search.addEventListener('input', draw);
    const state = getPath(statData, '主角.换身状态', {});
    panel.append(el('div', 'llm-muted', '每次确认换身后，这里按世代显示上一具身体的简要经历。'));
    if (state?.待归档人生词条 && state?.归档写入状态 === '待写入世界书') {
        panel.append(createButton('把待归档前世写入世界书', archivePendingLife, 'menu_button llm-primary'));
    }
    panel.append(search, list);
    draw();
}

function renderSettings(panel) {
    const ctx = context();
    const label = el('label', 'llm-label', '归档写入的现有世界书');
    const select = document.createElement('select');
    select.className = 'text_pole';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动：优先当前聊天绑定的世界书';
    select.append(auto);
    for (const name of ctx?.getWorldInfoNames?.() || []) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        option.selected = settings().worldBookName === name;
        select.append(option);
    }
    select.addEventListener('change', () => { settings().worldBookName = select.value; saveSettings(); render(); });
    const active = el('div', 'llm-muted', `当前目标：${currentWorldBookName() || '未找到'}`);
    const injectionLabel = el('label', 'llm-label', '发送给 AI 的当前身体资料');
    const injection = document.createElement('select');
    injection.className = 'text_pole';
    for (const [value, text] of [
        ['smart', '智能注入（推荐）'],
        ['full', '每轮完整注入'],
        ['compact', '始终精简注入'],
        ['off', '不注入'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        option.selected = (settings().injectionMode || 'full') === value;
        injection.append(option);
    }
    injection.addEventListener('change', () => {
        settings().injectionMode = injection.value;
        saveSettings();
        updateCurrentBodyPrompt();
    });
    injectionLabel.append(injection);
    const injectionHelp = el('div', 'llm-muted', '智能模式仅在换身后首轮发送完整人物卡；之后每轮固定发送人格与思维方式、核心身份、完整状态描述、身体变化和限长的历代经历索引。');
    const promptMeter = el('div', 'llm-prompt-meter', promptStatsText());

    const importLabel = el('label', 'llm-label', '从正文选择人物卡');
    const cardSelect = document.createElement('select');
    cardSelect.className = 'text_pole';
    const cards = availableCarrierCards();
    if (!cards.length) {
        const option = document.createElement('option');
        option.textContent = '当前聊天没有识别到人物卡';
        cardSelect.append(option);
        cardSelect.disabled = true;
    } else {
        cards.slice().reverse().forEach((record, index) => {
            const option = document.createElement('option');
            option.value = String(cards.indexOf(record));
            option.textContent = `第 ${record.messageIndex + 1} 楼 · ${record.profile.姓名}${index === 0 ? '（最近）' : ''}`;
            cardSelect.append(option);
        });
    }
    importLabel.append(cardSelect);
    const importActions = el('div', 'llm-actions');
    importActions.append(
        createButton('同步为当前身体', () => importSelectedCard(cards[Number(cardSelect.value)], 'sync')),
        createButton('确认换身并导入', () => importSelectedCard(cards[Number(cardSelect.value)], 'confirm'), 'menu_button llm-primary'),
    );
    const ledgerActions = el('div', 'llm-actions');
    ledgerActions.append(
        createButton('从当前正文重新同步', rebuildFromCurrentChat, 'menu_button llm-primary'),
        createButton('清空本聊天插件记录', clearCurrentChatLedger),
    );
    const safety = el('div', 'llm-safety');
    safety.textContent = '当前正文是事实来源：删除、编辑、切换或重生成相关楼层后，插件会撤销失去来源的身体、历代记录和 AI 注入。已经写入世界书的词条不会自动删除。';
    const archiveCard = el('section', 'llm-control-card');
    archiveCard.append(label, select, active);
    const aiCard = el('section', 'llm-control-card');
    aiCard.append(injectionLabel, injectionHelp, promptMeter);
    const importCard = el('section', 'llm-control-card');
    importCard.append(importLabel, importActions);
    const maintenanceCard = el('section', 'llm-control-card');
    maintenanceCard.append(ledgerActions, safety, createButton('导出完整备份', exportBackup, 'menu_button llm-primary'));
    panel.append(
        el('h3', 'llm-section-title', '世界书与 AI 注入'),
        archiveCard,
        aiCard,
        el('h3', 'llm-section-title', '人物卡导入'),
        importCard,
        el('h3', 'llm-section-title', '同步与备份'),
        maintenanceCard,
    );
}

function createPanel() {
    const root = el('div', 'extension_container', null);
    root.id = 'legacy-life-manager-root';
    const drawer = el('div', 'inline-drawer');
    const header = el('div', 'inline-drawer-toggle inline-drawer-header');
    const brand = el('div', 'llm-brand');
    brand.append(el('span', 'llm-brand-mark'), el('b', 'llm-brand-title', '历代人生管理器'));
    const sync = el('span', 'llm-sync', '已同步');
    sync.dataset.state = 'empty';
    header.append(brand, sync, el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const body = el('div', 'inline-drawer-content');
    const tabs = el('div', 'llm-tabs');
    for (const [id, label] of [['current', '当前身体'], ['lives', '历代人生'], ['settings', '设置与备份']]) {
        const button = createButton(label, () => activateTab(id), 'menu_button llm-tab');
        button.dataset.tab = id;
        tabs.append(button);
    }
    const content = el('div', 'llm-panel');
    content.dataset.activeTab = 'current';
    body.append(el('p', 'llm-help', '自动识别正文中已确认的当前身体，并按世代汇总已经结束的人生。'), tabs, content);
    drawer.append(header, body);
    root.append(drawer);
    return root;
}

function activateTab(id) {
    const panel = document.querySelector('#legacy-life-manager-root .llm-panel');
    if (panel) panel.dataset.activeTab = id;
    render();
}

async function render() {
    const root = document.getElementById('legacy-life-manager-root');
    if (!root) return;
    const panel = root.querySelector('.llm-panel');
    const sync = root.querySelector('.llm-sync');
    const requestedTab = panel.dataset.activeTab || 'current';
    const tab = ['current', 'lives', 'settings'].includes(requestedTab) ? requestedTab : 'current';
    panel.dataset.activeTab = tab;
    for (const button of root.querySelectorAll('.llm-tab')) button.classList.toggle('active', button.dataset.tab === tab);
    panel.replaceChildren();
    if (!activeChat()) {
        if (sync) { sync.textContent = '等待聊天'; sync.dataset.state = 'empty'; }
        panel.append(el('div', 'llm-empty', '请先打开一个角色聊天或群聊。'));
        return;
    }
    reconcileConversation({ reason: '打开或刷新聊天' });
    const runtimeInfo = readEffectiveStatData();
    const statData = runtimeInfo.statData;
    if (!Object.keys(asObject(statData)).length) {
        panel.append(el('div', 'llm-warning', '没有检测到 stat_data；身份与历代人生仍会尝试从已确认的正文人物卡读取。'));
    }
    if (sync) {
        const hasBody = Boolean(currentImportedBody());
        sync.textContent = hasBody ? (runtimeInfo.appliedOperations ? '正文已追踪' : '已同步') : '等待人物卡';
        sync.dataset.state = hasBody ? 'synced' : 'empty';
        sync.title = runtimeInfo.appliedOperations ? `已从最新正文补全 ${runtimeInfo.appliedOperations} 项动态变化` : '';
    }
    capturePendingSnapshot(statData);
    if (tab === 'current') renderCurrent(panel, statData, runtimeInfo);
    if (tab === 'lives') await renderLives(panel, statData);
    if (tab === 'settings') renderSettings(panel);
}

function installCardButtons() {
    const ctx = context();
    if (!Array.isArray(ctx?.chat)) return;
    for (const message of document.querySelectorAll('#chat .mes[mesid], #chat .mes[data-message-id]')) {
        const messageIndex = Number(message.getAttribute('mesid') ?? message.dataset.messageId);
        if (!Number.isFinite(messageIndex) || message.querySelector('.llm-card-actions')) continue;
        const cards = extractCarrierCards(ctx.chat[messageIndex]?.mes);
        const card = cards.at(-1);
        const profile = parseCarrierCard(card);
        if (!profile.姓名) continue;
        const actions = el('div', 'llm-actions llm-card-actions');
        actions.append(
            createButton('导入为当前身体', () => importSelectedCard({ messageIndex, card, profile }, 'sync')),
            createButton('确认换身并导入', () => importSelectedCard({ messageIndex, card, profile }, 'confirm'), 'menu_button llm-primary'),
        );
        (message.querySelector('.mes_text') || message.querySelector('.mes_block') || message).append(actions);
    }
}

function scheduleRefresh(reason = '正文楼层变化') {
    const result = reconcileConversation({ reason });
    if (result.cleared) notify('info', '相关人物卡或确认楼层已不存在，插件已撤销旧身体、历代记录和 AI 注入');
    refreshTimers.forEach(clearTimeout);
    refreshTimers = [0, 250, 900, 1800].map(delay => setTimeout(() => {
        render().catch(error => console.error('[历代人生管理器] 渲染失败', error));
        updateCurrentBodyPrompt().catch(error => console.error('[历代人生管理器] 注入失败', error));
        installCardButtons();
    }, delay));
}

function registerEvents() {
    const ctx = context();
    if (!ctx?.eventSource || !ctx?.eventTypes) return;
    for (const type of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], () => scheduleRefresh(type));
    }
    for (const type of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS']) {
        if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], updateCurrentBodyPrompt);
    }
}

export async function init() {
    if (initialized) return;
    const ctx = context();
    if (!ctx) return console.error('[历代人生管理器] SillyTavern 公共接口不可用');
    const mount = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!mount) return console.error('[历代人生管理器] 找不到扩展设置面板');
    initialized = true;
    settings();
    if (!document.getElementById('legacy-life-manager-root')) mount.append(createPanel());
    registerEvents();
    await render();
    installCardButtons();
    await updateCurrentBodyPrompt();
    const observer = new MutationObserver(() => installCardButtons());
    const chat = document.querySelector('#chat');
    if (chat) observer.observe(chat, { childList: true, subtree: true });
    console.log('[历代人生管理器] v0.5.0 已加载');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(), { once: true });
else init();
