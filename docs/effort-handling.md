# Effort / thinking-level handling on the effort dial

How `Dial 2 (Effort)` picks its values per agent, where those values come from, and why some
models legitimately don't offer every level (e.g. **DeepSeek has no `medium`**).

## The generic pipeline

For the **target** session, three pieces are resolved independently every poll (~1.5s):

| Piece | Source |
|---|---|
| **Current value** shown on the dial | `currentEffortByHandle` — from the agent's live state reader (`readCurrentState().effort`), falling back to `getEffortForModel(model)` (a value *bound to* the selected model) and finally the first list entry |
| **Option list** cycled by rotating | `dialList("effort")` → 1. live-discovered list (`effortsByHandle`, set only when a variant CLI exists), else 2. `agent.getEfforts(selectedModelId)` (per-model profile), else 3. the agent's static default list |
| **Apply** (push) | `getApplySteps("effort", value)` — a per-agent command/keystroke sequence into the session terminal |

`effortsByHandle` is populated by `refreshEfforts()` (throttled 30s), which runs the agent's
`getDiscoverVariantCmd()` with the target's current model and parses the output. Today only
**opencode** has a variant-discovery command.

## Per-agent behavior

| Agent | Option list source | Apply command | Dynamic per model? |
|---|---|---|---|
| **claude** | `getEfforts(modelId)`: per-model `effort_options` from `~/.claude/cache/model-catalog/*.json` (e.g. some models only have `low`/`high`); falls back to `low medium high xhigh max`; haiku → `[]` | `/effort <v>` | ✅ yes, when the model catalog has the model's `effort_options` |
| **codex** | static `none low medium high xhigh max`; per-model data not available from `models_cache.json` | `/effort <v>` | ❌ no (single option set) |
| **opencode** | **live per model via `opencode models --verbose <provider>`** — parses the model's `variants` keys and prepends `default` (e.g. DeepSeek → `default low high max`); falls back to static `low medium high max` when the model has no variants | `/variants` picker (opens dialog, types the variant, Enter) | ✅ yes — this is what makes DeepSeek show `Default(low/high/max)` instead of a fake `medium` |
| **agy** | static `low medium high`; the *current* effort is inferred from the model id suffix (`gemini-3.8-flash-high` → `high`) | `/effort <v>` | ⚠️ current value derived from model, option list static |
| **hermes** | static `none minimal low medium high xhigh max` (naming is hermes's own `/reasoning` vocabulary) | `/reasoning <v>` | ❌ no |
| **pi** | **per model from `~/.pi/agent/models-store.json` `thinkingLevelMap`** — levels with a `null` value are filtered out; `reasoning: false` models → `["off"]`; models with no map → full `off minimal low medium high xhigh max` (pi clamps on apply) | `/thinking <v>` (applies directly; pi validates/clamps) | ✅ yes — the dial mirrors exactly what the model supports |

## Why DeepSeek has no `medium`

Both opencode and pi describe per-model capabilities, and DeepSeek's map genuinely has no middle tier:

- **opencode** (`opencode models --verbose openrouter`): `deepseek-v4-flash` → `variants: { low, high, max }` → dial shows `default / low / high / max`. `claude-sonnet-4-6` → `low medium high max`; `gemini-3.8-flash` → `low medium high`. The variant set is per model.
- **pi** (`models-store.json` `thinkingLevelMap`): `openrouter/~deepseek/deepseek-v4-flash-latest` → `{ off: "none", medium: null, … }` → dial shows `off low high max`; `openrouter/deepseek/deepseek-v4-flash` → `off high xhigh`; `kilo/deepseek/*` → `off` only; `deepseek-chat` (`reasoning: false`) → `off` only.

So seeing **only `thinking: high`/`off` (pi)** or **`Default(low/high/max)` (opencode)** for a DeepSeek
session is correct — the model really doesn't accept `medium`. Pi's docs confirm: `/thinking`
accepts `off|minimal|low|medium|high|xhigh|max` and is *clamped to the model's capabilities*
(the `thinkingLevelMap` is that capability set).

## Dynamic discovery status (can we get values dynamically?)

| Source of truth | Agent(s) | Works today? |
|---|---|---|
| `getDiscoverVariantCmd()` CLI (`opencode models --verbose`) | opencode | ✅ after the Oct-2025 id-matching fix (`parseModelVariants` now reconstructs the canonical `providerID/id` form — opencode prints block ids without the outer provider, e.g. `deepseek/…` for `openrouter/deepseek/…`) |
| Per-model cache file (`models-store.json` `thinkingLevelMap`, claude `model-catalog` `effort_options`) | pi, claude | ✅ read fresh each poll (pi store cached by mtime) |
| Static per-agent list | codex, agy, hermes | ❌ fixed; acceptable because these hosts expose no per-model capability data locally |

Possible future work if a host starts exposing per-model effort data:

- **codex**: `models_cache.json` has no effort field today, but the Codex server can report reasoning
  capabilities per model — would slot into `getEfforts(modelId)` the same way claude/pi do.
- **pi**: models without a `thinkingLevelMap` currently fall back to the full 7-level list; pi clamps
  on apply, but the dial could query `pi --list-models <model>` (already wired for model discovery)
  which carries a `thinking` column.

## Where it lives

- Option resolution: `dialList("effort")` / `refreshEfforts()` in `src/plugin.ts`
- Per-agent profiles: `getEfforts(modelId?)`, `getDiscoverVariantCmd()`, `parseDiscoveredEfforts()` in `src/agents.ts`
- Live current value: `readCurrentState()` per agent (pi: `thinking_level_change` from session JSONL; opencode: `variant` map in `model.json`; claude: transcripts + `settings.json`; codex: `config.toml` `model_reasoning_effort`; agy: CLI logs; hermes: `config.yaml` `reasoning_effort`)