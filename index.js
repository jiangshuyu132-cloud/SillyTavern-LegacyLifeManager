import { archiveGate, specialGeneration, messageStat, protocolTimeline } from './strict-protocol.js';
import {
    ARCHIVE_PREFIX,
    archiveKeywords,
    archiveTitle,
    asObject,
    buildLifeRecord,
    carrierBackgroundStory,
    carrierCardsFromMessage,
    carrierGeneration,
    carrierCardSections,
    carrierCardText,
    carrierRecordKey,
    carrierProfileMatchesCurrentState,
    compactLifeIndex,
    confirmedCarrierProfile,
    confirmedCarrierRecords,
    conversationLedgerTruth,
    crossLifeMoneyTransition,
    currentBehaviorProfile,
    currentBodySummary,
    detectCarryover,
    getPath,
    inferredLivesFromCarrierCard,
    isSafeRuntimePatch,
    lifeHistorySummaries,
    liveBodyState,
    messageTextVariants,
    mergeLifeRecords,
    normalizedMoney,
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
const DEFAULT_SETTINGS = Object.freeze({ worldBookName: '', dataVersion: 12, injectionMode: 'strict', floatingPosition: null });
const RUNTIME_TOKEN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let initialized = false;
let archiveInFlight = false;
let moneyInheritanceInFlight = false;
let refreshTimers = [];
const sharedRuntime = globalThis.__legacyLifeManagerRuntime ??= { notification: { key: '', at: 0 }, token: '' };
let lastPromptText = '';
let lastPromptStats = { characters: 0, tokenLow: 0, tokenHigh: 0, requestedMode: 'strict', effectiveMode: '等待当前身体', injected: false, sourceFloor: 0, appliedOperations: 0 };
let floatingPanelHome = null;
let floatingPanelPlaceholder = null;

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
    if (Number(current.dataVersion || 0) < 6) {
        current.dataVersion = 6;
        ctx.saveSettingsDebounced?.();
    }
    if (Number(current.dataVersion || 0) < 7) {
        if (current.injectionMode !== 'off') current.injectionMode = 'strict';
        current.dataVersion = 7;
        ctx.saveSettingsDebounced?.();
    }
    if (Number(current.dataVersion || 0) < 9) {
        current.dataVersion = 9;
        ctx.saveSettingsDebounced?.();
    }
    if (Number(current.dataVersion || 0) < 10) {
        current.dataVersion = 10;
        ctx.saveSettingsDebounced?.();
    }
    if (Number(current.dataVersion || 0) < 11) {
        current.dataVersion = 11;
        ctx.saveSettingsDebounced?.();
    }
    if (Number(current.dataVersion || 0) < 12) {
        current.floatingPosition ??= null;
        current.dataVersion = 12;
        ctx.saveSettingsDebounced?.();
    }
    if (!['strict', 'smart', 'full', 'compact', 'off'].includes(current.injectionMode)) current.injectionMode = 'strict';
    return current;
}

function chatData(create = true) {
    const ctx = context();
    if (!ctx?.chatMetadata) return null;
    if (!ctx.chatMetadata[METADATA_KEY] && create) {
        ctx.chatMetadata[METADATA_KEY] = { version: 12, currentBody: null, lives: [], suppressedRecordKeys: [], pendingSnapshot: null, backups: [], portraits: {}, moneyInheritance: {}, trustedCarrierRecordKeys: [] };
    }
    const data = ctx.chatMetadata[METADATA_KEY] || null;
    if (data) {
        const previousVersion = Number(data.version || 0);
        if (data.protocolVersion !== 'dusk.1') {
            // Permanent one-time copy: stricter proof must not destroy a legacy ledger.
            data.legacyMigrationBackup ??= {at:new Date().toISOString(),data:structuredClone(data)};
            data.protocolVersion='dusk.1';
            ctx.saveMetadataDebounced?.();
        }
        data.version = 12;
        data.lives ??= [];
        data.currentBody ??= null;
        data.suppressedRecordKeys ??= [];
        data.backups ??= [];
        data.portraits ??= {};
        data.moneyInheritance ??= {};
        data.trustedCarrierRecordKeys ??= [];
        const previousTrustedKeys = JSON.stringify(data.trustedCarrierRecordKeys);
        // Keep verified record keys outside the rolling backup list. World-book
        // backups share the old list and can evict a body backup, but must not
        // make an already confirmed identity disappear after an update.
        const trustedKeys = new Set(data.trustedCarrierRecordKeys.filter(Boolean));
        const legacyBody = data.legacyMigrationBackup?.data?.currentBody;
        const bodies = [data.currentBody, legacyBody, ...(data.backups || []).map(item => item?.currentBody)];
        for (const body of bodies) {
            if (body?.confirmed === true && body?.sourceType === 'conversation' && body?.sourceRecordKey) {
                trustedKeys.add(body.sourceRecordKey);
            }
        }
        for (const [recordKey, receipt] of Object.entries(data.moneyInheritance)) {
            if (recordKey && receipt?.status === 'applied') trustedKeys.add(recordKey);
        }
        data.trustedCarrierRecordKeys = [...trustedKeys].slice(-50);
        if (previousVersion < 12 || previousTrustedKeys !== JSON.stringify(data.trustedCarrierRecordKeys)) {
            ctx.saveMetadataDebounced?.();
        }
    }
    return data;
}

function notify(level, message) {
    const key = `${level}:${message}`;
    const now = Date.now();
    if (sharedRuntime.notification.key === key && now - sharedRuntime.notification.at < 5000) return;
    sharedRuntime.notification = { key, at: now };
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

function protocolMessages() {
    return (context()?.chat || []).map((message,index) => {
        if (messageStat(message)) return message;
        const stat=mvu.readStatDataAt(index);
        return stat ? {...message, stat_data:stat} : message;
    });
}

function readEffectiveStatData() {
    const messages = protocolMessages();
    // Persisted snapshots remain the only proof for identity and lifecycle.
    // Runtime-only patches after the newest snapshot may update this turn's
    // injuries, clothing, status and other ordinary state, but cannot switch
    // the current body or alter the confirmation protocol.
    const timeline = protocolTimeline(messages, { storedOnly: true });
    let storedMessageIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messageStat(messages[index])) {
            storedMessageIndex = index;
            break;
        }
    }
    const stored = timeline.at(-1) || readStatData() || {};
    const replayed = replayDynamicStatData(stored, messages, {
        startIndex: storedMessageIndex + 1,
        allowOperation: isSafeRuntimePatch,
    });
    return {
        ...replayed,
        storedMessageIndex,
        sourceMessageIndex: replayed.lastMessageIndex >= 0 ? replayed.lastMessageIndex : storedMessageIndex,
    };
}

function mergeLives(data, incoming) {
    data.lives = mergeLifeRecords(data.lives, incoming);
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

function trustedCarrierOptions(data = chatData(false)) {
    const keys = [...(data?.trustedCarrierRecordKeys || [])];
    const bodies = [
        data?.currentBody,
        data?.legacyMigrationBackup?.data?.currentBody,
        ...(data?.backups || []).map(item => item?.currentBody),
    ];
    for (const body of bodies) {
        if (body?.confirmed === true && body?.sourceType === 'conversation' && body?.sourceRecordKey) {
            keys.push(body.sourceRecordKey);
        }
    }
    for (const [recordKey, receipt] of Object.entries(data?.moneyInheritance || {})) {
        if (recordKey && receipt?.status === 'applied') keys.push(recordKey);
    }
    return {
        trustedRecordKeys: [...new Set(keys)],
        currentState: readStatData() || {},
    };
}

function rememberTrustedCarrierRecord(data, record, messages) {
    const recordKey = carrierRecordKey(record, messages);
    if (!recordKey) return false;
    data.trustedCarrierRecordKeys ??= [];
    if (data.trustedCarrierRecordKeys.includes(recordKey)) return false;
    data.trustedCarrierRecordKeys.push(recordKey);
    data.trustedCarrierRecordKeys = data.trustedCarrierRecordKeys.slice(-50);
    return true;
}

function bodyFromConfirmedRecord(record, messages, lives, previous = null) {
    const sourceRecordKey = carrierRecordKey(record, messages);
    return {
        profile: record.profile,
        rawCard: record.card,
        text: carrierCardText(record.card),
        sections: carrierCardSections(record.card),
        backgroundStory: carrierBackgroundStory(record.card),
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

function recoverableSavedLedger(data, currentState) {
    const candidates = [
        ...(data?.backups || []).slice().reverse().map(item => ({ body: item?.currentBody, lives: item?.lives || [] })),
        { body: data?.legacyMigrationBackup?.data?.currentBody, lives: data?.legacyMigrationBackup?.data?.lives || [] },
    ];
    for (const candidate of candidates) {
        const body = candidate.body;
        if (!body?.rawCard || !Object.keys(asObject(body.profile)).length) continue;
        if (body.confirmed === false || (body.sourceType && body.sourceType !== 'conversation')) continue;
        if (!carrierProfileMatchesCurrentState(currentState, body.profile, 2)) continue;
        return {
            body: structuredClone(body),
            lives: structuredClone(candidate.lives || []),
        };
    }
    return null;
}

function reconcileConversation({ force = false, reason = '自动对账' } = {}) {
    const data = chatData();
    const messages = protocolMessages();
    const truth = conversationLedgerTruth(messages, force ? [] : data.suppressedRecordKeys, trustedCarrierOptions(data));
    const records = truth.records;
    const record = truth.currentRecord;
    const previous = data.currentBody;
    let nextLives = truth.lives;
    let nextBody = record ? bodyFromConfirmedRecord(record, messages, nextLives, previous) : null;
    let savedRecovery = null;
    if (!record && !force) {
        // A normal page refresh is not proof that the source was deleted.
        // Long imported chats can expose only the active swipe or omit older
        // message bodies while they are still loading. Never destroy a body
        // already confirmed by this plugin merely because one scan is empty.
        if (previous?.rawCard && previous?.profile) {
            nextBody = previous;
            nextLives = data.lives || [];
        } else {
            savedRecovery = recoverableSavedLedger(data, trustedCarrierOptions(data).currentState);
            if (savedRecovery) {
                nextBody = savedRecovery.body;
                nextLives = mergeLifeRecords(savedRecovery.lives, data.lives || []);
            }
        }
    }
    const remembered = record ? rememberTrustedCarrierRecord(data, record, messages) : false;

    const previousKey = previous?.sourceRecordKey || previous?.sourceCardFingerprint
        || (previous?.rawCard ? stableTextFingerprint(previous.rawCard) : '');
    const nextKey = nextBody?.sourceRecordKey || nextBody?.sourceCardFingerprint || '';
    const changed = previousKey !== nextKey || JSON.stringify(data.lives || []) !== JSON.stringify(nextLives);
    if (!changed) {
        if (remembered) saveChatMetadata();
        return { changed: false, cleared: false, restored: false };
    }

    backupLedger(data, reason);
    data.currentBody = nextBody;
    data.lives = nextLives;
    if (savedRecovery) {
        data.lastTrustedRecovery = {
            at: new Date().toISOString(),
            recordKey: nextBody?.sourceRecordKey || nextBody?.sourceCardFingerprint || '',
            name: nextBody?.profile?.姓名 || '',
            reason: '酒馆运行时暂未暴露旧人物卡正文；已用插件安全备份与当前身体的至少两个稳定字段交叉核对后恢复',
        };
    } else if (record?.recoveredFromTrustedBackup || record?.recoveredFromVerifiedLegacyChain) {
        const usedLegacyChain = record.recoveredFromVerifiedLegacyChain === true;
        data.lastTrustedRecovery = {
            at: new Date().toISOString(),
            recordKey: nextBody?.sourceRecordKey || '',
            name: nextBody?.profile?.姓名 || '',
            reason: usedLegacyChain
                ? '旧楼层快照与插件凭据均缺失，已用完整人物卡、精确确认口令、完整提交补丁及当前身体双字段一致性自动恢复并重建永久凭据'
                : '旧楼层缺少可见状态快照，已用完整人物卡、精确确认口令、提交补丁、可信记录与当前身体状态自动恢复',
        };
    }
    if (force) data.suppressedRecordKeys = [];
    saveChatMetadata();
    return { changed: true, cleared: Boolean(previous && !nextBody), restored: Boolean(nextBody), previous, current: nextBody };
}

function currentImportedBody() {
    return chatData(false)?.currentBody || null;
}

async function applyMoneyInheritance() {
    if (moneyInheritanceInFlight) return false;
    const data = chatData();
    const messages = protocolMessages();
    const record = conversationLedgerTruth(messages, data.suppressedRecordKeys, trustedCarrierOptions(data)).currentRecord;
    if (!record) return false;
    const key = carrierRecordKey(record, messages);
    if (!key || data.moneyInheritance?.[key]?.status === 'applied') return false;
    const transition = crossLifeMoneyTransition(messages, record);
    if (!transition) return false;

    moneyInheritanceInFlight = true;
    try {
        if (transition.needsRestore) {
            await mvu.writeMessagePath('stat_data.主角.金钱', transition.adjustedMoney);
            const verified = normalizedMoney(mvu.readStatData()?.主角?.金钱);
            if (!Object.is(verified, transition.adjustedMoney)) throw new Error('跨世金钱写入后回读不一致');
        }
        data.moneyInheritance[key] = {
            status: 'applied',
            inheritedMoney: transition.inheritedMoney,
            replacedBodyMoney: transition.committedMoney,
            adjustedMoney: transition.adjustedMoney,
            generation: carrierGeneration(record.card, 1),
            appliedAt: new Date().toISOString(),
        };
        saveChatMetadata();
        if (transition.needsRestore) notify('success', `已继承上一具身体的金钱：${transition.adjustedMoney.toLocaleString()}`);
        return transition.needsRestore;
    } finally {
        moneyInheritanceInFlight = false;
    }
}

function portraitKey(body = currentImportedBody()) {
    if (!body) return '';
    return body.sourceRecordKey || body.sourceCardFingerprint
        || `${Number(body.generation) || 1}:${String(body.profile?.姓名 || '当前身体')}`;
}

function currentPortrait(body = currentImportedBody()) {
    const key = portraitKey(body);
    return key ? chatData(false)?.portraits?.[key] || null : null;
}

async function compressPortrait(file) {
    if (!file || !/^image\/(?:png|jpe?g|webp|gif)$/i.test(file.type || '')) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
    if (file.size > 12 * 1024 * 1024) throw new Error('图片不能超过 12MB');
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.decoding = 'async';
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('无法读取这张图片'));
            image.src = url;
        });
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        if (!side) throw new Error('图片尺寸无效');
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const context2d = canvas.getContext('2d');
        if (!context2d) throw new Error('浏览器无法处理图片');
        const sx = Math.floor((image.naturalWidth - side) / 2);
        const sy = Math.floor((image.naturalHeight - side) / 2);
        context2d.drawImage(image, sx, sy, side, side, 0, 0, 512, 512);
        let dataUrl = canvas.toDataURL('image/webp', 0.84);
        if (dataUrl.length > 900000) {
            canvas.width = 384;
            canvas.height = 384;
            context2d.drawImage(image, sx, sy, side, side, 0, 0, 384, 384);
            dataUrl = canvas.toDataURL('image/webp', 0.72);
        }
        if (dataUrl.length > 900000) throw new Error('压缩后图片仍过大，请换一张较小的图片');
        return dataUrl;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function chooseCurrentPortrait() {
    const body = currentImportedBody();
    const key = portraitKey(body);
    if (!key) return notify('warning', '当前还没有已确认的身体，不能保存头像');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.addEventListener('change', async () => {
        try {
            const dataUrl = await compressPortrait(input.files?.[0]);
            const data = chatData();
            data.portraits[key] = {
                dataUrl,
                name: body.profile?.姓名 || '当前身体',
                generation: Number(body.generation) || 1,
                updatedAt: new Date().toISOString(),
            };
            const portraitEntries = Object.entries(data.portraits).sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')));
            data.portraits = Object.fromEntries(portraitEntries.slice(0, 20));
            saveChatMetadata();
            await render();
            notify('success', '当前身体头像已保存');
        } catch (error) {
            notify('error', error.message || '头像导入失败');
        }
    }, { once: true });
    input.click();
}

async function removeCurrentPortrait() {
    const key = portraitKey();
    const data = chatData();
    if (!key || !data.portraits?.[key]) return;
    delete data.portraits[key];
    saveChatMetadata();
    await render();
    notify('success', '当前身体头像已移除');
}

function dynamicContextText(statData, fullCarrier = false) {
    return JSON.stringify(liveBodyState(statData, { fullCarrier }), null, 2);
}

function buildCurrentBodyPrompt(body, statData, mode) {
    if (!body || mode === 'off') return { prompt: '', effectiveMode: body ? '已关闭' : '等待当前身体' };
    const special=specialGeneration(protocolMessages(),statData);
    const money = normalizedMoney(statData?.主角?.金钱);
    const moneyRule = `【跨世金钱｜唯一资源继承例外】\nstat_data.主角.金钱是连续主体跨世保留的余额${money == null ? '' : `，本次确认前余额为 ${money}`}。死亡、候选和确认换身不得用新身体初始现金覆盖、清零或重置它；换身只替换身体绑定资料。新身体原有现金仍属于其客观财产，但不改写这个跨世余额。该规则每次换身只结转一次，普通消费和收入仍按正文正常增减。`;
    if (special) {
        if (['等待换身','等待确认','确认交接或重复确认'].includes(special)) {
            return {prompt:`<legacy_life_money_continuity>\n${moneyRule}\n</legacy_life_money_continuity>`,effectiveMode:`仅金钱保护·${special}`};
        }
        return {prompt:'',effectiveMode:`暂停注入·${special}`};
    }
    if (body.profile?.姓名) {
        const liveName = String(statData?.主角?.载体档案?.姓名 || statData?.主角?.姓名 || '').trim();
        const nameConflicts = liveName && liveName !== String(body.profile.姓名).trim();
        const unnamedStateMatches = !liveName && carrierProfileMatchesCurrentState(statData, body.profile, 2);
        if (nameConflicts || (!liveName && !unnamedStateMatches)) return {prompt:'',effectiveMode:'等待MVU当前身体同步'};
    }
    const messages = protocolMessages();
    const profile = JSON.stringify(body.profile || {}, null, 2);
    const strict = mode === 'strict';
    const behavior = JSON.stringify(currentBehaviorProfile(body.rawCard || body.text, statData, { preferCard: strict }), null, 2);
    const firstSmartTurn = mode === 'smart' && smartInjectionUsesFullCard(body, messages);
    const useFullCard = strict || mode === 'full' || firstSmartTurn;
    const details = useFullCard ? body.text : profile;
    const detailTitle = useFullCard ? '完整当前身体档案' : '当前身体核心档案';
    const backgroundStory = String(body.backgroundStory || carrierBackgroundStory(body.rawCard || body.text) || '').trim();
    const backgroundSection = backgroundStory
        ? `\n\n【当前身体人生背景｜出生至接管年龄｜每轮有效】\n这是当前原主在接管前真实经历的人生连续史，用于约束其记忆、关系、知识来源、习惯、创伤、能力来源与当前处境。不得把它误当成前世经历，也不得用历代旧人格或旧技能补写空白。正文后来明确发生的新经历可以继续发展，但不得无故重写已经确认的出生与成长事实。\n${backgroundStory}`
        : '';
    const histories = (mode === 'smart' && !firstSmartTurn) || mode === 'compact'
        ? compactLifeIndex(mergeLifeRecords(chatData(false)?.lives || [], inferredLivesFromCarrierCard(body.rawCard)), 1200)
        : '';
    const historySection = histories
        ? `\n\n【历代经历压缩索引】\n以下只是历代重要经历记忆，不代表旧人格、感情、知识、技能或属性继承。\n${histories}`
        : '';
    const effectiveMode = strict ? '严格主档案·每轮完整'
        : mode === 'smart'
        ? (firstSmartTurn ? '智能·换身首轮完整' : '智能·日常精简')
        : mode === 'full' ? '完整' : '精简';
    const authorityRules = `【资料来源合并与优先级｜每轮强制执行】
- 必须同时读取本插件档案与正文已有的 <status_current_variables>/stat_data；“插件档案优先”不表示关闭、忽略或删除正文角色面板。
- 对姓名、种族、身份背景、从出生到接管年龄的人生背景、外貌、声音、气味、身体结构、卫生、长期疾病的完整表现、性格、记忆、认知、感情、习惯、知识语言及其它详细人物设定，本插件的已确认完整档案是主档案。同名正文变量若更短、更概括或缺字段，只能作为实时补充，不得缩写、抹除、降格或覆盖插件细节。
- 对世界时间、当前地点、生命/法力/体力、等级属性、金钱、物品数量、背包、装备、资产、任务、新闻、地图、人物是否在场、好感度、当前想法，以及正文中新发生并已写入变量的获得、消耗、损坏、治愈、移除、恶化等动态事实，以最新 stat_data 为准。
- 状态效果必须合并：stat_data 决定当前是否存在、层数、剩余时间与即时严重度；插件档案提供完整症状、身体表现、长期影响与叙事细节。简短状态条不得覆盖详细档案；变量明确治愈或移除后也不得因旧档案继续视为仍生效。正文新增而插件原卡没有的状态必须接受。
- 技能与人物关系同样合并：当前可用技能、数值、在场、好感度和即时想法以变量为准；插件档案中的能力背景、使用习惯、长期关系、记忆与感情提供详细语义。若出现无法按上述类型解决的真实冲突，明确指出冲突，不得默默选择较短文本。`;
    const prompt = `<legacy_life_current_body>\n这是现实Participant已经确认、由“历代人生管理器”保存并在本轮生成前重新合并的当前有效身体档案。它已经实际进入本轮 AI 上下文，不是只供插件界面显示的记录；也不是候选或前世。历代旧人格、旧感情、旧知识、旧语言、旧技能或旧属性不得回流；下方“当前有效动态覆盖”是截至本轮最新正文的执行值。\n\n【行动—人格协调规则｜每轮强制执行】\n- Participant输入决定“做什么”及最终选择；只要客观上可能，当前身体性格与恐惧不得否决、取消、偷换或强制判定该行动失败。\n- 当前身体的性格、价值观、感情、喜恶、愿望、恐惧、习惯、认知边界与思维方式决定“如何理解和执行”：注意力、风险评估、计划习惯、犹豫或决心、非意志性生理反应、语气与动作节奏都应一致。胆小者可以执行勇敢行动，但可在不撤销行动的前提下体现恐惧、谨慎准备、迟疑或身体紧张。\n- Recorder只能为实现Participant已明确内容，补充最低限度且不改变意图的当下体验与执行质感；不得新增目标、选择、台词、后续主动行动或替Participant改变决定。当前人格造成的是可信阻力与代价，不是行动否决权。\n- 思考与感知必须使用当前身体的词汇、知识边界、价值排序、认知习惯和身体经验；除已归档的重要经历记忆外，不得泄露历代旧人格或旧知识。\n\n【当前人格与思维方式｜每轮有效】\n${behavior}\n\n【${detailTitle}】\n${details}\n\n【当前有效动态覆盖｜本轮必须执行】\n以下内容已在生成前从最新 stat_data 及尚待 MVU 落盘的安全正文变量更新中重新计算。它不是历史备注：伤势、疾病是否仍生效、卫生、穿着、形态、改造、位置、资源和数值必须按这里的当前值续写；明确移除的状态不得从接管时原卡复活。\n${dynamicContextText(statData, mode === 'full')}${historySection}\n</legacy_life_current_body>`;
    const promptWithBackground = backgroundSection
        ? prompt.replace('\n\n【行动—人格协调规则', `${backgroundSection}\n\n【行动—人格协调规则`)
        : prompt;
    const authoritativePrompt = promptWithBackground
        .replace('<legacy_life_current_body>', '<legacy_life_current_body authority="confirmed-plugin-dossier-first">')
        .replace('\n\n【行动—人格协调规则', `\n\n${authorityRules}\n\n【行动—人格协调规则`);
    const guardedPrompt = authoritativePrompt.replace('\n\n【行动—人格协调规则', `\n\n${moneyRule}\n\n【行动—人格协调规则`);
    return { prompt: guardedPrompt, effectiveMode };
}

function recordPromptStats(prompt, requestedMode, effectiveMode, runtimeInfo = {}, injected = true) {
    const characters = prompt.length;
    lastPromptStats = {
        characters,
        tokenLow: characters ? Math.ceil(characters * 0.5) : 0,
        tokenHigh: characters,
        requestedMode,
        effectiveMode,
        injected: Boolean(injected && prompt),
        injectedAt: injected && prompt ? new Date().toISOString() : '',
        sourceFloor: Number(runtimeInfo?.sourceMessageIndex ?? -1) + 1,
        appliedOperations: Number(runtimeInfo?.appliedOperations || 0),
    };
    const meter = document.querySelector('#legacy-life-manager-root .llm-prompt-meter');
    if (meter) meter.textContent = promptStatsText();
}

function promptStatsText() {
    const stats = lastPromptStats;
    const source = stats.sourceFloor > 0 ? ` · 正文截至第 ${stats.sourceFloor} 楼` : '';
    const live = stats.appliedOperations ? ` · 含 ${stats.appliedOperations} 项待落盘变化` : '';
    const state = stats.injected ? '已写入 AI 上下文' : '当前未注入';
    return `${state}：${stats.effectiveMode} · ${stats.characters.toLocaleString()} 字符 · 约 ${stats.tokenLow.toLocaleString()}–${stats.tokenHigh.toLocaleString()} Token${source}${live}`;
}

async function updateCurrentBodyPrompt() {
    const ctx = context();
    if (typeof ctx?.setExtensionPrompt !== 'function') return;
    reconcileConversation({ reason: '生成前校验' });
    const runtimeInfo = readEffectiveStatData();
    const { statData } = runtimeInfo;
    const requestedMode = settings().injectionMode || 'strict';
    const built = buildCurrentBodyPrompt(currentImportedBody(), statData, requestedMode);
    await ctx.setExtensionPrompt(PROMPT_KEY, built.prompt, 1, 0, false, 0);
    lastPromptText = built.prompt;
    recordPromptStats(built.prompt, requestedMode, built.effectiveMode, runtimeInfo, true);
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
        throw new Error('后端世界书回读接口不可用；不以缓存代替写入验证，保留草稿');
    }
    const response = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
    });
    if (!response.ok) return false;
    const saved = await response.json();
    return Object.values(normalizeEntries(saved)).some(entry => (entry?.comment === `${ARCHIVE_PREFIX}${title}` || entry?.comment === title) && String(entry.content || '').trim() === content.trim());
}

async function archivePendingLife() {
    if (archiveInFlight) return notify('warning','正在归档，请等待当前操作完成');
    archiveInFlight=true;
    try {
        const ctx=context(), chatId=String(ctx?.chatId || ctx?.groupId || '');
        const messageIndex=latestMessageIndex(), anchor=ctx?.chat?.[messageIndex];
        const anchorText=String(anchor?.mes || '');
        const statData=mvu.readStatDataAt(messageIndex);
        const pending=archiveGate(statData);
        if (!pending) throw new Error('当前消息MVU未证实有效待归档人生；先等待变量写回，草稿不会丢弃');
        const records=confirmedCarrierRecords(protocolMessages(), trustedCarrierOptions());
        if (!records.some(record => carrierGeneration(record.card,0) === pending.generation+1)) throw new Error('缺少可核实的死亡、候选、精确确认及提交链，已停止归档');
        const {draft:content,title,generation}=pending;
        const name=currentWorldBookName();
        if (!name) throw new Error('请先选择本聊天已有的归档世界书');
        const assertContext=() => {
            const current=context();
            if (String(current?.chatId || current?.groupId || '')!==chatId || latestMessageIndex()!==messageIndex || String(current?.chat?.[messageIndex]?.mes || '')!==anchorText) throw new Error('归档期间聊天或楼层改变，停止清理草稿');
            const now=archiveGate(mvu.readStatDataAt(messageIndex));
            if (!now || now.draft!==content || now.generation!==generation) throw new Error('归档期间草稿改变，停止清理');
        };
        if (!globalThis.confirm(`将“${title}”写入已有世界书“${name}”？同名异文或同世异人将停止。`)) return;
        assertContext();
        const book=await ctx.loadWorldInfo?.(name);
        assertContext();
        if (!book) throw new Error('无法读取归档世界书');
        const result=upsertArchive(book,{title,content,keywords:archiveKeywords(title,content,statData)});
        if (result.status==='conflict') throw new Error('同名异文或同一世代已有其它人生，停止写入；请核对');
        if (result.status==='created') {
            if (typeof ctx.saveWorldInfo!=='function') throw new Error('世界书保存接口不可用');
            const data=chatData();data.backups??=[];
            data.backups.push({at:new Date().toISOString(),worldBookName:name,title,statData});data.backups=data.backups.slice(-5);saveChatMetadata();
            await ctx.saveWorldInfo(name,result.book,true);
        }
        assertContext();
        if (!await verifyWorldBook(name,title,content)) throw new Error('后端回读未验证成功，保留草稿');
        assertContext();
        await mvu.completeArchive({messageIndex,chatId,draft:content,generation,assertContext});
        const saved=mvu.readStatDataAt(messageIndex)?.主角?.换身状态;
        if (saved?.待归档人生词条!=='' || saved?.归档写入状态!=='已写入世界书') throw new Error('世界书已保存，但MVU清理未确认，请刷新核对后重试；不会新增重复词条');
        notify('success',result.status==='duplicate'?'相同词条已存在并回读核验；已清理对应草稿':`“${title}”已写入并回读核验`);
        await render();
    } finally { archiveInFlight=false; }
}

async function backupDigest(payload) {
    const text = JSON.stringify(payload);
    if (globalThis.crypto?.subtle && typeof TextEncoder === 'function') {
        const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return { algorithm: 'SHA-256', digest: [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('') };
    }
    return { algorithm: 'FNV1A', digest: stableTextFingerprint(text) };
}

async function verifyBackupEnvelope(envelope) {
    if (envelope?.format !== 'sillytavern-legacy-life-backup') throw new Error('这不是历代人生管理器备份文件');
    const version = Number(envelope?.version || 0);
    if (![1, 2].includes(version)) throw new Error(`不支持的备份版本：${version || '未知'}`);
    if (!asObject(envelope.pluginLedger).currentBody && !(asObject(envelope.pluginLedger).lives || []).length) {
        throw new Error('备份中没有当前身体或历代人生资料');
    }
    if (version >= 2) {
        const payload = { ...envelope };
        delete payload.integrity;
        const actual = await backupDigest(payload);
        if (!envelope.integrity?.digest || envelope.integrity.algorithm !== actual.algorithm || envelope.integrity.digest !== actual.digest) {
            throw new Error('备份完整性校验失败，文件可能被截断或修改');
        }
    }
    return version;
}

function normalizedImportedBody(value) {
    const body = asObject(value);
    const rawCard = String(body.rawCard || body.text || '').trim();
    const profile = asObject(body.profile);
    if (!rawCard || !String(profile.姓名 || '').trim()) return null;
    return {
        ...structuredClone(body),
        profile: structuredClone(profile),
        rawCard,
        text: String(body.text || carrierCardText(rawCard) || rawCard),
        sections: Array.isArray(body.sections) ? structuredClone(body.sections) : carrierCardSections(rawCard),
        backgroundStory: String(body.backgroundStory || carrierBackgroundStory(rawCard) || ''),
        confirmed: true,
        sourceType: 'conversation',
        sourceCardFingerprint: body.sourceCardFingerprint || stableTextFingerprint(rawCard),
    };
}

async function importBackupPayload(envelope, { ask = true } = {}) {
    const ctx = context();
    if (!activeChat()) throw new Error('请先打开需要恢复的聊天');
    const backupVersion = await verifyBackupEnvelope(envelope);
    const importedLedger = asObject(envelope.pluginLedger);
    const importedBody = normalizedImportedBody(importedLedger.currentBody);
    const importedLives = Array.isArray(importedLedger.lives) ? importedLedger.lives : [];
    const exportedAt = String(envelope.exportedAt || '时间未知');
    const sourceChat = String(envelope.chatId || '未知聊天');
    const targetChat = String(ctx.chatId || ctx.groupId || '');
    const crossChat = sourceChat && sourceChat !== '未知聊天' && sourceChat !== targetChat;
    const preview = `备份时间：${exportedAt}\n当前身体：${importedBody?.profile?.姓名 || '无'}\n历代人生：${importedLives.length} 条${crossChat ? '\n\n注意：备份来自另一个聊天。' : ''}\n\n导入前会自动保存当前插件账本；只有与当前实时身体至少两个稳定身份字段一致，才会恢复为当前身体并写入 AI 上下文。`;
    if (ask && !globalThis.confirm(`确认导入这份备份？\n\n${preview}`)) return { cancelled: true };

    const current = chatData();
    const before = structuredClone(current);
    const beforeSettings = structuredClone(settings());
    const liveState = readEffectiveStatData().statData || readStatData() || {};
    const canActivate = Boolean(importedBody && carrierProfileMatchesCurrentState(liveState, importedBody.profile, 2));
    const importedBackups = Array.isArray(importedLedger.backups) ? importedLedger.backups : [];
    const restorePoint = { at: new Date().toISOString(), reason: '导入外部备份前自动保存', currentBody: before.currentBody, lives: before.lives || [] };

    current.version = 12;
    current.protocolVersion = 'dusk.1';
    current.lives = mergeLifeRecords(current.lives || [], importedLives);
    current.backups = [...(current.backups || []), restorePoint, ...structuredClone(importedBackups)].slice(-12);
    if (importedBody && !canActivate) current.backups.push({ at: new Date().toISOString(), reason: '已导入但未通过当前身体核对', currentBody: importedBody, lives: structuredClone(importedLives) });
    current.backups = current.backups.slice(-12);
    current.portraits = { ...asObject(importedLedger.portraits), ...asObject(current.portraits) };
    current.moneyInheritance = { ...asObject(importedLedger.moneyInheritance), ...asObject(current.moneyInheritance) };
    current.trustedCarrierRecordKeys = [...new Set([
        ...(Array.isArray(importedLedger.trustedCarrierRecordKeys) ? importedLedger.trustedCarrierRecordKeys : []),
        ...(Array.isArray(current.trustedCarrierRecordKeys) ? current.trustedCarrierRecordKeys : []),
        importedBody?.sourceRecordKey,
    ].filter(Boolean))].slice(-100);
    current.pendingSnapshot ??= structuredClone(importedLedger.pendingSnapshot || null);
    current.legacyMigrationBackup ??= structuredClone(importedLedger.legacyMigrationBackup || null);
    current.lastExternalImport = { at: new Date().toISOString(), exportedAt, sourceChat, backupVersion, activated: canActivate };
    if (canActivate) current.currentBody = importedBody;
    saveChatMetadata();

    if (!canActivate) {
        await render();
        notify('warning', `备份已安全保存，但未替换当前身体：实时姓名、种族或职业不足两项一致。资料可在插件备份中保留。`);
        return { imported: true, activated: false };
    }

    const currentSettings = settings();
    const importedSettings = asObject(envelope.pluginSettings);
    const importedPosition = asObject(importedSettings.floatingPosition);
    if (Number.isFinite(Number(importedPosition.xRatio)) && Number.isFinite(Number(importedPosition.yRatio))) {
        currentSettings.floatingPosition = {
            xRatio: Math.min(1, Math.max(0, Number(importedPosition.xRatio))),
            yRatio: Math.min(1, Math.max(0, Number(importedPosition.yRatio))),
        };
    }
    const importedBook = String(importedSettings.worldBookName || '').trim();
    if (importedBook && (ctx.getWorldInfoNames?.() || []).includes(importedBook)) currentSettings.worldBookName = importedBook;
    currentSettings.injectionMode = 'strict';
    saveSettings();
    const launcher = document.getElementById('legacy-life-manager-floating');
    if (launcher) forceFloatingLauncherVisible(launcher);
    try {
        if (typeof ctx.setExtensionPrompt !== 'function') throw new Error('酒馆没有提供 AI 上下文注入接口');
        await updateCurrentBodyPrompt();
        const bodyName = String(importedBody.profile?.姓名 || '');
        const injected = lastPromptText.includes('<legacy_life_current_body')
            && lastPromptText.includes(bodyName)
            && lastPromptText.includes('authority="confirmed-plugin-dossier-first"');
        if (!injected) throw new Error('导入后人物档案未通过 AI 上下文回读验证');
        current.aiInjectionReceipt = {
            at: new Date().toISOString(),
            promptKey: PROMPT_KEY,
            bodyName,
            promptFingerprint: stableTextFingerprint(lastPromptText),
            characters: lastPromptText.length,
            mode: 'strict',
            verified: true,
        };
        saveChatMetadata();
    } catch (error) {
        ctx.chatMetadata[METADATA_KEY] = before;
        ctx.extensionSettings[EXTENSION_KEY] = beforeSettings;
        saveChatMetadata();
        saveSettings();
        await updateCurrentBodyPrompt().catch(() => {});
        throw new Error(`导入已回滚：${error.message}`);
    }
    await render();
    notify('success', `已恢复“${importedBody.profile.姓名}”，并验证完整人物档案已写入 AI 上下文`);
    return { imported: true, activated: true, name: importedBody.profile.姓名 };
}

async function chooseBackupImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
        try {
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 40 * 1024 * 1024) throw new Error('备份文件超过 40MB，已停止读取');
            await importBackupPayload(JSON.parse(await file.text()));
        } catch (error) {
            notify('error', error.message || '备份导入失败');
        }
    }, { once: true });
    input.click();
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
        textVariants: messageTextVariants(message),
        sendDate: message?.send_date || null,
    }));
    const payload = {
        format: 'sillytavern-legacy-life-backup', version: 2, exportedAt: new Date().toISOString(),
        chatId: ctx?.chatId || ctx?.groupId || '', statData, worldBookName: name,
        pluginSettings: {
            worldBookName: String(settings().worldBookName || ''),
            injectionMode: String(settings().injectionMode || 'strict'),
            floatingPosition: structuredClone(settings().floatingPosition || null),
        },
        pluginLedger: structuredClone(chatData(false)),
        archiveEntries: book ? Object.values(normalizeEntries(book)).filter(entry => String(entry?.comment || '').startsWith(ARCHIVE_PREFIX)) : [],
        transcript,
    };
    const integrity = await backupDigest(payload);
    downloadJson(`历代人生备份-${Date.now()}.json`, { ...payload, integrity });
    notify('success', '已导出带完整性校验的当前身体、历代词条、头像和聊天原文');
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
    for (const [messageIndex, message] of (protocolMessages()).entries()) {
        if (!message || message.is_user || message.is_system) continue;
        const cards = carrierCardsFromMessage(message);
        for (const [cardIndex, card] of cards.entries()) {
            const profile = parseCarrierCard(card);
            if (profile.姓名) result.push({ messageIndex, cardIndex, card, profile });
        }
    }
    return result;
}

function importSelectedCard(record, mode) {
    if (!record) return notify('warning','没有选择人物卡');
    const messages=protocolMessages();
    const valid=confirmedCarrierRecords(messages, trustedCarrierOptions()).find(item => item.cardIndex===record.messageIndex && stableTextFingerprint(item.card)===stableTextFingerprint(record.card));
    if (!valid) return notify('warning','这仍是候选或提交链不完整。请在有效死亡和待确认状态下亲自发送精确口令“确认换身”，等待MVU提交后再同步。按钮不会替你确认。');
    reconcileConversation({force:true,reason:'同步已确认档案'});
    updateCurrentBodyPrompt();render();
    notify('success','已按有效确认链重新同步；未发出口令、未增加世代');
}

async function rebuildFromCurrentChat() {
    if (!globalThis.confirm('根据当前仍然存在的正文楼层，重新建立当前身体和历代人生？\n\n已删除楼层产生的记录会从插件中撤销，但不会删除已经写入世界书的词条。')) return;
    const result = reconcileConversation({ force: true, reason: '手动从当前正文重建' });
    await applyMoneyInheritance();
    await updateCurrentBodyPrompt();
    await render();
    if (result.current) notify('success', `已按当前正文重建：${result.current.profile?.姓名 || '当前身体'}`);
    else notify('info', '当前正文没有有效的已确认换身记录；已撤销孤立身体和历代记录');
}

async function clearCurrentChatLedger() {
    if (!globalThis.confirm('清空本聊天由插件保存的当前身体、历代人生和 AI 注入？\n\n现有确认楼层会暂时忽略；以后新产生的确认记录仍可自动识别。世界书内容不会被删除。')) return;
    const data = chatData();
    const messages = protocolMessages();
    backupLedger(data, '手动清空本聊天插件记录');
    data.suppressedRecordKeys = confirmedCarrierRecords(messages, trustedCarrierOptions(data)).map(record => carrierRecordKey(record, messages));
    data.currentBody = null;
    data.lives = [];
    saveChatMetadata();
    await updateCurrentBodyPrompt();
    await render();
    notify('success', '已清空本聊天的插件记录和 AI 当前身体注入');
}

function renderFullBody(panel, body) {
    if (!body?.text) return;
    const heading = el('h3', 'llm-section-title', '当前有效身体档案（每轮发送给 AI）');
    const intro = el('div', 'llm-muted', '下列折叠项保留接管时的详细基础设定；上方“当前有效动态覆盖”会随正文更新并在同一轮提示中覆盖旧伤势、疾病状态、卫生、穿着、形态和改造。界面显示与 AI 实际接收使用同一份合并数据。');
    const sections = el('div', 'llm-sections');
    for (const section of body.sections || carrierCardSections(body.rawCard)) {
        if (/^(?:人生背景|背景故事|生平经历|成长经历)$/.test(String(section.title || '').trim())) continue;
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

function renderBackgroundStory(panel, body) {
    if (!body) return;
    const story = String(body.backgroundStory || carrierBackgroundStory(body.rawCard || body.text) || '').trim();
    panel.append(el('h3', 'llm-section-title', '当前身体人生背景（每轮发送给 AI）'));
    if (!story) {
        const empty = el('section', 'llm-background-empty');
        empty.append(
            el('strong', '', '本人物卡未提供人生背景'),
            el('div', '', '当前这具身体的原始人物卡中没有“人生背景/背景故事/生平经历”板块，因此插件不能凭空补写。导入新版世界书后，新生成的下一具身体会包含从出生到接管年龄的完整背景，并在每轮发送给 AI。'),
        );
        panel.append(empty);
        return;
    }
    const details = document.createElement('details');
    details.className = 'llm-background-story';
    details.append(
        el('summary', '', '查看从出生到接管年龄的完整背景'),
        el('div', 'llm-background-content', story),
    );
    panel.append(details);
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
    const wanted = /伤|病|健康|外貌|身体|体型|皮肤|四肢|器官|结构|生理|变异|改造|形态|植入|义体|血脉|特征|疤痕|气味|卫生|体毛|发色|瞳色|身高|体重|尺寸|标记|烙印|诅咒|祝福|穿着|衣着|足部|脚部/;
    for (const [key, value] of Object.entries(carrier)) {
        if (wanted.test(key) && runtimeValueText(value)) changes.push([key, value]);
    }
    for (const [key, value] of Object.entries(main)) {
        if (key !== '载体档案' && key !== '状态效果' && wanted.test(key) && runtimeValueText(value)) changes.push([key, value]);
    }
    if (!effects.length && !changes.length && !runtimeInfo.appliedOperations) return;

    panel.append(el('h3', 'llm-section-title', '当前有效动态覆盖（已发送给 AI）'));
    const sourceFloor = Number(runtimeInfo?.sourceMessageIndex ?? -1) + 1;
    const note = runtimeInfo.appliedOperations
        ? `已读取到第 ${sourceFloor} 楼，并从最新正文变量更新中提前补全 ${runtimeInfo.appliedOperations} 项尚待 MVU 落盘的安全变化；这些内容已经加入本轮 AI 上下文。`
        : `已读取到第 ${sourceFloor} 楼的最新变量快照；伤势、状态、变异、改造、形态、卫生和穿着会随正文更新并加入 AI 上下文。`;
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
    const messages = protocolMessages();
    const importedBody = currentImportedBody();
    const confirmedProfile = confirmedCarrierProfile(messages, trustedCarrierOptions());
    const importedProfile = asObject(importedBody?.profile);
    const hasImportedProfile = Object.keys(importedProfile).length > 0;
    const hasConfirmedProfile = Object.keys(confirmedProfile).length > 0;
    const chatProfile = hasImportedProfile ? importedProfile : hasConfirmedProfile ? confirmedProfile : supplementalPlayerProfile(messages, statData);
    const summary = currentBodySummary(statData, chatProfile, { preferSupplemental: hasImportedProfile || hasConfirmedProfile });
    const main = summary.main;
    const rowMap = new Map(summary.rows);
    const hero = el('section', 'llm-profile-hero');
    const orbit = el('button', 'llm-orbit-avatar');
    orbit.type = 'button';
    orbit.title = importedBody ? '点击导入或更换当前身体头像' : '需要先同步一个已确认的当前身体';
    orbit.disabled = !importedBody;
    const portrait = currentPortrait(importedBody);
    if (portrait?.dataUrl) {
        const image = document.createElement('img');
        image.className = 'llm-portrait-image';
        image.src = portrait.dataUrl;
        image.alt = `${summary.name}的头像`;
        orbit.append(image);
    } else {
        orbit.append(el('div', 'llm-silhouette'));
    }
    orbit.append(el('span', 'llm-avatar-edit', portrait?.dataUrl ? '更换' : '导入'));
    if (importedBody) orbit.addEventListener('click', chooseCurrentPortrait);
    const heroInfo = el('div', 'llm-hero-info');
    heroInfo.append(el('div', 'llm-hero-name', summary.name));
    const chips = el('div', 'llm-chips');
    for (const label of ['年龄', '种族', '职业']) {
        const value = String(rowMap.get(label) || '').trim();
        if (value && value !== '—') chips.append(el('span', 'llm-chip', value));
    }
    heroInfo.append(chips);
    const portraitActions = el('div', 'llm-portrait-actions');
    portraitActions.append(el('span', 'llm-muted', '点击头像导入图片；图片仅用于插件显示。'));
    if (portrait?.dataUrl) portraitActions.append(createButton('移除头像', removeCurrentPortrait, 'menu_button llm-avatar-remove'));
    heroInfo.append(portraitActions);
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
    renderBackgroundStory(panel, importedBody);
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
    const receipt = el('div', lastPromptStats.injected ? 'llm-injection-receipt' : 'llm-warning');
    receipt.textContent = promptStatsText();
    panel.append(receipt);
    renderFullBody(panel, importedBody);
}

async function renderLives(panel, statData) {
    const name = currentWorldBookName();
    const book = name ? await context()?.loadWorldInfo?.(name) : null;
    const entries = book ? Object.values(normalizeEntries(book)) : [];
    const summaries = lifeHistorySummaries(protocolMessages(), statData, entries, chatData(false)?.lives || []);
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
        ['strict', '严格主档案（推荐·每轮完整）'],
        ['smart', '智能注入（首轮完整）'],
        ['full', '每轮完整注入'],
        ['compact', '始终精简注入'],
        ['off', '不注入'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        option.selected = (settings().injectionMode || 'strict') === value;
        injection.append(option);
    }
    injection.addEventListener('change', () => {
        settings().injectionMode = injection.value;
        saveSettings();
        updateCurrentBodyPrompt();
    });
    injectionLabel.append(injection);
    const injectionHelp = el('div', 'llm-muted', '严格主档案模式在每次生成前重新合并并发送完整人物卡、出生至接管年龄的人生背景与当前有效动态覆盖；正文 stat_data 的物品、任务、关系、新闻等模块仍会一起读取。身份必须经过确认链，伤势、卫生、穿着、形态等安全动态可紧跟最新正文。');
    const promptMeter = el('div', 'llm-prompt-meter', promptStatsText());
    const promptPreview = document.createElement('details');
    promptPreview.className = 'llm-prompt-preview';
    promptPreview.append(el('summary', '', '查看本轮实际发送给 AI 的插件资料'), el('pre', 'llm-json', lastPromptText || '当前尚未生成注入内容'));

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
        createButton('同步已确认换身', () => importSelectedCard(cards[Number(cardSelect.value)], 'confirm'), 'menu_button llm-primary'),
    );
    const ledgerActions = el('div', 'llm-actions');
    ledgerActions.append(
        createButton('从当前正文重新同步', rebuildFromCurrentChat, 'menu_button llm-primary'),
        createButton('清空本聊天插件记录', clearCurrentChatLedger),
    );
    const safety = el('div', 'llm-safety');
    safety.textContent = '普通总结、隐藏和刷新不会清空已确认身体。主动“从当前正文重新同步”会严格按当前可见正文重建。外部备份导入后必须通过实时身份核对，并会自动切换严格主档案、回读确认人物资料已写入 AI 上下文。';
    const archiveCard = el('section', 'llm-control-card');
    archiveCard.append(label, select, active);
    const aiCard = el('section', 'llm-control-card');
    aiCard.append(injectionLabel, injectionHelp, promptMeter, promptPreview);
    const importCard = el('section', 'llm-control-card');
    importCard.append(importLabel, importActions);
    const maintenanceCard = el('section', 'llm-control-card');
    const backupActions = el('div', 'llm-actions');
    backupActions.append(
        createButton('导出完整备份', exportBackup, 'menu_button llm-primary'),
        createButton('导入完整备份', chooseBackupImport, 'menu_button llm-primary'),
    );
    maintenanceCard.append(ledgerActions, safety, backupActions);
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

function closeFloatingPanel() {
    const overlay = document.getElementById('legacy-life-manager-floating-overlay');
    const root = document.getElementById('legacy-life-manager-root');
    if (root && floatingPanelPlaceholder?.parentNode) {
        floatingPanelPlaceholder.parentNode.insertBefore(root, floatingPanelPlaceholder);
        floatingPanelPlaceholder.remove();
    } else if (root && floatingPanelHome?.isConnected) {
        floatingPanelHome.append(root);
    }
    floatingPanelPlaceholder = null;
    floatingPanelHome = null;
    if (overlay) overlay.hidden = true;
    document.body?.classList.remove('llm-floating-open');
}

async function openFloatingPanel() {
    const root = document.getElementById('legacy-life-manager-root');
    const host = document.querySelector('#legacy-life-manager-floating-overlay .llm-floating-panel-host');
    const overlay = document.getElementById('legacy-life-manager-floating-overlay');
    if (!root || !host || !overlay) return;
    if (!floatingPanelPlaceholder) {
        floatingPanelHome = root.parentElement;
        floatingPanelPlaceholder = document.createComment('legacy-life-manager-panel-home');
        root.parentNode?.insertBefore(floatingPanelPlaceholder, root);
        host.append(root);
    }
    overlay.hidden = false;
    document.body?.classList.add('llm-floating-open');
    await render();
}

function ensureFloatingRuntimeStyles() {
    let style = document.getElementById('legacy-life-manager-floating-runtime-styles');
    if (!style) {
        style = document.createElement('style');
        style.id = 'legacy-life-manager-floating-runtime-styles';
        (document.head || document.documentElement).append(style);
    }
    style.textContent = `
        #legacy-life-manager-floating.llm-floating-launcher {
            position: fixed !important;
            z-index: 2147483000 !important;
            right: auto !important;
            top: var(--llm-floating-top, 50%) !important;
            left: var(--llm-floating-left, calc(100vw - 70px)) !important;
            bottom: auto !important;
            display: grid !important;
            width: 52px !important;
            height: 52px !important;
            min-width: 52px !important;
            min-height: 52px !important;
            margin: 0 !important;
            padding: 0 !important;
            place-items: center !important;
            border: 1px solid rgb(186 166 255 / 78%) !important;
            border-radius: 50% !important;
            background: radial-gradient(circle at 35% 30%, #b69cff, #7253dc 48%, #27203f 100%) !important;
            color: #fff !important;
            opacity: 1 !important;
            visibility: visible !important;
            font-family: serif !important;
            font-size: 1.05rem !important;
            font-weight: 700 !important;
            line-height: 1 !important;
            box-shadow: 0 8px 28px rgb(71 48 151 / 48%), inset 0 1px rgb(255 255 255 / 28%) !important;
            cursor: grab !important;
            transform: none !important;
            touch-action: none !important;
            user-select: none !important;
        }
        #legacy-life-manager-floating.llm-floating-launcher[data-dragging="true"] { cursor: grabbing !important; }
        #legacy-life-manager-floating.llm-floating-launcher::after {
            position: absolute;
            inset: -5px;
            border: 1px solid rgb(218 200 255 / 28%);
            border-radius: 50%;
            content: '';
            pointer-events: none;
        }
        #legacy-life-manager-floating-overlay.llm-floating-overlay {
            position: fixed !important;
            z-index: 2147483001 !important;
            inset: 0 !important;
            display: grid !important;
            padding: 3vh 3vw !important;
            place-items: center !important;
            background: rgb(3 5 9 / 72%) !important;
            backdrop-filter: blur(5px);
        }
        #legacy-life-manager-floating-overlay[hidden] { display: none !important; }
        #legacy-life-manager-floating-overlay .llm-floating-shell {
            display: grid !important;
            width: min(980px, 94vw) !important;
            max-height: 94vh !important;
            overflow: hidden !important;
            grid-template-rows: auto minmax(0, 1fr) !important;
            border: 1px solid rgb(164 174 204 / 32%) !important;
            border-radius: 18px !important;
            background: #0d1017 !important;
            box-shadow: 0 24px 80px rgb(0 0 0 / 62%) !important;
        }
        #legacy-life-manager-floating-overlay .llm-floating-topbar {
            display: flex !important;
            min-height: 46px !important;
            padding: .45rem .55rem .45rem 1rem !important;
            align-items: center !important;
            justify-content: space-between !important;
            border-bottom: 1px solid rgb(158 166 190 / 18%) !important;
            color: #c8cad5 !important;
        }
        #legacy-life-manager-floating-overlay .llm-floating-close {
            display: grid !important;
            width: 34px !important;
            height: 34px !important;
            padding: 0 !important;
            place-items: center !important;
            border: 0 !important;
            border-radius: 50% !important;
            background: rgb(255 255 255 / 6%) !important;
            color: #d9dbe4 !important;
            font-size: 1.25rem !important;
            cursor: pointer !important;
        }
        #legacy-life-manager-floating-overlay .llm-floating-panel-host { min-height: 0 !important; overflow: auto !important; }
        body.llm-floating-open #legacy-life-manager-root .inline-drawer-content { display: block !important; }
        body.llm-floating-open #legacy-life-manager-root .inline-drawer-icon { display: none !important; }
        @media (max-width: 720px) {
            #legacy-life-manager-floating.llm-floating-launcher {
                width: 46px !important;
                height: 46px !important;
                min-width: 46px !important;
                min-height: 46px !important;
            }
            #legacy-life-manager-floating-overlay.llm-floating-overlay { padding: 1.5vh 2vw !important; }
            #legacy-life-manager-floating-overlay .llm-floating-shell { width: 96vw !important; max-height: 97vh !important; }
        }
    `;
}

function floatingLauncherPosition(launcher) {
    const size = Math.max(46, Number(launcher?.offsetWidth) || 52);
    const maxX = Math.max(8, Number(globalThis.innerWidth || document.documentElement?.clientWidth || 800) - size - 8);
    const maxY = Math.max(8, Number(globalThis.innerHeight || document.documentElement?.clientHeight || 600) - size - 8);
    const saved = asObject(settings().floatingPosition);
    const xRatio = Number(saved.xRatio);
    const yRatio = Number(saved.yRatio);
    const x = Number.isFinite(xRatio) ? 8 + Math.min(1, Math.max(0, xRatio)) * (maxX - 8) : maxX;
    const y = Number.isFinite(yRatio) ? 8 + Math.min(1, Math.max(0, yRatio)) * (maxY - 8) : Math.round(maxY / 2);
    return { x, y, maxX, maxY };
}

function forceFloatingLauncherVisible(launcher) {
    const { x, y } = floatingLauncherPosition(launcher);
    const important = {
        position: 'fixed',
        'z-index': '2147483000',
        right: 'auto',
        left: `${Math.round(x)}px`,
        top: `${Math.round(y)}px`,
        bottom: 'auto',
        display: 'grid',
        width: '52px',
        height: '52px',
        'min-width': '52px',
        'min-height': '52px',
        margin: '0',
        padding: '0',
        'place-items': 'center',
        opacity: '1',
        visibility: 'visible',
        transform: 'none',
        'touch-action': 'none',
    };
    for (const [name, value] of Object.entries(important)) launcher.style.setProperty(name, value, 'important');
}

function installFloatingDrag(launcher) {
    let drag = null;
    launcher.addEventListener('pointerdown', event => {
        if (event.button !== 0 && event.pointerType !== 'touch') return;
        const rect = launcher.getBoundingClientRect();
        drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
        launcher.dataset.dragging = 'true';
        launcher.setPointerCapture?.(event.pointerId);
    });
    launcher.addEventListener('pointermove', event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        event.preventDefault();
        const { maxX, maxY } = floatingLauncherPosition(launcher);
        const x = Math.min(maxX, Math.max(8, drag.left + dx));
        const y = Math.min(maxY, Math.max(8, drag.top + dy));
        launcher.style.setProperty('left', `${Math.round(x)}px`, 'important');
        launcher.style.setProperty('top', `${Math.round(y)}px`, 'important');
    });
    const finish = event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const moved = drag.moved;
        launcher.releasePointerCapture?.(event.pointerId);
        launcher.dataset.dragging = 'false';
        drag = null;
        if (!moved) return;
        const rect = launcher.getBoundingClientRect();
        const { maxX, maxY } = floatingLauncherPosition(launcher);
        settings().floatingPosition = {
            xRatio: maxX > 8 ? Math.min(1, Math.max(0, (rect.left - 8) / (maxX - 8))) : 0,
            yRatio: maxY > 8 ? Math.min(1, Math.max(0, (rect.top - 8) / (maxY - 8))) : 0,
        };
        launcher.dataset.suppressClick = 'true';
        setTimeout(() => { launcher.dataset.suppressClick = 'false'; }, 0);
        saveSettings();
    };
    launcher.addEventListener('pointerup', finish);
    launcher.addEventListener('pointercancel', finish);
    globalThis.addEventListener?.('resize', () => forceFloatingLauncherVisible(launcher));
}

function ensureFloatingLauncher() {
    if (!document.body) return;
    ensureFloatingRuntimeStyles();
    let existingLauncher = document.getElementById('legacy-life-manager-floating');
    if (existingLauncher) {
        const replacement = existingLauncher.cloneNode(true);
        existingLauncher.replaceWith(replacement);
        existingLauncher = replacement;
        existingLauncher.classList.add('llm-floating-launcher');
        existingLauncher.textContent = '历';
        existingLauncher.title = '拖动可移动；点击打开历代人生管理器';
        existingLauncher.setAttribute('aria-label', '可拖动的历代人生管理器入口');
        forceFloatingLauncherVisible(existingLauncher);
        installFloatingDrag(existingLauncher);
        existingLauncher.addEventListener('click', () => {
            if (existingLauncher.dataset.suppressClick === 'true') return;
            openFloatingPanel().catch(error => notify('error', error.message || '无法打开浮动面板'));
        });
        if (document.getElementById('legacy-life-manager-floating-overlay')) return;
    }
    const launcher = existingLauncher || el('button', 'llm-floating-launcher', '历');
    if (!existingLauncher) {
        launcher.id = 'legacy-life-manager-floating';
        launcher.type = 'button';
        launcher.title = '拖动可移动；点击打开历代人生管理器';
        launcher.setAttribute('aria-label', '可拖动的历代人生管理器入口');
        forceFloatingLauncherVisible(launcher);
        installFloatingDrag(launcher);
        launcher.addEventListener('click', () => {
            if (launcher.dataset.suppressClick === 'true') return;
            openFloatingPanel().catch(error => notify('error', error.message || '无法打开浮动面板'));
        });
    }

    const overlay = el('div', 'llm-floating-overlay');
    overlay.id = 'legacy-life-manager-floating-overlay';
    overlay.hidden = true;
    const shell = el('section', 'llm-floating-shell');
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', '历代人生管理器');
    const topbar = el('div', 'llm-floating-topbar');
    topbar.append(
        el('span', '', '正文快速查看'),
        createButton('×', closeFloatingPanel, 'llm-floating-close'),
    );
    const host = el('div', 'llm-floating-panel-host');
    shell.append(topbar, host);
    overlay.append(shell);
    overlay.addEventListener('click', event => { if (event.target === overlay) closeFloatingPanel(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) closeFloatingPanel(); });
    if (!launcher.isConnected) document.body.append(launcher);
    document.body.append(overlay);
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
        panel.append(el('div', 'llm-warning', '没有检测到 stat_data；无法核实换身提交，暂停候选接管与归档。旧账本迁移备份随导出保留。'));
    }
    const recovery = chatData(false)?.lastTrustedRecovery;
    if (currentImportedBody() && recovery?.recordKey === currentImportedBody()?.sourceRecordKey) {
        panel.append(el('div', 'llm-injection-receipt', `已自动恢复可信档案：${recovery.name || '当前身体'}。旧楼层快照不完整时将继续使用原人物卡、确认记录和当前状态交叉核对，不会再直接清空。`));
    }
    if (sync) {
        const hasBody = Boolean(currentImportedBody());
        sync.textContent = hasBody ? (runtimeInfo.appliedOperations ? '正文已追踪' : '已同步') : '等待人物卡';
        sync.dataset.state = hasBody ? 'synced' : 'empty';
        sync.title = runtimeInfo.appliedOperations ? `已从最新正文补全 ${runtimeInfo.appliedOperations} 项动态变化` : '';
    }
    if (!currentImportedBody() && chatData(false)?.legacyMigrationBackup?.data?.currentBody) panel.append(el('div','llm-warning','旧载体缺少完整提交证据，已保留迁移备份并暂停自动注入；导出备份包含旧账本，真实MVU与世界书未被重置。'));
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
        const cards = carrierCardsFromMessage(ctx.chat[messageIndex]);
        const card = cards.at(-1);
        const profile = parseCarrierCard(card);
        if (!profile.姓名) continue;
        const actions = el('div', 'llm-actions llm-card-actions');
        actions.append(
            createButton('同步已确认档案', () => importSelectedCard({ messageIndex, card, profile }, 'sync')),
            createButton('同步已确认换身', () => importSelectedCard({ messageIndex, card, profile }, 'confirm'), 'menu_button llm-primary'),
        );
        (message.querySelector('.mes_text') || message.querySelector('.mes_block') || message).append(actions);
    }
}

function scheduleRefresh(reason = '正文楼层变化') {
    const result = reconcileConversation({ reason });
    if (result.cleared) notify('info', '相关人物卡或确认楼层已不存在，插件已撤销旧身体、历代记录和 AI 注入');
    if (result.restored && result.current?.sourceRecordKey && result.current?.sourceRecordKey !== result.previous?.sourceRecordKey) {
        notify('success', `已自动恢复可信身体档案：${result.current.profile?.姓名 || '当前身体'}`);
    }
    refreshTimers.forEach(clearTimeout);
    refreshTimers = [0, 250, 900, 1800].map(delay => setTimeout(async () => {
        await applyMoneyInheritance().catch(error => notify('warning', `跨世金钱继承失败：${error.message}`));
        await updateCurrentBodyPrompt().catch(error => console.error('[历代人生管理器] 注入失败', error));
        render().catch(error => console.error('[历代人生管理器] 渲染失败', error));
        installCardButtons();
    }, delay));
}

function registerEvents() {
    const ctx = context();
    if (!ctx?.eventSource || !ctx?.eventTypes) return;
    for (const type of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], () => {
            if (sharedRuntime.token === RUNTIME_TOKEN) scheduleRefresh(type);
        });
    }
    for (const type of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS']) {
        if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], () => {
            if (sharedRuntime.token === RUNTIME_TOKEN) updateCurrentBodyPrompt();
        });
    }
}

export async function init() {
    if (initialized) return;
    const ctx = context();
    if (!ctx) return console.error('[历代人生管理器] SillyTavern 公共接口不可用');
    const mount = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!mount) return console.error('[历代人生管理器] 找不到扩展设置面板');
    initialized = true;
    sharedRuntime.token = RUNTIME_TOKEN;
    settings();
    if (!document.getElementById('legacy-life-manager-root')) mount.append(createPanel());
    ensureFloatingLauncher();
    registerEvents();
    await render();
    await applyMoneyInheritance().catch(error => notify('warning', `跨世金钱继承失败：${error.message}`));
    await updateCurrentBodyPrompt();
    await render();
    installCardButtons();
    const observer = new MutationObserver(() => installCardButtons());
    const chat = document.querySelector('#chat');
    if (chat) observer.observe(chat, { childList: true, subtree: true });
    console.log('[历代人生管理器] v0.10.0 已加载');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(), { once: true });
else init();
