// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
import { test } from 'node:test';
import assert from 'node:assert';
import {
    toRuns, resolveBoundary, planReconcile, applyReleaseAndOrphans, findNotHidden, findStillHidden,
} from '../lib/reconcile.js';

// Message with id; opts: sys (is_system true), hidden (is_hidden true), noSys (omit is_system)
const msg = (id, sys = false, extra = {}) => {
    const m = { mes: id, extra: { sc_id: id } };
    if (sys !== undefined) m.is_system = sys;
    return Object.assign(m, extra);
};
const plain = (mes, props = {}) => ({ mes, ...props });

test('toRuns', () => {
    assert.deepStrictEqual(toRuns([5, 1, 2, 3, 7, 8, 8]), [[1, 3], [5, 5], [7, 8]]);
    assert.deepStrictEqual(toRuns([]), []);
    assert.deepStrictEqual(toRuns([4]), [[4, 4]]);
});

test('basic: some owned in range not hidden go to toHide', () => {
    const chat = [msg('a', true), msg('b', false), msg('c', false), plain('d')];
    const p = planReconcile({ chat, ownedIds: ['a', 'b', 'c'], summarizedUpTo: 2, boundaryId: 'c' });
    assert.deepStrictEqual(p.toHide, [1, 2]);
    assert.deepStrictEqual(p.toUnhide, []);
    assert.deepStrictEqual(p.release, []);
    assert.strictEqual(p.boundary, 2);
    assert.strictEqual(p.boundaryReason, null);
    assert.strictEqual(p.pastEnd, false);
    assert.deepStrictEqual(p.stats, {
        owned: 3, ownedInRange: 3, actualHidden: 1, expectedHidden: 3, mismatches: 2,
        userHiddenInRange: 0, unownedVisibleInRange: 0,
    });
});

test('all hidden: no mismatches', () => {
    const chat = [msg('a', true), msg('b', true), plain('c')];
    const p = planReconcile({ chat, ownedIds: ['a', 'b'], summarizedUpTo: 1, boundaryId: 'b' });
    assert.strictEqual(p.stats.mismatches, 0);
    assert.strictEqual(p.stats.actualHidden, 2);
});

test('imported chat with no is_system keys', () => {
    const chat = [0, 1, 2].map(i => ({ mes: 'm' + i, extra: { sc_id: 'x' + i } }));
    const p = planReconcile({ chat, ownedIds: ['x0', 'x1', 'x2'], summarizedUpTo: 2, boundaryId: 'x2' });
    assert.deepStrictEqual(p.toHide, [0, 1, 2]);
});

test('user-hidden message in range is never touched', () => {
    const chat = [
        msg('a', false), plain('u1', { is_system: true }), plain('u2', { is_hidden: true }),
        plain('vis'), msg('b', false), plain('after'),
    ];
    const p = planReconcile({ chat, ownedIds: ['a', 'b'], summarizedUpTo: 4, boundaryId: 'b' });
    assert.deepStrictEqual(p.toHide, [0, 4]);
    assert.deepStrictEqual(p.toUnhide, []);
    assert.deepStrictEqual(p.release, []);
    assert.strictEqual(p.stats.userHiddenInRange, 2);
    assert.strictEqual(p.stats.unownedVisibleInRange, 1);
    const p2 = planReconcile({ chat, ownedIds: ['a', 'b'], summarizedUpTo: 4, boundaryId: 'b', disableGhosting: true });
    assert.deepStrictEqual(p2.toUnhide, []);
});

test('deleted message in range: orphan and anchor shift', () => {
    const chat = [msg('a', true), msg('b', true), msg('c', true), msg('d', true), plain('e')];
    chat.splice(1, 1);
    const p = planReconcile({ chat, ownedIds: ['a', 'b', 'c', 'd'], summarizedUpTo: 3, boundaryId: 'd' });
    assert.deepStrictEqual(p.orphans, ['b']);
    assert.strictEqual(p.boundary, 2);
    assert.strictEqual(p.boundaryReason, 'anchor');
    assert.strictEqual(p.stats.owned, 3);
    assert.deepStrictEqual(p.release, []);
});

test('boundary message deleted: anchor_lost', () => {
    const chat = [msg('a', true), plain('x'), msg('c', true), plain('y')];
    const ownedIds = ['a', 'b', 'c'];
    // 'b' was the boundary at index 1 and has been deleted
    const p = planReconcile({ chat, ownedIds, summarizedUpTo: 1, boundaryId: 'b' });
    assert.strictEqual(p.boundaryReason, 'anchor_lost');
    assert.strictEqual(p.boundary, 0);
    assert.deepStrictEqual(p.orphans, ['b']);
    assert.deepStrictEqual(p.release, ['c']);
    assert.deepStrictEqual(p.toUnhide, [2]);
});

test('anchor_lost with no owned candidates uses clamped summarizedUpTo', () => {
    const chat = [plain('a'), plain('b')];
    assert.deepStrictEqual(
        resolveBoundary({ chat, ownedIds: [], summarizedUpTo: 5, boundaryId: 'zz' }),
        { boundary: 1, reason: 'anchor_lost' });
});

test('past end without boundaryId', () => {
    const chat = [msg('a', false), msg('b', false)];
    const p = planReconcile({ chat, ownedIds: ['a', 'b'], summarizedUpTo: 9, boundaryId: null });
    assert.strictEqual(p.pastEnd, true);
    assert.strictEqual(p.boundaryReason, 'past_end');
    assert.strictEqual(p.boundary, 1);
    assert.deepStrictEqual(p.toHide, [0, 1]);
});

test('anchor resolving at same index has null reason', () => {
    const chat = [msg('a'), msg('b')];
    assert.deepStrictEqual(
        resolveBoundary({ chat, ownedIds: [], summarizedUpTo: 1, boundaryId: 'b' }),
        { boundary: 1, reason: null });
    assert.deepStrictEqual(
        resolveBoundary({ chat, ownedIds: [], summarizedUpTo: 0, boundaryId: null }),
        { boundary: 0, reason: null });
});

test('hidden owned beyond boundary: unhide and release', () => {
    const chat = [msg('a', true), msg('b', true), msg('c', true), plain('d')];
    const p = planReconcile({ chat, ownedIds: ['a', 'b', 'c'], summarizedUpTo: 1, boundaryId: 'b' });
    assert.deepStrictEqual(p.toUnhide, [2]);
    assert.deepStrictEqual(p.release, ['c']);
    assert.deepStrictEqual(p.toHide, []);
});

test('disableGhosting', () => {
    const chat = [msg('a', true), msg('b', false), msg('c', true), msg('d', true)];
    const ownedIds = ['a', 'b', 'c', 'd'];
    const p = planReconcile({ chat, ownedIds, summarizedUpTo: 1, boundaryId: 'b', disableGhosting: true });
    assert.deepStrictEqual(p.toHide, []);
    assert.deepStrictEqual(p.toUnhide, [0, 2, 3]);
    assert.deepStrictEqual(p.release, ['c', 'd']);
    assert.strictEqual(p.stats.expectedHidden, 0);
    assert.strictEqual(p.stats.ownedInRange, 2);

    // switching back off, state after unhide
    const chat2 = [msg('a', false), msg('b', false), msg('c', false)];
    const p2 = planReconcile({ chat: chat2, ownedIds: ['a', 'b'], summarizedUpTo: 1, boundaryId: 'b', disableGhosting: false });
    assert.deepStrictEqual(p2.toHide, [0, 1]);
    assert.deepStrictEqual(p2.toUnhide, []);
});

test('summarizedUpTo -1 releases everything', () => {
    const chat = [msg('a', true), msg('b', false)];
    const p = planReconcile({ chat, ownedIds: ['a', 'b'], summarizedUpTo: -1, boundaryId: null });
    assert.strictEqual(p.boundary, -1);
    assert.strictEqual(p.boundaryReason, null);
    assert.deepStrictEqual(p.release, ['a', 'b']);
    assert.deepStrictEqual(p.toUnhide, [0]);
    assert.deepStrictEqual(p.toHide, []);
    assert.strictEqual(p.stats.ownedInRange, 0);
});

test('duplicates are reported', () => {
    const chat = [msg('a'), msg('a')];
    const p = planReconcile({ chat, ownedIds: ['a'], summarizedUpTo: 1, boundaryId: null });
    assert.deepStrictEqual(p.duplicates, ['a']);
});

test('planReconcile does not mutate inputs', () => {
    const chat = [msg('a', true), msg('b', false), plain('u', { is_system: true }), msg('c', true), plain('d')];
    const ownedIds = ['a', 'b', 'gone', 'c'];
    const snapChat = structuredClone(chat);
    const snapIds = [...ownedIds];
    planReconcile({ chat, ownedIds, summarizedUpTo: 1, boundaryId: 'b', disableGhosting: false });
    planReconcile({ chat, ownedIds, summarizedUpTo: 1, boundaryId: 'b', disableGhosting: true });
    assert.deepStrictEqual(chat, snapChat);
    assert.deepStrictEqual(ownedIds, snapIds);
});

test('applyReleaseAndOrphans', () => {
    const store = { ownedIds: ['a', 'b', 'c', 'd'] };
    const n = applyReleaseAndOrphans(store, { release: ['c'], orphans: ['b', 'zz'] });
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(store.ownedIds, ['a', 'd']);
});

test('findNotHidden / findStillHidden', () => {
    const chat = [{ is_system: true }, {}, { is_system: false }, { is_system: true }];
    assert.deepStrictEqual(findNotHidden(chat, [0, 1, 2, 3]), [1, 2]);
    assert.deepStrictEqual(findStillHidden(chat, [0, 1, 2, 3]), [0, 3]);
    assert.deepStrictEqual(findNotHidden(chat, []), []);
});
