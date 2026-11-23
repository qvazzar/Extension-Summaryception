// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
import { test } from 'node:test';
import assert from 'node:assert';
import {
    SC_ID_KEY, getMessageId, ensureMessageId, buildIdIndex, isHidden, isUserHidden,
    selectGhostable, claimMessages, migrateOwnership, syncMirrors, setBoundary,
} from '../lib/ownership.js';

const mkGen = () => { let n = 0; return () => 'id' + (++n); };

test('SC_ID_KEY and getMessageId', () => {
    assert.strictEqual(SC_ID_KEY, 'sc_id');
    assert.strictEqual(getMessageId({ extra: { sc_id: 'a' } }), 'a');
    assert.strictEqual(getMessageId({ extra: { sc_id: '' } }), null);
    assert.strictEqual(getMessageId({ extra: { sc_id: 5 } }), null);
    assert.strictEqual(getMessageId({}), null);
    assert.strictEqual(getMessageId(undefined), null);
});

test('ensureMessageId creates extra and keeps existing id', () => {
    const genId = mkGen();
    const m = { mes: 'x' };
    assert.strictEqual(ensureMessageId(m, genId), 'id1');
    assert.strictEqual(m.extra.sc_id, 'id1');
    assert.strictEqual(ensureMessageId(m, genId), 'id1');
    assert.strictEqual(genId(), 'id2');
    assert.strictEqual(ensureMessageId({ extra: { sc_id: 'keep' } }, genId), 'keep');
});

test('ensureMessageId mirrors into swipe_info', () => {
    const genId = mkGen();
    const m = { mes: 'x', swipe_id: 1, swipe_info: [{}, {}] };
    const id = ensureMessageId(m, genId);
    assert.strictEqual(m.swipe_info[1].extra.sc_id, id);
    assert.strictEqual(m.swipe_info[0].extra, undefined);
    const m2 = { mes: 'y', swipe_id: 0, swipe_info: [{ extra: { a: 1 } }] };
    const id2 = ensureMessageId(m2, genId);
    assert.deepStrictEqual(m2.swipe_info[0].extra, { a: 1, sc_id: id2 });
});

test('ensureMessageId without swipe_info', () => {
    const m = { mes: 'x', swipe_id: 0 };
    ensureMessageId(m, mkGen());
    assert.strictEqual('swipe_info' in m, false);
});

test('buildIdIndex reports duplicates', () => {
    const chat = [
        { extra: { sc_id: 'a' } }, { mes: 'no id' }, { extra: { sc_id: 'a' } },
        { extra: { sc_id: 'b' } }, { extra: { sc_id: 'a' } },
    ];
    const { byId, duplicates } = buildIdIndex(chat);
    assert.strictEqual(byId.get('a'), 0);
    assert.strictEqual(byId.get('b'), 3);
    assert.strictEqual(byId.size, 2);
    assert.deepStrictEqual(duplicates, ['a']);
});

test('isHidden / isUserHidden', () => {
    assert.strictEqual(isHidden({ is_system: true }), true);
    assert.strictEqual(isHidden({ is_hidden: true }), true);
    assert.strictEqual(isHidden({ is_system: false }), false);
    assert.strictEqual(isHidden({}), false);
    assert.strictEqual(isUserHidden({ is_system: true }, new Set()), true);
    assert.strictEqual(isUserHidden({ is_system: true, extra: { sc_id: 'a' } }, new Set(['a'])), false);
    assert.strictEqual(isUserHidden({}, new Set()), false);
});

test('selectGhostable', () => {
    const chat = [
        { mes: 'a', is_user: true },
        { mes: 'b', is_system: true },
        { mes: 'c', is_hidden: true },
        { mes: 'd', is_system: true, extra: { sc_id: 'own' } },
        { mes: '' },
        { mes: 'f', is_system: false },
    ];
    const owned = new Set(['own']);
    assert.deepStrictEqual(selectGhostable(chat, 0, 5, owned), [0, 3, 4, 5]);
    assert.deepStrictEqual(selectGhostable(chat, -3, 100, owned), [0, 3, 4, 5]);
    assert.deepStrictEqual(selectGhostable(chat, 4, 4, owned), [4]);
    assert.deepStrictEqual(selectGhostable(chat, 6, 9, owned), []);
});

test('claimMessages', () => {
    const genId = mkGen();
    const chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }];
    const store = {};
    assert.deepStrictEqual(claimMessages(store, chat, [0, 2], genId), ['id1', 'id2']);
    assert.deepStrictEqual(store.ownedIds, ['id1', 'id2']);
    assert.strictEqual(chat[0].extra.sc_ghosted, true);
    claimMessages(store, chat, [0, 1], genId);
    assert.deepStrictEqual(store.ownedIds, ['id1', 'id2', 'id3']);
});

test('migrateOwnership from sc_ghosted flags, no is_system keys', () => {
    const genId = mkGen();
    const chat = [
        { mes: 'a', extra: { sc_ghosted: true } },
        { mes: 'b', extra: { sc_ghosted: true } },
        { mes: 'c' },
    ];
    const store = { summarizedUpTo: 1, ghostedIndices: [0, 1] };
    assert.deepStrictEqual(migrateOwnership(store, chat, genId), { migrated: true, count: 2 });
    assert.strictEqual(store.ownedIds.length, 2);
    assert.strictEqual(store.boundaryId, getMessageId(chat[1]));
    assert.strictEqual(store.ownedIds[1], store.boundaryId);
});

test('migrateOwnership falls back to ghostedIndices only when no flags', () => {
    const chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }, { mes: 'd' }];
    const store = { summarizedUpTo: 2, ghostedIndices: [2, 0, 0, 9, -1, 3, 1.5] };
    const r = migrateOwnership(store, chat, mkGen());
    assert.deepStrictEqual(r, { migrated: true, count: 2 });
    assert.strictEqual(chat[0].extra.sc_ghosted, true);
    assert.strictEqual(chat[2].extra.sc_ghosted, true);
    assert.strictEqual(chat[3].extra?.sc_ghosted, undefined);

    const chat2 = [{ mes: 'a', extra: { sc_ghosted: true } }, { mes: 'b' }];
    const s2 = { summarizedUpTo: 1, ghostedIndices: [1] };
    assert.strictEqual(migrateOwnership(s2, chat2, mkGen()).count, 1);
    assert.strictEqual(chat2[1].extra?.sc_ghosted, undefined);
});

test('migrateOwnership is idempotent', () => {
    const chat = [{ mes: 'a', extra: { sc_ghosted: true } }, { mes: 'b' }];
    const store = { summarizedUpTo: 0 };
    const genId = mkGen();
    migrateOwnership(store, chat, genId);
    const before = [...store.ownedIds];
    chat[1].extra = { sc_ghosted: true };
    assert.deepStrictEqual(migrateOwnership(store, chat, genId), { migrated: false, count: 0 });
    assert.deepStrictEqual(store.ownedIds, before);
});

test('migrateOwnership with summarizedUpTo past end gives null boundaryId', () => {
    const chat = [{ mes: 'a' }];
    const store = { summarizedUpTo: 5 };
    migrateOwnership(store, chat, mkGen());
    assert.strictEqual(store.boundaryId, null);
    assert.deepStrictEqual(store.ownedIds, []);
    const s2 = { summarizedUpTo: -1 };
    migrateOwnership(s2, chat, mkGen());
    assert.strictEqual(s2.boundaryId, null);
});

test('syncMirrors', () => {
    const chat = [
        { mes: 'a', extra: { sc_id: 'a', sc_ghosted: true } },
        { mes: 'b', extra: { sc_id: 'b', sc_ghosted: true } },
        { mes: 'c', extra: { sc_id: 'c' } },
        { mes: 'd' },
    ];
    const store = { ownedIds: ['a', 'c', 'gone'], ghostedIndices: [9] };
    syncMirrors(store, chat);
    assert.deepStrictEqual(store.ghostedIndices, [0, 2]);
    assert.strictEqual(chat[0].extra.sc_ghosted, true);
    assert.strictEqual('sc_ghosted' in chat[1].extra, false);
    assert.strictEqual(chat[1].extra.sc_id, 'b');
    assert.strictEqual(chat[2].extra.sc_ghosted, true);
});

test('setBoundary', () => {
    const chat = [{ mes: 'a' }, { mes: 'b' }];
    const store = {};
    const genId = mkGen();
    setBoundary(store, chat, 1, genId);
    assert.strictEqual(store.summarizedUpTo, 1);
    assert.strictEqual(store.boundaryId, chat[1].extra.sc_id);
    setBoundary(store, chat, 7, genId);
    assert.strictEqual(store.summarizedUpTo, 7);
    assert.strictEqual(store.boundaryId, null);
    setBoundary(store, chat, -1, genId);
    assert.strictEqual(store.boundaryId, null);
});
