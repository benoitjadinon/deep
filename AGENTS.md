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
- **Dial 1 (model)** — rotate cycles `opus`→`sonnet`→`haiku`; push applies `/model <m>` to the target via `orca terminal send --enter`.
- **Dial 2 (effort)** — rotate cycles `low`→`medium`→`high`→`xhigh`→`ultracode`; push applies `/effort <e>`.
- **Dial 3 (talk)** — push toggles live on-device Apple Speech recognition (language follows the system default; override via `STT_LOCALE` or `/tmp/agentdeck-stt.locale`); push again stops and sends the transcript to the target session. Errors surface on the dial (`받아쓰기 켜기` / `마이크 권한 켜기` / `음성인식 권한 켜기`).
- **Dial 4 (target)** — rotate walks all sessions (works past the 8 keys) with a debounced terminal switch; push jumps to that session.

## How it works

The plugin polls Orca every 1.5s and merges two sources:
`orca terminal list --json` (handles/titles, joined to worktrees by `paneKey = tabId:leafId`) + `orca worktree ps --json` (agent state, repo/branch, `unread` flag). `buildDeck` (pure) keeps only agent-bearing terminals, sorts stably by handle (fixed slots = muscle memory), and paginates to 8. Rendering is canvas-free SVG rendered to pure functions (`keySvg`/`dialImage`) with a 160ms pulse loop gated on `needsAttention`. Dial roles are fixed by dial position (column 0–3), not by action instance.

STT uses a separately signed `SttHelper.app` (Swift, `src/stt-helper.swift`) so macOS TCC trusts mic/speech usage descriptions — the plugin launches it via `open`, polls `/tmp/agentdeck-stt.partial` for live transcript and `.status` for failure codes, SIGINTs to finalize, then sends the text. Requires Dictation enabled + mic/speech permissions.

## Code layout

| Path | Role |
|---|---|
| `src/deck.ts` | Pure core: `orca` sources → 8-slot button model (`buildDeck`, `needsAttention`, state→color mapping) |
| `src/render.ts` | Pure SVG rendering: `keySvg`/`dialImage`, wrapping, marquee, glow pulse |
| `src/plugin.ts` | Elgato glue: actions, `orca` CLI calls, 1.5s poll, dial logic, target tracking, talk lifecycle |
| `src/stt-helper.swift` + plist | Apple Speech STT helper app (signed `.app` bundle) |
| `scripts/poll.mjs` | `npm run poll` — render the board to a terminal (smoke against real `orca`) |
| `scripts/gen-icons.mjs` | SVG → PNG icon pipeline |
| `com.byjw.deep.sdPlugin/` | Plugin bundle: `manifest.json`, `launch.sh` (runs plugin.js under system node), `SttHelper.app` |

Dev: `npm test` (Vitest, pure layers), `npm run build` (esbuild → `plugin.js`), `npm run poll`. Debug state dumps at `/tmp/agentdeck-*.json|.log`.