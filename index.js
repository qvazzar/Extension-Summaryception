/**
 * Summaryception v5.5.4 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

// ─── Imports ─────────────────────────────────────────────────────────
import {
    sendSummarizerRequest,
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
    getConnectionDisplayName,
} from './connectionutil.js';
import {
    PLACEMENT_DEFAULTS,
    normalizePlacement,
    buildInjectionArgs,
    injectionSignature,
} from './lib/placement.js';
import {
    isUserHidden,
    buildIdIndex,
    selectGhostable,
    claimMessages,
    migrateOwnership,
    syncMirrors,
    setBoundary,
} from './lib/ownership.js';
import {
    toRuns,
    planReconcile,
    applyReleaseAndOrphans,
    findNotHidden,
    findStillHidden,
} from './lib/reconcile.js';
import {
    normalizeThreshold,
    shouldRunBatch,
    countVisibleTokens,
} from './lib/threshold.js';

import { buildStatusLines, formatStatusText } from './lib/status.js';

const MODULE_NAME = 'summaryception';
const LOG_PREFIX = '[Summaryception]';
// const TRACE_MODE = true;  // ultra-verbose logging

// ═══════════════════════════════════════════════════════════════════════
//  TUNING — Centralised operational constants.
//  Change these instead of hunting through function bodies.
// ═══════════════════════════════════════════════════════════════════════

const TUNING = Object.freeze({

    // ── Retry / Resilience ─────────────────────────────────────────
    maxRetries:               5,        // LLM call retry attempts before giving up
    retryBaseDelay:           2_000,    // ms — initial back-off delay
    retryMaxDelay:            60_000,   // ms — ceiling for exponential back-off
    retryBackoffMultiplier:   2,        // exponential growth factor
    retryableStatuses:        [429, 500, 502, 503, 504],
    llmRequestTimeout:        120_000,  // ms — per-request hard timeout
    consecutiveFailureLimit:  3,        // catchup aborts after this many failures in a row

    // ── Backlog / Catchup ──────────────────────────────────────────
    backlogMultiplier:        2,        // overflow > turnsPerSummary × this triggers catchup dialog

    // ── Event Debouncing ───────────────────────────────────────────
    messageReceivedDelay:     500,      // ms — delay after new message before summarisation check
    chatChangedDelay:         100,      // ms — delay after chat switch before UI refresh
    catchupInterBatchDelay:   200,      // ms — breathing room between catchup batches

    // ── Progress Reporting ─────────────────────────────────────────
    ghostProgressInterval:    10,       // update toast every N messages during ghost/unghost
    repairProgressInterval:   5,        // update toast every N messages during repair scan

    // ── Toast Durations (ms) ───────────────────────────────────────
    // Named by intent so you can tune notification verbosity in one place.
    toastShort:               1_500,
    toastDefault:             2_000,
    toastMedium:              3_000,
    toastLong:                4_000,
    toastLonger:              5_000,
    toastExtended:            6_000,
    toastError:               8_000,

    // ── Connection UI ──────────────────────────────────────────────
    connectionStatusTimeout:  8_000,    // ms — auto-hide the status indicator
    stopButtonCooldown:       2_000,    // ms — brief disable after clicking Stop
});

// Legacy alias — keeps RETRY_CONFIG references readable without a noisy diff.
const RETRY_CONFIG = Object.freeze({
    maxRetries:         TUNING.maxRetries,
    baseDelay:          TUNING.retryBaseDelay,
    maxDelay:           TUNING.retryMaxDelay,
    backoffMultiplier:  TUNING.retryBackoffMultiplier,
    retryableStatuses:  TUNING.retryableStatuses,
});

// ─── Default Settings ────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    verbatimTurns: 10,
    turnsPerSummary: 3,
    tokenThreshold: 0,
    snippetsPerLayer: 20,
    snippetsPerPromotion: 3,
    maxLayers: 5,
    injectionPosition: PLACEMENT_DEFAULTS.injectionPosition,
    injectionDepth: PLACEMENT_DEFAULTS.injectionDepth,
    injectionRole: PLACEMENT_DEFAULTS.injectionRole,
    injectionTemplate: '\n\n<auto_injected_historical_context>\n[system guidance: this is a historical summary of messages that occurred prior to the oldest assistant message currently in context for this chat]\n{{summary}}\n</auto_injected_historical_context>\n\n',

    summarizerSystemPrompt:
        'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt:
        `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`,

    promptPreset: 'narrative',  // 'narrative' | 'gamestate' | 'custom'
    savedCustomPrompts: {},        // { name: promptText } — named custom prompt slots
    lastCustomPrompt: '',          // Auto-saved when switching away from custom
    pauseSummarization: false,  // true = stop processing, keep injecting
    disableGhosting: false,  // true = still summarize and track messages, but don't set is_system (they stay in the LLM prompt)

    stripPatterns: [
        '<|channel>thought',
        '<channel|>',
        '<output>',
        '</output>',
        '<thinking>',
        '</thinking>',
    ],

    debugMode: false,
    traceMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default',          // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerResponseLength: 0,          // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
    connectionProfileId: '',              // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [],                // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0,                   // 0 = no limit (provider default)
});

// ─── Prompt Presets ──────────────────────────────────────────────────

const PROMPT_PRESETS = {
    narrative: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the final response instead of 'you'.

IF prior_context has no content: include establishing details in the generated summary, extend the maximum number of short phrases up to 40.

Priority Elements: Time + location changes + narrative themes and subtext + sensory details that establish tone + atmosphere + mood + plot developments + proper names + character motivations + character interactions + dialogue tone + relationship dynamics + emotional beats + unresolved tensions.

Exclude anything insubstantial, fluff, or events already covered in prior_context.

Write in short *phrases* — up to 20; final response must be a single line:`,

    gamestate: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

Focus on: story progression, plot points, plans, tasks, quests; location changes and current location (reference by name); location interactables encountered, used, or discovered; significant changes to player, NPCs, locations, world, or setting.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

    custom: null, // Uses whatever is in the textarea
};

const DEFAULT_PROMPT_PRESET = 'narrative';

// ─── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(error) {
    try {
        const retryAfter = error?.response?.headers?.['retry-after']
            || error?.retryAfter
            || error?.data?.retry_after;
        if (!retryAfter) return null;
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (e) { /* ignore */ }
    return null;
}

function isRetryableError(error) {
    if (error?.name === 'AbortError') return false;

    // ConnectionError from connectionutil.js carries an explicit retryable flag.
    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }

    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) return true;
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('server error')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('overloaded')) return true;
    if (msg.includes('capacity')) return true;
    return false;
}

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function trace(...args) {
    const s = getSettings();
    if (s.debugMode && s.traceMode) {
        const normalized = args.map((arg, idx) => (idx === 0 && typeof arg === 'string')
            ? arg.toUpperCase()
            : arg);
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

function debugVisibleTurns(chat, store) {
    trace('=== DEBUG VISIBLE TURNS ===');
    trace('  store.summarizedUpTo:', store.summarizedUpTo);
    trace('  Total chat messages:', chat.length);

    let visibleCount = 0;
    let ghostedCount = 0;
    let hiddenCount = 0;
    let visibleIndices = [];

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes?.trim()?.length > 0) {
            visibleCount++;
            visibleIndices.push(i);
        }
        if (m.extra?.sc_ghosted) ghostedCount++;
        if (m.is_hidden || m.is_system) hiddenCount++;
    }

    trace('  Visible non-ghosted turns:', visibleCount);
    trace('  Ghosted turns:', ghostedCount);
    trace('  Hidden/System turns:', hiddenCount);
    trace('  First 10 visible indices:', visibleIndices.slice(0, 10));
    trace('  Last 10 visible indices:', visibleIndices.slice(-10));

    // Check for messages that should have been ghosted but aren't
    const unghosteredSummarized = visibleIndices.filter(idx => idx <= store.summarizedUpTo);
    if (unghosteredSummarized.length > 0) {
        trace('  ⚠️ WARNING: Found ' + unghosteredSummarized.length + ' visible messages that are BEFORE summarizedUpTo!');
        trace('  First 5 unghostered summarized indices:', unghosteredSummarized.slice(0, 5));
    }
    trace('=== END DEBUG ===');
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
            ownedIds: [],
            boundaryId: null,
        };
    }
    const store = chatMetadata[MODULE_NAME];

    // Existing migrations
    if (!Array.isArray(store.layers)) store.layers = [];
    if (!Array.isArray(store.ghostedIndices)) store.ghostedIndices = [];

    // Migrate summarizedUpTo if missing/invalid (e.g. store written by
    // another version of the extension). Comparing against undefined
    // yields NaN → always false → every turn looks "already summarized"
    // while nothing is.
    if (!Number.isInteger(store.summarizedUpTo)) {
        const layer0 = Array.isArray(store.layers[0]) ? store.layers[0] : [];
        const ends = layer0.map(sn => sn?.turnRange?.[1]).filter(Number.isInteger);
        store.summarizedUpTo = ends.length ? Math.max(...ends) : -1;
        log(`Store migration: summarizedUpTo was missing/invalid → derived ${store.summarizedUpTo}`);
    }

    return store;
}

async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

// ─── Message Hiding (stable-ID ownership + reconciliation) ───────────

function genId() {
    return SillyTavern.getContext().uuidv4?.() ?? crypto.randomUUID();
}

/**
 * Migrate a stock store (no ownedIds) to stable-ID ownership.
 * Mutates the store/chat; the caller is responsible for saving.
 * Returns true if a migration happened.
 */
function ensureOwnership(store, chat) {
    const r = migrateOwnership(store, chat, genId);
    if (r.migrated) {
        log(`Ownership migrated: ${r.count} message(s) claimed, boundaryId=${store.boundaryId}`);
        return true;
    }
    return false;
}

function setSummaryBoundary(index) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    ensureOwnership(store, chat);
    setBoundary(store, chat, index, genId);
}

// Promise-chain lock: reconcile / ghost / unghost never interleave.
let ghostLockTail = Promise.resolve();
function withGhostLock(fn) {
    const run = ghostLockTail.then(() => fn());
    ghostLockTail = run.then(() => undefined, () => undefined);
    return run;
}

async function runSlash(cmd) {
    try {
        await SillyTavern.getContext().executeSlashCommandsWithOptions(cmd, { showOutput: false });
    } catch (e) {
        console.error(LOG_PREFIX, `Slash command failed: ${cmd}`, e);
    }
}

async function runHideUnhide(verb, indices) {
    let runs = 0;
    for (const [a, b] of toRuns(indices)) {
        await runSlash(a === b ? `/${verb} ${a}` : `/${verb} ${a}-${b}`);
        runs++;
    }
    return runs;
}

/**
 * Hide (verb 'hide') or unhide the given indices, verify, retry once.
 * Returns { runs, failures } where failures are indices still wrong.
 */
async function applyAndVerify(verb, indices, chat) {
    if (indices.length === 0) return { runs: 0, failures: [] };
    const check = verb === 'hide' ? findNotHidden : findStillHidden;
    let runs = await runHideUnhide(verb, indices);
    let failures = check(chat, indices);
    if (failures.length > 0) {
        runs += await runHideUnhide(verb, failures);
        failures = check(chat, failures);
    }
    return { runs, failures };
}

function warnFailures(failures, verb) {
    if (failures.length === 0) return;
    const what = verb === 'hide' ? 'hidden' : 'unhidden';
    toastr.warning(
        `Summaryception: ${failures.length} message(s) could not be ${what}. Use Repair or check the console.`,
        'Summaryception',
        { timeOut: TUNING.toastLonger }
    );
    console.warn(LOG_PREFIX, `Could not be ${what}:`, failures);
}

function mirrorSignature(store, chat) {
    let flags = '';
    for (const m of chat) flags += m?.extra?.sc_ghosted ? '1' : '0';
    return flags + '|' + (store.ghostedIndices || []).join(',');
}

/**
 * Branch repair: trim stale layer-0 snippets and recompute the boundary
 * when summarizedUpTo points beyond the end of the chat. No save.
 */
function repairBranchState(store, chat) {
    const chatLength = chat.length;
    const oldSummarizedUpTo = store.summarizedUpTo;
    log(`Branch detected! summarizedUpTo (${oldSummarizedUpTo}) >= chat length (${chatLength}). Repairing...`);

    if (store.layers[0]) {
        const before = store.layers[0].length;
        store.layers[0] = store.layers[0].filter(sn => {
            if (!sn.turnRange) return true; // promoted snippets without turnRange are kept
            return sn.turnRange[1] < chatLength;
        });
        const removed = before - store.layers[0].length;
        if (removed > 0) {
            log(`Removed ${removed} Layer 0 snippets that referenced turns beyond branch point`);
        }
    }

    const ends = (store.layers[0] || []).map(sn => sn?.turnRange?.[1]).filter(Number.isInteger);
    setSummaryBoundary(ends.length ? Math.max(...ends) : -1);

    log(`Branch repair complete. summarizedUpTo: ${oldSummarizedUpTo} → ${store.summarizedUpTo}`);
    toastr.info(
        `Branch detected — trimmed ${oldSummarizedUpTo - store.summarizedUpTo} turns of stale summary data that referenced messages beyond the branch point.`,
        'Summaryception — Branch Repair',
        { timeOut: TUNING.toastExtended }
    );
}

/** Unlocked reconcile body. Only call from inside withGhostLock. */
async function _reconcileNow({ reason, notify = false, forceSave = false } = {}) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) return null;
    const store = getChatStore();
    const s = getSettings();
    let dirty = !!forceSave;

    const migrated = ensureOwnership(store, chat);
    if (migrated) dirty = true;

    if (Number.isInteger(store.summarizedUpTo) && store.summarizedUpTo >= chat.length) {
        repairBranchState(store, chat);
        dirty = true;
    }

    const plan = planReconcile({
        chat,
        ownedIds: store.ownedIds,
        summarizedUpTo: store.summarizedUpTo,
        boundaryId: store.boundaryId,
        disableGhosting: s.disableGhosting,
    });

    if (plan.boundary !== store.summarizedUpTo || (store.boundaryId == null && plan.boundary >= 0)) {
        log(`Boundary ${store.summarizedUpTo} → ${plan.boundary} (${plan.boundaryReason ?? 'anchor set'}) [${reason}]`);
        setSummaryBoundary(plan.boundary);
        dirty = true;
    }

    const un = await applyAndVerify('unhide', plan.toUnhide, chat);
    const hi = await applyAndVerify('hide', plan.toHide, chat);
    const hidden = plan.toHide.length - hi.failures.length;
    const unhidden = plan.toUnhide.length - un.failures.length;
    if (un.runs > 0 || hi.runs > 0) dirty = true;
    warnFailures(hi.failures, 'hide');
    warnFailures(un.failures, 'unhide');
    const failures = { hide: hi.failures, unhide: un.failures };

    const sigBefore = mirrorSignature(store, chat);
    const dropped = applyReleaseAndOrphans(store, plan);
    syncMirrors(store, chat);
    if (dropped > 0 || sigBefore !== mirrorSignature(store, chat)) dirty = true;

    if (dirty) {
        await saveChatStore();
        await ctx.saveChat?.();
    }

    return {
        plan,
        migrated,
        hidden,
        unhidden,
        failures,
        released: plan.release.length,
        orphansRemoved: plan.orphans.length,
    };
}

/** The ONE function that makes the chat's hidden state match the stored intent. */
function reconcileGhosting(opts = {}) {
    return withGhostLock(() => _reconcileNow(opts));
}

async function ghostMessagesUpTo(endIndex, startIndex = 0) {
    const reconcileResult = await withGhostLock(async () => {
        const { chat } = SillyTavern.getContext();
        const store = getChatStore();
        ensureOwnership(store, chat);
        const ids = selectGhostable(chat, startIndex, endIndex, new Set(store.ownedIds));
        claimMessages(store, chat, ids, genId);
        log(`Claimed ${ids.length} message(s) in ${startIndex}–${endIndex}`);
        return _reconcileNow({ reason: 'batch', forceSave: true });
    });
    return reconcileResult;
}

/** Claim specific indices (if not user-hidden) and reconcile once. */
async function ghostIndices(indices) {
    return withGhostLock(async () => {
        const { chat } = SillyTavern.getContext();
        const store = getChatStore();
        ensureOwnership(store, chat);
        const owned = new Set(store.ownedIds);
        const ids = indices.filter(i => chat[i] && !isUserHidden(chat[i], owned));
        claimMessages(store, chat, ids, genId);
        return _reconcileNow({ reason: 'batch', forceSave: true });
    });
}

async function unghostAllMessages() {
    return withGhostLock(async () => {
        const { chat } = SillyTavern.getContext();
        const store = getChatStore();
        ensureOwnership(store, chat);

        const { byId } = buildIdIndex(chat);
        const toUnhide = [];
        for (const id of store.ownedIds) {
            const idx = byId.get(id);
            if (idx !== undefined && chat[idx].is_system === true) toUnhide.push(idx);
        }
        toUnhide.sort((a, b) => a - b);

        if (toUnhide.length > 0) {
            const progressToast = toastr.info(
                `Unhiding ${toUnhide.length} message(s)...`,
                'Summaryception — Clearing',
                { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
            );
            try {
                const r = await applyAndVerify('unhide', toUnhide, chat);
                warnFailures(r.failures, 'unhide');
            } finally {
                toastr.clear(progressToast);
            }
        }

        store.ownedIds = [];
        store.boundaryId = null;
        syncMirrors(store, chat);
        log(`Unghosted ${toUnhide.length} owned message(s)`);
    });
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        const isOurGhost = m.extra?.sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);
        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Build passage text from a range of chat messages.
 * Skips messages that are hidden (by user or system) UNLESS they were
 * hidden by Summaryception (sc_ghosted). Also skips empty messages.
 */
function buildPassageFromRange(chat, startIdx, endIdx) {
    const lines = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!m.mes || !m.mes.trim()) continue;

        // Skip messages hidden by the user (not by us)
        // A message hidden by the user will be is_system/is_hidden but NOT sc_ghosted
        // A message hidden by us will have sc_ghosted = true
        const isUserHidden = (m.is_system || m.is_hidden) && !m.extra?.sc_ghosted;
        if (isUserHidden) continue;

        const speaker = m.is_user ? 'Player' : 'Assistant';
        lines.push(`${speaker}: ${m.mes.trim()}`);
    }
    return lines.join('\n');
}

/**
 * Build a full context string from all layers down to (and including) a target layer.
 * Deepest layers first, target layer last — gives the summarizer full awareness
 * of what's already been captured so it can avoid redundancy.
 *
 * @param {number} downToLayer - Include this layer and all layers above it
 * @returns {string} - Combined context string, or '(none yet)'
 */
function buildFullContext(downToLayer = 0) {
    const store = getChatStore();
    const parts = [];

    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            parts.push(sn.text);
        }
    }

    return parts.length > 0 ? parts.join(' ') : '(none yet)';
}

// ─── Prompt Toggle Management ────────────────────────────────────────

function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }
        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) return snapshot;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return snapshot;
        for (const entry of collection.collection) {
            for (const orderEntry of orderList) {
                if (orderEntry.identifier === entry.identifier) {
                    snapshot.set(entry.identifier, orderEntry.enabled);
                }
            }
        }
        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

function disableAllPromptToggles() {
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }
        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }
        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Output Cleaning ─────────────────────────────────────────────────

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 */
function cleanSummarizerOutput(raw) {
    let text = raw;

    const s = getSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Remove common reasoning blocks (content between tag pairs)
    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;
let currentAbortController = null;

function abortSummarization() {
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
    isSummarizing = false;
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

async function callSummarizer(storyTxt, contextStr) {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const prompt = s.summarizerUserPrompt
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{story_txt}}', storyTxt);

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) disableAllPromptToggles();

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    let lastError = null;

    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            trace(`  Attempt ${attempt} starting...`);

            if (signal.aborted) {
                log('Summarization aborted by user.');
                toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: TUNING.toastMedium });
                return '';
            }

            try {
                if (attempt > 0) {
                    log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
                }

                trace(`  About to call sendSummarizerRequest with:`, {
                    connectionSource: s.connectionSource,
                    summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
                    promptLength: prompt.length,
                });

                const result = await Promise.race([
                    sendSummarizerRequest(s, s.summarizerSystemPrompt, prompt),
                    new Promise((_, reject) => {
                        const timer = setTimeout(() => reject(new Error('Request timed out after 120s')), TUNING.llmRequestTimeout);
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Aborted by user'));
                        });
                    }),
                ]);

                trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));

                let trimmed = (result || '').trim();
                trimmed = cleanSummarizerOutput(trimmed);

                if (!trimmed) {
                    log('Empty response from LLM, treating as retryable');
                    throw new Error('Empty response from summarizer');
                }

                log('Result:', trimmed);
                trace('<<< EXITING callSummarizer WITH SUCCESS');
                return trimmed;

            } catch (err) {
                lastError = err;
                trace(`  Caught error on attempt ${attempt}:`, {
                    name: err?.name,
                    message: err?.message,
                    retryable: err?.retryable,
                });

                if (signal.aborted || err.message === 'Aborted by user') {
                    log('Summarization aborted by user.');
                    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: TUNING.toastMedium });
                    return '';
                }

                if (!isRetryableError(err)) {
                    trace('  ERROR IS NON-RETRYABLE, BREAKING');
                    console.error(LOG_PREFIX, 'Non-retryable error:', err);
                    break;
                }

                if (attempt >= RETRY_CONFIG.maxRetries) {
                    trace('  MAX RETRIES EXHAUSTED');
                    console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                    break;
                }

                let delay;
                const retryAfterMs = parseRetryAfter(err);
                if (retryAfterMs) {
                    delay = Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
                    log(`Server requested retry after ${delay}ms`);
                } else {
                    const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
                    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
                    delay = Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
                }

                const delaySec = (delay / 1000).toFixed(1);
                const status = err?.status || err?.response?.status || '?';

                console.warn(LOG_PREFIX, `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`, err.message || err);

                toastr.warning(
                    `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
                    'Summaryception',
                    { timeOut: delay }
                );

                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
            'Summaryception',
            { timeOut: TUNING.toastError }
        );
        trace('<<< EXITING callSummarizer WITH FAILURE');
        return '';

    } finally {
        currentAbortController = null;
        if (isDefaultMode && snapshot) {
            restorePromptToggles(snapshot);
        }
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

let lastThresholdCheck = null;
let thresholdWarned = false;

async function evaluateTokenThreshold(chat, threshold) {
    let visibleTokens = null;
    try {
        const countFn = SillyTavern.getContext().getTokenCountAsync;
        if (typeof countFn !== 'function') throw new Error('getTokenCountAsync is not available');
        visibleTokens = await countVisibleTokens(chat, countFn);
    } catch (err) {
        visibleTokens = null;
        if (!thresholdWarned) {
            thresholdWarned = true;
            console.warn('[Summaryception] Token threshold: tokenizer unavailable, treating threshold as met.', err);
        }
    }
    const met = shouldRunBatch({ turnConditionMet: true, threshold, visibleTokens });
    lastThresholdCheck = { threshold, visibleTokens, met, at: Date.now() };
    return met;
}

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) return;
    if (s.pauseSummarization) return;
    if (isSummarizing) return;

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

    log(`Visible assistant turns: ${visibleTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleTurns.length <= s.verbatimTurns) return;

    const tokenThreshold = normalizeThreshold(s.tokenThreshold);
    if (tokenThreshold > 0) {
        const met = await evaluateTokenThreshold(chat, tokenThreshold);
        if (!met) {
            log(`Token threshold not met (${lastThresholdCheck.visibleTokens} <= ${tokenThreshold}); skipping automatic batch`);
            return;
        }
    }

    const overflow = visibleTurns.length - s.verbatimTurns;

    // ─── Backlog detection ───────────────────────────────────────
    const backlogThreshold = s.turnsPerSummary * TUNING.backlogMultiplier;

    if (overflow > backlogThreshold && !catchupDismissed) {
        log(`Large backlog detected: ${overflow} turns over limit`);

        const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);
        const choice = await showCatchupDialog(overflow, batchesNeeded);

        if (choice === 'skip') {
            const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
            if (cutoff) {
                setSummaryBoundary(cutoff.index);
                log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
            }
            catchupDismissed = true;
            await saveChatStore();
            return;
        } else if (choice === 'catchup') {
            await runCatchup(visibleTurns, overflow);
            return;
        } else if (choice === 'partial') {
            await summarizeOneBatch(visibleTurns);
            return;
        }
        return;
    }

    // ─── Normal operation: single batch ──────────────────────────
    const success = await summarizeOneBatch(visibleTurns);

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return;
    }

    const remaining = getAssistantTurns(chat).filter(t => !chat[t.index].extra?.sc_ghosted);
    if (remaining.length > s.verbatimTurns && remaining.length - s.verbatimTurns <= backlogThreshold) {
        await maybeSummarizeTurns();
    }
}

// ─── Core: Single Batch Summarization ────────────────────────────────

async function summarizeOneBatch(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatch');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        await ghostIndices(turnsToGhost.map(t => t.index));
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatch - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatch - EMPTY BATCH');
        return false;
    }

    isSummarizing = true;

    try {
        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;
        trace('  startIdx:', startIdx, 'endIdx:', endIdx);
        trace('  store.summarizedUpTo:', store.summarizedUpTo);

        log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

        if (!store.layers[0]) store.layers[0] = [];
        const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

        // ─── SANITY CHECK ───
        if (passageStart > endIdx) {
            log(`ERROR: passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
            trace('<<< EXITING summarizeOneBatch - PASSAGE START GREATER THAN END');
            return false;
        }

        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
        if (!storyTxt.trim()) {
            trace('<<< EXITING summarizeOneBatch - EMPTY PASSAGE');
            // --- FIX: Advance pointer and save so it doesn't try this empty batch again next turn ---
            setSummaryBoundary(Math.max(store.summarizedUpTo, endIdx));
            await saveChatStore();
            return true; // Return true so it doesn't think the cycle crashed
        }

        const contextStr = buildFullContext(0);

        toastr.info(`Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`, 'Summaryception', {
            timeOut: TUNING.toastMedium,
            progressBar: true,
        });

        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  summary length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('<<< EXITING summarizeOneBatch - EMPTY SUMMARY');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        setSummaryBoundary(Math.max(store.summarizedUpTo, endIdx));
        await ghostMessagesUpTo(endIdx, passageStart);

        log(`Layer 0 now has ${store.layers[0].length} snippets`);

        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        toastr.success(`Summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: TUNING.toastDefault });
        trace('<<< EXITING summarizeOneBatch - SUCCESS');
        return true;

    } finally {
        isSummarizing = false;
    }
}

// ─── Core: Inner Batch for Catchup ───────────────────────────────────

async function summarizeOneBatchFromTurns(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        await ghostIndices(turnsToGhost.map(t => t.index));
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatchFromTurns - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    trace('  batchSize:', batchSize);
    trace('  batch prepared:', batch.length);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const startIdx = batch[0].index;
    const endIdx = batch[batch.length - 1].index;

    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  store.summarizedUpTo:', store.summarizedUpTo);

    if (!store.layers[0]) store.layers[0] = [];

    // ─── Start from the message AFTER the last summarized one ───
    const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

    trace('  passageStart:', passageStart, 'endIdx:', endIdx);

    // ─── SANITY CHECK: passageStart should always be <= endIdx ───
    if (passageStart > endIdx) {
        trace('  CRITICAL: passageStart > endIdx! This should never happen.');
        trace('  This likely means the batch was already summarized.');
        trace('<<< EXITING - passageStart > endIdx');
        return 'EMPTY_SKIP';
    }

    trace('  About to call buildPassageFromRange...');

    try {
        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  buildPassageFromRange returned, length:', storyTxt?.length ?? 'UNDEFINED');

        if (!storyTxt.trim()) {
            trace('  <<< EXITING - storyTxt is empty after trim');
            trace('  This suggests all messages in range [' + passageStart + ', ' + endIdx + '] are hidden or empty');

            // --- FIX: Advance pointer so we don't get stuck on these empty indexes ---
            setSummaryBoundary(Math.max(store.summarizedUpTo, endIdx));
            await saveChatStore();

            return 'EMPTY_SKIP';
        }

        trace('  About to call buildFullContext...');
        const contextStr = buildFullContext(0);
        trace('  buildFullContext returned, length:', contextStr?.length ?? 'UNDEFINED');

        trace('  About to call callSummarizer...');
        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  callSummarizer returned, length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('  <<< EXITING - summary is empty');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        setSummaryBoundary(Math.max(store.summarizedUpTo, endIdx));
        trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

        await saveChatStore();
        await ghostMessagesUpTo(endIdx, passageStart);
        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        trace('<<< EXITING summarizeOneBatchFromTurns - SUCCESS');
        return true;

    } catch (err) {
        trace('  CAUGHT EXCEPTION:', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.substring?.(0, 200),
        });
        console.error(LOG_PREFIX, 'summarizeOneBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeOneBatchFromTurns - EXCEPTION');
        return false;
    }
}

// ─── Core: Catchup Processing ────────────────────────────────────────

async function runCatchup(visibleTurns, overflow) {

    trace('>>> ENTERING runCatchup');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
    trace('  overflow:', overflow);

    const s = getSettings();
    const totalBatches = Math.ceil(overflow / s.turnsPerSummary);
    let completed = 0;
    let failed = 0;
    let cancelled = false;

    trace('  totalBatches calculated:', totalBatches);

    const progressToast = toastr.info(
        `Processing backlog: 0 / ${totalBatches} batches (0%)`,
        'Summaryception Catch-Up',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            onCloseClick: () => {
                cancelled = true;
                abortSummarization();
            },
        }
    );

    isSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const currentVisible = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            trace(`  currentVisible turns: ${currentVisible.length}, verbatimTurns limit: ${s.verbatimTurns}`);

            if (currentVisible.length <= s.verbatimTurns) {
                trace('  Visible turns now within limit, breaking');
                break;
            }

            trace('  About to call summarizeOneBatchFromTurns...');
            const result = await summarizeOneBatchFromTurns(currentVisible);

            if (result === true) {
                trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                completed++;
                consecutiveFailures = 0;
            } else if (result === 'EMPTY_SKIP') {
                trace('  >>> summarizeOneBatchFromTurns returned EMPTY_SKIP (skipping empty system/hidden cards)');
                consecutiveFailures = 0;
            } else {
                trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
                failed++;
                consecutiveFailures++;

                if (consecutiveFailures >= TUNING.consecutiveFailureLimit) {
                    toastr.error(
                        `${TUNING.consecutiveFailureLimit} consecutive failures — API may be down. Pausing catch-up. Progress saved; will resume on next message.`,
                        'Summaryception',
                        { timeOut: TUNING.toastError }
                    );
                    trace(`  ${TUNING.consecutiveFailureLimit} consecutive failures, breaking`);
                    break;
                }
            }

            const pct = Math.round((completed / totalBatches) * 100);
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast).find('.toast-message').text(
                `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`
            );

            await new Promise(r => setTimeout(r, TUNING.catchupInterBatchDelay));
        }

        toastr.clear(progressToast);

        if (cancelled) {
            toastr.warning(
                `Catch-up paused at ${completed}/${totalBatches}. Progress saved — will continue on next message.`,
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else if (failed === 0) {
            toastr.success(
                `Catch-up complete! ${completed} batches processed.`,
                'Summaryception',
                { timeOut: TUNING.toastLong }
            );
        } else {
            toastr.warning(
                `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
                'Summaryception',
                { timeOut: TUNING.toastExtended }
            );
        }

        updateUI();

    } finally {
        isSummarizing = false;
    }
}

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your ${s.verbatimTurns} verbatim limit).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Summarize all ${overflowCount} turns — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Summarize ${s.turnsPerSummary} turns now, deal with the rest later</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => {
            overlay.remove();
            resolve('catchup');
        });
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => {
            overlay.remove();
            resolve('skip');
        });
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => {
            overlay.remove();
            resolve('partial');
        });
    });
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        const seed = layer.shift();
        seed.promoted = true;
        seed.seedFromLayer = layerIndex;
        destLayer.push(seed);

        log(`Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`);

        toastr.info(
            `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
            'Summaryception',
            { timeOut: TUNING.toastDefault }
        );

        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex);
        }
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex + 1);
        }
        return;
    }

    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map(sn => sn.text).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: TUNING.toastMedium, progressBar: true }
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) return '';

    const snippets = [];

    for (let i = store.layers.length - 1; i >= 1; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            snippets.push(sn.text);
        }
    }

    if (store.layers[0] && store.layers[0].length > 0) {
        for (const sn of store.layers[0]) {
            snippets.push(sn.text);
        }
    }

    if (snippets.length === 0) return '';

    return s.injectionTemplate.replace('{{summary}}', snippets.map((text, i) => `  ${i + 1}. ${text}`).join('\n'));
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

function updateInjection() {
    try {
        const { setExtensionPrompt, extensionPrompts } = SillyTavern.getContext();
        const s = getSettings();

        const args = buildInjectionArgs(s, s.enabled ? assembleSummaryBlock() : '');
        // Compare against the live entry, not a module-level cache: ST's
        // clearChat() resets extension_prompts on every chat (re)load.
        const live = extensionPrompts?.[MODULE_NAME];
        if (live && injectionSignature(live) === injectionSignature(args)) return;

        setExtensionPrompt(MODULE_NAME, args.value, args.position, args.depth, args.scan, args.role);

        log(`Injection updated: ${args.value.length} chars (position ${args.position}, depth ${args.depth}, role ${args.role}${args.macroOnly ? ', macro only' : ''})`);
    } catch (e) {
        log('updateInjection error:', e);
    }
}

// ─── {{summaryception}} macro ────────────────────────────────────────

function summaryMacroHandler() {
    const s = getSettings();
    if (!s.enabled) return '';
    if (normalizePlacement(s).position !== 'macro_only') return '';
    return assembleSummaryBlock();
}

function registerSummaryMacro() {
    try {
        const ctx = SillyTavern.getContext();
        const description = 'Summaryception summary block (only filled when Injection Position is "Macro Only").';
        const legacyOk = typeof ctx.registerMacro === 'function';
        if (ctx.powerUserSettings?.experimental_macro_engine === false && legacyOk) {
            // Legacy registration also feeds the new engine.
            ctx.registerMacro('summaryception', () => summaryMacroHandler(), description);
        } else if (ctx.macros?.register) {
            const options = { description, handler: () => summaryMacroHandler() };
            const category = ctx.macros.category?.CHAT;
            if (category) options.category = category;
            ctx.macros.register('summaryception', options);
        } else if (legacyOk) {
            ctx.registerMacro('summaryception', () => summaryMacroHandler(), description);
        }
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to register {{summaryception}} macro:', e);
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────

function onMessageReceived(messageIndex) {
    if (!getSettings().enabled) return;
    try {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            setTimeout(async () => {
                await maybeSummarizeTurns();
                updateInjection();
                updateUI();
            }, TUNING.messageReceivedDelay);
        }
    } catch (e) {
        log('onMessageReceived error:', e);
    }
}

function onChatChanged() {
    log('Chat changed.');
    catchupDismissed = false;
    setTimeout(async () => {
        try {
            if (getSettings().enabled) await reconcileGhosting({ reason: 'chat_load' });
        } catch (e) {
            console.error(LOG_PREFIX, 'Reconcile on chat load failed:', e);
        }
        updateInjection();
        updateUI();
    }, TUNING.chatChangedDelay);
}

async function onGenerationStarted(type, params, dryRun) {
    try {
        if (getSettings().enabled && !dryRun) await reconcileGhosting({ reason: 'generation' });
    } catch (e) {
        console.error(LOG_PREFIX, 'Reconcile on generation failed:', e);
    }
    updateInjection();
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        const statusProps = {
            name: 'sc-status',
            callback: async (args) => {
                const settings = getSettings();
                const store = getChatStore();
                const { chat } = SillyTavern.getContext();
                let plan = null;
                if (Array.isArray(store.ownedIds)) {
                    plan = planReconcile({
                        chat: Array.isArray(chat) ? chat : [],
                        ownedIds: store.ownedIds,
                        summarizedUpTo: store.summarizedUpTo,
                        boundaryId: store.boundaryId,
                        disableGhosting: settings.disableGhosting,
                    });
                }
                const lines = buildStatusLines({
                    enabled: !!settings.enabled,
                    paused: !!settings.pauseSummarization,
                    store,
                    snippetsPerLayer: settings.snippetsPerLayer,
                    plan,
                    disableGhosting: !!settings.disableGhosting,
                    placement: normalizePlacement(settings),
                    threshold: normalizeThreshold(settings.tokenThreshold),
                    lastThresholdCheck,
                    now: Date.now(),
                });
                const text = formatStatusText(lines);
                const quiet = args?.quiet === true || args?.quiet === 'true';
                if (!quiet) {
                    const c = SillyTavern.getContext();
                    if (typeof c.callGenericPopup === 'function') {
                        // Intentionally not awaited so the command returns immediately.
                        c.callGenericPopup(
                            '<div class="sc-status-popup">' + lines.map(escapeHtml).join('<br>') + '</div>',
                            c.POPUP_TYPE?.TEXT ?? 1,
                        );
                    } else {
                        toastr.info(text, 'Summaryception');
                    }
                }
                return text;
            },
            helpString: 'Show Summaryception status: boundary, snippets per layer, owned vs actually hidden messages, mismatches, placement and token threshold. Use quiet=true to only return the text.',
        };
        if (ctx.SlashCommandNamedArgument?.fromProps) {
            statusProps.namedArgumentList = [
                ctx.SlashCommandNamedArgument.fromProps({
                    name: 'quiet',
                    description: 'only return the status text, do not show a popup',
                    typeList: [ctx.ARGUMENT_TYPE?.BOOLEAN ?? 'boolean'],
                    defaultValue: 'false',
                }),
            ];
        }
        SlashCommandParser.addCommandObject(SlashCommand.fromProps(statusProps));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                await unghostAllMessages();

                const store = getChatStore();
                store.layers.length = 0;
                setSummaryBoundary(-1);

                const { chatMetadata } = SillyTavern.getContext();
                chatMetadata[MODULE_NAME] = store;

                await saveChatStore();
                try {
                    const ctx2 = SillyTavern.getContext();
                    if (ctx2.saveChat) await ctx2.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────

function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
        $('#sc_verbatim_turns').val(s.verbatimTurns);
        $('#sc_verbatim_turns_val').text(s.verbatimTurns);
        $('#sc_turns_per_summary').val(s.turnsPerSummary);
        $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
        $('#sc_token_threshold').val(normalizeThreshold(s.tokenThreshold));
        $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
        $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
        $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
        $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
        $('#sc_max_layers').val(s.maxLayers);
        $('#sc_max_layers_val').text(s.maxLayers);
        $('#sc_injection_template').val(s.injectionTemplate);
        {
            const pl = normalizePlacement(s);
            $('#sc_injection_position').val(pl.position);
            $('#sc_injection_depth').val(pl.depth);
            $('#sc_injection_role').val(pl.role);
            $('#sc_injection_depth_row').toggle(pl.position === 'in_chat');
            $('#sc_injection_role_row').toggle(pl.position !== 'macro_only');
            $('#sc_macro_only_hint').toggle(pl.position === 'macro_only');
        }
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        // ── Prompt preset migration & sync ──
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt) {
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                s.promptPreset = 'custom';
                saveSettings();
            }
        }

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        let statsHtml = '';
        try {
            const { chat } = SillyTavern.getContext();
            if (!Array.isArray(store.ownedIds)) {
                statsHtml += `<div class="sc-layer-stat sc-muted">Ownership not migrated yet (happens on chat load)</div>`;
            } else {
                const plan = planReconcile({
                    chat,
                    ownedIds: store.ownedIds,
                    summarizedUpTo: store.summarizedUpTo,
                    boundaryId: store.boundaryId,
                    disableGhosting: s.disableGhosting,
                });
                const st = plan.stats;
                statsHtml += `<div class="sc-layer-stat">👻 Owned (metadata): <strong>${st.owned}</strong> · Actually hidden: <strong>${st.actualHidden}</strong> / expected ${st.expectedHidden}</div>`;
                if (st.mismatches > 0) {
                    statsHtml += `<div class="sc-layer-stat sc-mismatch">⚠️ ${st.mismatches} mismatch(es) between metadata and actual hiding — press Repair.</div>`;
                }
                if (plan.orphans.length > 0) {
                    statsHtml += `<div class="sc-layer-stat sc-muted">${plan.orphans.length} orphaned ID(s) (deleted/branched messages) — Repair will clean up.</div>`;
                }
                if (st.userHiddenInRange > 0) {
                    statsHtml += `<div class="sc-layer-stat sc-muted">${st.userHiddenInRange} message(s) in range hidden by you or another extension (not touched).</div>`;
                }
            }
        } catch (e) { /* no chat loaded */ }
        if (s.disableGhosting) {
            statsHtml += `<div class="sc-layer-stat sc-mismatch">⚠️ Hiding is disabled: summarized messages stay in the LLM prompt (originals + summaries).</div>`;
        } else {
            statsHtml += `<div class="sc-layer-stat sc-muted">Summarized messages are hidden from the LLM (still visible to you in the chat).</div>`;
        }
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }

        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');

        updateSnippetBrowser();
        updateCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

function updateCustomPromptSlots() {
    const s = getSettings();
    const select = $('#sc_custom_prompt_slot');
    select.empty().append('<option value="">-- Load a saved prompt --</option>');

    const prompts = s.savedCustomPrompts || {};
    const names = Object.keys(prompts).sort();

    for (const name of names) {
        const preview = prompts[name].substring(0, 60).replace(/\n/g, ' ');
        select.append(
            $('<option></option>')
            .val(name)
            .text(`${name}`)
            .attr('title', preview)
        );
    }

    // Show/hide the prompt manager based on current preset
    if (s.promptPreset === 'custom') {
        $('#sc_custom_prompt_manager').show();
    } else {
        $('#sc_custom_prompt_manager').hide();
    }
}

function updateSnippetBrowser() {
    const store = getChatStore();
    let html = '';

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const rangeStr = sn.turnRange
                    ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                    : sn.mergedCount
                        ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                        : '';
                const seedStr = sn.promoted ? ' 🌱' : '';
                const canRedo = (i === 0 && sn.turnRange);
                const redoBtn = canRedo
                    ? `<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right" title="Regenerate this snippet"></button>`
                    : '';

                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                <span class="sc-snippet-text" data-layer="${i}" data-idx="${j}" title="Click to edit">${escapeHtml(sn.text)}</span>
                <span class="sc-snippet-meta">${rangeStr}${seedStr}</span>
                ${redoBtn}
                <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    // Edit snippet on click
    $('.sc-snippet-text').off('click').on('click', function () {
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];
        const textEl = $(this);

        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.text)
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const newText = $(this).val().trim();
                    if (newText) {
                        sn.text = newText;
                        await saveChatStore();
                        updateInjection();
                        toastr.success('Snippet updated', 'Summaryception', { timeOut: TUNING.toastShort });
                    }
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                const newText = $(this).val().trim();
                if (newText && newText !== sn.text) {
                    sn.text = newText;
                    await saveChatStore();
                    updateInjection();
                    toastr.success('Snippet updated', 'Summaryception', { timeOut: TUNING.toastShort });
                }
                updateSnippetBrowser();
            });

        textEl.replaceWith(textarea);

        // Auto-size to fit content
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';

        textarea.focus().select();
    });

    // Redo snippet
    $('.sc-snippet-redo').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const store = getChatStore();
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];

        if (!sn.turnRange) {
            toastr.warning(
                'Only Layer 0 (turn summary) snippets can be regenerated. Promoted meta-summaries have no source turns.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
            return;
        }

        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.', 'Summaryception');
            return;
        }

        const [rangeStart, rangeEnd] = sn.turnRange;
        const { chat } = SillyTavern.getContext();

        if (!confirm(`Regenerate summary for turns ${rangeStart}–${rangeEnd}?`)) return;

        isSummarizing = true;
        const btn = $(this);
        btn.prop('disabled', true).removeClass('fa-rotate-right').addClass('fa-spinner fa-spin');

        try {
            const storyTxt = buildPassageFromRange(chat, rangeStart, rangeEnd);

            if (!storyTxt.trim()) {
                toastr.error('Source turns are empty — cannot regenerate.', 'Summaryception');
                return;
            }

            const contextParts = [];
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const l = store.layers[i];
                if (!l) continue;
                for (let j = 0; j < l.length; j++) {
                    if (i === layerIdx && j === snippetIdx) continue;
                    contextParts.push(l[j].text);
                }
            }
            const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';

            toastr.info(`Regenerating summary for turns ${rangeStart}–${rangeEnd}…`, 'Summaryception', {
                timeOut: TUNING.toastMedium,
                progressBar: true,
            });

            const newSummary = await callSummarizer(storyTxt, contextStr);

            if (!newSummary) {
                toastr.error('Regeneration failed — original snippet kept.', 'Summaryception');
                return;
            }

            sn.text = newSummary;
            sn.timestamp = Date.now();
            sn.regenerated = true;

            await saveChatStore();
            updateInjection();
            updateUI();

            toastr.success(`Snippet regenerated for turns ${rangeStart}–${rangeEnd}`, 'Summaryception', { timeOut: TUNING.toastMedium });

        } finally {
            isSummarizing = false;
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
        }
    });

    // Delete snippet
    $('.sc-snippet-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer) {
            layer.splice(snippetIdx, 1);

            // Keep the current boundary unless layer 0 still has ranged snippets.
            const ends = (store.layers[0] || []).map(sn => sn?.turnRange?.[1]).filter(Number.isInteger);
            if (ends.length > 0) {
                setSummaryBoundary(Math.max(...ends));
            }

            await reconcileGhosting({ reason: 'snippet_delete' });
            await saveChatStore();
            updateInjection();
            updateUI();
            toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
        }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function bindUIEvents() {
    $(document).on('change', '#sc_enabled', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $(document).on('change', '#sc_pause_summarization', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: TUNING.toastMedium }
            );
        }
    });

    $(document).on('change', '#sc_disable_ghosting', async function () {
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();

        try {
            await reconcileGhosting({ reason: 'setting' });
        } catch (e) {
            console.error(LOG_PREFIX, 'Reconcile after setting change failed:', e);
        }
        updateUI();

        if ($(this).prop('checked')) {
            toastr.warning(
                'Hiding disabled: summarized messages are back in the LLM prompt, so the model now sees both the originals and the summaries.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else {
            toastr.info(
                'Hiding enabled: summarized messages are hidden from the LLM again.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        }
    });

    $(document).on('input', '#sc_summarizer_response_length', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $(document).on('change', '#sc_strip_patterns', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });

    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        { id: '#sc_turns_per_summary', key: 'turnsPerSummary', display: '#sc_turns_per_summary_val' },
        { id: '#sc_snippets_per_layer', key: 'snippetsPerLayer', display: '#sc_snippets_per_layer_val' },
        { id: '#sc_snippets_per_promotion', key: 'snippetsPerPromotion', display: '#sc_snippets_per_promotion_val' },
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
    ];

    for (const sl of sliders) {
        $(document).on('input', sl.id, function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val;
            $(sl.display).text(val);
            saveSettings();
            updateInjection();
        });
    }

    $(document).on('change', '#sc_token_threshold', function () {
        getSettings().tokenThreshold = normalizeThreshold($(this).val());
        saveSettings();
        updateUI();
    });

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(document).on('change', ta.id, function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
        });
    }

    const applyPlacement = (key, value) => {
        const s = getSettings();
        const next = normalizePlacement({ ...s, [key]: value });
        s.injectionPosition = next.position;
        s.injectionDepth = next.depth;
        s.injectionRole = next.role;
        saveSettings();
        updateInjection();
        updateUI();
    };
    $(document).on('change', '#sc_injection_position', function () {
        applyPlacement('injectionPosition', $(this).val());
    });
    $(document).on('change', '#sc_injection_role', function () {
        applyPlacement('injectionRole', $(this).val());
    });
    $(document).on('change', '#sc_injection_depth', function () {
        applyPlacement('injectionDepth', $(this).val());
    });
    $(document).on('click', '.sc_depth_preset', function () {
        applyPlacement('injectionDepth', $(this).data('depth'));
    });

    $(document).on('change', '#sc_debug_mode', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_trace_mode', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('click', '#sc_repair', async function () {
        const r = await reconcileGhosting({ reason: 'repair', notify: true });
        updateInjection();
        updateUI();
        if (!r) {
            toastr.info('No chat loaded.', 'Summaryception', { timeOut: TUNING.toastMedium });
            return;
        }
        const { plan } = r;
        const parts = [];
        if (r.hidden > 0) parts.push(`hidden ${r.hidden}`);
        if (r.unhidden > 0) parts.push(`unhidden ${r.unhidden}`);
        if (r.orphansRemoved > 0) parts.push(`orphan IDs removed ${r.orphansRemoved}`);
        if (r.released > 0) parts.push(`released ${r.released}`);
        if (plan.boundaryReason) parts.push(`boundary corrected (${plan.boundaryReason})`);
        let msg = parts.length > 0 ? `Repair: ${parts.join(', ')}.` : 'Everything is in sync.';
        if (plan.stats.userHiddenInRange > 0) {
            msg += ` ${plan.stats.userHiddenInRange} hidden message(s) in the summarized range are not owned by Summaryception (hidden by you or another extension) and were left untouched.`;
        }
        toastr.success(msg, 'Summaryception', { timeOut: TUNING.toastLonger });
    });

    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) return;

        try {
            await unghostAllMessages();
        } catch (e) {
            console.error(LOG_PREFIX, 'Error during unghost (continuing with clear):', e);
            toastr.warning('Some messages could not be unghosted, but memory will still be cleared.', 'Summaryception');
        }

        const store = getChatStore();
        store.layers.length = 0;
        setSummaryBoundary(-1);

        const { chatMetadata } = SillyTavern.getContext();
        chatMetadata[MODULE_NAME] = store;

        await saveChatStore();
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }
        updateInjection();
        updateUI();
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
    });

    $(document).on('click', '#sc_force_summarize', async function () {
        const s = getSettings();
        if (!s.enabled) {
            toastr.warning('Enable Summaryception first.');
            return;
        }
        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.');
            return;
        }
        if (s.pauseSummarization) {
            log('Force Summarize overrides pause mode.');
        }
        $(this).prop('disabled', true).text(' Working…');
        try {
            catchupDismissed = false;

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            if (visibleTurns.length <= s.verbatimTurns) {
                toastr.info('Nothing to summarize — visible turns are within the verbatim limit.', 'Summaryception');
                return;
            }

            const overflow = visibleTurns.length - s.verbatimTurns;
            toastr.info(`${overflow} turns to process. Starting...`, 'Summaryception', { timeOut: TUNING.toastDefault });

            await runCatchup(visibleTurns, overflow);
            updateInjection();
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateUI();
        }
    });

    $(document).on('click', '#sc_stop_summarize', function () {
        if (!isSummarizing && !currentAbortController) {
            toastr.info('Nothing is running.', 'Summaryception');
            return;
        }
        abortSummarization();
        toastr.warning('Summarization stopped. Progress has been saved.', 'Summaryception', { timeOut: TUNING.toastLong });
        $(this).prop('disabled', true);
        setTimeout(() => $(this).prop('disabled', false), TUNING.stopButtonCooldown);
        updateUI();
    });

    $(document).on('click', '#sc_refresh_preview', () => updateUI());

    $(document).on('click', '#sc_export', function () {
        const store = getChatStore();
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $(document).on('click', '#sc_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.layers || !Array.isArray(data.layers)) {
                    toastr.error('Invalid file format.');
                    return;
                }

                const { chat } = SillyTavern.getContext();
                const store = getChatStore();

                await unghostAllMessages();

                store.layers = data.layers;
                setSummaryBoundary(data.summarizedUpTo ?? -1);

                if (store.summarizedUpTo >= 0) {
                    await ghostMessagesUpTo(store.summarizedUpTo);
                }

                await saveChatStore();
                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                toastr.success(
                    `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                               'Summaryception',
                               { timeOut: TUNING.toastLong }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.');
            }
        };
        input.click();
    });

    // ── Prompt Preset dropdown ──
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        // Auto-save custom prompt before switching away
        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            log('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            // Restore the last custom prompt if we have one
            if (s.lastCustomPrompt) {
                $('#sc_summarizer_user_prompt').val(s.lastCustomPrompt);
                s.summarizerUserPrompt = s.lastCustomPrompt;
                log('Restored auto-saved custom prompt');
            }
            $('#sc_custom_prompt_manager').show();
        } else {
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
            $('#sc_custom_prompt_manager').hide();
        }

        saveSettings();
        updateCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $(document).on('input', '#sc_summarizer_user_prompt', function () {
        const currentText = $(this).val();
        const s = getSettings();

        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                s.promptPreset = 'custom';
                s.lastCustomPrompt = currentText;
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                updateCustomPromptSlots();
            }
        } else {
            s.lastCustomPrompt = currentText;
        }

        saveSettings();
    });

    // ── Custom Prompt: Save to named slot ──
    $(document).on('click', '#sc_custom_prompt_save', function () {
        const name = $('#sc_custom_prompt_name').val().trim();
        if (!name) {
            toastr.warning('Enter a name for the prompt.', 'Summaryception');
            return;
        }

        const s = getSettings();
        if (!s.savedCustomPrompts) s.savedCustomPrompts = {};

        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to save.', 'Summaryception');
            return;
        }

        const isOverwrite = s.savedCustomPrompts[name];
        s.savedCustomPrompts[name] = promptText;
        saveSettings();

        $('#sc_custom_prompt_name').val('');
        updateCustomPromptSlots();

        toastr.success(
            `Prompt "${name}" ${isOverwrite ? 'updated' : 'saved'}.`,
            'Summaryception',
            { timeOut: TUNING.toastDefault }
        );
    });

    // ── Custom Prompt: Load from named slot ──
    $(document).on('click', '#sc_custom_prompt_load', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to load.', 'Summaryception');
            return;
        }

        const s = getSettings();
        const promptText = s.savedCustomPrompts?.[name];
        if (!promptText) {
            toastr.error(`Prompt "${name}" not found.`, 'Summaryception');
            return;
        }

        $('#sc_summarizer_user_prompt').val(promptText);
        s.summarizerUserPrompt = promptText;
        s.lastCustomPrompt = promptText;
        s.promptPreset = 'custom';
        $('#sc_prompt_preset').val('custom');
        saveSettings();

        toastr.success(`Loaded prompt "${name}".`, 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Delete named slot ──
    $(document).on('click', '#sc_custom_prompt_delete_slot', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to delete.', 'Summaryception');
            return;
        }

        if (!confirm(`Delete saved prompt "${name}"?`)) return;

        const s = getSettings();
        if (s.savedCustomPrompts) {
            delete s.savedCustomPrompts[name];
            saveSettings();
        }

        updateCustomPromptSlots();
        toastr.info(`Prompt "${name}" deleted.`, 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Export as .txt ──
    $(document).on('click', '#sc_custom_prompt_export', function () {
        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to export.', 'Summaryception');
            return;
        }

        const blob = new Blob([promptText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_prompt_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Prompt exported.', 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Import from .txt ──
    $(document).on('click', '#sc_custom_prompt_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.text';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                if (!text.trim()) {
                    toastr.warning('File is empty.', 'Summaryception');
                    return;
                }

                const s = getSettings();
                $('#sc_summarizer_user_prompt').val(text);
                s.summarizerUserPrompt = text;
                s.lastCustomPrompt = text;
                s.promptPreset = 'custom';
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                saveSettings();
                updateCustomPromptSlots();

                toastr.success(
                    `Prompt imported from "${file.name}".`,
                    'Summaryception',
                    { timeOut: TUNING.toastMedium }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.', 'Summaryception');
            }
        };
        input.click();
    });

    $(document).on('click', '#sc_reset_defaults', function () {
        if (!confirm(
            'Reset all Advanced Settings to defaults?\n\n' +
            'This will reset sliders, prompts, injection template, injection placement, and strip patterns.\n' +
            'It will NOT clear your summary memory or connection settings.'
        )) return;

        const s = getSettings();

        // Reset sliders
        s.verbatimTurns = defaultSettings.verbatimTurns;
        s.turnsPerSummary = defaultSettings.turnsPerSummary;
        s.tokenThreshold = defaultSettings.tokenThreshold;
        s.snippetsPerLayer = defaultSettings.snippetsPerLayer;
        s.snippetsPerPromotion = defaultSettings.snippetsPerPromotion;
        s.maxLayers = defaultSettings.maxLayers;

        // Reset prompts
        s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
        s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
        s.promptPreset = defaultSettings.promptPreset;
        s.injectionTemplate = defaultSettings.injectionTemplate;
        s.injectionPosition = PLACEMENT_DEFAULTS.injectionPosition;
        s.injectionDepth = PLACEMENT_DEFAULTS.injectionDepth;
        s.injectionRole = PLACEMENT_DEFAULTS.injectionRole;
        s.stripPatterns = [...defaultSettings.stripPatterns];
        s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

        // Reset debug
        s.debugMode = defaultSettings.debugMode;
        s.traceMode = defaultSettings.traceMode;

        saveSettings();
        updateInjection();
        updateUI();

        toastr.success(
            'Advanced settings reset to defaults. Connection settings and summary memory were preserved.',
            'Summaryception',
            { timeOut: TUNING.toastLong }
        );
    });
}

// ─── Connection Settings UI ──────────────────────────────────────────

function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            save();
            updateConnectionSubPanels(sourceSelect.value);
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, s().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, s().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            s().connectionProfileId = profileSelect.value;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = s().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile: document.getElementById('summaryception_profile_settings'),
        ollama: document.getElementById('summaryception_ollama_settings'),
        openai: document.getElementById('summaryception_openai_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) container.style.display = 'none';
        }, TUNING.connectionStatusTimeout);
    }
}

async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}

// ─── Initialization ──────────────────────────────────────────────────

(async function init() {
    const {
        eventSource,
        event_types,
        renderExtensionTemplateAsync,
    } = SillyTavern.getContext();

    getSettings();

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);

    bindUIEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    registerSlashCommands();
    registerSummaryMacro();

    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        updateUI();
        console.log(LOG_PREFIX, 'v5.5.4 loaded. Connection Settings available');
    });
})();