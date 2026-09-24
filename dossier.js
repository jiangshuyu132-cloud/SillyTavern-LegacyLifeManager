import { asObject, carrierCardSections, carrierCardText, stableTextFingerprint } from './core.js';
import { isDiscussion } from './strict-protocol.js';

// The original card is immutable. This module materializes a second full card
// from field replacements, with an evidence journal independent of MVU schema.
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTITY = new Set(['姓名', '原主姓名', '世代编号', '确认换身']);
const BLOCK = /<LegacyBodyUpdate\b[^>]*>([\s\S]*?)<\/LegacyBodyUpdate>/gi;
const BODY_WORDS = /化妆|卸妆|妆容|唇色|眼线|腮红|染发|剪发|换衣|脱下|穿上|洗澡|洗净|疤痕|体味|声音变|身体改造|变形|治愈|复发/;
const clean = value => String(value ?? '').trim();
const plain = value => clean(value).replace(/<[^>]*>/g, '').replace(/\s+/g, '');

export function dossierBodyId(body) {
    return `${Number(body?.generation) || 1}:${body?.sourceCardFingerprint || stableTextFingerprint(body?.rawCard || body?.text || '')}`;
}

function originalSections(body) {
    const parsed = carrierCardSections(body?.rawCard || body?.text);
    const sections = parsed.length ? parsed : body?.sections || [];
    return sections.map(s => ({ title: clean(s.title), content: String(s.content || '') }));
}

function splitFields(content) {
    const matches = [...content.matchAll(/^([^\n：:<>]{1,40})[：:]\s*/gm)]
        .filter(m => !/^\s*[-*\d]/.test(m[1]) && !UNSAFE.has(m[1].trim()));
    const names = matches.map(m => m[1].trim());
    // Do not collapse duplicate symptom labels or prose into a lossy map.
    if (!matches.length || new Set(names).size !== names.length) return [{ name: '完整描述', value: content }];
    const fields = [];
    const preamble = content.slice(0, matches[0].index).trim();
    if (preamble) fields.push({ name: '板块说明', value: preamble });
    matches.forEach((m, i) => fields.push({ name: names[i], value: content.slice(m.index + m[0].length, matches[i + 1]?.index ?? content.length).trim() }));
    return fields;
}

function documentFrom(body) {
    return originalSections(body).map(s => ({ ...s, fields: splitFields(s.content), changed: false, sources: [] }));
}

function applyChange(sections, change, source) {
    const section = sections.find(s => s.title === change.section);
    if (!section) return;
    if (change.field === '完整描述') {
        section.fields = [{ name: '完整描述', value: change.op === 'remove' ? '当前无此项 / 已解除。' : change.value }];
    } else {
        const value = change.op === 'remove' ? '无（已移除 / 不再生效）' : change.value;
        const field = section.fields.find(f => f.name === change.field);
        if (field) field.value = value;
        else section.fields.push({ name: change.field, value });
    }
    section.changed = true;
    if (source && !section.sources.includes(source)) section.sources.push(source);
}

function activeText(message) {
    // Never scan alternate swipes, model reasoning or image prompts for facts.
    return String(message?.mes || '');
}

function updateSource(message) {
    let text = activeText(message).replace(/```[\s\S]*?```/g, '');
    for (const tag of ['recorder_thinking', 'think', 'thinking', 'analysis', 'options', 'image', 'image_think', 'UpdateVariable', 'status_current_variables', 'char_info']) {
        text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    }
    return text;
}

export function narrativeEvidence(message) {
    let text = activeText(message).replace(BLOCK, '').replace(/```[\s\S]*?```/g, '');
    for (const tag of ['UpdateVariable', 'recorder_thinking', 'think', 'thinking', 'analysis', 'options', 'image', 'image_think', 'status_current_variables', 'char_info']) {
        text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    }
    const story = [...text.matchAll(/<(?:gametxt|summary)\b[^>]*>([\s\S]*?)<\/(?:gametxt|summary)>/gi)].map(m => m[1]).filter(s => !/^身体档案同步$/.test(carrierCardText(s)));
    return carrierCardText(story.length ? story.join('\n') : text);
}

function messageKey(message, index) {
    return clean(message?.extra?.message_id || message?.send_date) || `floor:${index}`;
}

function validateBlock(block, body, sections, evidence) {
    if (block?.version !== 1 || block.bodyId !== dossierBodyId(body) || !Array.isArray(block.changes)) throw new Error('档案更新的身体标识或格式不符');
    if (block.changes.length > 80) throw new Error('单轮档案更新项目过多');
    return block.changes.map(change => {
        const section = clean(change?.section), field = clean(change?.field), quote = clean(change?.evidence);
        const target = sections.find(s => s.title === section);
        if (!target || !field || field.length > 50 || UNSAFE.has(field) || IDENTITY.has(field)) throw new Error('档案更新包含未知板块或受保护身份字段');
        if (/人物卡说明|历代.*索引/.test(section)) throw new Error('说明和历代索引不作为身体变化更新');
        if (field === '完整描述' && /基础|人生背景|生平|成长|背景故事/.test(section)) throw new Error('基础与人生背景只允许逐字段更新');
        if (field === '完整描述' && target.fields.some(f => !['完整描述', '板块说明'].includes(f.name))) throw new Error('有分字段的板块必须逐字段更新，不能整块覆盖');
        if (!['set', 'remove'].includes(change.op)) throw new Error('未知档案更新操作');
        if (change.op === 'set' && (typeof change.value !== 'string' || !change.value.trim() || change.value.length > 16000)) throw new Error('档案更新缺少完整的新值');
        if (plain(quote).length < 4 || quote.length > 1200 || !evidence.some(text => plain(text).includes(plain(quote)))) throw new Error('档案更新缺少可核对的正文依据');
        return { section, field, op: change.op, value: change.op === 'set' ? change.value.trim() : '', evidence: quote };
    });
}

function printable(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(printable).join('、') || '无';
    if (value && typeof value === 'object') return Object.entries(value).map(([k,v]) => `${k}：${printable(v)}`).join('\n');
    return String(value ?? '无');
}

function liveChanges(body, stat, sections) {
    const main = asObject(stat?.主角), carrier = asObject(main.载体档案);
    const result = [];
    const put = (section, field, value) => {
        if (value === undefined || !section) return;
        result.push({ section, field, op: 'set', value: printable(value) || '无' });
    };
    const findSection = regex => sections.find(s => regex.test(s.title))?.title;
    const base = findSection(/当前形态基础|基础信息|基本信息|完整人物资料/);
    for (const key of ['年龄','实龄','外貌年龄','身高','体重','等级','生命层级','当前地点']) put(base, key, main[key] ?? carrier[key]);
    const location = main.当前地点 ?? stat?.世界?.当前地点 ?? stat?.世界?.地点;
    put(base, '当前地点', location);
    const structured = asObject(main.动态身体档案);
    for (const section of sections) {
        if (/人物卡说明|历代.*索引/.test(section.title)) continue;
        for (const field of section.fields) {
            if (IDENTITY.has(field.name) || ['完整描述','板块说明','种族','职业','身份','身份背景'].includes(field.name)) continue;
            const value = Object.hasOwn(carrier,field.name) ? carrier[field.name] : main[field.name];
            // A compact mirror of the same information is not a replacement
            // for the detailed original field (which may include prose).
            if (value != null && field.value.length > printable(value).length && field.value.includes(printable(value))) continue;
            put(section.title,field.name,value);
        }
        for (const [field,value] of Object.entries(asObject(structured[section.title]))) {
            if (!IDENTITY.has(field) && !UNSAFE.has(field)) put(section.title, field, value);
        }
        // Explicit same-named sections can be stored as a complete description.
        const live = carrier[section.title] ?? main[section.title];
        if (live !== undefined && !/基础|人物卡说明|历代|背景/.test(section.title)) {
            if (typeof live === 'string' && section.fields.length === 1 && section.fields[0].name === '完整描述') put(section.title, '完整描述', live);
            else for (const [field,value] of Object.entries(asObject(live))) if (!IDENTITY.has(field) && !UNSAFE.has(field)) put(section.title, field, value);
        }
    }
    const mapped = [
        [/外貌/, ['妆容','当前妆容','发型','发色','瞳色','面容','肤色肤质']],
        [/声音/, ['音色','音调与音量','语速','发音与口音']],
        [/气味/, ['自然体味','当前气味']],
        [/卫生/, ['近期洗浴','清洁度','全身卫生']],
    ];
    for (const [sectionRx, fields] of mapped) for (const key of fields) put(findSection(sectionRx), key === '当前妆容' ? '妆容' : key, carrier[key] ?? main[key]);
    // Status membership is authoritative, but a short status bar must not
    // overwrite a long symptom description. Annotate active disease entries
    // in place and ask the model to reconcile their detailed manifestations.
    if (main.状态效果 && typeof main.状态效果 === 'object') {
        const effects = printable(main.状态效果) || '当前无状态效果';
        put(base, '当前生效状态', effects || '无');
        const diseaseSection = findSection(/疾病|病症/);
        if (diseaseSection) put(diseaseSection, '当前状态核对', `最新变量中的有效状态：\n${effects || '无'}\n本板块详细表现须结合上述当前状态阅读；原记录不证明疾病仍生效，已移除项目不得复活。正文明确的病程变化须更新对应详细描述。`);
    }
    return result;
}

/** Ordinary hide/summary preserves the journal. Only explicit editing/swiping/
 * deletion events may retract existing source entries. An empty scan is not
 * evidence that the current person ceased to exist. */
export function resolveDynamicDossier(body, messages = [], stat = {}, options = {}) {
    const bodyId = dossierBodyId(body);
    const previous = body?.dynamicDossier?.bodyId === bodyId ? body.dynamicDossier : null;
    const sections = documentFrom(body);
    const anchor = Number(body?.confirmationMessageIndex ?? body?.startMessageIndex ?? -1);
    const journal = new Map((previous?.events || []).map(e => [e.key, structuredClone(e)]));
    const issues = [];
    const evidenceWindow = [];
    const seen = new Set();
    let latestNarrative = previous?.pending ? { key: previous.pending.key, index: previous.pending.sourceIndex, text: previous.pending.text } : null;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message) continue;
        const key = messageKey(message, index);
        seen.add(key);
        if (message.is_user || isDiscussion(message)) {
            if (options.retractChanged) journal.delete(key);
            continue;
        }
        const text = activeText(message);
        if (!text.trim()) {
            if (options.retractChanged && !message.is_system) journal.delete(key);
            continue;
        }
        const evidence = narrativeEvidence(message);
        evidenceWindow.push(evidence);
        if (evidenceWindow.length > 8) evidenceWindow.shift();
        const blocks = [...updateSource(message).matchAll(BLOCK)];
        const old = journal.get(key);
        const sourceHash = stableTextFingerprint(text);
        // An explicitly edited source replaces its journal; merely hidden text
        // remains valid, as summaries often set is_system on original messages.
        const edited = options.retractChanged === true;
        if (!blocks.length) {
            if (edited && old && old.sourceHash !== sourceHash && !message.is_system) journal.delete(key);
            if (index > anchor && !message.is_system && evidence && (previous || BODY_WORDS.test(evidence))) latestNarrative = { key, index, text: evidence };
            continue;
        }
        // Unrelated generations must never change this body's archive.
        if (index <= anchor && !blocks.some(b => b[1].includes(bodyId))) continue;
        if (old?.sourceHash === sourceHash) {
            old.sourceIndex = index;
            latestNarrative = null;
            issues.length = 0;
            continue;
        }
        try {
            const eligibleEvidence = previous?.pending?.text ? [...evidenceWindow, previous.pending.text] : evidenceWindow;
            const changes = blocks.flatMap(b => validateBlock(JSON.parse(b[1].trim()), body, sections, eligibleEvidence));
            journal.set(key, { key, sourceIndex: index, sourceHash, changes });
            issues.length = 0;
            if (!message.is_system) latestNarrative = null;
        } catch (error) {
            if (edited) journal.delete(key);
            issues.push(`第 ${index} 楼：${error.message}`);
            if (evidence) latestNarrative = { key, index, text: evidence };
        }
    }
    if (options.retractDeleted) for (const key of previous?.sourcePresence || []) if (!seen.has(key)) journal.delete(key);
    const events = [...journal.values()].sort((a,b) => a.sourceIndex - b.sourceIndex);
    // Persist exact live fields too: unavailable snapshots are not deletions.
    // Same-floor narrative patches win because they carry the fuller detail.
    const live = liveChanges(body, stat, sections);
    const liveRecords = structuredClone(asObject(previous?.liveRecords));
    for (const c of live) {
        const key = `${c.section}/${c.field}`;
        if (liveRecords[key]?.change.value !== c.value) liveRecords[key] = {
            change: c,
            sourceIndex: previous ? (options.liveSourceIndex ?? messages.length - 1) : anchor,
        };
    }
    const timeline = [
        ...Object.values(liveRecords).map(r => ({ sourceIndex: r.sourceIndex, changes: [r.change], kind: 0 })),
        ...events.map(e => ({ ...e, kind: 1 })),
    ].sort((a,b) => a.sourceIndex - b.sourceIndex || a.kind - b.kind);
    for (const entry of timeline) for (const change of entry.changes) applyChange(sections, change, entry.kind ? `正文第 ${entry.sourceIndex} 楼` : '最新变量');
    const rendered = sections.map(s => ({
        title: s.title,
        content: s.changed ? s.fields.map(f => f.name === '完整描述' || f.name === '板块说明' ? f.value : `${f.name}：${f.value}`).join('\n\n') : s.content,
        changed: s.changed,
        sources: s.sources,
        fields: s.fields.map(f => f.name),
    }));
    const text = rendered.map(s => `— ${s.title} —\n${s.content}`).join('\n\n');
    const pending = latestNarrative && !journal.has(latestNarrative.key) ? { key: latestNarrative.key, sourceIndex: latestNarrative.index, text: latestNarrative.text.slice(-16000) } : null;
    const state = { version: 1, bodyId, events, liveRecords, sourcePresence: events.filter(e => seen.has(e.key)).map(e => e.key), sections: rendered, text, issues: issues.slice(-8), pending };
    return { state, sections: rendered, text, changed: JSON.stringify(previous) !== JSON.stringify(state) };
}

export function dossierUpdateInstructions(body, dossier) {
    const shape = dossier.sections.map(s => ({ section: s.title, fields: s.fields })).filter(s => !/人物卡说明|历代.*索引/.test(s.section));
    return `【完整动态身体档案维护协议】
当前身体标识 bodyId=${dossierBodyId(body)}。本插件维护固定接管原档与完整动态主档两份人物卡。你读到的是已更新的动态主档；原档只用于追溯，不得把旧状态重新带回当前人物。
每次普通剧情回复都检查：外貌、妆容/卸妆、发型、声音、气味、卫生、穿着、伤势、疾病、身体结构、改造、形态、认知记忆、背景经历是否发生已完成且持续到下一轮的变化。把变化融入对应主档字段，不能只新增一条状态效果。一个变化影响多个板块时分别更新。未变化的细节完整保留，不能缩写整张人物卡。临时妆容不得改写自然五官；卸妆更新妆容为“无”，勿把卸妆前的妆面复活。
在正文后独立输出一个 <LegacyBodyUpdate> JSON </LegacyBodyUpdate>，置于 UpdateVariable 外部。格式：{"version":1,"bodyId":"${dossierBodyId(body)}","changes":[{"op":"set","section":"原板块标题","field":"原字段或新增具体字段","value":"该字段的完整当前描述","evidence":"逐字摘录本轮或最近八条助手正文/summary中证明已发生的短句"}]}。没有变化时 changes 为 []。删除临时效果用 op="remove"；字段移除不会恢复原档旧值。仅无分字段的描述板块可用 field="完整描述"，须保留该板块所有仍有效细节。禁止修改姓名、世代编号、人物卡说明、前世索引；换身继续走原确认流程。
只有当前身体已发生的事实可更新，未确认候选、NPC、未来计划、选项、比喻、推理过程和图片提示不能当依据。MVU 的状态效果、资源、物品和关系照常更新；此块由插件独立保存，不受 MVU 删未知字段影响。状态条有变化时，也要将具体表现融入健康/疾病/卫生等详细字段；明确治愈的条目在动态主档中写为已治愈，保留仍有效的详细信息。可用 <details><summary>身体档案同步</summary> 包裹更新块以折叠显示，但不要放进代码围栏、推理或图片标签。
可更新板块与字段：${JSON.stringify(shape)}
${dossier.state.issues.length ? `上次更新被拒绝（旧有效档案仍保留），本轮纠正后重新提交：${dossier.state.issues.join('；')}` : ''}
${dossier.state.pending ? `旧正文补齐：以下是仍未进入动态主档的最近已写正文（来源第 ${dossier.state.pending.sourceIndex} 楼）。核对其中已发生且仍有效的身体变化，在本次更新块补入对应字段。未来安排不得当成已完成；无明确事实则不编造。\n<legacy_dossier_pending_evidence>\n${dossier.state.pending.text}\n</legacy_dossier_pending_evidence>` : ''}`;
}
