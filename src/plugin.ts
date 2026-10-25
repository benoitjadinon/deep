// AgentDeck Stream Deck plugin entrypoint.
// Polls Orca to render session states across 8 slots, and handles keyDown / dials to control Orca.
// Dial roles determined by physical position (column): 0=Model 1=Effort 2=Talk 3=Target.
import streamDeck, { action, SingletonAction } from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, watch, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import {
  IS_LINUX,
  orcaDataDir,
  linuxExtraPath,
  withExtraPath,
  parseHyprClients,
  isOrcaClass,
  isDeckHostClass,
  previousWindow,
  orcaWindow,
  hyprFocusDispatches,
  WHISPER_BIN_CANDIDATES,
  whisperModelPath,
  whisperLanguage,
  whisperArgs,
  cleanTranscript,
  pwRecordArgs,
} from "./linux";
import {
  buildDeck,
  environmentArgs,
  needsAttention,
  resolveActiveTerminal,
  nextWorktreeName,
  stabilizeTerminalAgents,
  type Deck,
  type OrcaHost,
  type OrcaRepo,
  type CachedTerminalAgent,
} from "./deck";
import { keyImage, dialImage } from "./render";
import { prefetchRepoIcons } from "./icons";
import {
  agentFor,
  profileFor,
  supported,
  stepsFor,
  discoverModelCmd,
  discoverAgentCmd,
  discoverVariantCmd,
  parseModels,
  parsePrimaryAgents,
  parseModelVariants,
  parseOpenCodeState,
  parseTuiAgent,
  sortModels,
  AbstractAgent,
  UNSUPPORTED_AGENT,
  UNSUPPORTED_PROFILE,
  type AgentContext,
  type AgentProfile,
  type ApplyStep,
  type ControlKind,
  type OpenCodeModelState,
  type OrcaRateLimits,
  readLocalAgyQuota,
  HERMES_MODELS_CACHE,
  HERMES_MODELS_CACHE_TMP,
} from "./agents";

const execFileP = promisify(execFile);
// Plugin processes started by the OpenDeck Flatpak get a minimal host PATH; add the usual user bin dirs
if (IS_LINUX) process.env.PATH = withExtraPath(process.env.PATH, linuxExtraPath(homedir()));
const ORCA_DATA_DIR = orcaDataDir(process.platform, homedir(), process.env);
// Search common paths across different machines (eliminating hardcoded paths)
function firstExisting(candidates: string[], fallback: string): string {
  for (const p of candidates) if (existsSync(p)) return p;
  return fallback;
}
const ORCA = firstExisting([
  "/usr/local/bin/orca",
  "/opt/homebrew/bin/orca",
  // Linux AppImage install: Orca drops its CLI shim here instead of on PATH
  join(homedir(), ".config/orca/linux-orca-cli-shim/orca"),
], "orca");
// Full path to opencode — avoids injection of unsupported --permissions arguments from Orca's opencode launcher
const OPENCODE_CMD = firstExisting([
  join(homedir(), ".opencode", "bin", "opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
  "/opt/local/bin/opencode",
], "opencode");
// Apple Speech STT helper — bundled in the same bin/ directory alongside plugin.js
const STT_APP = join(__dirname, "SttHelper.app");
const STT_TXT = "/tmp/agentdeck-stt.txt";
const STT_PID = "/tmp/agentdeck-stt.pid";
const STT_PARTIAL = "/tmp/agentdeck-stt.partial"; // Real-time partial recognition result
const STT_STATUS = "/tmp/agentdeck-stt.status"; // Failure status code
// Last selected model/variant recorded by opencode (reflects TUI changes)
const OPENCODE_STATE = join(homedir(), ".local", "state", "opencode", "model.json");
// Current opencode agent/mode from TUI TOML (e.g. agent = "build")
const OPENCODE_TUI = join(homedir(), ".local", "state", "opencode", "tui");
// Failure code -> dial guidance label
const TALK_HINT: Record<string, string> = {
  MIC_DENIED: "Enable Mic Perm",
  SPEECH_DENIED: "Enable Speech Rec",
  DICTATION_OFF: "Enable Dictation",
  NO_RECOGNIZER: "No STT Locale",
  MIC_ERR: "Mic Error",
  NO_WHISPER: "Install whisper-cpp",
  NO_MODEL: "No whisper model",
  STT_FAILED: "STT Failed",
};
const talkHint = (code: string) => TALK_HINT[code] ?? "STT Error";
const EXEC = { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 } as const;

async function orcaJson(args: string[]): Promise<any> {
  const { stdout } = await execFileP(ORCA, [...args, "--json"], EXEC);
  return JSON.parse(stdout);
}
async function orcaRun(args: string[]): Promise<void> {
  await execFileP(ORCA, args, EXEC);
}
interface AppInfo {
  bundleId?: string;
  name?: string;
  asn?: string;
}

let lastNonOrcaApp: AppInfo | null = null;

function isOrca(app: AppInfo | null): boolean {
  if (!app) return false;
  if (IS_LINUX) return isOrcaClass(app.bundleId);
  if (app.bundleId === "com.stablyai.orca") return true;
  if (app.name === "Orca") return true;
  return false;
}

function isStreamDeck(app: AppInfo | null): boolean {
  if (!app) return false;
  if (IS_LINUX) return isDeckHostClass(app.bundleId);
  if (app.bundleId === "com.elgato.StreamDeck") return true;
  if (app.name === "Stream Deck") return true;
  return false;
}

// ---- Linux (Hyprland): bundleId = window class, asn = window address, name = title ----
async function hyprClients() {
  const { stdout } = await execFileP("hyprctl", ["clients", "-j"], EXEC);
  return parseHyprClients(stdout);
}

const toAppInfo = (c: { address: string; class: string; title: string }): AppInfo => ({
  asn: c.address,
  bundleId: c.class,
  name: c.title,
});

async function hyprFocus(address: string): Promise<boolean> {
  for (const args of hyprFocusDispatches(address)) {
    try {
      const { stdout } = await execFileP("hyprctl", args, EXEC);
      if (!/error/i.test(stdout)) return true;
    } catch {}
  }
  return false;
}

async function getFrontmostApp(): Promise<AppInfo | null> {
  if (IS_LINUX) {
    try {
      const { stdout } = await execFileP("hyprctl", ["activewindow", "-j"], EXEC);
      const w = JSON.parse(stdout);
      return w?.address ? toAppInfo(w) : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout: frontAsn } = await execFileP("/usr/bin/lsappinfo", ["front"], EXEC);
    const asn = frontAsn.trim();
    if (!asn) return null;
    const { stdout: info } = await execFileP("/usr/bin/lsappinfo", [
      "info",
      "-only", "bundleid",
      "-only", "name",
      asn,
    ], EXEC);
    const bidMatch = info.match(/"CFBundleIdentifier"="([^"]+)"/);
    const nameMatch = info.match(/"LSDisplayName"="([^"]+)"/);
    return {
      asn,
      bundleId: bidMatch ? bidMatch[1] : undefined,
      name: nameMatch ? nameMatch[1] : undefined,
    };
  } catch {
    return null;
  }
}

async function getPreviousAppFromSystem(): Promise<AppInfo | null> {
  if (IS_LINUX) {
    try {
      const prev = previousWindow(await hyprClients());
      return prev ? toAppInfo(prev) : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout: meta } = await execFileP("/usr/bin/lsappinfo", ["metainfo"], EXEC);
    const m = meta.match(/bringForwardOrder\s*=\s*(.+)/);
    if (!m) return null;
    const entries = [...m[1].matchAll(/"([^"]+)"\s+(ASN:[^\s:]+:)/g)].map((x) => ({ name: x[1], asn: x[2] }));
    for (const app of entries) {
      if (app.name === "Orca" || app.name === "Stream Deck") continue;
      try {
        const { stdout: info } = await execFileP("/usr/bin/lsappinfo", [
          "info",
          "-only", "bundleid",
          app.asn,
        ], EXEC);
        const bidMatch = info.match(/"CFBundleIdentifier"="([^"]+)"/);
        const bundleId = bidMatch ? bidMatch[1] : undefined;
        if (bundleId && bundleId !== "com.stablyai.orca" && bundleId !== "com.elgato.StreamDeck") {
          return { name: app.name, asn: app.asn, bundleId };
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function activateApp(app: AppInfo): Promise<boolean> {
  if (IS_LINUX) return app.asn ? hyprFocus(app.asn) : false;
  if (app.bundleId) {
    try {
      await execFileP("/usr/bin/open", ["-b", app.bundleId], EXEC);
      return true;
    } catch {}
  }
  if (app.asn) {
    try {
      await execFileP("/usr/bin/lsappinfo", ["setfront", app.asn], EXEC);
      return true;
    } catch {}
  }
  if (app.name) {
    try {
      await execFileP("/usr/bin/open", ["-a", app.name], EXEC);
      return true;
    } catch {}
  }
  return false;
}

async function hideOrca(): Promise<void> {
  // No app-level hide on Linux; switchToPreviousApp already refocused the previous window
  if (IS_LINUX) return;
  try {
    await execFileP("/usr/bin/osascript", [
      "-l", "JavaScript",
      "-e", 'ObjC.import("AppKit"); const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.stablyai.orca"); if (a.count > 0) a.objectAtIndex(0).hide();',
    ], EXEC);
  } catch {}
}

// OS-level switch to previously focused app (Super-Tab: Cmd+Tab / Alt+Tab toggle effect)
async function switchToPreviousApp(): Promise<void> {
  try {
    if (lastNonOrcaApp) {
      const ok = await activateApp(lastNonOrcaApp);
      if (ok) return;
    }
    const sysPrev = await getPreviousAppFromSystem();
    if (sysPrev) {
      const ok = await activateApp(sysPrev);
      if (ok) return;
    }
    await hideOrca();
  } catch (e) {
    streamDeck.logger.error(`switch to previous app: ${e}`);
  }
}

// Bring Orca forward if it's in the background (focused on another app)
async function focusOrca(): Promise<void> {
  try {
    const frontApp = await getFrontmostApp();
    if (!isOrca(frontApp) && frontApp && !isStreamDeck(frontApp)) {
      lastNonOrcaApp = frontApp;
    }
    if (IS_LINUX) {
      const win = orcaWindow(await hyprClients());
      if (win) await hyprFocus(win.address);
      else streamDeck.logger.warn("focus orca: no Orca window found");
      return;
    }
    await execFileP("/usr/bin/open", ["-b", "com.stablyai.orca"], EXEC);
  } catch (e) {
    streamDeck.logger.error(`focus orca: ${e}`);
  }
}

// Timestamp of manual navigation (dial rotate / key tap) — prevents poll auto-tracking from overwriting manual selection immediately
let lastNav = 0;
// Last resolved Orca active terminal handle — used to detect when the user changes agents in Orca UI
let lastActiveHandle: string | undefined;
// Interaction hold: when a session slot is tapped, freeze visible slots in place for 20s
// so interacting with or replying to an agent does not reshuffle tiles out from under the user's finger.
let pinnedSlots = new Map<string, number>(); // handle -> slot index
let pinnedUntil = 0;
const PINNED_SLOT_HOLD_MS = 20_000;
function getActivePinnedSlots(): Map<string, number> | undefined {
  if (Date.now() < pinnedUntil && pinnedSlots.size > 0) {
    return pinnedSlots;
  }
  pinnedSlots.clear();
  return undefined;
}
function holdCurrentSlotsInPlace(): void {
  pinnedSlots.clear();
  pinnedUntil = Date.now() + PINNED_SLOT_HOLD_MS;
  for (let i = 0; i < deck.slots.length; i++) {
    const s = deck.slots[i];
    if (s && !s.empty && !s.isPageButton && s.handle) {
      pinnedSlots.set(s.handle, i);
    }
  }
}
// Debounce rapid target dial rotation (180ms)
let targetSwitchTimer: ReturnType<typeof setTimeout> | null = null;
function switchTargetSoon(handle: string): void {
  if (targetSwitchTimer) clearTimeout(targetSwitchTimer);
  targetSwitchTimer = setTimeout(() => {
    targetSwitchTimer = null;
    switchTerminal(handle).then(() => {
      pollDebounced(50);
    }).catch(() => {});
  }, 180);
}

let currentPage = 0;
let deck: Deck = buildDeck({ terminals: [], worktrees: [] }, { page: 0, perPage: 8 });
let tick = 0;

// Dial target / configuration state
let targetHandle: string | undefined; // Target session affected by dials (selected via key tap or dial 4)
let pendingEffort = ""; // Selected effort on dial 2 before pushing
let pendingModel = ""; // Selected model on dial 1 before pushing
let pendingMode = ""; // Selected mode on mode dial before pushing
let pendingPermissions = ""; // Selected permissions on permissions dial before pushing
const modelByHandle = new Map<string, string>(); // Last applied model per session
const effortByHandle = new Map<string, string>(); // Last applied effort per session
const modeByHandle = new Map<string, string>(); // Last applied mode per session
const permissionsByHandle = new Map<string, string>(); // Last applied permissions per session
// Currently active model/effort/mode per session read periodically from disk
const currentModelByHandle = new Map<string, string>();
const currentEffortByHandle = new Map<string, string>();
const currentModeByHandle = new Map<string, string>();
const currentPermissionsByHandle = new Map<string, string>();
// Timestamp when dial was rotated — gives grace period so auto-poll doesn't overwrite user selection
const pickAt = { model: 0, effort: 0, mode: 0, permissions: 0 };
const PICK_GRACE = 2500;
// Gating / discovery state per agent: agentType -> profile / discovered live list
const agentByHandle = new Map<string, string>(); // session -> agentType (orca worktree ps)
const agentInstanceByHandle = new Map<string, AbstractAgent>(); // session -> abstract agent instance
const modelsByHandle = new Map<string, string[]>(); // session -> discovered model list
const modesByHandle = new Map<string, string[]>(); // session -> discovered mode list
const effortsByHandle = new Map<string, string[]>(); // session -> discovered effort list
let allHandles: string[] = []; // All session handles (sidebar total, independent of 8-slot page)
const sessionByHandle = new Map<string, any>(); // handle -> button metadata
// handle -> paired environment name (undefined = this machine). Terminal handles belong to the
// runtime that issued them, so every `terminal send`/`switch` for a remote session must pass
// `--environment <name>` or it resolves against the wrong runtime.
const environmentByHandle = new Map<string, string | undefined>();
function envArgsFor(handle?: string): string[] {
  return environmentArgs(handle ? environmentByHandle.get(handle) : undefined);
}

interface OrcaRuntimeInfo {
  endpoint: string;
  authToken: string;
  mtimeMs: number;
}
let cachedRuntimeInfo: OrcaRuntimeInfo | null = null;

function getSocketEndpointAndToken(): { endpoint: string; authToken: string } | null {
  const metaPath = join(ORCA_DATA_DIR, "orca-runtime.json");
  if (!existsSync(metaPath)) return null;
  try {
    const stat = statSync(metaPath);
    if (cachedRuntimeInfo && cachedRuntimeInfo.mtimeMs === stat.mtimeMs) {
      if (existsSync(cachedRuntimeInfo.endpoint)) {
        return cachedRuntimeInfo;
      }
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const transports = Array.isArray(meta?.transports)
      ? meta.transports
      : meta?.transport
        ? [meta.transport]
        : [];
    const unixTransport = transports.find((t: any) => t?.kind === "unix");
    const endpoint = unixTransport?.endpoint;
    if (endpoint && existsSync(endpoint)) {
      cachedRuntimeInfo = {
        endpoint,
        authToken: meta.authToken || "",
        mtimeMs: stat.mtimeMs,
      };
      return cachedRuntimeInfo;
    }
  } catch {}
  return null;
}

/**
 * Fast direct RPC to Orca's local Unix domain socket.
 * Executes in ~1-5ms without spawning any child processes.
 */
async function orcaRpc(
  method: string,
  params: Record<string, any> = {},
  timeoutMs = 2500,
): Promise<any> {
  const info = getSocketEndpointAndToken();
  if (!info) throw new Error("Orca runtime socket not available");

  return await new Promise<any>((resolve, reject) => {
    let settled = false;
    const socket = createConnection(info.endpoint);
    const reqId = randomUUID();
    let buf = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Socket RPC timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    socket.on("connect", () => {
      const payload = JSON.stringify({
        id: reqId,
        authToken: info.authToken,
        method,
        params,
      }) + "\n";
      socket.write(payload);
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx !== -1) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        try {
          const line = buf.slice(0, newlineIdx);
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && parsed.ok === false) {
            reject(new Error(parsed.error?.message || `RPC error: ${method}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      }
    });
  });
}

/**
 * Direct RPC to the local Orca desktop runtime to reveal a terminal pane in the UI.
 * Used for paired remote sessions because Orca CLI's `terminal switch` commands the remote
 * server and skips local desktop reveal when the remote server returns navigated=true.
 */
async function orcaRevealTerminal(params: {
  worktreeId: string;
  tabId: string;
  leafId?: string | null;
  executionHostId?: string | null;
}): Promise<boolean> {
  try {
    const res = await orcaRpc("terminal.reveal", params);
    return res?.ok === true && res?.result?.reveal?.navigated === true;
  } catch {
    return false;
  }
}

/**
 * Switch terminal in Orca. If the terminal is on a paired remote runtime (e.g. Mac mini),
 * `terminal switch` only navigates the server; we additionally reveal the pane on the local desktop.
 */
async function switchTerminal(handle: string): Promise<void> {
  const b = sessionByHandle.get(handle);
  const env = environmentByHandle.get(handle);

  let focused = false;
  if (!env) {
    try {
      const res = await orcaRpc("terminal.focus", {
        terminal: handle,
        navigation: "host",
      });
      if (res?.ok) focused = true;
    } catch {}
  }

  if (!focused) {
    const switchArgs = ["terminal", "switch", ...envArgsFor(handle), "--terminal", handle];
    streamDeck.logger.info(`switching terminal via CLI: ${switchArgs.join(" ")}`);
    await orcaRun(switchArgs);
  }

  let worktreeId = b?.worktreeId;
  let tabId = b?.tabId;
  let leafId = b?.leafId;
  const envId = b?.environmentId;

  if (envId && (!worktreeId || !tabId)) {
    try {
      let show: any;
      if (env) {
        show = await orcaJson(["terminal", "show", ...envArgsFor(handle), "--terminal", handle]);
      } else {
        try {
          show = await orcaRpc("terminal.show", { terminal: handle });
        } catch {
          show = await orcaJson(["terminal", "show", "--terminal", handle]);
        }
      }
      if (show?.result?.terminal) {
        worktreeId = show.result.terminal.worktreeId;
        tabId = show.result.terminal.tabId;
        leafId = show.result.terminal.leafId;
      }
    } catch {}
  }

  if (envId && worktreeId && tabId) {
    const revealed = await orcaRevealTerminal({
      worktreeId,
      tabId,
      leafId,
      executionHostId: `runtime:${envId}`,
    }).catch(() => false);
    streamDeck.logger.info(`revealed remote terminal on desktop: ${revealed}`);
  }
}
const terminalAgentCache = new Map<string, CachedTerminalAgent>(); // handle -> stabilized agentIdentity across polls

// Push-to-talk state — uses Apple Speech STT helper (.app)
// Linux STT: pw-record -> wav -> whisper-cli (offline). Same /tmp status files as the macOS helper.
const STT_WAV = "/tmp/agentdeck-stt.wav";
let sttRecorder: ChildProcess | null = null;
let sttRecorderExit: Promise<void> | null = null;

function setSttStatus(code: string): void {
  try { writeFileSync(STT_STATUS, code); } catch {}
}

function startLinuxCapture(): void {
  const whisper = WHISPER_BIN_CANDIDATES.find((c) => existsSync(c));
  if (!whisper) return setSttStatus("NO_WHISPER");
  if (!existsSync(whisperModelPath(homedir(), process.env))) return setSttStatus("NO_MODEL");
  const child = spawn("pw-record", pwRecordArgs(STT_WAV), { stdio: "ignore" });
  sttRecorder = child;
  sttRecorderExit = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => { setSttStatus("MIC_ERR"); resolve(); });
  });
  if (child.pid) writeFileSync(STT_PID, String(child.pid));
}

async function stopLinuxCaptureAndTranscribe(): Promise<void> {
  const rec = sttRecorder;
  sttRecorder = null;
  if (!rec) return;
  rec.kill("SIGINT"); // lets pw-record finalize the wav header
  await Promise.race([sttRecorderExit, new Promise((r) => setTimeout(r, 2000))]);
  sttRecorderExit = null;
  const whisper = WHISPER_BIN_CANDIDATES.find((c) => existsSync(c));
  if (!whisper || !existsSync(STT_WAV)) return setSttStatus("MIC_ERR");
  const locale = process.env.STT_LOCALE ?? (existsSync("/tmp/agentdeck-stt.locale") ? readFileSync("/tmp/agentdeck-stt.locale", "utf8") : "");
  try {
    const { stdout } = await execFileP(
      whisper,
      whisperArgs(whisperModelPath(homedir(), process.env), STT_WAV, whisperLanguage(locale), 4),
      { ...EXEC, timeout: 60_000 },
    );
    const txt = cleanTranscript(stdout);
    if (txt) writeFileSync(STT_TXT, txt);
  } catch (e) {
    streamDeck.logger.error(`whisper: ${e}`);
    setSttStatus("STT_FAILED");
  } finally {
    try { unlinkSync(STT_WAV); } catch {}
  }
}

let recording = false;
let talkState = "hold"; // hold | ● REC | <live text> | mic err | STT err
let recPoll: ReturnType<typeof setInterval> | null = null;

async function startRecording(): Promise<void> {
  if (recording) return;
  if (recPoll) {
    clearInterval(recPoll);
    recPoll = null;
  }
  recording = true;
  talkState = "● REC";
  renderAll();
  try {
    for (const f of [STT_TXT, STT_PID, STT_PARTIAL, STT_STATUS]) if (existsSync(f)) try { unlinkSync(f); } catch {}
    // Launch helper via open (starts live recognition with bundle permissions)
    if (IS_LINUX) startLinuxCapture();
    else await execFileP("/usr/bin/open", [STT_APP]);
    // Show partial transcription in real-time on dial
    recPoll = setInterval(() => {
      try {
        if (existsSync(STT_STATUS)) {
          talkState = talkHint(readFileSync(STT_STATUS, "utf8").trim());
          recording = false;
          if (recPoll) { clearInterval(recPoll); recPoll = null; }
          renderAll();
          return;
        }
        const p = existsSync(STT_PARTIAL) ? readFileSync(STT_PARTIAL, "utf8").trim() : "";
        talkState = p || "● REC";
        renderAll();
      } catch {}
    }, 250);
  } catch (e) {
    streamDeck.logger.error(`stt start: ${e}`);
    recording = false;
    talkState = "mic err";
    renderAll();
  }
}

async function stopAndSend(target?: string): Promise<void> {
  if (!recording) return;
  recording = false;
  if (recPoll) { clearInterval(recPoll); recPoll = null; }
  talkState = "processing";
  renderAll();
  try {
    // Send SIGINT to helper PID to finalize recognition
    if (IS_LINUX) {
      await stopLinuxCaptureAndTranscribe();
    } else {
      const pid = existsSync(STT_PID) ? readFileSync(STT_PID, "utf8").trim() : "";
      if (pid) try { await execFileP("/bin/kill", ["-INT", pid]); } catch {}
    }
    // Wait for output file to populate (up to ~3s)
    let txt = "";
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (existsSync(STT_TXT)) {
        txt = readFileSync(STT_TXT, "utf8").trim();
        if (txt) break;
      }
    }
    // If empty transcript and failure status exists, surface hint on dial
    if (!txt && existsSync(STT_STATUS)) {
      talkState = talkHint(readFileSync(STT_STATUS, "utf8").trim());
      renderAll();
      return;
    }
    let sent = false;
    let sendErr: string | null = null;
    if (txt && target) {
      try {
        await orcaRun(["terminal", "send", ...envArgsFor(target), "--terminal", target, "--text", txt]);
        sent = true;
      } catch (e) {
        sendErr = String(e);
      }
    }
    try {
      writeFileSync("/tmp/agentdeck-talk.json", JSON.stringify({ at: new Date().toISOString(), txt, target: target ?? null, sent, sendErr }, null, 2));
    } catch {}
    talkState = "hold";
  } catch (e) {
    streamDeck.logger.error(`stt stop: ${e}`);
    talkState = "STT err";
  }
  renderAll();
}

// Create AgentContext for given handle (worktree path, worktree ID, preview, etc.)
const screenTailByHandle = new Map<string, string>();
const lastTargetOutputAt = new Map<string, number | null>();
let screenReadBusy = false;

async function refreshTargetScreen(target: string): Promise<string | undefined> {
  if (screenReadBusy || !target) return screenTailByHandle.get(target);
  const session = sessionByHandle.get(target);
  const lastOutput = session ? (session as any).lastOutputAt : undefined;
  if (
    lastOutput !== undefined &&
    lastOutput !== null &&
    lastOutput === lastTargetOutputAt.get(target) &&
    screenTailByHandle.has(target)
  ) {
    return screenTailByHandle.get(target);
  }

  screenReadBusy = true;
  try {
    const env = environmentByHandle.get(target);
    let res: any;
    if (env) {
      res = await orcaJson(["terminal", "read", ...envArgsFor(target), "--terminal", target, "--screen", "--limit", "15"]);
    } else {
      try {
        res = await orcaRpc("terminal.read", {
          terminal: target,
          screen: true,
          limit: 15,
        });
      } catch {
        res = await orcaJson(["terminal", "read", "--terminal", target, "--screen", "--limit", "15"]);
      }
    }
    const tail = res?.result?.terminal?.tail;
    if (Array.isArray(tail) && tail.length) {
      const text = tail.join("\n");
      screenTailByHandle.set(target, text);
      lastTargetOutputAt.set(target, lastOutput ?? null);
      return text;
    }
  } catch (e) {
    streamDeck.logger.error(`read screen for ${target}: ${e}`);
  } finally {
    screenReadBusy = false;
  }
  return screenTailByHandle.get(target);
}

function contextForHandle(h: string): AgentContext {
  const b = sessionByHandle.get(h);
  return {
    handle: h,
    worktreePath: b?.worktreePath,
    worktreeId: b?.worktreeId,
    preview: screenTailByHandle.get(h) || b?.preview,
    tabTitle: b?.tabTitle || b?.label,
  };
}

// Reset pending values to session's applied/profile defaults when target changes
function noteHandle(h: string): void {
  const b = sessionByHandle.get(h);
  if (b) {
    const nextType = b.agentType ?? "";
    if (agentByHandle.get(h) !== nextType) {
      agentByHandle.set(h, nextType);
      agentInstanceByHandle.set(h, agentFor(nextType));
    }
  }
}

// Read real-time session state (model/effort/mode) via agent interface
function refreshSessionState(h: string): boolean {
  if (!h) return false;
  noteHandle(h);
  const agent = agentInstanceByHandle.get(h) ?? agentFor(agentByHandle.get(h));
  const ctx = contextForHandle(h);
  const state = agent.readCurrentState(ctx);
  let modelChanged = false;

  if (state.model && (h !== targetHandle || Date.now() - pickAt.model >= PICK_GRACE)) {
    if (currentModelByHandle.get(h) !== state.model) {
      currentModelByHandle.set(h, state.model);
      modelChanged = true;
    }
  }

  let effortToSet = state.effort;
  if (!effortToSet && state.model) {
    effortToSet = agent.getEffortForModel(state.model);
  }
  if (effortToSet && (h !== targetHandle || Date.now() - pickAt.effort >= PICK_GRACE)) {
    if (currentEffortByHandle.get(h) !== effortToSet || modelChanged) {
      currentEffortByHandle.set(h, effortToSet);
      if (modelChanged) {
        effortByHandle.set(h, effortToSet);
      }
    }
  }

  if (state.mode && (h !== targetHandle || Date.now() - pickAt.mode >= PICK_GRACE)) {
    currentModeByHandle.set(h, state.mode);
  }
  if (state.modes && state.modes.length) {
    modesByHandle.set(h, state.modes);
  }
  if (state.permissions && (h !== targetHandle || Date.now() - pickAt.permissions >= PICK_GRACE)) {
    currentPermissionsByHandle.set(h, state.permissions);
  }

  if (state.recentModels || state.favoriteModels) {
    const list = modelsByHandle.get(h);
    if (list && list.length) {
      const sorted = sortModels(list, state.recentModels ?? [], state.favoriteModels ?? []);
      if (sorted.length !== list.length || sorted.some((m, i) => m !== list[i])) {
        modelsByHandle.set(h, sorted);
      }
    }
  }

  return modelChanged;
}

function setTarget(h?: string): void {
  boostPolling();
  targetHandle = h;
  if (h) {
    noteHandle(h);
    refreshSessionState(h);
    refreshTargetScreen(h).then(() => {
      refreshSessionState(h);
      applyPending();
      renderDials();
    }).catch(() => {});
  }
  agentForHandle();
  pickAt.model = 0; // Target change invalidates previous grace period
  pickAt.effort = 0;
  pickAt.mode = 0;
  pickAt.permissions = 0;
  applyPending();
  renderDials();
}
// For gating: abstract agent instance for target session
function agentForHandle(): AbstractAgent {
  const t = ensureTarget();
  if (!t) return UNSUPPORTED_AGENT;
  noteHandle(t);
  return agentInstanceByHandle.get(t) ?? agentFor(agentByHandle.get(t));
}
function profileForHandle(): AgentProfile {
  return profileFor(agentForHandle().agentType);
}
// Model/effort/mode list for target session on dials (discovered live list preferred)
function dialList(kind: ControlKind): string[] {
  const t = ensureTarget();
  if (!t) return [];
  const agent = agentForHandle();
  if (kind === "model") {
    const live = modelsByHandle.get(t);
    if (live && live.length) return live;
    return agent.getModels();
  }
  if (kind === "effort") {
    const live = effortsByHandle.get(t);
    if (live && live.length) return live;
    return agent.getEfforts(currentModelByHandle.get(t) || modelByHandle.get(t));
  }
  if (kind === "mode") {
    const live = modesByHandle.get(t);
    if (live && live.length) return live;
    return agent.getModes(contextForHandle(t));
  }
  if (kind === "permissions") {
    return agent.getPermissions(contextForHandle(t));
  }
  return [];
}
function applyPending(): void {
  adoptPending("model");
  adoptPending("effort");
  adoptPending("mode");
  adoptPending("permissions");
}
// Populate dial display with currently read value (unless user rotated dial within grace period)
function adoptPending(role: ControlKind): void {
  const t = targetHandle;
  if (!t) return;
  if (Date.now() - pickAt[role] < PICK_GRACE) return;
  const first = dialList(role)[0] || "";
  if (role === "model") {
    const current = currentModelByHandle.get(t);
    const applied = modelByHandle.get(t);
    pendingModel = current || applied || first;
  } else if (role === "effort") {
    const current = currentEffortByHandle.get(t);
    const applied = effortByHandle.get(t);
    pendingEffort = current || applied || first;
  } else if (role === "mode") {
    const current = currentModeByHandle.get(t);
    const applied = modeByHandle.get(t);
    pendingMode = current || applied || first;
  } else if (role === "permissions") {
    const current = currentPermissionsByHandle.get(t);
    const applied = permissionsByHandle.get(t);
    pendingPermissions = current || applied || first;
  }
}
// Value to display on dial — "-" if unsupported, "…" if empty/loading
function dialValue(role: string): string {
  const agent = agentForHandle();
  if (role === "model") {
    if (!agent.supports("model")) return "-";
    return pendingModel ? pendingModel : "…";
  }
  if (role === "effort") {
    if (!agent.supports("effort")) return "-";
    return pendingEffort || "…";
  }
  if (role === "mode") {
    if (!agent.supports("mode")) return "-";
    return pendingMode || "…";
  }
  if (role === "permissions") {
    if (!agent.supports("permissions")) return "-";
    return pendingPermissions || "…";
  }
  if (role === "target") return targetLabel();
  return talkState;
}
// Send steps to terminal with delay support
async function applyAgentSteps(handle: string, steps: ApplyStep[]): Promise<void> {
  for (const s of steps) {
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    const args = ["terminal", "send", ...envArgsFor(handle), "--terminal", handle, "--text", s.text];
    if (s.enter) args.push("--enter");
    await orcaRun(args);
  }
}
// Periodically load models exposed by agent (throttled) — supported agents only
let lastDiscoverAt = 0;
let discoverBusy = false;
async function refreshDiscovery(): Promise<void> {
  const t = ensureTarget();
  if (!t) return;
  const agent = agentForHandle();
  if (discoverBusy || Date.now() - lastDiscoverAt < 30000) return;
  discoverBusy = true;
  try {
    lastDiscoverAt = Date.now();
    const modelCmd = agent.getDiscoverModelCmd();
    if (modelCmd) {
      const { stdout } = await execFileP(modelCmd[0], modelCmd.slice(1), EXEC);
      const list = agent.parseDiscoveredModels(stdout);
      if (list.length) {
        agent.setModelNames(agent.parseDiscoveredModelNames(stdout));
        const st = agent.readCurrentState(contextForHandle(t));
        modelsByHandle.set(t, sortModels(list, st.recentModels ?? [], st.favoriteModels ?? []));
      }
    }
    if (agent.agentType === "hermes" && !existsSync(HERMES_MODELS_CACHE)) {
      try {
        const isRemote = Boolean(environmentByHandle.get(t));
        if (isRemote || !existsSync(HERMES_MODELS_CACHE_TMP)) {
          const { stdout } = await execFileP(
            "ssh",
            ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "mac-mini", "cat ~/.hermes/provider_models_cache.json"],
            EXEC,
          );
          if (stdout && stdout.startsWith("{")) {
            writeFileSync(HERMES_MODELS_CACHE_TMP, stdout, "utf8");
            const models = agent.getModels();
            if (models.length) {
              const st = agent.readCurrentState(contextForHandle(t));
              modelsByHandle.set(t, sortModels(models, st.recentModels ?? [], st.favoriteModels ?? []));
            }
          }
        }
      } catch {}
    }
    const agentCmd = agent.getDiscoverAgentCmd();
    if (agentCmd) {
      try {
        let output = "";
        try {
          const res = await execFileP(agentCmd[0], agentCmd.slice(1), EXEC);
          output = (res.stdout || "") + "\n" + (res.stderr || "");
        } catch (err: any) {
          output = (err?.stdout || "") + "\n" + (err?.stderr || "");
        }
        const modes = agent.parseDiscoveredModes(output);
        if (modes.length) modesByHandle.set(t, modes);
      } catch (e) {
        streamDeck.logger.error(`discover agents: ${e}`);
      }
    }
  } catch (e) {
    streamDeck.logger.error(`discover models: ${e}`);
  } finally {
    discoverBusy = false;
    renderAll();
  }
}

// Read current state (model/effort/mode) for all active sessions via agent interface
function refreshCurrentState(): void {
  const t = ensureTarget();
  for (const h of allHandles) {
    // A remote session's agent state files live on that machine and are not readable directly
    // from this filesystem. But sessions with terminal context (tabTitle, preview) or the
    // currently targeted session can still resolve live agent state.
    const isRemote = Boolean(environmentByHandle.get(h));
    if (isRemote && h !== t) continue;
    const modelChanged = refreshSessionState(h);
    if (h === t && modelChanged) {
      lastEffortDiscoverAt = 0;
      refreshEfforts().catch(() => {});
    }
  }
  adoptPending("model");
  adoptPending("effort");
  adoptPending("mode");
  adoptPending("permissions");
}

// Periodically load effort variants for target session's current model (throttled)
let lastEffortDiscoverAt = 0;
let effortDiscoverBusy = false;
async function refreshEfforts(): Promise<void> {
  const t = ensureTarget();
  if (!t) return;
  const agent = agentForHandle();
  const cmd = agent.getDiscoverVariantCmd();
  if (!cmd) return;
  const currentModel = currentModelByHandle.get(t) || modelByHandle.get(t) || pendingModel;
  if (!currentModel) return;
  if (effortDiscoverBusy || Date.now() - lastEffortDiscoverAt < 30000) return;
  effortDiscoverBusy = true;
  try {
    lastEffortDiscoverAt = Date.now();
    const provider = currentModel.split("/")[0];
    const { stdout } = await execFileP(cmd[0], [...cmd.slice(1), provider], EXEC);
    const efforts = agent.parseDiscoveredEfforts(stdout, currentModel);
    if (efforts.length) {
      effortsByHandle.set(t, efforts);
      adoptPending("effort");
    }
  } catch (e) {
    streamDeck.logger.error(`discover efforts: ${e}`);
  } finally {
    effortDiscoverBusy = false;
  }
}

type SlotSettings = {
  isPagingKey?: boolean;
};

type Coords = { column: number; row: number };
const slotViews = new Map<string, { action: any; coordinates?: Coords; settings?: SlotSettings }>();
const dialViews = new Map<string, { action: any; role: string }>();
const lastImg = new Map<string, string>();
const lastDialImg = new Map<string, string>();

function getSortedSlotEntries(): Array<[string, { action: any; coordinates?: Coords; settings?: SlotSettings }]> {
  return Array.from(slotViews.entries()).sort(([, a], [, b]) => {
    const cA = a.coordinates;
    const cB = b.coordinates;
    if (!cA && !cB) return 0;
    if (!cA) return 1;
    if (!cB) return -1;
    if (cA.row !== cB.row) return cA.row - cB.row;
    return cA.column - cB.column;
  });
}

function getSortedSlotIds(): string[] {
  return getSortedSlotEntries().map(([id]) => id);
}

function getActiveSlotCount(): number {
  return slotViews.size || 8;
}

function getPagingSlotIndex(): number | undefined {
  const entries = getSortedSlotEntries();
  if (entries.length === 0) return undefined;
  const explicitIdx = entries.findIndex(([, v]) => v.settings?.isPagingKey);
  if (explicitIdx >= 0) return explicitIdx;
  return entries.length - 1;
}

function ensureTarget(): string | undefined {
  if (!targetHandle || !allHandles.includes(targetHandle)) {
    const candidate =
      lastActiveHandle && allHandles.includes(lastActiveHandle)
        ? lastActiveHandle
        : allHandles.find((h) => !environmentByHandle.get(h)) ?? allHandles[0];
    if (targetHandle !== candidate) {
      targetHandle = candidate;
      applyPending();
    }
  }
  return targetHandle;
}
function targetLabel(): string {
  const b = sessionByHandle.get(targetHandle ?? "");
  return b ? String(b.repo || b.label || "?") : "-";
}

function dialFeedback(role: string): { full: string } {
  ensureTarget();
  const agent = agentForHandle();
  const isSupported = role === "target" || role === "talk" ? true : agent.supports(role as ControlKind);
  const tb = sessionByHandle.get(targetHandle ?? "");
  const badge = tb ? (tb as any).agentType : undefined;
  const branch = tb ? (tb as any).branch : undefined;
  const v = dialValue(role);
  if (role === "model") {
    mergeLocalRateLimits();
    const quota = agent.getQuotaDisplay(cachedRateLimits, contextForHandle(targetHandle ?? ""), v);
    return { full: dialImage("model", "MODEL", v, tick, !isSupported, badge, quota) };
  }
  if (role === "effort") return { full: dialImage("effort", "EFFORT", v, tick, !isSupported, badge) };
  if (role === "mode") return { full: dialImage("mode", "MODE", v, tick, !isSupported, badge) };
  if (role === "permissions") return { full: dialImage("permissions", "PERM", v, tick, !isSupported, badge) };
  if (role === "talk") return { full: dialImage("talk", "TALK", v, tick) };
  if (role === "target") {
    // Button-style state rendering: the target session drives the status bar color and glyph.
    // The dial pulses on alerts like an unattended key, even for the focused target — the
    // target session is what the board is watching (and it may sit past the 8 visible keys),
    // so waiting/error/unread-done trigger the same blink as a needs-attention key.
    const st = tb
      ? {
          state: (tb as any).state,
          status: (tb as any).status,
          color: (tb as any).color as string | undefined,
          attention: needsAttention(tb, false),
          nowMs: 0,
        }
      : undefined;
    return { full: dialImage("target", "TARGET", v, tick, false, badge, branch, undefined, st) };
  }
  return { full: dialImage("target", "TARGET", v, tick, false, badge, branch) };
}

function renderAll(): void {
  renderKeys();
  renderDials();
}

// Re-render session keys only. Called on data/target changes, not on dial rotation.
function renderKeys(): void {
  const now = Date.now();
  const boardAttn = anyAttention(); // If any key requires attention, dim non-attention keys to emphasize contrast
  const entries = getSortedSlotEntries();
  for (let i = 0; i < entries.length; i++) {
    const [id, { action: a }] = entries[i];
    const b = deck.slots[i] ?? { empty: true as const };
    const isTarget = !b.empty && (b as any).handle === targetHandle;
    const isWorking = !b.empty && ((b as any).state === "working" || (b as any).color === "orange");
    const dim = boardAttn && !b.empty && !isTarget && !isWorking && !needsAttention(b, false);
    const img = keyImage(b, tick, isTarget, now, dim);
    if (lastImg.get(id) === img) continue;
    lastImg.set(id, img);
    a.setImage(img).catch(() => {});
  }
}

// Re-render dials only — avoids key re-rendering overhead on dial rotation ticks.
// lastDialImg skips identical frames so the pulse loop only pushes the blinking target dial.
function renderDials(): void {
  for (const { action: a, role } of dialViews.values()) {
    const fb = dialFeedback(role);
    if (lastDialImg.get(a.id) === fb.full) continue;
    lastDialImg.set(a.id, fb.full);
    a.setFeedback(fb).catch(() => {});
  }
}

// Check if any visible key requires attention (pulse animation).
function anyAttention(): boolean {
  const entries = getSortedSlotEntries();
  for (let i = 0; i < entries.length; i++) {
    const b = deck.slots[i];
    if (b && !b.empty && needsAttention(b, (b as any).handle === targetHandle)) return true;
  }
  return false;
}

// Check if the target session (dial 4) itself requires attention — blinks even when it sits past
// the 8 visible keys. Uses the unattended-key rule (waiting/error/unread-done pulse) so the dial
// alerts the same way a needs-attention button would.
function targetAttention(): boolean {
  const tb = targetHandle ? sessionByHandle.get(targetHandle) : undefined;
  return Boolean(tb) && needsAttention(tb, false);
}

// Read latest hook states from Orca agent-hooks (last-status.json)
function getHookEvents(): Map<string, { hookEventName?: string; agentType?: string; state?: string; status?: string; workingMode?: string; interrupted?: boolean; receivedAt?: number }> {
  const map = new Map<string, { hookEventName?: string; agentType?: string; state?: string; status?: string; workingMode?: string; interrupted?: boolean; receivedAt?: number }>();
  try {
    const filePath = join(ORCA_DATA_DIR, "agent-hooks", "last-status.json");
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const data = JSON.parse(content);
      if (data && typeof data.entries === "object") {
        for (const [paneKey, entry] of Object.entries(data.entries as Record<string, any>)) {
          if (entry) {
            map.set(paneKey, {
              hookEventName: entry.hookEventName,
              agentType: entry.source || entry.payload?.agentType,
              state: entry.payload?.state,
              status: entry.payload?.status,
              workingMode: entry.payload?.workingMode,
              interrupted: entry.payload?.interrupted ?? entry.interrupted,
              receivedAt: entry.receivedAt,
            });
          }
        }
      }
    }
  } catch {}
  return map;
}

let cachedRepos: OrcaRepo[] = [];
let lastRepoFetchAt = 0;
async function refreshRepos(): Promise<void> {
  if (Date.now() - lastRepoFetchAt < 15000 && cachedRepos.length > 0) return;
  try {
    let rl: any;
    try {
      rl = await orcaRpc("repo.list");
    } catch {
      rl = await orcaJson(["repo", "list"]);
    }
    if (rl?.result?.repos) {
      cachedRepos = rl.result.repos;
      lastRepoFetchAt = Date.now();
      prefetchRepoIcons(cachedRepos);
    }
  } catch (e) {
    streamDeck.logger.error(`fetch repos: ${e}`);
  }
}

interface OrcaEnvironment {
  id: string;
  name: string;
  runtimeId?: string;
}

let cachedEnvironments: OrcaEnvironment[] = [];
let lastEnvFetchAt = 0;
/** Paired remote Orca runtimes (`orca environment list`) — each is polled on its own so its sessions
 * appear on the deck next to this machine's (a remote runtime reports its own rows as hostId `local`). */
async function refreshEnvironments(): Promise<void> {
  if (Date.now() - lastEnvFetchAt < 30000 && cachedEnvironments.length > 0) return;
  const envFile = join(ORCA_DATA_DIR, "orca-environments.json");
  if (existsSync(envFile)) {
    try {
      const data = JSON.parse(readFileSync(envFile, "utf-8"));
      if (Array.isArray(data?.environments)) {
        cachedEnvironments = (data.environments as any[]).filter((e) => e?.name);
        lastEnvFetchAt = Date.now();
        return;
      }
    } catch {}
  }
  try {
    const el = await orcaJson(["environment", "list"]);
    if (el?.result?.environments) {
      cachedEnvironments = (el.result.environments as any[]).filter((e) => e?.name);
      lastEnvFetchAt = Date.now();
    }
  } catch (e) {
    streamDeck.logger.error(`fetch environments: ${e}`);
  }
}

let cachedHosts: OrcaHost[] = [];
let lastHostFetchAt = 0;
/** Hosts from `orca host list` — maps each session's hostId to a short machine label on the tile. */
async function refreshHosts(): Promise<void> {
  if (Date.now() - lastHostFetchAt < 60000 && cachedHosts.length > 0) return;
  for (const cacheFile of ["/tmp/orca-panel-hosts.json", "/tmp/orca-hosts.json"]) {
    if (existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
        const atMs = typeof cached.at === "number" ? (cached.at < 1e11 ? cached.at * 1000 : cached.at) : 0;
        if (Date.now() - atMs < 60000 && Array.isArray(cached.hosts) && cached.hosts.length > 0) {
          cachedHosts = cached.hosts;
          lastHostFetchAt = Date.now();
          return;
        }
      } catch {}
    }
  }
  try {
    const hl = await orcaJson(["host", "list"]);
    if (hl?.result?.hosts) {
      cachedHosts = hl.result.hosts;
      lastHostFetchAt = Date.now();
      try {
        writeFileSync("/tmp/orca-hosts.json", JSON.stringify({ hosts: cachedHosts, at: Date.now() }));
      } catch {}
    }
  } catch (e) {
    streamDeck.logger.error(`fetch hosts: ${e}`);
  }
}

let cachedRateLimits: OrcaRateLimits | null = null;
let lastRateLimitFetchAt = 0;

function mergeLocalRateLimits(): void {
  const localAgy = readLocalAgyQuota();
  if (localAgy) {
    if (!cachedRateLimits) {
      cachedRateLimits = { antigravity: localAgy, gemini: localAgy };
    } else {
      if (!cachedRateLimits.antigravity || cachedRateLimits.antigravity.status !== "ok") {
        cachedRateLimits.antigravity = localAgy;
      }
      if (!cachedRateLimits.gemini || cachedRateLimits.gemini.status !== "ok") {
        cachedRateLimits.gemini = localAgy;
      }
    }
  }
}

async function refreshRateLimits(): Promise<void> {
  if (Date.now() - lastRateLimitFetchAt < 30000 && cachedRateLimits !== null) {
    mergeLocalRateLimits();
    return;
  }
  try {
    let data: any;
    try {
      data = await orcaRpc("accounts.list");
    } catch {
      data = await orcaJson(["account", "list"]);
    }
    if (data?.result?.rateLimits) {
      cachedRateLimits = data.result.rateLimits;
      lastRateLimitFetchAt = Date.now();
    }
  } catch (e) {
    streamDeck.logger.error(`fetch rate limits: ${e}`);
  }
  mergeLocalRateLimits();
}

let pollBusy = false;
async function poll(): Promise<void> {
  if (pollBusy) return;
  pollBusy = true;
  try {
    refreshRepos().catch(() => {});
    refreshRateLimits().catch(() => {});
    refreshHosts().catch(() => {});
    // Cached (30s) so the fan-out below starts from a known set of paired runtimes.
    await refreshEnvironments();
    // Paired environments are polled in parallel with the local runtime; a failing environment
    // (offline Mac mini, revoked pairing) is logged and skipped rather than breaking the deck.
    // Remote environments must be queried via CLI (`orcaJson`), because the local domain socket
    // RPC (`orcaRpc`) runs on this machine and ignores the environment parameter.
    const remotePoll = Promise.all(
      cachedEnvironments.map(async (env) => {
        try {
          const [rtl, rwp] = await Promise.all([
            orcaJson(["terminal", "list", "--include-visual-layouts", "--environment", env.name]),
            orcaJson(["worktree", "ps", "--environment", env.name]),
          ]);
          return {
            env,
            terminals: (rtl.result?.terminals ?? []).map((t: any) => ({ ...t, environment: env.name, environmentId: env.id })),
            worktrees: (rwp.result?.worktrees ?? []).map((w: any) => ({ ...w, environment: env.name, environmentId: env.id })),
            visualLayouts: (rtl.result?.visualLayouts ?? []) as any[],
          };
        } catch (e) {
          streamDeck.logger.error(`poll environment ${env.name}: ${e}`);
          return null;
        }
      }),
    );
    let tl: any;
    let wp: any;
    try {
      [tl, wp] = await Promise.all([
        orcaRpc("terminal.list", { includeVisualLayouts: true }),
        orcaRpc("worktree.ps"),
      ]);
    } catch {
      [tl, wp] = await Promise.all([
        orcaJson(["terminal", "list", "--include-visual-layouts"]),
        orcaJson(["worktree", "ps"]),
      ]);
    }
    const [remote] = await Promise.all([remotePoll]);
    const localTerminals = tl.result?.terminals ?? [];
    const localWorktrees = wp.result?.worktrees ?? [];
    const remoteOk = remote.filter((r): r is NonNullable<typeof r> => !!r);
    const hookEvents = getHookEvents();
    const visualLayouts = [...(tl.result?.visualLayouts ?? []), ...remoteOk.flatMap((r) => r.visualLayouts)];
    // One shared timestamp so the 8-key page and the full session list always agree on ordering buckets.
    const now = Date.now();
    const activeSlots = getActiveSlotCount();
    const pagingSlotIndex = getPagingSlotIndex();
    const terminals = stabilizeTerminalAgents(
      [...localTerminals, ...remoteOk.flatMap((r) => r.terminals)],
      terminalAgentCache,
      now,
    );
    const worktrees = [...localWorktrees, ...remoteOk.flatMap((r) => r.worktrees)];
    const deckInput = {
      terminals,
      worktrees,
      repos: cachedRepos,
      hosts: cachedHosts,
      visualLayouts,
      hookEventsByPane: hookEvents,
    };
    const activePinned = getActivePinnedSlots();
    deck = buildDeck(deckInput, {
      page: currentPage,
      perPage: activeSlots,
      now,
      pagingSlotIndex,
      pinnedSlots: activePinned,
    });
    if (currentPage >= deck.pageCount) {
      currentPage = Math.max(0, deck.pageCount - 1);
      deck = buildDeck(deckInput, {
        page: currentPage,
        perPage: activeSlots,
        now,
        pagingSlotIndex,
        pinnedSlots: activePinned,
      });
    }
    // Full session list (sidebar total) — target dial can cycle past 8 keys
    const full = buildDeck(deckInput, { page: 0, perPage: 9999, now });
    allHandles = [];
    sessionByHandle.clear();
    for (const s of full.slots) {
      if (!s.empty) {
        const h = (s as any).handle;
        allHandles.push(h);
        sessionByHandle.set(h, s);
        environmentByHandle.set(h, (s as any).environment);
        const nextType = (s as any).agentType ?? "";
        if (agentByHandle.get(h) !== nextType) {
          agentByHandle.set(h, nextType);
          agentInstanceByHandle.set(h, agentFor(nextType));
          if (h === targetHandle) {
            lastDiscoverAt = 0;
            applyPending();
          }
        }
      }
    }
    // Prevent memory leaks for closed sessions across all handle maps
    const handleMaps: Map<string, any>[] = [
      agentByHandle,
      agentInstanceByHandle,
      environmentByHandle,
      modelsByHandle,
      modesByHandle,
      effortsByHandle,
      currentModelByHandle,
      currentEffortByHandle,
      currentModeByHandle,
      currentPermissionsByHandle,
      screenTailByHandle,
      lastTargetOutputAt,
      modelByHandle,
      effortByHandle,
      modeByHandle,
      permissionsByHandle,
    ];
    for (const map of handleMaps) {
      for (const h of Array.from(map.keys())) {
        if (!sessionByHandle.has(h)) {
          map.delete(h);
        }
      }
    }
    // Automatically set currently focused session as target. Only the local runtime can report
    // what this desktop is focused on — a remote runtime's `isActive` would fight the user's
    // manual selection (and every remote deck session would look "active" at once).
    const isTargetRemote = targetHandle ? Boolean(environmentByHandle.get(targetHandle)) : false;
    const activeHandle = resolveActiveTerminal(
      localWorktrees,
      localTerminals,
      tl.result?.visualLayouts,
      targetHandle,
    );
    const orcaChanged = activeHandle !== lastActiveHandle;
    const navGraceExpired = Date.now() - lastNav > 1800;

    if (activeHandle && sessionByHandle.has(activeHandle)) {
      if (!targetHandle) {
        setTarget(activeHandle);
      } else if (orcaChanged && navGraceExpired) {
        // Orca's active terminal changed in the UI — follow user focus even if target was remote
        setTarget(activeHandle);
      } else if (!isTargetRemote && navGraceExpired && activeHandle !== targetHandle) {
        // Local active terminal differs from local target after navigation grace — sync target
        setTarget(activeHandle);
      }
    }
    lastActiveHandle = activeHandle;
    const t = ensureTarget();
    if (t) {
      await refreshTargetScreen(t);
    }
    refreshDiscovery(); // Periodically load model list for supported agents (throttled)
    refreshCurrentState(); // Track active state (model/effort/mode) from agent interfaces (every poll)
    refreshEfforts(); // Periodically load effort variants (throttled)
    renderAll();
    try {
      writeFileSync(
        "/tmp/agentdeck-debug.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            total: deck.total,
            slotViews: slotViews.size,
            dialViews: dialViews.size,
            environments: cachedEnvironments.map((e) => e.name),
            target: targetHandle,
            targetEnvironment: environmentByHandle.get(targetHandle ?? "") ?? null,
            dials: {
              model: dialValue("model"),
              effort: dialValue("effort"),
              mode: dialValue("mode"),
              permissions: dialValue("permissions"),
            },
            slots: deck.slots.map((s) =>
              s.empty
                ? s
                : {
                    ...s,
                    bgIconUri: s.bgIconUri ? `[data-uri ${s.bgIconUri.length} chars]` : undefined,
                  },
            ),
          },
          null,
          2,
        ),
      );
    } catch {}
  } catch (e) {
    streamDeck.logger.error(`poll failed: ${e}`);
  } finally {
    pollBusy = false;
  }
}

// Empty slot tap -> create new worktree in target session's project (repo)
// and launch identical agent (agentType) in first terminal, then switch to it.
async function spawnSession(ev: any): Promise<void> {
  const t = ensureTarget();
  const b = t ? sessionByHandle.get(t) : undefined;
  const wtId = b ? (b as any).worktreeId : undefined;
  if (!b || !wtId) {
    streamDeck.logger.info("spawn: unknown target worktree (no project) — cannot spawn");
    ev.action.showAlert?.();
    return;
  }
  const repoId = String(wtId).split("::")[0];
  const repo = (b as any).repo || repoId;
  const agent = agentByHandle.get(t!) || "";
  if (!agent) {
    streamDeck.logger.info("spawn: unknown target agent — cannot spawn");
    ev.action.showAlert?.();
    return;
  }
  try {
    // Spawn in the target session's runtime: local by default, or the paired environment it came
    // from (repo ids and terminal handles are server-scoped, so every call here must be scoped too).
    const env = environmentByHandle.get(t!);
    const envArgs = env ? ["--environment", env] : [];
    // Determine next index from existing worktrees in same repo
    const list = await orcaJson(["worktree", "list", ...envArgs]);
    const same = (list?.result?.worktrees ?? []).filter((w: any) => w.repoId === repoId);
    const name = nextWorktreeName(repo, same.map((w: any) => w.displayName || ""));
    const createArgs: string[] = ["worktree", "create", ...envArgs, "--repo", `id:${repoId}`, "--name", name];
    // Work around Orca injecting unsupported --permissions argument for opencode
    const isOpenCode = agent === "opencode";
    if (!isOpenCode) createArgs.push("--agent", agent);
    const res = await orcaJson(createArgs);
    const wt = res?.result?.worktree?.id ?? (res?.result ?? res)?.worktreeId;
    const createdWt = wt || (res?.result ?? res)?.id;
    let handle: string | undefined;
    if (isOpenCode) {
      if (createdWt) {
        const created = await orcaJson(["terminal", "create", ...envArgs, "--worktree", createdWt, "--command", OPENCODE_CMD, "--focus"]);
        handle = created?.result?.terminal?.handle ?? created?.result?.handle?.handle;
      }
      // fallback: if agent terminal not found yet, find terminal in created worktree
      if (!handle) {
        const terms = await orcaJson(["terminal", "list", ...envArgs]);
        const wtTerm = (terms?.result?.terminals ?? []).find((x: any) => x.worktreeId === createdWt || (x.worktreePath ?? "").includes(name));
        if (wtTerm?.handle) {
          await orcaRun(["terminal", "switch", ...envArgs, "--terminal", wtTerm.handle]);
          handle = wtTerm.handle;
        }
      }
    } else {
      const r = res?.result ?? res ?? {};
      handle = r.agentTerminalHandle ?? r.startupTerminal?.handle;
    }
    if (handle) {
      lastNav = Date.now();
      setTarget(handle);
      try {
        await orcaRun(["terminal", "switch", ...envArgs, "--terminal", handle]);
        await focusOrca();
      } catch (e) {
        streamDeck.logger.error(`spawn switch: ${e}`);
      }
    }
    renderAll();
  } catch (e) {
    streamDeck.logger.error(`spawn session: ${e}`);
    ev.action.showAlert?.();
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollBurstUntil = 0;
const IDLE_POLL_INTERVAL_MS = 3000;
const BURST_POLL_INTERVAL_MS = 1000;
const BURST_DURATION_MS = 4000;

function boostPolling(durationMs = BURST_DURATION_MS): void {
  pollBurstUntil = Math.max(pollBurstUntil, Date.now() + durationMs);
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(runPollLoop, 50);
  }
}

function pollDebounced(delay = 50): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(runPollLoop, delay);
}

async function runPollLoop(): Promise<void> {
  pollTimer = null;
  try {
    await poll();
  } catch (e) {
    streamDeck.logger.error(`poll loop error: ${e}`);
  } finally {
    const isBurst = Date.now() < pollBurstUntil;
    const delay = isBurst ? BURST_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    pollTimer = setTimeout(runPollLoop, delay);
  }
}

@action({ UUID: "com.byjw.deep.slot" })
class SlotAction extends SingletonAction<SlotSettings> {
  override onWillAppear(ev: any): void {
    slotViews.set(ev.action.id, {
      action: ev.action,
      coordinates: ev.payload?.coordinates,
      settings: ev.payload?.settings,
    });
    renderAll();
    pollDebounced(100);
  }
  override onDidReceiveSettings(ev: any): void {
    const v = slotViews.get(ev.action.id);
    if (v) {
      v.settings = ev.payload?.settings;
    }
    pollDebounced(10);
  }
  override onWillDisappear(ev: any): void {
    slotViews.delete(ev.action.id);
    lastImg.delete(ev.action.id);
  }
  override async onKeyDown(ev: any): Promise<void> {
    const sortedIds = getSortedSlotIds();
    const idx = sortedIds.indexOf(ev.action.id);
    const b: any = idx >= 0 ? deck.slots[idx] : undefined;
    if (b && "isPageButton" in b && b.isPageButton) {
      currentPage = (currentPage + 1) % deck.pageCount;
      pinnedSlots.clear();
      pinnedUntil = 0;
      pollDebounced(10);
      return;
    }
    if (b && !b.empty) {
      const frontApp = await getFrontmostApp();
      const isOrcaFront = isOrca(frontApp);

      if (!isOrcaFront && frontApp && !isStreamDeck(frontApp)) {
        lastNonOrcaApp = frontApp;
      }

      // If Orca is already focused and tapped slot is the active session (targetHandle):
      // Super-Tab (Cmd+Tab / Alt+Tab) toggle back to previous app
      if (isOrcaFront && targetHandle === b.handle) {
        await switchToPreviousApp();
        return;
      }

      setTarget(b.handle);
      b.unread = false;
      lastNav = Date.now();
      holdCurrentSlotsInPlace();
      try {
        await switchTerminal(b.handle);
        await focusOrca();
      } catch (e) {
        streamDeck.logger.error(`switch failed: ${e}`);
        ev.action.showAlert?.();
      }
      renderAll();
      pollDebounced(50);
    } else {
      // Empty slot tap -> spawn new session
      await spawnSession(ev);
    }
  }
}

// Dial base logic — role fixed by subclass
class DialBase extends SingletonAction {
  role = "model";
  override onWillAppear(ev: any): void {
    dialViews.set(ev.action.id, { action: ev.action, role: this.role });
    ev.action.setFeedback(dialFeedback(this.role)).catch(() => {});
    pollDebounced(100);
  }
  override onWillDisappear(ev: any): void {
    dialViews.delete(ev.action.id);
    lastDialImg.delete(ev.action.id);
  }
  override onDialRotate(ev: any): void {
    boostPolling();
    const dir = (ev.payload?.ticks ?? 0) > 0 ? 1 : (ev.payload?.ticks ?? 0) < 0 ? -1 : 0;
    if (!dir) return;
    const t = ensureTarget();
    if (this.role === "model" || this.role === "effort" || this.role === "mode" || this.role === "permissions") {
      // Gate: unsupported agent / empty list -> alert
      const agent = agentForHandle();
      const kind = this.role as ControlKind;
      if (!t || !agent.supports(kind)) {
        ev.action.showAlert?.();
        return;
      }
      const list = dialList(kind);
      if (!list.length) {
        ev.action.showAlert?.();
        return;
      }
      const cur =
        this.role === "model"
          ? pendingModel
          : this.role === "effort"
          ? pendingEffort
          : this.role === "mode"
          ? pendingMode
          : pendingPermissions;
      const idx = cur ? list.indexOf(cur) : -1;
      const start = idx < 0 ? (dir > 0 ? -1 : 0) : idx;
      const next = list[(start + dir + list.length) % list.length];
      if (this.role === "model") pendingModel = next;
      else if (this.role === "effort") pendingEffort = next;
      else if (this.role === "mode") pendingMode = next;
      else pendingPermissions = next;
      pickAt[kind] = Date.now();
      renderDials();
    } else if (this.role === "target") {
      // Cycle all sessions. Move target immediately on deck; debounce terminal switch.
      if (allHandles.length) {
        const cur = allHandles.indexOf(t ?? allHandles[0]);
        const next = allHandles[(cur + dir + allHandles.length) % allHandles.length];
        lastNav = Date.now();
        setTarget(next);
        switchTargetSoon(next);
      }
      renderAll();
    } else {
      renderDials();
    }
  }
  override async onDialDown(ev: any): Promise<void> {
    boostPolling();
    const t = ensureTarget();
    if (this.role === "model" || this.role === "effort" || this.role === "mode" || this.role === "permissions") {
      const agent = agentForHandle();
      const kind = this.role as ControlKind;
      if (!t || !agent.supports(kind)) {
        streamDeck.logger.info(`apply ${kind}: unsupported in agent (${agent.label}) — gated`);
        ev.action.showAlert?.();
      } else {
        const value =
          this.role === "model"
            ? pendingModel
            : this.role === "effort"
            ? pendingEffort
            : this.role === "mode"
            ? pendingMode
            : pendingPermissions;
        if (!value) {
          ev.action.showAlert?.();
          return;
        }
        const prevValue =
          this.role === "model"
            ? (currentModelByHandle.get(t) || modelByHandle.get(t))
            : this.role === "effort"
            ? (currentEffortByHandle.get(t) || effortByHandle.get(t))
            : this.role === "mode"
            ? (currentModeByHandle.get(t) || modeByHandle.get(t))
            : (currentPermissionsByHandle.get(t) || permissionsByHandle.get(t));

        if (this.role === "model") {
          modelByHandle.set(t, value);
          currentModelByHandle.set(t, value);
          pendingModel = value;
          const inferred = agent.getEffortForModel(value);
          if (inferred) {
            effortByHandle.set(t, inferred);
            currentEffortByHandle.set(t, inferred);
            pendingEffort = inferred;
            pickAt.effort = 0;
          }
          lastEffortDiscoverAt = 0;
          refreshEfforts().catch(() => {});
        } else if (this.role === "effort") {
          effortByHandle.set(t, value);
          currentEffortByHandle.set(t, value);
          pendingEffort = value;
        } else if (this.role === "mode") {
          modeByHandle.set(t, value);
          currentModeByHandle.set(t, value);
          pendingMode = value;
        } else if (this.role === "permissions") {
          permissionsByHandle.set(t, value);
          currentPermissionsByHandle.set(t, value);
          pendingPermissions = value;
        }
        pickAt[kind] = Date.now();
        try {
          const modeList = this.role === "mode" ? dialList("mode") : undefined;
          await applyAgentSteps(t, agent.getApplySteps(kind, value, prevValue, modeList));
          pickAt[kind] = Date.now();
          if (this.role === "mode") {
            await refreshTargetScreen(t);
          }
          refreshCurrentState();
        } catch (e) {
          streamDeck.logger.error(`apply ${kind}: ${e}`);
          ev.action.showAlert?.();
        }
      }
    } else if (this.role === "target" && t) {
      lastNav = Date.now();
      await switchTerminal(t).catch(() => {});
      await focusOrca();
      pollDebounced(50);
    } else if (this.role === "talk") {
      // Toggle: push starts recording, push again stops, transcribes, and sends
      if (recording) await stopAndSend(ensureTarget());
      else await startRecording();
    }
    renderAll();
  }
}

@action({ UUID: "com.byjw.deep.model" })
class ModelDial extends DialBase {
  role = "model";
}
@action({ UUID: "com.byjw.deep.effort" })
class EffortDial extends DialBase {
  role = "effort";
}
@action({ UUID: "com.byjw.deep.mode" })
class ModeDial extends DialBase {
  role = "mode";
}
@action({ UUID: "com.byjw.deep.permissions" })
class PermissionsDial extends DialBase {
  role = "permissions";
}
@action({ UUID: "com.byjw.deep.talk" })
class TalkDial extends DialBase {
  role = "talk";
}
@action({ UUID: "com.byjw.deep.target" })
class TargetDial extends DialBase {
  role = "target";
}

streamDeck.actions.registerAction(new SlotAction());
streamDeck.actions.registerAction(new ModelDial());
streamDeck.actions.registerAction(new EffortDial());
streamDeck.actions.registerAction(new ModeDial());
streamDeck.actions.registerAction(new PermissionsDial());
streamDeck.actions.registerAction(new TalkDial());
streamDeck.actions.registerAction(new TargetDial());
// System & device events: immediate poll and render on system wake-up / device connect
streamDeck.system.onSystemDidWakeUp(() => {
  streamDeck.logger.info("system did wake up: triggering immediate poll");
  lastHeartbeat = Date.now();
  poll().catch(() => {});
});

streamDeck.devices.onDeviceDidConnect((ev) => {
  streamDeck.logger.info(`device connected: ${ev.device.id}, polling & rendering`);
  poll().catch(() => {});
  renderAll();
});

streamDeck.devices.onDeviceDidChange(() => {
  poll().catch(() => {});
  renderAll();
});

// Watchdog heartbeat for sleep/process pause detection
let lastHeartbeat = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastHeartbeat > 2500) {
    streamDeck.logger.info(`heartbeat gap detected (${now - lastHeartbeat}ms): waking up, running poll`);
    poll().catch(() => {});
  }
  lastHeartbeat = now;
}, 1000);

// File watchers for Orca hooks and agent state files (<50ms fast reactive update)
let fileWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function setupFileWatchers(): void {
  const dirsToWatch = [
    join(ORCA_DATA_DIR, "agent-hooks"),
    join(homedir(), ".local/state/opencode"),
    join(homedir(), ".claude"),
    join(homedir(), ".claude/cache/model-catalog"),
    join(homedir(), ".claude/projects"),
    join(homedir(), ".codex"),
    join(homedir(), ".gemini/antigravity-cli"),
    join(homedir(), ".pi/agent"),
    join(homedir(), ".pi/agent/sessions"),
  ];
  for (const dir of dirsToWatch) {
    try {
      if (existsSync(dir)) {
        watch(dir, { recursive: false }, () => {
          if (fileWatchDebounceTimer) return;
          fileWatchDebounceTimer = setTimeout(() => {
            fileWatchDebounceTimer = null;
            pollDebounced(250);
          }, 1000);
        });
      }
    } catch (e) {
      streamDeck.logger.warn(`watch ${dir} failed: ${e}`);
    }
  }
}
setupFileWatchers();

streamDeck.connect();

runPollLoop();

