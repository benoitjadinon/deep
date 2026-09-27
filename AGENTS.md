## Language Rule

- **English only**: Always communicate with the user in English. All responses, explanations, code comments, commit messages, and documentation must be strictly in English. Never use Korean.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## What this plugin does

**Deep** ("AgentDeck") is a Stream Deck Plus plugin that turns [Orca](https://orca.computer) agent sessions into a hardware control surface: 8 keys show session state as a color board, a key tap focuses that session, and the 4 dials set model / effort, pick a target session, and push-to-talk voice input. Built for macOS + Stream Deck Plus + Orca (macOS-only: STT, permissions, audio). All agent communication, comments, and documentation in this codebase are strictly in English.

Control model — the **target** session (what dials act on) is marked with a coral dot/ring:
- **Key (Session Slot)** — color ribbon = agent state (blue working · amber waiting · green done · red error · white idle), center = project name, bottom = branch. Slots are **grouped by project** (agents of one project sit next to each other) with groups ordered by most recent activity (freshest project first; most recent session first inside a group). Tap → `orca terminal switch` + focus Orca (if already focused on that session in Orca, performs an OS-wide super-tab back to the previous app). A done-but-unread session shows green; once reviewed it fades to idle. Attention keys (waiting/done-unread/error) pulse.
- **Dial 1 (model)** — rotate cycles the **agent's actual available models**; push applies it. Gated per `agentType` (from `orca worktree ps`): `claude`/`codex`/`opencode`/`agy`/`hermes`/`pi` supported, everything else blocked (dial shows `-`). Command is agent-specific — Claude gets `/model <m>` slash; opencode gets `ctrl+x m` (leader+m, deterministic) to open the model picker, then the dial types a **provider-qualified filter** (`<provider> <name>`, e.g. `openrouter MiniMax-M3`) and leaves Enter to the user to confirm; pi gets `/model <provider/id>` (pi applies directly on an exact match). The dial shows the full `provider/model` id (e.g. `openrouter/minimax/minimax-m3`) so the provider is always visible.
- **Dial 2 (effort)** — same gating; rotate cycles the agent's effort list, push applies it (Claude `/effort <e>`, opencode `/variants` picker, pi `/thinking <level>`).
- **Dial 3 (talk)** — push toggles live on-device Apple Speech recognition (language follows the system default; override via `STT_LOCALE` or `/tmp/agentdeck-stt.locale`); push again stops and sends the transcript to the target session. Errors surface on the dial (`Enable Dictation` / `Enable Mic Permission` / `Enable Speech Recognition`).
- **Dial 4 (target)** — rotate walks all sessions (works past the 8 keys) with a debounced terminal switch; push jumps to that session. The dial renders the target session **button-style**: a state-colored top status bar (blue working · amber waiting · green done · red error · white idle) with the same white state glyph as a key (`?`/`!`/checkmark/dashed ring), the label/glow tinted by that state color, and it **pulses exactly like a needs-attention button** (waiting/error/unread-done blink; urgent amber/red blink fast) — even when the session sits past the 8 visible keys. The static amber accent rail is replaced by this status bar.

## How it works

The plugin polls Orca every 1.5s and merges two sources:
`orca terminal list --json` (handles/titles, joined to worktrees by `paneKey = tabId:leafId`) + `orca worktree ps --json` (agent state, repo/branch, `unread` flag, `agentType`). `buildDeck` (pure) keeps only agent-bearing terminals, groups them by project, orders groups by most recent activity (most recent session first inside a group, handle as deterministic tiebreak so equal-activity slots stay put), and paginates to 8. **Ordering is debounced by activity buckets** (`activityBucket`, default 60s): sessions/groups active in the same wall-clock bucket keep their relative order, so several concurrently working projects don't re-sort the keys every poll — override the bucket size with `AGENTDECK_ORDER_BUCKET_MS`. Rendering is canvas-free SVG rendered to pure functions (`keySvg`/`dialImage`) with a 160ms pulse loop gated on `needsAttention`. Dial roles are fixed by dial position (column 0–3), not by action instance.

**Dial gating and model discovery** (`src/agents.ts`, pure): model/effort/mode planning is per `agentType`.
- `claude`: slash commands (`/model`, `/effort`, `/mode`), dynamic model & effort discovery from `~/.claude/cache/model-catalog/*.json`, and live state tracking from `settings.json` + `~/.claude/projects/` transcripts.
- `codex`: slash commands (`/model`, `/effort`, `/permissions`), dynamic model discovery from `~/.codex/models_cache.json`, and live state tracking from workspace/global `config.toml` (`model_reasoning_effort`, `sandbox_mode`).
- `opencode`: picker dialogs (`ctrl+x m` for model, `/variants` for effort, `ctrl+x a` for mode) driven by terminal-send keystrokes, with the model list **discovered live** via host `opencode models --verbose` (throttled every 30s) — the parser keeps only `provider/model` id lines and extracts each model's display `name` (`parseModelIdLines`/`parseOpenCodeModelNames`), so the picker filter can be provider-qualified (`<provider> <name>`) to disambiguate same-named models across providers. For `opencode`, the dial also shows the **currently selected model/effort/mode** by reading `~/.local/state/opencode/model.json` (`recent[0]` = model, `variant[model]` = effort) and `tui` every poll — so a model changed in the TUI appears on the dial within ~1.5s.
- `agy` / `antigravity`: slash commands (`/model`, `/effort`), `Shift-Tab` mode cycling, dynamic model discovery from `agy models`, and live state tracking from `settings.json` and session logs.
- `hermes`: slash commands (`/model`, `/reasoning`), dynamic model discovery from `provider_models_cache.json`, and live state tracking from `config.yaml`.
- `pi`: slash commands (`/model <provider/id>`, `/thinking <level>`), dynamic model discovery from host `pi --list-models` (fallback to the local `~/.pi/agent/models-store.json` catalog, cached by mtime), and live state tracking from pi session JSONL (`~/.pi/agent/sessions/--<path>--/*.jsonl`): head read for session-start state + tail read for live state (newest `model_change`/`thinking_level_change`, and the newest assistant message as the continuous live-model signal), with `settings.json` defaults as fallback. `mode` is unsupported (gated `-`); available thinking levels per model come from `thinkingLevelMap`.
- Unknown/unsupported agents are hard-gated — the dial shows `-` and push is a no-op (no wrong command sent). A 2.5s grace after dial rotate prevents the auto-read from clobbering an in-flight pick.

STT uses a separately signed `SttHelper.app` (Swift, `src/stt-helper.swift`) so macOS TCC trusts mic/speech usage descriptions — the plugin launches it via `open`, polls `/tmp/agentdeck-stt.partial` for live transcript and `.status` for failure codes, SIGINTs to finalize, then sends the text. Requires Dictation enabled + mic/speech permissions.

## Code layout

| Path | Role |
|---|---|
| `src/deck.ts` | Pure core: `orca` sources → 8-slot button model (`buildDeck`, `needsAttention`, state→color mapping) |
| `src/agents.ts` | Pure per-agent profiles: gating, apply command builders, live model discovery (`parseModels`) |
| `src/render.ts` | Pure SVG rendering: `keySvg`/`dialImage`, wrapping, marquee, glow pulse |
| `src/plugin.ts` | Elgato glue: actions, `orca` CLI calls, 1.5s poll, dial logic, target tracking, talk lifecycle |
| `src/stt-helper.swift` + plist | Apple Speech STT helper app (signed `.app` bundle) |
| `scripts/poll.mjs` | `npm run poll` — render the board to a terminal (smoke against real `orca`) |
| `scripts/gen-icons.mjs` | SVG → PNG icon pipeline |
| `com.byjw.deep.sdPlugin/` | Plugin bundle: `manifest.json`, `launch.sh` (runs plugin.js under system node), `SttHelper.app` |

## Building & debugging (this repo)

**Build + test:**
- `npm test` — Vitest over the pure layers (`src/deck.ts`, `src/agents.ts`, `src/render.ts`). Runs non-deterministically in Orca's symlinked worktrees too — the repo runs `test/deck.test.ts` + `test/render.test.ts` under the checked-out copy; ignore `.orca/worktrees/**/test` duplicates.
- `npm run build` — esbuild → `com.byjw.deep.sdPlugin/bin/plugin.js`. **Note:** the repo's `node_modules/esbuild` was once missing (downloaded nothing) — `npm install` restored it; if `sh: esbuild: command not found`, run `npm install` first.
- `npx tsc --noEmit` — shows **pre-existing, unrelated** `@action` decorator signature errors (SDK typing vs TS 5.7). The real build is esbuild; don't chase those.
- Smoke a script: `bash com.byjw.deep.sdPlugin/bin/launch.sh -port <n> -pluginUUID test -registerEvent registerPlugin -info '{}'` from the plugin root.
- **Build→reload loop:** `npm run build && npm run restart` — `scripts/restart-opendeck.sh` (`npm run restart`) quits + relaunches **OpenDeck** (the Stream Deck host app in use) so the rebuilt `plugin.js` takes effect (host apps don't hot-reload plugins). It also best-effort quits Elgato Stream Deck if running, since the two apps fight over the same hardware. Use this when testing a code change. Verify it picked up: `pgrep -fl plugin.js | grep deep` (expect a fresh node pid, parent `opendeck`) and check `/tmp/agentdeck-debug.json`'s `at` timestamp advanced.

**Deploy / relaunch (crucial):**
- The installed plugin is a **symlink** to this repo in **both** host plugin dirs: Elgato (`~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.byjw.deep.sdPlugin -> …/deep/com.byjw.deep.sdPlugin`, via `npx @elgato/cli link com.byjw.deep.sdPlugin`) and OpenDeck (`~/Library/Application Support/opendeck/plugins/com.byjw.deep.sdPlugin -> …/deep/com.byjw.deep.sdPlugin`). So a **rebuild of `plugin.js` is automatically the running bundle** — no copy needed.
- **You must fully quit + reopen OpenDeck** (Cmd+Q / `npm run restart`, not just close) for a rebuilt `plugin.js` to take effect. Other plugin .js run off host-managed node; this one runs via `launch.sh` under system node.

**Debug flow / evidence:**
- Plugin runtime logs live in the **linked** dir's `logs/` — e.g. `<link>/logs/com.byjw.deep.0.log`. This is where a crash/exception surfaces first.
- `/tmp/agentdeck-debug.json` — last poll state dump (`slotViews`, `dialViews`, `target`, `slots[]` incl. `agentType`). If `slotViews:0`/`dialViews:0`, no keys/dials ever drew.
- `/tmp/agentdeck-*.json|.log` STT artifacts; `/tmp/agentdeck-stt.log` has the recognizer's locale/errors.
- Common traps observed here:
  - **"black keys / dead dials = plugin crashed on startup."** Whether it's running: `ps aux | grep byjw.deep` (expect a node process); if not, read the newest `logs/com.byjw.deep.*.log` tail — a JS `ReferenceError` at a dial/action `onWillAppear` kills the whole plugin with no keys drawn. Repro on the CLI: `cd <plugin root> && timeout 4 node bin/plugin.js -port 1 -pluginUUID x -registerEvent registerPlugin -info '{"devices":[]}'` (needs cwd = plugin root so `manifest.json` resolves).
  - **Installed-plugin encryption**: a plugin installed via a `.streamDeckPlugin` packages `manifest.json` inside an encrypted header; hand-editing its `bin/` can make Stream Deck silently stop launching it. Prefer the `link` dev-symlink over editing the installed copy.
  - **`launch.sh` exec bit**: must stay `-rwxr-xr-x` (repo already has `100755`); SD execs it via PATH. A non-exec copy → exit 126 → no plugin.
  - **Session missing from deck even though `orca worktree ps` lists its agent**: check its `paneKey` — Orca's experimental chat UI hosts agents as *structured agent sessions* (`paneKey` starts with `structured-agent-session-<agent>_…`, `structuredHostOwned: true`, headless, no PTY). Those never match a terminal's `tabId:leafId`, so `buildDeck` drops them by design, and `orca terminal *` cannot control them (no CLI send path yet). Disable the chat UI and use `orca worktree create --agent <id>` (terminal-backed, returns `agentTerminalHandle`) — verified live for claude: the `--agent` path yields a real `agentIdentity: claude` terminal that shows and accepts dial updates; chat-UI sessions do neither until Orca exposes session-level RPC in the CLI.
  - **STT `mic err` = `open SttHelper.app` failing** (launchd job spawn, xattr/provenance or signature), not necessarily the mic. See `logs/com.byjw.deep.*.log` for `stt start: Error`.
- `scripts/poll.mjs` (`npm run poll`) renders the 8-slot board to a terminal as a live-Orca smoke test.