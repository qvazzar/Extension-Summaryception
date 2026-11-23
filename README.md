# 🧠 Summaryception

### Layered Recursive Memory for SillyTavern

> **Fork notice.** This is a fork of [Summaryception](https://github.com/Lodactio/Extension-Summaryception) by Lodactio, maintained by [qvazzar](https://github.com/qvazzar/Extension-Summaryception). It is a **drop-in replacement**: same extension folder name (`Extension-Summaryception`), same settings key and same chat-metadata key, so existing chats, snippets and settings keep working. It is inspired in places by [vadash's fork](https://github.com/vadash/Extension-Summaryception); no code was copied from it. Licensed under AGPL-3.0, like the original. See [Changes in this fork](#changes-in-this-fork).

> Your AI remembers **thousands of turns** in under **20k tokens**. No context bloat. No lost plot threads. No compromises.

Summaryception is a non-destructive, context-aware memory system for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that replaces brute-force context stuffing with intelligent layered summarization. It keeps your most recent turns verbatim while compressing older conversation into ultra-compact summary snippets — organized in recursive layers that scale indefinitely.

---

## Changes in this fork

### Injection placement

The summary block can be placed in several ways (Settings, "Injection Placement"):

- **Position**: Before Prompt, In Prompt, In Chat (at depth), or Macro Only.
- **Depth** (In Chat only), with quick presets for 0 (end of chat) and 1 (before the last message).
- **Role**: system, user or assistant.

Defaults are In Chat, depth 0, role user (stock Summaryception used in-chat depth 12, role user).

**Macro Only** registers the `{{summaryception}}` macro, which expands to the full wrapped summary block. Nothing is injected automatically in this mode, and in the other modes the macro is empty, so the block is never duplicated.

Some providers may move or merge system-role messages that appear in the middle of the chat, so user or assistant is the safer role for In Chat. In Text Completion mode the role only applies to In Chat.

### Reliable hiding

- Every summarized message gets a stable ID (`extra.sc_id`). The set of IDs the extension owns and a boundary anchor are stored in chat metadata. Existing chats are migrated automatically.
- The extension never hides or unhides messages that you (or another extension) hid.
- One reconciliation routine brings the chat in line with the ownership state. It runs on chat load, before every generation, after every batch (with verification, one retry and a warning toast if messages are still not hidden) and on Repair.
- Orphans are handled: deleted messages, branches, swipes, and a boundary that points past the end of the chat.
- Repair no longer unhides messages it does not own, and Clear Memory only unhides owned messages.
- Layer Stats shows owned versus actually hidden messages and highlights mismatches.
- Deleting a snippet no longer resets the boundary to -1 when layer 0 has no ranged snippets.

### Honest compatibility mode

The former "Disable Message Hiding" setting is now **"Don't hide summarized messages (compatibility mode)"**. When it is enabled, summarized messages **stay in the LLM prompt** alongside their summaries. Use it only with extensions that manage message hiding themselves.

### Optional token threshold

A new setting, **Token Threshold** (0 = off). When set, an automatic batch runs only if the turn condition is met **and** the visible (non-hidden) chat is longer than N tokens, counted with SillyTavern's tokenizer. Batching itself stays turn-based. Force Summarize ignores the threshold.

### /sc-status

`/sc-status` opens a popup (SillyTavern discards the return values of typed commands) with the boundary, snippet counts per layer, owned and actually hidden message counts, mismatches, injection placement and the token threshold. `/sc-status quiet=true` returns plain text only, for piping.

### Fixes

- Macro names in the settings hints were rendered empty by Handlebars; they are now shown correctly.
- The summary injection is re-applied correctly after a chat reload (SillyTavern clears extension prompts on chat load).

### Development

Pure logic lives in `lib/` and is covered by unit tests. Run them with `node --test` (Node 18+, no dependencies). `package.json` is dev-only and ignored by SillyTavern.

---

## ✨ The Problem

Every roleplayer hits the same wall:

| Approach | What happens |
|---|---|
| **No summary** | Context fills up → hard truncation → everything before the cutoff is **gone forever** |
| **Basic summarization** | Lossy single summary → important details vanish → you compensate by keeping 20+ verbatim turns → context still bloats |
| **More verbatim turns** | 20 turns × 1,500 tokens = 30k tokens of mostly atmospheric prose the LLM has to process → attention degrades → coherence drops anyway |

The conventional wisdom — *"keep more raw turns"* — is a band-aid for bad compression.

## 💡 The Solution

Summaryception flips the approach: **compress aggressively, lose nothing.**

A context-aware summarizer prompt examines each batch of turns against what's *already been summarized*, outputting only the **narrative delta** — new plot points, state changes, character decisions. Nothing repeated, nothing lost.

**Real example** — 3 turns, ~5,200 raw tokens, compressed to:

> *Alina kisses Lodactio; he reciprocates; she grows to human size, straddling him; she squeezes his crotch and intends to undo his pants.*

**27 tokens. 125:1 compression. Every plot-relevant beat preserved.**

And because each snippet is written with knowledge of all previous snippets, they get *more efficient over time* — the summarizer doesn't re-establish characters, settings, or relationships that are already recorded. Early snippets might be 40 tokens. By snippet 10, you're seeing 15-token summaries.

---

## 🔄 How It Works

```
YOUR CHAT (e.g., 200 turns)
│
│  Turns 1-180: Ghosted (hidden from LLM, still readable by you)
│               (unless compatibility mode "Don't hide summarized
│                messages" is on: then they stay in the prompt)
│  Turns 181-200: Kept VERBATIM (7 most recent assistant turns)
│
│  The ghosted turns have been compressed into:
│
│  ┌──────────────────────────────────────────┐
│  │  LAYER 2 (Deep Memory)                   │
│  │  Ultra-compressed summaries of Layer 1   │
│  │  Each covers ~27 turns                   │
│  ├──────────────────────────────────────────┤
│  │  LAYER 1 (Meta-Summaries)                │
│  │  Compressed summaries of Layer 0         │
│  │  Each covers ~9 turns                    │
│  ├──────────────────────────────────────────┤
│  │  LAYER 0 (Turn Summaries)                │
│  │  Direct summaries of conversation turns  │
│  │  Each covers ~3 turns                    │
│  ├──────────────────────────────────────────┤
│  │  VERBATIM TURNS (most recent 7)          │
│  │  Sent word-for-word to the LLM           │
│  └──────────────────────────────────────────┘
│
│  Total context: ~12k tokens
│  Total narrative coverage: EVERYTHING
```

### The "Ception" — Recursive Layer Promotion

When a layer fills up (default: 30 snippets), the oldest snippets are promoted to the next deeper layer:

1. **Seed promotion** — The very first time a deeper layer opens, the oldest snippet is promoted **directly** as a seed, no LLM call, preserving maximum information as the foundation for that layer.
2. **Subsequent promotions** — Additional overflow snippets (default: 3 at a time) are summarized together against the destination layer's existing content (including the seed) as prior context.
3. **Cascade** — If the destination layer also fills up, the process repeats, creating Layer 2, Layer 3, etc.

Each layer multiplies the turn coverage per snippet while maintaining coherent narrative continuity.

---

## 📊 The Math

*Using ~70 tokens per snippet as a working median. Actual snippets range from ~30 tokens (late-layer, minimal delta) to ~100 tokens (early context establishment). Your results will vary based on narrative density.*

### Default Settings (30 snippets/layer, 3 turns/batch, 3 snippets/promotion)

Each promotion merges 3 snippets into 1, so each layer multiplies turn coverage by 3×.

| Layer | Snippets | Turns per Snippet | Total Turns Covered | ~Tokens |
|---|---|---|---|---|
| Verbatim | 7 turns | — | 7 | ~5,000 |
| Layer 0 | 30 | 3 | 90 | ~2,100 |
| Layer 1 | 30 | 9 | 270 | ~2,100 |
| Layer 2 | 30 | 27 | 810 | ~2,100 |
| Layer 3 | 30 | 81 | 2,430 | ~2,100 |
| Layer 4 | 30 | 243 | 7,290 | ~2,100 |
| **Total** | — | — | **~10,897 turns** | **~15,500 tokens** |

> **Nearly 11,000 turns of narrative history in ~16k tokens.**

### Conservative Estimate (smaller snippets at deeper layers)

In practice, deeper layers produce shorter snippets as they compress already-compressed material. A more realistic breakdown:

| Layer | Snippets | Turns per Snippet | ~Tokens/Snippet | ~Layer Tokens |
|---|---|---|---|---|
| Verbatim | 7 turns | — | — | ~5,000 |
| Layer 0 | 30 | 3 | ~80 | ~2,400 |
| Layer 1 | 30 | 9 | ~70 | ~2,100 |
| Layer 2 | 30 | 27 | ~60 | ~1,800 |
| Layer 3 | 30 | 81 | ~50 | ~1,500 |
| Layer 4 | 30 | 243 | ~40 | ~1,200 |
| **Total** | — | — | — | **~14,000 tokens** |

> **~11,000 turns in ~14k tokens.** The raw conversation? Roughly **15–25 million tokens.** That's a compression ratio approaching **1,000:1**.

For comparison, most roleplayers hit 17,500 tokens by **turn 10** with verbatim context. Summaryception uses the same budget to remember **eleven thousand**.

---

## 👻 Non-Destructive Ghost Mode

Summaryception never deletes your messages. Summarized turns are **ghosted** — hidden from the LLM context but fully visible and readable in your chat UI. Scroll up anytime to read the original prose.

> This is true unless the compatibility mode **"Don't hide summarized messages"** is enabled. In that mode summarized messages stay in the prompt (see [Changes in this fork](#honest-compatibility-mode)).

- 👻 Ghosted messages show a system icon in the chat
- Clear Memory unghosts everything instantly
- Your chat file is never modified destructively

---

## 🧹 Clean Prompt Isolation

When Summaryception calls the summarizer, it **temporarily disables all Chat Completion preset toggles** — your creative writing prompts, character instructions, scenario text, everything. The summarizer sees only its own system prompt and the passage to summarize.

This means:
- ✅ No 4k tokens of story-writing instructions competing with a 200-token summarization task
- ✅ Budget models perform like premium models on the focused extraction task
- ✅ Your preset is restored instantly after, whether the call succeeds or fails

---

## 🔁 Context-Aware Incremental Summaries

This is the core innovation. The summarizer prompt receives:

| Variable | Contents |
|---|---|
| `{{player_name}}` | Your active persona name |
| `{{context_str}}` | **That layer's existing summaries** — everything already recorded |
| `{{story_txt}}` | The new passage to summarize |

The instruction: *"Summarize only necessary elements to coherently continue the Prior Context. Exclude anything already covered."*

This means:
- **Snippet 1** has to establish characters, setting, relationships (~80–100 tokens)
- **Snippet 5** only records new events — characters and setting are established (~50–70 tokens)
- **Snippet 10** is pure narrative delta — just what changed (~30–50 tokens)
- **Layer promotions** work the same way — each deeper layer summarizes against its own existing content

Every summary is a **minimal diff**, not a redundant recap.

---

## 🛡️ Resilient API Handling

- **Exponential backoff** with jitter for rate limits (429) and server errors (500/502/503/504)
- **Retry-After header** respected when the server provides one
- Retries up to 5 times with delays from 2s → 60s
- **Failed batches are never ghosted** — turns stay visible for the next attempt
- Network errors, timeouts, and empty responses are all handled gracefully

---

## 📦 Backlog Detection

Opening an existing chat with 100+ messages? Summaryception detects the backlog and offers you a choice:

| Option | What it does |
|---|---|
| **Process Entire Backlog** | Summarizes everything with a cancelable progress bar |
| **Skip Backlog** | Ignores old turns, only tracks new ones going forward |
| **Just One Batch** | Processes a single batch now, handles the rest incrementally |

Progress is saved continuously — cancel anytime and pick up where you left off.

---

## ⚙️ Configuration

All settings are adjustable from the SillyTavern Extensions panel:

| Setting | Default | Description |
|---|---|---|
| Verbatim Turns | 10 | Recent assistant turns kept word-for-word |
| Turns per Batch | 3 | Oldest turns summarized together per trigger |
| Snippets per Layer | 30 | Max snippets before promoting to next layer |
| Snippets per Promotion | 3 | How many snippets merge on promotion |
| Max Layers | 5 | Maximum recursion depth |

### Prompt Presets

| Preset | Best For | Focus |
|---|---|---|
| **Narrative State** (default) | Character RP, drama, thrillers, romance | Interactions, emotions, relationships, atmosphere, subtext |
| **Game State** | Roguelites, strategy, mechanical games | Plot points, quests, locations, interactables, state changes |
| **Custom** | Your own prompt | Whatever you write |

Select a preset from the dropdown in Summary Prompts, or edit the prompt directly — it auto-switches to Custom.

Plus fully customizable:
- 📝 Summarizer system prompt
- 📝 Summarizer user prompt (with `{{player_name}}`, `{{context_str}}`, `{{story_txt}}` variables)
- 📝 Injection wrapper template

---

## 🔌 Connection Settings

Summaryception can use different backends for summarization, independent of your main chat connection:

| Source | Description |
|---|---|
| **Default** | Uses SillyTavern's active connection — simplest setup |
| **OpenAI Compatible** | Direct endpoint with URL, API key, and model — bypasses all ST formatting |
| **Ollama** | Local Ollama instance with model browser |
| **Connection Profile** | Uses an ST Connection Profile (⚠️ inherits preset formatting — may degrade summary quality) |

> 💡 **Recommended:** Use **Default** or **OpenAI Compatible** for cleanest results. Connection Profiles inject preset formatting into summary requests, which can cause the model to roleplay instead of summarize.

---

## 🗂️ Built-in Tools

- **Layer Stats** — Live view of snippet counts per layer and ghosted message count
- **Injection Preview** — See exactly what gets sent to the LLM
- **Snippet Browser** — Browse, edit, regenerate, and delete individual snippets across all layers
- **Export/Import** — Save and restore memory as JSON
- **Force Summarize** — Manually trigger summarization
- **Stop** — Abort any running summarization, progress saved
- **Repair** — Find and fix orphaned hidden messages
- **Slash Commands** — `/sc-status`, `/sc-preview`, `/sc-clear`

---

## 📥 Installation

### Requirements

- **SillyTavern 1.16.0+** (release or staging). Older versions use an incompatible `generateRaw` signature and will not work correctly.

### From SillyTavern UI
1. Open **Extensions** → **Install Extension**
2. Paste: `https://github.com/Lodactio/Extension-Summaryception` (stock) or `https://github.com/qvazzar/Extension-Summaryception` (this fork)
3. Click Install
4. Find **🧠 Summaryception** in Extensions settings

> The folder must stay named `Extension-Summaryception` (the extension loads its settings template from `third-party/Extension-Summaryception`). Installing this fork from its URL keeps that name. To switch from the stock extension, remove it first: only one Summaryception fork can be installed at a time in the same folder.

### Manual
```bash
cd SillyTavern/data/default-user/extensions/third-party/
git clone https://github.com/Lodactio/Extension-Summaryception
# or this fork:
git clone https://github.com/qvazzar/Extension-Summaryception
```
Restart SillyTavern and enable the extension.

---

## 🧠 Why This Works Better

| | Traditional Summary | Summaryception |
|---|---|---|
| **Compression** | ~10:1, lossy | ~125:1 per snippet, lossless |
| **Context at turn 100** | 30k+ tokens or truncated | ~10k tokens |
| **Context at turn 1,000** | Impossible without truncation | ~13k tokens |
| **Context at turn 10,000** | Literally impossible | ~16k tokens |
| **Lost information** | Lots — hedged by keeping more raw turns | None — every state change is tracked |
| **Coherence over time** | Degrades as context grows | Stable indefinitely |
| **Works with budget models** | Poorly — needs powerful summarizer | Excellently — prompt does the heavy lifting |

---

## Community Forks

These forks extend Summaryception with specialized features. They use the same internal module name, so **install only one at a time** — your existing settings and per-chat memory will carry over.

### [Per-Character Memory Banks](https://github.com/dogoo9/Extension-Summaryception) by dogoo9

Keeps separate summary memory for each character card in the same chat. Useful for group chats or stories where you switch between characters and don't want their memories bleeding together.

### [Lorebook Ingestion](https://github.com/jeromehbonaparte-star/Extension-Summaryception-Lorebook) by Romuromylus

Automatically extracts stable facts (character traits, locations, items) from summaries and proposes them as World Info entries. Summaries handle events and state changes; lorebook entries handle things that should never be forgotten across layers. Includes a review queue so nothing gets written without your approval.

### [Verdash's Summaryception](https://github.com/vadash/Extension-Summaryception) By Verdash

Highly Polished Summaryception with many requested features by the community and superior context management.

---

## Credits & License

- Original extension: [Summaryception](https://github.com/Lodactio/Extension-Summaryception) by Lodactio. Built with frustration at context limits and love for long-form roleplay.
- This fork: [qvazzar](https://github.com/qvazzar/Extension-Summaryception).
- Inspiration: [vadash's fork](https://github.com/vadash/Extension-Summaryception) (no code copied).

If this saves your 500-turn adventure from amnesia, consider starring the repo. ⭐

Licensed under AGPL-3.0 (see `LICENSE`).

**Modification notice (AGPL section 5a):** This fork modifies the original work. Changes started in November 2026; see "Changes in this fork" and the git history.
