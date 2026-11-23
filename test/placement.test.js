// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
import { test } from 'node:test';
import assert from 'node:assert';
import {
    PROMPT_TYPES, PROMPT_ROLES, normalizePlacement, buildInjectionArgs, injectionSignature,
} from '../lib/placement.js';

const mk = (p, d, r) => ({ injectionPosition: p, injectionDepth: d, injectionRole: r });

test('defaults', () => {
    assert.deepStrictEqual(normalizePlacement({}), { position: 'in_chat', depth: 0, role: 'user' });
    assert.deepStrictEqual(normalizePlacement(undefined), { position: 'in_chat', depth: 0, role: 'user' });
});

test('four modes', () => {
    let a = buildInjectionArgs(mk('before_prompt', 5, 'system'), 'x');
    assert.deepStrictEqual(a, { value: 'x', position: PROMPT_TYPES.BEFORE_PROMPT, depth: 0, scan: false, role: PROMPT_ROLES.SYSTEM, macroOnly: false });
    a = buildInjectionArgs(mk('in_prompt', 5, 'assistant'), 'x');
    assert.strictEqual(a.position, PROMPT_TYPES.IN_PROMPT);
    assert.strictEqual(a.depth, 0);
    assert.strictEqual(a.role, PROMPT_ROLES.ASSISTANT);
    a = buildInjectionArgs(mk('in_chat', 3, 'user'), 'x');
    assert.deepStrictEqual(a, { value: 'x', position: PROMPT_TYPES.IN_CHAT, depth: 3, scan: false, role: PROMPT_ROLES.USER, macroOnly: false });
    a = buildInjectionArgs(mk('macro_only', 3, 'user'), 'text');
    assert.deepStrictEqual(a, { value: '', position: PROMPT_TYPES.NONE, depth: 0, scan: false, role: PROMPT_ROLES.SYSTEM, macroOnly: true });
});

test('depth normalization', () => {
    const d = v => normalizePlacement(mk('in_chat', v, 'user')).depth;
    assert.strictEqual(d('3'), 3);
    assert.strictEqual(d(-5), 0);
    assert.strictEqual(d(2.7), 2);
    assert.strictEqual(d(NaN), 0);
    assert.strictEqual(d('abc'), 0);
    assert.strictEqual(d(1e9), 10000);
    assert.strictEqual(d(Infinity), 0);
});

test('invalid position/role fall back', () => {
    assert.deepStrictEqual(normalizePlacement(mk('bogus', 1, 'nope')), { position: 'in_chat', depth: 1, role: 'user' });
});

test('empty text', () => {
    assert.strictEqual(buildInjectionArgs(mk('in_chat', 0, 'user'), '').value, '');
    assert.strictEqual(buildInjectionArgs(mk('in_chat', 0, 'user'), undefined).value, '');
    assert.strictEqual(buildInjectionArgs(mk('in_chat', 0, 'user'), 42).value, '');
});

test('signature', () => {
    const sig = (p, d, r) => injectionSignature(buildInjectionArgs(mk(p, d, r), 'same'));
    const base = sig('in_chat', 1, 'user');
    assert.strictEqual(base, sig('in_chat', 1, 'user'));
    assert.notStrictEqual(base, sig('in_prompt', 1, 'user'));
    assert.notStrictEqual(base, sig('in_chat', 1, 'system'));
    assert.notStrictEqual(base, sig('in_chat', 2, 'user'));
});
