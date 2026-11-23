// Part of the Summaryception fork by qvazzar. Licensed under AGPL-3.0.
// Pure status-report builder (no SillyTavern, no DOM).

const POSITION_LABELS = {
    before_prompt: 'Before Prompt',
    in_prompt: 'In Prompt',
};

function placementLabel(placement) {
    const p = placement || {};
    if (p.position === 'in_chat') return `In Chat (depth ${p.depth})`;
    if (p.position === 'macro_only') return 'Macro Only ({{summaryception}})';
    return POSITION_LABELS[p.position] || String(p.position);
}

export function buildStatusLines(input) {
    const {
        enabled, paused, store, snippetsPerLayer, plan, disableGhosting,
        placement, threshold, lastThresholdCheck, now,
    } = input;
    const st = store || {};
    const lines = [];

    lines.push('Summaryception status');
    lines.push(`Extension: ${enabled ? 'enabled' : 'disabled'}${paused ? ' (paused)' : ''}`);

    const up = Number.isInteger(st.summarizedUpTo) ? st.summarizedUpTo : -1;
    let b = up < 0 ? 'Summarized boundary: none (-1)' : `Summarized boundary: index ${up}`;
    if (st.boundaryId) b += ` (anchored to message ID ${String(st.boundaryId).slice(0, 8)})`;
    lines.push(b);
    if (plan && plan.boundaryReason) {
        lines.push(`Boundary needs correction: ${plan.boundaryReason} → index ${plan.boundary}`);
    }

    lines.push('Snippets per layer:');
    const layers = Array.isArray(st.layers) ? st.layers : [];
    let any = false;
    for (let i = layers.length - 1; i >= 0; i--) {
        const n = Array.isArray(layers[i]) ? layers[i].length : 0;
        if (n === 0) continue;
        any = true;
        lines.push(`  Layer ${i}${i === 0 ? ' (turn summaries)' : ''}: ${n} / ${snippetsPerLayer}`);
    }
    if (!any) lines.push('  (no snippets yet)');

    lines.push(disableGhosting
        ? 'Hiding: DISABLED (compatibility mode, summarized messages stay in the LLM prompt)'
        : 'Hiding: enabled');

    if (!plan) {
        lines.push('Ownership: not migrated yet (happens on chat load)');
    } else {
        const s = plan.stats;
        lines.push(`Owned messages (metadata): ${s.owned}`);
        lines.push(`Actually hidden: ${s.actualHidden} / expected ${s.expectedHidden}`);
        let m = `Mismatches: ${s.mismatches}`;
        if (s.mismatches > 0) {
            m += ` (to hide: ${plan.toHide.length}, to unhide: ${plan.toUnhide.length}) — run Repair`;
        }
        lines.push(m);
        if (plan.orphans.length > 0) lines.push(`Orphaned IDs: ${plan.orphans.length}`);
        if (s.userHiddenInRange > 0) lines.push(`Hidden by user/other extension in range: ${s.userHiddenInRange}`);
        if (s.unownedVisibleInRange > 0) lines.push(`Unowned visible in range: ${s.unownedVisibleInRange}`);
    }

    const pl = placement || {};
    lines.push(`Placement: ${placementLabel(pl)}`);
    if (pl.position !== 'macro_only') lines.push(`Role: ${pl.role}`);

    if (!(threshold > 0)) {
        lines.push('Token threshold: off');
    } else {
        lines.push(`Token threshold: ${threshold} tokens`);
        if (lastThresholdCheck) {
            const tokens = lastThresholdCheck.visibleTokens == null
                ? 'tokenizer unavailable'
                : `${lastThresholdCheck.visibleTokens} visible tokens`;
            const secs = Math.max(0, Math.round((now - lastThresholdCheck.at) / 1000));
            lines.push(`Last check: ${tokens} → ${lastThresholdCheck.met ? 'met' : 'not met'} (${secs}s ago)`);
        } else {
            lines.push('Last check: not evaluated yet');
        }
    }
    return lines;
}

export function formatStatusText(lines) {
    return lines.join('\n');
}
