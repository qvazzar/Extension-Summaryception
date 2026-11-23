// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
import test from 'node:test';
import assert from 'node:assert';
import {
    normalizeThreshold,
    collectVisibleTexts,
    shouldRunBatch,
    countVisibleTokens,
} from '../lib/threshold.js';

test('normalizeThreshold', () => {
    assert.strictEqual(normalizeThreshold('500'), 500);
    assert.strictEqual(normalizeThreshold(-1), 0);
    assert.strictEqual(normalizeThreshold('x'), 0);
    assert.strictEqual(normalizeThreshold(2.9), 2);
    assert.strictEqual(normalizeThreshold(undefined), 0);
});

test('collectVisibleTexts filters correctly', () => {
    const chat = [
        { mes: 'a', is_system: true },
        { mes: 'b' },
        { mes: '   ' },
        { mes: '' },
        { mes: 'c', is_system: false },
        { is_system: false },
    ];
    assert.deepStrictEqual(collectVisibleTexts(chat), ['b', 'c']);
});

test('shouldRunBatch', () => {
    assert.strictEqual(shouldRunBatch({ turnConditionMet: false, threshold: 0, visibleTokens: 999 }), false);
    assert.strictEqual(shouldRunBatch({ turnConditionMet: true, threshold: 0, visibleTokens: 1 }), true);
    assert.strictEqual(shouldRunBatch({ turnConditionMet: true, threshold: 100, visibleTokens: 100 }), false);
    assert.strictEqual(shouldRunBatch({ turnConditionMet: true, threshold: 100, visibleTokens: 101 }), true);
    assert.strictEqual(shouldRunBatch({ turnConditionMet: true, threshold: 100, visibleTokens: null }), true);
    assert.strictEqual(shouldRunBatch({ turnConditionMet: true, threshold: 100 }), true);
});

test('countVisibleTokens', async () => {
    const chat = [{ mes: 'abc' }, { mes: 'hidden', is_system: true }, { mes: 'de' }];
    assert.strictEqual(await countVisibleTokens(chat, async (t) => t.length), 5);
    assert.strictEqual(await countVisibleTokens(chat, async (t) => (t === 'abc' ? NaN : 2)), 2);
    assert.strictEqual(await countVisibleTokens([], async (t) => t.length), 0);
});
