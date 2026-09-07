## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## What this plugin does

**Deep** ("AgentDeck") is a Stream Deck Plus plugin that turns [Orca](https://orca.computer) agent sessions into a hardware control surface: 8 keys show session state as a color board, a key tap focuses that session, and the 4 dials set model / effort, pick a target session, and push-to-talk voice input. Built for macOS + Stream Deck Plus + Orca (macOS-only: STT, permissions, audio). Comments and UI strings in this codebase are in Korean.

Control model — the **target** session (what dials act on) is marked with a coral dot/ring:
- **Key (Session Slot)** — color ribbon = agent state (blue working · amber waiting · green done · red error · white idle), center = project name, bottom = branch held steady by handle-sorted order. Tap → `orca terminal switch` + focus Orca. A done-but-unread session shows green; once reviewed it fades to idle. Attention keys (waiting/done-unread/error) pulse.
- **Dial 1 (model)** — rotate cycles the **agent's actual available models**; push applies it. Gated per `agentType` (from `orca worktree ps`): `claude`/`opencode` supported, everything else blocked (dial shows `-`). Command is agent-specific — Claude gets `/model <m>` slash; opencode gets `ctrl+x m` (leader+m, deterministic) to open the model picker, then the dial types a **provider-qualified filter** (`<provider> <name>`, e.g. `openrouter MiniMax-M3`) and leaves Enter to the user to confirm. The dial shows the full `provider/model` id (e.g. `openrouter/minimax/minimax-m3`) so the provider is always visible.
- **Dial 2 (effort)** — same gating; rotate cycles the agent's effort list, push applies it (Claude `/effort <e>`, opencode `/variants` picker).
- **Dial 3 (talk)** — push toggles live on-device Apple Speech recognition (language follows the system default; override via `STT_LOCALE` or `/tmp/agentdeck-stt.locale`); push again stops and sends the transcript to the target session. Errors surface on the dial (`받아쓰기 켜기` / `마이크 권한 켜기` / `음성인식 권한 켜기`).
- **Dial 4 (target)** — rotate walks all sessions (works past the 8 keys) with a debounced terminal switch; push jumps to that session.

## How it works

The plugin polls Orca every 1.5s and merges two sources:
`orca terminal list --json` (handles/titles, joined to worktrees by `paneKey = tabId:leafId`) + `orca worktree ps --json` (agent state, repo/branch, `unread` flag, `agentType`). `buildDeck` (pure) keeps only agent-bearing terminals, sorts stably by handle (fixed slots = muscle memory), and paginates to 8. Rendering is canvas-free SVG rendered to pure functions (`keySvg`/`dialImage`) with a 160ms pulse loop gated on `needsAttention`. Dial roles are fixed by dial position (column 0–3), not by action instance.

**Dial gating and model discovery** (`src/agents.ts`, pure): model/effort planning is per `agentType`. `claude` = slash commands (`/model`, `/effort`) over the static curated list. `opencode` = picker dialogs (`ctrl+x m` for model, `/variants` for effort) driven by terminal-send keystrokes, with the model list **discovered live** via host `opencode models --verbose` (throttled every 30s) — the parser keeps only `provider/model` id lines and extracts each model's display `name` (`parseModelIdLines`/`parseOpenCodeModelNames`), so the picker filter can be provider-qualified (`<provider> <name>`) to disambiguate same-named models across providers. Unknown/unsupported agents are hard-gated — the dial shows `-` and push is a no-op (no wrong command sent). For `opencode`, the dial also shows the **currently selected model/effort** by reading `~/.local/state/opencode/model.json` (`recent[0]` = model, `variant[model]` = effort) every poll — so a model changed in the TUI appears on the dial within ~1.5s. A 2.5s grace after dial rotate prevents the auto-read from clobbering an in-flight pick.

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
- **Build→reload loop:** `npm run build && npm run restart` — `scripts/restart-streamdeck.sh` (`npm run restart`) quits + relaunches Elgato Stream Deck so the rebuilt `plugin.js` takes effect (Stream Deck doesn't hot-reload plugins). Use this when testing a code change. Verify it picked up: `pgrep -fl plugin.js | grep deep` (expect a fresh node pid) and check `/tmp/agentdeck-debug.json`'s `at` timestamp advanced.

**Deploy / relaunch (crucial):**
- The installed plugin is a **symlink** to this repo (`~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.byjw.deep.sdPlugin -> …/deep/com.byjw.deep.sdPlugin`, via `npx @elgato/cli link com.byjw.deep.sdPlugin`). So a **rebuild of `plugin.js` is automatically the running bundle** — no copy needed.
- **You must fully quit + reopen Stream Deck** (Cmd+Q, not just close) for a rebuilt `plugin.js` to take effect. Other plugin .js run off Elgato-managed node; this one runs via `launch.sh` under system node.

**Debug flow / evidence:**
- Plugin runtime logs live in the **linked** dir's `logs/` — e.g. `<link>/logs/com.byjw.deep.0.log`. This is where a crash/exception surfaces first.
- `/tmp/agentdeck-debug.json` — last poll state dump (`slotViews`, `dialViews`, `target`, `slots[]` incl. `agentType`). If `slotViews:0`/`dialViews:0`, no keys/dials ever drew.
- `/tmp/agentdeck-*.json|.log` STT artifacts; `/tmp/agentdeck-stt.log` has the recognizer's locale/errors.
- Common traps observed here:
  - **"black keys / dead dials = plugin crashed on startup."** Whether it's running: `ps aux | grep byjw.deep` (expect a node process); if not, read the newest `logs/com.byjw.deep.*.log` tail — a JS `ReferenceError` at a dial/action `onWillAppear` kills the whole plugin with no keys drawn. Repro on the CLI: `cd <plugin root> && timeout 4 node bin/plugin.js -port 1 -pluginUUID x -registerEvent registerPlugin -info '{"devices":[]}'` (needs cwd = plugin root so `manifest.json` resolves).
  - **Installed-plugin encryption**: a plugin installed via a `.streamDeckPlugin` packages `manifest.json` inside an encrypted header; hand-editing its `bin/` can make Stream Deck silently stop launching it. Prefer the `link` dev-symlink over editing the installed copy.
  - **`launch.sh` exec bit**: must stay `-rwxr-xr-x` (repo already has `100755`); SD execs it via PATH. A non-exec copy → exit 126 → no plugin.
  - **STT `mic err` = `open SttHelper.app` failing** (launchd job spawn, xattr/provenance or signature), not necessarily the mic. See `logs/com.byjw.deep.*.log` for `stt start: Error`.
- `scripts/poll.mjs` (`npm run poll`) renders the 8-slot board to a terminal as a live-Orca smoke test.