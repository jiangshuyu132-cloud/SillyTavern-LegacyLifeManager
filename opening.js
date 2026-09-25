import { carrierCardText, carrierCardSections, carrierBackgroundStory, initialPlayerProfile, parseCarrierCard, carrierProfileMatchesCurrentState, stableTextFingerprint } from './core.js';
import { isDiscussion } from './strict-protocol.js';

// Initial player-authored setup is not a death/confirmation transaction.
// Never discover an opening by scanning arbitrary later cards or NPC output.
export function initialOpeningRecord(messages = []) {
    const index = messages.findIndex(m => m?.is_user);
    const message = messages[index];
    if (!message || isDiscussion(message)) return null;
    const source = String(message.mes || '').replace(/\r/g, '');
    if (!/^【剧情生成上下文】/m.test(source) || !/^【初始开局剧情】\s*\n【自定义开局】/m.test(source)) return null;
    const rawCard = source.split(/^【自定义开局】[ \t]*\n/m)[1]?.replace(/^[ \t]*描述[：:][ \t]*/, '').trim();
    const header = initialPlayerProfile([{ ...message, is_system: false }]);
    const parsed = parseCarrierCard(rawCard);
    const sections = carrierCardSections(rawCard);
    if (!header.姓名 || parsed.姓名 !== header.姓名 || sections.length < 2) return null;
    const fingerprint = stableTextFingerprint(rawCard);
    return {
        profile: { ...header, ...parsed }, rawCard, text: carrierCardText(rawCard), sections,
        backgroundStory: carrierBackgroundStory(rawCard), sourceType: 'opening',
        sourceCardFingerprint: fingerprint, sourceRecordKey: `opening:${fingerprint}`,
        sourceMessageIndex: index, startMessageIndex: index, generation: 1,
        confirmed: true,
    };
}

export function openingMatchesCurrent(body, messages = [], stat = {}) {
    if (body?.sourceType !== 'opening') return false;
    const opening = initialOpeningRecord(messages);
    // A visible edited/replaced opening must never silently restore the old one.
    if (opening && opening.sourceRecordKey !== body.sourceRecordKey) return false;
    const start = opening?.sourceMessageIndex ?? Number(body.startMessageIndex);
    if (!Number.isInteger(start)) return false;
    const main = stat?.主角 || {};
    const stage = main.换身状态 || {};
    if (stage.当前身体死亡已确认 === true || ['等待换身', '等待确认'].includes(stage.阶段)) return false;
    if (messages.slice(start + 1).some(m => !isDiscussion(m) && (
        (m?.is_user && String(m.mes || '').trim() === '确认换身')
        || (!m?.is_user && /【当前载体人物设定开始】|【换身待定】/.test(String(m?.mes || '').replace(/```[\s\S]*?```/g, '')))
    ))) return false;
    // The exact authored opening is independent identity evidence. Without it,
    // require the existing two-field live-state check (e.g. hidden old floors).
    return carrierProfileMatchesCurrentState(stat, body.profile, opening ? 1 : 2);
}
