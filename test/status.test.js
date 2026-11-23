// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusLines, formatStatusText } from '../lib/status.js';
import { planReconcile } from '../lib/reconcile.js';

const base = () => ({
    enabled: true, paused: false,
    store: { layers: [], summarizedUpTo: -1, boundaryId: null },
    snippetsPerLayer: 20, plan: null, disableGhosting: false,
    placement: { position: 'in_chat', depth: 2, role: 'user' },
    threshold: 0, lastThresholdCheck: null, now: 100000,
});
const text = (o) => formatStatusText(buildStatusLines({ ...base(), ...o }));

test('not migrated, empty layers, boundary none', () => {
    const t = text({});
    assert.match(t, /^Summaryception status\nExtension: enabled\n/);
    assert.match(t, /Summarized boundary: none \(-1\)/);
    assert.match(t, /\(no snippets yet\)/);
    assert.match(t, /Ownership: not migrated yet/);
    assert.match(t, /Hiding: enabled/);
});

test('paused and disabled', () => {
    assert.match(text({ enabled: false, paused: true }), /Extension: disabled \(paused\)/);
});

test('boundary with anchor and layers high to low', () => {
    const t = text({ store: { layers: [[1, 2, 3], [], [1]], summarizedUpTo: 5, boundaryId: 'abcdefghijk' } });
    assert.match(t, /index 5 \(anchored to message ID abcdefgh\)/);
    assert.ok(t.indexOf('Layer 2: 1 / 20') < t.indexOf('Layer 0 (turn summaries): 3 / 20'));
    assert.doesNotMatch(t, /Layer 1/);
});

test('mismatches via planReconcile', () => {
    const chat = [
        { extra: { sc_id: 'a' }, is_system: false },
        { extra: { sc_id: 'b' }, is_system: true },
        { is_system: false },
    ];
    const plan = planReconcile({ chat, ownedIds: ['a', 'b', 'gone'], summarizedUpTo: 0, boundaryId: null, disableGhosting: false });
    const t = text({ plan });
    assert.match(t, /Owned messages \(metadata\): 2/);
    assert.match(t, new RegExp(`Mismatches: ${plan.stats.mismatches} \\(to hide: ${plan.toHide.length}, to unhide: ${plan.toUnhide.length}\\) — run Repair`));
    assert.match(t, /Orphaned IDs: 1/);
});

test('plan without mismatches omits optional lines; boundary reason shown', () => {
    const plan = { boundary: 3, boundaryReason: 'past_end', orphans: [], toHide: [], toUnhide: [],
        stats: { owned: 1, actualHidden: 1, expectedHidden: 1, mismatches: 0, userHiddenInRange: 0, unownedVisibleInRange: 0 } };
    const t = text({ plan });
    assert.match(t, /Mismatches: 0\n/);
    assert.doesNotMatch(t, /Orphaned|Hidden by user|Unowned/);
    assert.match(t, /Boundary needs correction: past_end → index 3/);
    plan.stats.userHiddenInRange = 2; plan.stats.unownedVisibleInRange = 4;
    assert.match(text({ plan }), /Hidden by user\/other extension in range: 2\nUnowned visible in range: 4/);
});

test('disableGhosting', () => {
    assert.match(text({ disableGhosting: true }), /Hiding: DISABLED \(compatibility mode/);
});

test('placement labels', () => {
    assert.match(text({}), /Placement: In Chat \(depth 2\)\nRole: user/);
    assert.match(text({ placement: { position: 'before_prompt', depth: 0, role: 'system' } }), /Placement: Before Prompt\nRole: system/);
    assert.match(text({ placement: { position: 'in_prompt', depth: 0, role: 'assistant' } }), /Placement: In Prompt\nRole: assistant/);
    const m = text({ placement: { position: 'macro_only', depth: 0, role: 'user' } });
    assert.match(m, /Placement: Macro Only \(\{\{summaryception\}\}\)/);
    assert.doesNotMatch(m, /Role:/);
});

test('threshold variants', () => {
    assert.match(text({}), /Token threshold: off/);
    assert.match(text({ threshold: 500 }), /Token threshold: 500 tokens\nLast check: not evaluated yet/);
    const at = 90000;
    assert.match(text({ threshold: 500, lastThresholdCheck: { threshold: 500, visibleTokens: 800, met: true, at } }),
        /Last check: 800 visible tokens → met \(10s ago\)/);
    assert.match(text({ threshold: 500, lastThresholdCheck: { threshold: 500, visibleTokens: 100, met: false, at } }),
        /100 visible tokens → not met/);
    assert.match(text({ threshold: 500, lastThresholdCheck: { threshold: 500, visibleTokens: null, met: true, at } }),
        /tokenizer unavailable → met/);
});
