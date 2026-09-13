import {
    ARCHIVE_PREFIX,
    archiveKeywords,
    archiveTitle,
    asObject,
    currentBodySummary,
    detectCarryover,
    extractCharacterCard,
    getPath,
    normalizeEntries,
    normalizeStage,
    safeFilename,
    supplementalPlayerProfile,
    upsertArchive,
} from './core.js';
import { createMvuAdapter } from './mvu-adapter.js';

const EXTENSION_KEY = 'legacy_life_manager';
const METADATA_KEY = 'legacy_life_manager';
const DEFAULT_SETTINGS = Object.freeze({ worldBookName: '', dataVersion: 1 });
let initialized = false;
let selectedMessageIndex = '';

function context() {
    return globalThis.SillyTavern?.getContext?.();
}

function settings() {
    const ctx = context();
    if (!ctx) return { ...DEFAULT_SETTINGS };
    ctx.extensionSettings[EXTENSION_KEY] ??= { ...DEFAULT_SETTINGS };
    return ctx.extensionSettings[EXTENSION_KEY];
}

function chatData(create = true) {
    const ctx = context();
    if (!ctx?.chatMetadata) return null;
    if (!ctx.chatMetadata[METADATA_KEY] && create) {
        ctx.chatMetadata[METADATA_KEY] = { version: 1, pendingSnapshot: null, backups: [] };
    }
    return ctx.chatMetadata[METADATA_KEY] || null;
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

function assistantMessages() {
    return (context()?.chat || [])
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message && !message.is_user && !message.is_system && String(message.mes || '').trim())
        .slice(-30)
        .reverse();
}

function selectedCard() {
    const index = Number(selectedMessageIndex);
    const message = context()?.chat?.[index];
    return message ? extractCharacterCard(message.mes) : '';
}

async function importCandidate() {
    const card = selectedCard();
    if (!card) {
        notify('warning', '本条回复中没有识别到人物卡；请选择包含人物卡的 AI 回复');
        return;
    }
    const statData = readStatData();
    const state = getPath(statData, '主角.换身状态', {});
    if (state?.当前身体死亡已确认 !== true) {
        notify('warning', '当前身体尚未确认死亡，不能把人物卡写入换身候选');
        return;
    }
    if (!globalThis.confirm('只把所选人物卡写入“待确认人物卡”，不会立即换身。继续吗？')) return;
    await writeMessagePath('stat_data.主角.换身状态.待确认人物卡', card);
    await writeMessagePath('stat_data.主角.换身状态.阶段', '等待确认');
    notify('success', '候选人物卡已写入；仍需你发送精确口令“确认换身”');
    render();
}

function prepareConfirmation() {
    const statData = readStatData();
    const state = getPath(statData, '主角.换身状态', {});
    if (state?.阶段 !== '等待确认' || state?.当前身体死亡已确认 !== true || !state?.待确认人物卡) {
        notify('warning', '尚未满足换身条件：需要真正死亡、阶段为“等待确认”且候选人物卡非空');
        return;
    }
    const textarea = document.querySelector('#send_textarea, textarea[placeholder*="消息"], textarea[placeholder*="message"]');
    if (!textarea) {
        notify('warning', '找不到聊天输入框，请手动发送：确认换身');
        return;
    }
    textarea.value = '确认换身';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    notify('info', '已填入“确认换身”，请核对后由你亲自发送');
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
    const statData = readStatData();
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
    const statData = readStatData();
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

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function renderCurrent(panel, statData) {
    const summary = currentBodySummary(statData, supplementalPlayerProfile(context()?.chat || [], statData));
    const main = summary.main;
    const header = el('div', 'llm-card-head');
    header.append(el('div', 'llm-avatar', '◈'), el('div', '', summary.name));
    const grid = el('div', 'llm-summary-grid');
    for (const [label, value] of summary.rows) {
        const item = el('div', 'llm-summary-item');
        item.append(el('span', '', label), el('strong', '', value));
        grid.append(item);
    }
    const details = document.createElement('details');
    details.append(el('summary', '', '查看完整 stat_data.主角'), el('pre', 'llm-json', pretty(main)));
    const warnings = carryoverWarnings(statData);
    panel.append(header, grid);
    if (summary.usedSupplementalProfile) {
        panel.append(el('div', 'llm-muted', '人物资料来自当前聊天的人物卡；地点、生命值与状态来自 stat_data。'));
    }
    if (warnings.length) {
        const warning = el('div', 'llm-warning');
        warning.append(el('strong', '', '继承检查提醒'), ...warnings.map(item => el('div', '', `• ${item}`)));
        panel.append(warning);
    }
    panel.append(details);
}

function renderSwitch(panel, statData) {
    const state = getPath(statData, '主角.换身状态', {});
    const badge = el('div', `llm-stage stage-${normalizeStage(state?.阶段)}`, `当前阶段：${normalizeStage(state?.阶段)}`);
    const facts = el('div', 'llm-summary-grid');
    for (const [label, value] of [
        ['世代编号', state?.当前世代编号], ['死亡已确认', state?.当前身体死亡已确认 ? '是' : '否'],
        ['归档状态', state?.归档写入状态], ['死亡信息', state?.当前身体死亡信息],
    ]) {
        const item = el('div', 'llm-summary-item');
        item.append(el('span', '', label), el('strong', '', value ?? '—'));
        facts.append(item);
    }
    const select = document.createElement('select');
    select.className = 'text_pole';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择含人物卡的 AI 回复…';
    select.append(placeholder);
    for (const { message, index } of assistantMessages()) {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `#${index} ${String(message.mes).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 72)}`;
        option.selected = String(index) === selectedMessageIndex;
        select.append(option);
    }
    select.addEventListener('change', () => { selectedMessageIndex = select.value; render(); });
    const preview = el('pre', 'llm-json llm-card-preview', selectedCard() || '尚未选择，或所选回复未识别到人物卡。');
    const actions = el('div', 'llm-actions');
    actions.append(
        createButton('导入为待确认人物卡', importCandidate),
        createButton('填入“确认换身”', prepareConfirmation),
        createButton('归档上一世到世界书', archivePendingLife, 'menu_button llm-primary'),
    );
    panel.append(badge, facts, el('label', 'llm-label', '从正文选择候选人物卡'), select, preview, actions);
}

async function renderLives(panel, statData) {
    const name = currentWorldBookName();
    const book = name ? await context()?.loadWorldInfo?.(name) : null;
    const entries = book ? Object.values(normalizeEntries(book)).filter(entry => String(entry?.comment || '').startsWith(ARCHIVE_PREFIX)) : [];
    const search = document.createElement('input');
    search.className = 'text_pole';
    search.placeholder = '搜索姓名、人物、地点或事件';
    const list = el('div', 'llm-life-list');
    const draw = () => {
        const needle = search.value.trim().toLowerCase();
        list.replaceChildren();
        const visible = entries.filter(entry => !needle || `${entry.comment}\n${entry.content}\n${(entry.key || []).join(' ')}`.toLowerCase().includes(needle));
        if (!visible.length) list.append(el('div', 'llm-empty', name ? '没有匹配的历代人生词条。' : '请先在设置中选择世界书。'));
        for (const entry of visible) {
            const details = document.createElement('details');
            details.className = 'llm-life';
            details.append(el('summary', '', String(entry.comment).replace(ARCHIVE_PREFIX, '')), el('pre', 'llm-life-content', entry.content || ''));
            list.append(details);
        }
    };
    search.addEventListener('input', draw);
    panel.append(el('div', 'llm-muted', name ? `世界书：${name}` : '尚未选择世界书'), search, list);
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
    const safety = el('div', 'llm-safety');
    safety.textContent = '插件只读取 stat_data；人物卡须手动选择；确认口令只填入不发送；归档只追加到已有世界书；同名异文会停止。';
    panel.append(label, select, active, safety, createButton('导出完整备份', exportBackup, 'menu_button llm-primary'));
}

function createPanel() {
    const root = el('div', 'extension_container', null);
    root.id = 'legacy-life-manager-root';
    const drawer = el('div', 'inline-drawer');
    const header = el('div', 'inline-drawer-toggle inline-drawer-header');
    header.append(el('b', '', '🗂️ 历代人生管理器'), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const body = el('div', 'inline-drawer-content');
    const tabs = el('div', 'llm-tabs');
    for (const [id, label] of [['current', '当前身体'], ['switch', '换身候选'], ['lives', '历代人生'], ['settings', '设置与备份']]) {
        const button = createButton(label, () => activateTab(id), 'menu_button llm-tab');
        button.dataset.tab = id;
        tabs.append(button);
    }
    const content = el('div', 'llm-panel');
    content.dataset.activeTab = 'current';
    body.append(el('p', 'llm-help', '查看当前身体、管理换身候选，并把待归档前世安全写入同一本世界书。'), tabs, content);
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
    const tab = panel.dataset.activeTab || 'current';
    for (const button of root.querySelectorAll('.llm-tab')) button.classList.toggle('active', button.dataset.tab === tab);
    panel.replaceChildren();
    if (!activeChat()) {
        panel.append(el('div', 'llm-empty', '请先打开一个角色聊天或群聊。'));
        return;
    }
    const statData = readStatData();
    if (!Object.keys(asObject(statData)).length) {
        panel.append(el('div', 'llm-warning', '没有检测到 stat_data。请确认当前聊天已产生 MVU 变量，并启用酒馆助手/MVU。'));
        if (tab !== 'settings') return;
    }
    capturePendingSnapshot(statData);
    if (tab === 'current') renderCurrent(panel, statData);
    if (tab === 'switch') renderSwitch(panel, statData);
    if (tab === 'lives') await renderLives(panel, statData);
    if (tab === 'settings') renderSettings(panel);
}

function registerEvents() {
    const ctx = context();
    if (!ctx?.eventSource || !ctx?.eventTypes) return;
    const refresh = () => render().catch(error => console.error('[历代人生管理器] 渲染失败', error));
    for (const type of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], refresh);
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
    console.log('[历代人生管理器] v0.1.2 已加载');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(), { once: true });
else init();
