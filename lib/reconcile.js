// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
// Pure planning of hide/unhide/release actions from ownership state.

import { buildIdIndex, getMessageId, isHidden } from './ownership.js';

export function toRuns(indices) {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const runs = [];
    for (const i of sorted) {
        const last = runs[runs.length - 1];
        if (last && i === last[1] + 1) last[1] = i;
        else runs.push([i, i]);
    }
    return runs;
}

export function resolveBoundary({ chat, ownedIds, summarizedUpTo, boundaryId }) {
    if (!Number.isInteger(summarizedUpTo) || summarizedUpTo < 0) return { boundary: -1, reason: null };
    const { byId } = buildIdIndex(chat);
    if (boundaryId) {
        if (byId.has(boundaryId)) {
            const j = byId.get(boundaryId);
            return { boundary: j, reason: j !== summarizedUpTo ? 'anchor' : null };
        }
        const cap = Math.min(summarizedUpTo, chat.length - 1);
        let fallback = -1;
        for (const id of ownedIds || []) {
            const idx = byId.get(id);
            if (idx !== undefined && idx <= cap && idx > fallback) fallback = idx;
        }
        return { boundary: fallback >= 0 ? fallback : cap, reason: 'anchor_lost' };
    }
    if (summarizedUpTo >= chat.length) return { boundary: chat.length - 1, reason: 'past_end' };
    return { boundary: summarizedUpTo, reason: null };
}

export function planReconcile({ chat, ownedIds, summarizedUpTo, boundaryId, disableGhosting }) {
    const ids = ownedIds || [];
    const ownedSet = new Set(ids);
    const { byId, duplicates } = buildIdIndex(chat);
    const { boundary, reason } = resolveBoundary({ chat, ownedIds: ids, summarizedUpTo, boundaryId });

    const toHide = [];
    const toUnhide = [];
    const release = [];
    const orphans = [];
    let owned = 0, ownedInRange = 0, actualHidden = 0;

    for (const id of ids) {
        const idx = byId.get(id);
        if (idx === undefined) { orphans.push(id); continue; }
        owned++;
        const inRange = idx <= boundary;
        const sys = chat[idx].is_system === true;
        if (inRange) {
            ownedInRange++;
            if (sys) actualHidden++;
        } else {
            release.push(id);
        }
        if (inRange && !sys && !disableGhosting) toHide.push(idx);
        if (sys && (!inRange || disableGhosting)) toUnhide.push(idx);
    }
    toHide.sort((a, b) => a - b);
    toUnhide.sort((a, b) => a - b);

    let userHiddenInRange = 0, unownedVisibleInRange = 0;
    for (let i = 0; i <= boundary && i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || ownedSet.has(getMessageId(msg))) continue;
        if (isHidden(msg)) userHiddenInRange++;
        else unownedVisibleInRange++;
    }

    return {
        boundary,
        boundaryReason: reason,
        pastEnd: Number.isInteger(summarizedUpTo) && summarizedUpTo >= chat.length,
        toHide,
        toUnhide,
        release,
        orphans,
        duplicates,
        stats: {
            owned,
            ownedInRange,
            actualHidden,
            expectedHidden: disableGhosting ? 0 : ownedInRange,
            mismatches: toHide.length + toUnhide.length,
            userHiddenInRange,
            unownedVisibleInRange,
        },
    };
}

export function applyReleaseAndOrphans(store, plan) {
    if (!Array.isArray(store.ownedIds)) return 0;
    const drop = new Set([...plan.release, ...plan.orphans]);
    const before = store.ownedIds.length;
    store.ownedIds = store.ownedIds.filter(id => !drop.has(id));
    return before - store.ownedIds.length;
}

export function findNotHidden(chat, indices) {
    return indices.filter(i => chat[i]?.is_system !== true);
}

export function findStillHidden(chat, indices) {
    return indices.filter(i => chat[i]?.is_system === true);
}
