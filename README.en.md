# Deep

**A physical control surface for directing [Orca](https://orca.computer) Claude (or compatible agent) sessions from a Stream Deck Plus.**

When running several agents in parallel, instead of hopping between windows, you can **view the 8-slot state board** · **tap to jump** · **change model/effort via dials** · and **direct via voice**. An OpenAI Codex Micro-style concept, on a Stream Deck.

---

## Requirements
| | |
|---|---|
| **macOS** | Required (STT, permissions, and audio are macOS-only) |
| **[Orca](https://orca.computer)** | Required — session listing, state, switching, and sending all go through the `orca` CLI |
| **Node.js** | Required — runs under the system node (auto-detected via homebrew/local/nvm) |
| **Stream Deck +** | 8 keys + 4 dials (dial features are +-only) |
| Agent | Claude Code recommended. The session board and Talk work with any Orca agent; the **model/effort dials** need agents that accept `/model` and `/effort` (e.g. Claude) |

## Download · Install (users)
1. Download the latest `com.byjw.deep.streamDeckPlugin` from [Releases](https://github.com/Jungwoon/deep/releases)
2. **Double-click** the file → Stream Deck app install window → install
3. In the Stream Deck app, check the **Deep** category on the right → drag onto keys/dials as in [Action placement](#action-placement-stream-deck-app) below

> The voice (STT) helper is Apple-notarized, so it runs without a Gatekeeper warning.

## Building from source (developers)
```bash
git clone https://github.com/Jungwoon/deep && cd deep
npm install
npm run package                              # icons + esbuild bundle
npx streamdeck link com.byjw.deep.sdPlugin
# New plugins are scanned at Stream Deck app startup → restart the app once
```

## Action placement (Stream Deck app)
- **Keypad tab** → **Deep** category on the right → drag **Session Slot** onto the **8 keys** (slot = coordinate, automatic, no setup needed)
- **Dial tab** → drag onto the dials: **Model / Effort / Talk / Target session selection**

## Usage
### Keys (session board)
| Element | Meaning |
|---|---|
| **Top color ribbon** | 🔵 working · 🟡 waiting (input needed) · 🟢 done · 🔴 error · ⚪ idle |
| **Center white text** | Project name (extracted from the path, e.g. `AcmeApp`) |
| **Bottom** | Branch. The session you're currently viewing is highlighted with a coral chip |
| **Tap** | Focus that session (`orca terminal switch`) |
| **Green done color** | done + unread = green (needs checking), fades to white (idle) once reviewed |

### Dials
| Dial | Rotate | Push |
|---|---|---|
| **Model** | choose opus↔sonnet↔haiku | apply `/model` to the current session |
| **Effort** | choose low↔…↔ultracode | apply `/effort` to the current session |
| **Talk** | — | push to start recording → speak → push again to stop and send (toggle) |
| **Target session selection** | walk all sessions (moves focus) | jump to that session |

> Dials act on the **session you're currently viewing (focused)**. The coral chip marks the target.

## 🎤 Talk (voice input) setup — first time only
Talk uses **macOS on-device speech recognition**. You need:
1. **Turn on Dictation**: System Settings → Keyboard → **Dictation On**
2. **Allow permissions**: the first Talk push prompts for **Microphone** and **Speech Recognition** permissions → allow
3. Make sure the input device is your actual mic (System Settings → Sound → Input)

The recognition language follows your **system Dictation language** automatically (it is no longer hardcoded to Korean). To force a specific language, set the `STT_LOCALE` environment variable (e.g. `en-US`) or write the locale into `/tmp/agentdeck-stt.locale`.

If something's wrong, the **Talk dial shows the cause**: `받아쓰기 켜기` (turn on Dictation) / `마이크 권한 켜기` (turn on mic permission) / `음성인식 권한 켜기` (turn on speech-recognition permission).

## Limitations
- **Mac + Orca only**. Other terminals/OSes unsupported.
- **Keys are 8 slots (1 page)**. With more than 8 sessions, the 9th+ aren't on the keys but remain reachable via the **target dial**.
- Model/effort presets are Claude-based (other agents use different names).

## Development
```bash
npm test          # core unit tests (Vitest)
npm run build     # esbuild → com.byjw.deep.sdPlugin/bin/plugin.js
npm run poll      # preview real orca sessions as a console state board
# STT helper (Swift): swiftc src/stt-helper.swift → .app bundle, requires Developer ID signing
```
- **Node execution**: `bin/launch.sh` runs with the system node instead of the Elgato-managed Node (avoids a missing runtime).
- **STT**: must be a signed `.app` bundle so macOS TCC trusts the mic/speech usage descriptions. Distribution needs **notarization**.
- Debug: `/tmp/agentdeck-*.json`·`.log` (poll state, recognition results, failure codes).