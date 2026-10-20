# Deep

**A physical control surface for directing [Orca](https://orca.computer) Claude (or compatible agent) sessions from a Stream Deck Plus.**

When running several agents in parallel, instead of hopping between windows, you can **view the 8-slot state board** · **tap to jump** · **change model/effort via dials** · and **direct via voice**. An OpenAI Codex Micro-style concept, on a Stream Deck.

---

## Requirements
| | |
|---|---|
| **macOS or Linux** | macOS uses the Apple Speech helper; Linux (Hyprland) see [Linux](#linux-hyprland--opendeck) |
| **[Orca](https://orca.computer)** | Required — session listing, state, switching, and sending all go through the `orca` CLI |
| **Node.js** | Required — runs under the system node (auto-detected via homebrew/local/nvm) |
| **Stream Deck +** | 8 keys + 4 dials (dial features are +-only) |
| Agent | Claude Code recommended. The session board and Talk work with any Orca agent; the **model/effort dials** need agents that accept `/model` and `/effort` (e.g. Claude) |

## Linux (Hyprland + OpenDeck)
Works on Linux with [OpenDeck](https://github.com/nekename/OpenDeck) (Flatpak or native) instead of the Elgato app.

| macOS piece | Linux replacement |
|---|---|
| `lsappinfo` / `open -b` (focus Orca, toggle back to the previous app) | `hyprctl` (Hyprland, Lua or classic dispatch syntax); needs to be reachable from the plugin process |
| Orca data in `~/Library/Application Support/orca` | `~/.config/orca` (`$XDG_CONFIG_HOME/orca`) |
| Apple Speech helper (Talk) | `pw-record` (PipeWire) + [`whisper-cli`](https://github.com/ggml-org/whisper.cpp), fully offline |
| `orca` CLI on PATH | Orca AppImage shim in `~/.config/orca/linux-orca-cli-shim/orca` is found automatically |

```bash
sudo pacman -S whisper-cpp                      # Arch; provides /usr/bin/whisper-cli
mkdir -p ~/.local/share/agentdeck/whisper
curl -L -o ~/.local/share/agentdeck/whisper/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
npm install && npm run build
ln -s "$PWD/com.byjw.deep.sdPlugin" <opendeck-config>/plugins/com.byjw.deep.sdPlugin
# Flatpak: <opendeck-config> = ~/.var/app/me.amankhanna.opendeck/config/opendeck, and grant the sandbox read access:
flatpak override --user --filesystem="$PWD":ro me.amankhanna.opendeck
npm run restart                                 # restarts OpenDeck and the plugin
```
- OpenDeck starts the plugin with the host's `node` (Node 20+). Talk's language follows `STT_LOCALE` (e.g. `fr-FR`) and defaults to auto-detect; use `AGENTDECK_WHISPER_MODEL` for another model file (e.g. `ggml-small.bin`).
- Talk dial hints on Linux: `Install whisper-cpp`, `No whisper model`, `Mic Error`, `STT Failed`.

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
- **Dial tab** → drag onto the dials: **Model / Effort / Mode / Talk / Target session selection**

## Usage
### Keys (session board)
| Element | Meaning |
|---|---|
| **Top color ribbon** | 🔵 working · 🟡 waiting (input needed) · 🟢 done · 🔴 error · ⚪ idle |
| **Center white text** | Project name (extracted from the path, e.g. `AcmeApp`), branch, then a 2-line session summary |
| **Bottom edge** | Host running that project — `ben-laptop13` for this machine, `Mac mini` for a remote Orca host — with the focused session marked by a coral dot at the bottom right |
| **Tap** | Focus that session (`orca terminal switch`) / If already focused on that session, toggle back to previous app (OS super-tab) |
| **Green done color** | done + unread = green (needs checking), fades to white (idle) once reviewed |

### Dials
| Dial | Rotate | Push |
|---|---|---|
| **Model** | choose opus↔sonnet↔haiku | apply `/model` to the current session |
| **Effort** | choose low↔…↔ultracode | apply `/effort` to the current session |
| **Mode** | choose plan↔build↔… | apply mode to the current session |
| **Talk** | — | push to start recording → speak → push again to stop and send (toggle) |
| **Target session selection** | walk all sessions (moves focus) | jump to that session |

> Dials act on the **session you're currently viewing (focused)**. The coral chip marks the target.

## 🎤 Talk (voice input) setup — first time only
Talk uses **macOS on-device speech recognition**. You need:
1. **Turn on Dictation**: System Settings → Keyboard → **Dictation On**
2. **Allow permissions**: the first Talk push prompts for **Microphone** and **Speech Recognition** permissions → allow
3. Make sure the input device is your actual mic (System Settings → Sound → Input)

The recognition language follows your **system Dictation language** automatically. To force a specific language, set the `STT_LOCALE` environment variable (e.g. `en-US`) or write the locale into `/tmp/agentdeck-stt.locale`.

If something's wrong, the **Talk dial shows the cause**: `Enable Dictation` / `Enable Mic Permission` / `Enable Speech Recognition`.

## Limitations
- **Mac + Orca only**. Other terminals/OSes unsupported.
- **Keys are 8 slots (1 page)**. With more than 8 sessions, the 9th+ aren't on the keys but remain reachable via the **target dial**. Slots are **grouped by project** (a project's agents sit together) and ordered by most recent activity: freshest project group first, freshest session first inside a group, handle as tiebreak. Activity is bucketed (60s) so multiple concurrently working projects don't re-sort the keys constantly — override with `AGENTDECK_ORDER_BUCKET_MS` (milliseconds).
- Dial signals are **gated per running agent**: only supported agents (Claude, OpenCode, Codex, AGY, Hermes, Pi) get a working model/effort/mode dial, and model lists are **loaded live** from respective agent configurations and tools. Unsupported/unknown agents get the dial blocked (`-`), so no wrong command is ever sent.
- **Sessions from paired remote Orca runtimes** (e.g. a Mac mini, via `orca environment list`) share the same board: the tile footer names the machine (`BEN-LAPTOP13`, `MAC MINI`) and taps/dials are routed to that runtime. Because the remote agent's own files are not readable here, its dials show the **last applied** model/effort/mode rather than live state, and remote tiles draw no project watermark icon.

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