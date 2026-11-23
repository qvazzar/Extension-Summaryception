// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
// Pure helpers for the optional token-threshold gate on automatic batching.

export function normalizeThreshold(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
}

export function collectVisibleTexts(chat) {
    const out = [];
    if (!Array.isArray(chat)) return out;
    for (const m of chat) {
        if (!m || m.is_system === true) continue;
        if (typeof m.mes !== 'string' || m.mes.trim() === '') continue;
        out.push(m.mes);
    }
    return out;
}

export function shouldRunBatch({ turnConditionMet, threshold, visibleTokens } = {}) {
    if (!turnConditionMet) return false;
    const t = normalizeThreshold(threshold);
    if (t === 0) return true;
    if (visibleTokens === null || visibleTokens === undefined) return true;
    return visibleTokens > t;
}

export async function countVisibleTokens(chat, countFn) {
    const texts = collectVisibleTexts(chat);
    const counts = await Promise.all(texts.map(async (t) => Number(await countFn(t))));
    return counts.reduce((a, c) => a + (Number.isFinite(c) ? c : 0), 0);
}
