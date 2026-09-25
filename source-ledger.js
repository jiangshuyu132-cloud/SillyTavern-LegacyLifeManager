import { stableTextFingerprint } from './core.js';
import { messageStat } from './strict-protocol.js';

// Own, persisted message identity: floor numbers move on deletion, send_date is
// not unique, and extra/swipe_info can be replaced when changing a swipe.
export const SOURCE_ID = 'legacy_life_source_id';
const clone = value => structuredClone(value);
export const sourceHash = message => stableTextFingerprint(String(message?.mes || ''));
function newId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const bytes = new Uint32Array(4);
    if (globalThis.crypto?.getRandomValues) { globalThis.crypto.getRandomValues(bytes); return `llm-${[...bytes].map(x => x.toString(16)).join('-')}`; }
    return `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function observeSources(previous, messages, { reason = '', targetIndex, idFactory = newId, variablesAt = index => messageStat(messages[index]) } = {}) {
    const before = previous?.active || [];
    const byId = new Map(before.map(s => [s.id, s]));
    const seen = new Set();
    let stamped = false;
    const active = messages.map((message, index) => {
        let id = message[SOURCE_ID];
        if (typeof id !== 'string' || !id || seen.has(id)) {
            id = idFactory(); message[SOURCE_ID] = id; stamped = true;
        }
        seen.add(id);
        const old = byId.get(id);
        const swipe = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        const edited = ['MESSAGE_EDITED', 'MESSAGE_SWIPED'].includes(reason) && index === targetIndex;
        // A hide operation changes is_system, not the underlying facts. Some
        // summary helpers also replace hidden text; retain the saved source.
        // An explicit edit/swipe on an already hidden source is still an edit.
        const retained = old && message.is_system && swipe === old.swipe
            && !(edited && old.hidden);
        const text = retained ? old.text : String(message.mes || '');
        const hash = stableTextFingerprint(text);
        return {
            id, hash, swipe, index, text, isUser: Boolean(message.is_user),
            hidden: Boolean(message.is_system),
            system: old?.system ?? Boolean(message.is_system && message.name === 'System'),
            legacyKey: String(message.extra?.message_id || message.send_date || `floor:${index}`),
            statHash: stableTextFingerprint(JSON.stringify(variablesAt(index) || null)),
        };
    });
    const removed = before.filter(s => !seen.has(s.id));
    const revised = active.filter(s => {
        const old = byId.get(s.id);
        return old && (old.hash !== s.hash || old.swipe !== s.swipe || old.isUser !== s.isUser);
    });
    const signature = stableTextFingerprint(JSON.stringify(active.map(s => [s.id, s.hash, s.swipe, s.isUser])));
    const changed = signature !== previous?.signature;
    const staleSnapshots = { ...(previous?.staleSnapshots || {}) };
    if (removed.length || revised.length) {
        let prefix = 0;
        while (prefix < before.length && prefix < active.length
            && before[prefix].id === active[prefix].id && before[prefix].hash === active[prefix].hash
            && before[prefix].swipe === active[prefix].swipe) prefix++;
        // Later cumulative MVU snapshots may still contain the deleted fact.
        // Ignore the observed snapshot until MVU actually recomputes it; replay
        // surviving patches locally. This does not overwrite external MVU.
        for (const source of active.slice(prefix)) if (byId.has(source.id)) staleSnapshots[source.id] = source.statHash;
    }
    for (const [id, fingerprint] of Object.entries(staleSnapshots)) {
        const source = active.find(s => s.id === id);
        if (!source || source.statHash !== fingerprint) delete staleSnapshots[id];
    }
    const state = {
        version: 1, revision: Number(previous?.revision || 0) + Number(changed), signature, active, staleSnapshots,
        // Tombstones are audit data, never a recovery source.
        retired: [...(previous?.retired || []), ...removed.map(s => ({ id: s.id, hash: s.hash, reason: 'deleted' })),
            ...revised.map(s => ({ id: s.id, hash: byId.get(s.id).hash, reason: 'revised' }))].slice(-1000),
    };
    return { state, changed, stamped, removed, revised };
}

export function sourceRef(source) {
    return source ? { id: source.id, hash: source.hash, swipe: source.swipe } : null;
}

export function refsPresent(refs, sources) {
    const active = new Map(sources.map(s => [s.id, s]));
    return Array.isArray(refs) && refs.length > 0 && refs.every(ref => {
        const now = active.get(ref.id);
        return now && now.hash === ref.hash && now.swipe === ref.swipe;
    });
}

export function bindBody(body, sources, indexes) {
    return { ...body, sourceAnchors: indexes.map(index => sourceRef(sources[index])).filter(Boolean) };
}

// Source facts come from the full chat array, not the visible DOM. No fallback
// to unselected swipes, reasoning, old display text, or an archive copy.
export function projectSources(messages, sources, staleSnapshots = {}) {
    return sources.map((source, index) => ({
        ...messages[index], mes: source.text, is_system: source.system,
        stat_data: messageStat(messages[index]) || undefined,
        swipes: [], original_mes: undefined, reasoning: undefined,
        extra: { ...messages[index]?.extra, original_mes: undefined, display_text: undefined, reasoning: undefined,
            ...(staleSnapshots[source.id] ? { variables: undefined, stat_data: undefined } : {}) },
        ...(staleSnapshots[source.id] ? { variables: undefined, stat_data: undefined } : {}),
        data: undefined,
    }));
}

export function captureIdentityCheckpoint(data, body) {
    if (!body?.sourceRecordKey) return;
    data.identityCheckpoints ??= {};
    data.identityCheckpoints[body.sourceRecordKey] = { body: clone(body), lives: clone(data.lives || []) };
}
