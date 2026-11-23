// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
// Stable-ID ownership of messages hidden by the extension. Pure logic, no globals.

export const SC_ID_KEY = 'sc_id';

export function getMessageId(msg) {
    const id = msg?.extra?.[SC_ID_KEY];
    return typeof id === 'string' && id !== '' ? id : null;
}

export function ensureMessageId(msg, genId) {
    const existing = getMessageId(msg);
    if (existing) return existing;
    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    const id = genId();
    msg.extra[SC_ID_KEY] = id;
    const swipe = Array.isArray(msg.swipe_info) ? msg.swipe_info[msg.swipe_id] : undefined;
    if (swipe && typeof swipe === 'object') {
        if (!swipe.extra || typeof swipe.extra !== 'object') swipe.extra = {};
        swipe.extra[SC_ID_KEY] = id;
    }
    return id;
}

export function buildIdIndex(chat) {
    const byId = new Map();
    const dups = new Set();
    for (let i = 0; i < chat.length; i++) {
        const id = getMessageId(chat[i]);
        if (!id) continue;
        if (byId.has(id)) dups.add(id);
        else byId.set(id, i);
    }
    return { byId, duplicates: [...dups] };
}

export function isHidden(msg) {
    return msg?.is_system === true || msg?.is_hidden === true;
}

export function isUserHidden(msg, ownedSet) {
    return isHidden(msg) && !ownedSet.has(getMessageId(msg));
}

export function selectGhostable(chat, start, end, ownedSet) {
    const out = [];
    const lo = Math.max(0, start);
    const hi = Math.min(end, chat.length - 1);
    for (let i = lo; i <= hi; i++) {
        if (chat[i] && !isUserHidden(chat[i], ownedSet)) out.push(i);
    }
    return out;
}

export function claimMessages(store, chat, indices, genId) {
    if (!Array.isArray(store.ownedIds)) store.ownedIds = [];
    const seen = new Set(store.ownedIds);
    const ids = [];
    for (const i of indices) {
        const msg = chat[i];
        if (!msg) continue;
        const id = ensureMessageId(msg, genId);
        if (!seen.has(id)) {
            seen.add(id);
            store.ownedIds.push(id);
        }
        msg.extra.sc_ghosted = true;
        ids.push(id);
    }
    return ids;
}

export function migrateOwnership(store, chat, genId) {
    if (Array.isArray(store.ownedIds)) return { migrated: false, count: 0 };
    let candidates = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sc_ghosted === true) candidates.push(i);
    }
    if (candidates.length === 0 && Array.isArray(store.ghostedIndices) && store.ghostedIndices.length > 0) {
        const set = new Set();
        for (const i of store.ghostedIndices) {
            if (Number.isInteger(i) && i >= 0 && i < chat.length && i <= store.summarizedUpTo) set.add(i);
        }
        candidates = [...set].sort((a, b) => a - b);
    }
    store.ownedIds = [];
    claimMessages(store, chat, candidates, genId);
    const s = store.summarizedUpTo;
    store.boundaryId = (Number.isInteger(s) && s >= 0 && s < chat.length)
        ? ensureMessageId(chat[s], genId)
        : null;
    return { migrated: true, count: candidates.length };
}

export function syncMirrors(store, chat) {
    const owned = new Set(store.ownedIds || []);
    const indices = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;
        const id = getMessageId(msg);
        if (id && owned.has(id)) {
            indices.push(i);
            if (!msg.extra) msg.extra = {};
            msg.extra.sc_ghosted = true;
        } else if (msg.extra && 'sc_ghosted' in msg.extra) {
            delete msg.extra.sc_ghosted;
        }
    }
    store.ghostedIndices = indices;
}

export function setBoundary(store, chat, index, genId) {
    store.summarizedUpTo = index;
    store.boundaryId = (Number.isInteger(index) && index >= 0 && index < chat.length)
        ? ensureMessageId(chat[index], genId)
        : null;
}
