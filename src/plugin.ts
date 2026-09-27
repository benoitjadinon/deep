// AgentDeck Stream Deck plugin entrypoint.
// Polls Orca to render session states across 8 slots, and handles keyDown / dials to control Orca.
// Dial roles determined by physical position (column): 0=Model 1=Effort 2=Talk 3=Target.
import streamDeck, { action, SingletonAction } from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { buildDeck, needsAttention, resolveActiveTerminal, nextWorktreeName, DEFAULT_ACTIVITY_BUCKET_MS, type Deck, type OrcaRepo } from "./deck";
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
} from "./agents";

const execFileP = promisify(execFile);
// Search common paths across different machines (eliminating hardcoded paths)
function firstExisting(candidates: string[], fallback: string): string {
  for (const p of candidates) if (existsSync(p)) return p;
  return fallback;
}
const ORCA = firstExisting(["/usr/local/bin/orca", "/opt/homebrew/bin/orca"], "orca");
// Full path to opencode — avoids injection of unsupported --permissions arguments from Orca's opencode launcher
const OPENCODE_CMD = firstExisting([
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
};
const talkHint = (code: string) => TALK_HINT[code] ?? "STT Error";
const EXEC = { maxBuffer: 64 * 1024 * 1024 } as const;
// Deck ordering debounce: sessions/groups active in the same wall-clock bucket keep their relative order,
// so several concurrently working projects don't re-sort the keys on every poll. Override with
// AGENTDECK_ORDER_BUCKET_MS (milliseconds).
const ORDER_BUCKET_MS =
  Number(process.env.AGENTDECK_ORDER_BUCKET_MS ?? "") > 0
    ? Number(process.env.AGENTDECK_ORDER_BUCKET_MS)
    : DEFAULT_ACTIVITY_BUCKET_MS;

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
  if (app.bundleId === "com.stablyai.orca") return true;
  if (app.name === "Orca") return true;
  return false;
}

function isStreamDeck(app: AppInfo | null): boolean {
  if (!app) return false;
  if (app.bundleId === "com.elgato.StreamDeck") return true;
  if (app.name === "Stream Deck") return true;
  return false;
}

async function getFrontmostApp(): Promise<AppInfo | null> {
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
    await execFileP("/usr/bin/open", ["-b", "com.stablyai.orca"], EXEC);
  } catch (e) {
    streamDeck.logger.error(`focus orca: ${e}`);
  }
}

// Timestamp of manual navigation (dial rotate / key tap) — prevents poll auto-tracking from overwriting manual selection immediately
let lastNav = 0;
// Debounce rapid target dial rotation (180ms)
let targetSwitchTimer: ReturnType<typeof setTimeout> | null = null;
function switchTargetSoon(handle: string): void {
  if (targetSwitchTimer) clearTimeout(targetSwitchTimer);
  targetSwitchTimer = setTimeout(() => {
    targetSwitchTimer = null;
    orcaRun(["terminal", "switch", "--terminal", handle]).then(() => {
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
const modelByHandle = new Map<string, string>(); // Last applied model per session
const effortByHandle = new Map<string, string>(); // Last applied effort per session
const modeByHandle = new Map<string, string>(); // Last applied mode per session
// Currently active model/effort/mode per session read periodically from disk
const currentModelByHandle = new Map<string, string>();
const currentEffortByHandle = new Map<string, string>();
const currentModeByHandle = new Map<string, string>();
// Timestamp when dial was rotated — gives grace period so auto-poll doesn't overwrite user selection
const pickAt = { model: 0, effort: 0, mode: 0 };
const PICK_GRACE = 2500;
// Gating / discovery state per agent: agentType -> profile / discovered live list
const agentByHandle = new Map<string, string>(); // session -> agentType (orca worktree ps)
const agentInstanceByHandle = new Map<string, AbstractAgent>(); // session -> abstract agent instance
const modelsByHandle = new Map<string, string[]>(); // session -> discovered model list
const modesByHandle = new Map<string, string[]>(); // session -> discovered mode list
const effortsByHandle = new Map<string, string[]>(); // session -> discovered effort list
let allHandles: string[] = []; // All session handles (sidebar total, independent of 8-slot page)
const sessionByHandle = new Map<string, any>(); // handle -> button metadata

// Push-to-talk state — uses Apple Speech STT helper (.app)
let recording = false;
let talkState = "hold"; // hold | ● REC | <live text> | mic err | STT err
let recPoll: ReturnType<typeof setInterval> | null = null;

async function startRecording(): Promise<void> {
  if (recording) return;
  recording = true;
  talkState = "● REC";
  renderAll();
  try {
    for (const f of [STT_TXT, STT_PID, STT_PARTIAL, STT_STATUS]) if (existsSync(f)) try { unlinkSync(f); } catch {}
    // Launch helper via open (starts live recognition with bundle permissions)
    await execFileP("/usr/bin/open", [STT_APP]);
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
    const pid = existsSync(STT_PID) ? readFileSync(STT_PID, "utf8").trim() : "";
    if (pid) try { await execFileP("/bin/kill", ["-INT", pid]); } catch {}
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
        await orcaRun(["terminal", "send", "--terminal", target, "--text", txt]);
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
function contextForHandle(h: string): AgentContext {
  const b = sessionByHandle.get(h);
  return {
    handle: h,
    worktreePath: b?.worktreePath,
    worktreeId: b?.worktreeId,
    preview: b?.preview,
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

  if (state.model) {
    if (currentModelByHandle.get(h) !== state.model) {
      currentModelByHandle.set(h, state.model);
      modelChanged = true;
    }
  }

  let effortToSet = state.effort;
  if (!effortToSet && state.model) {
    effortToSet = agent.getEffortForModel(state.model);
  }
  if (effortToSet) {
    if (currentEffortByHandle.get(h) !== effortToSet || modelChanged) {
      currentEffortByHandle.set(h, effortToSet);
      if (modelChanged) {
        effortByHandle.set(h, effortToSet);
      }
    }
  }

  if (state.mode) {
    currentModeByHandle.set(h, state.mode);
  }
  if (state.modes && state.modes.length) {
    modesByHandle.set(h, state.modes);
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
  targetHandle = h;
  if (h) {
    noteHandle(h);
    refreshSessionState(h);
  }
  agentForHandle();
  pickAt.model = 0; // Target change invalidates previous grace period
  pickAt.effort = 0;
  pickAt.mode = 0;
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
    return agent.getEfforts(currentModelByHandle.get(t));
  }
  if (kind === "mode") {
    const live = modesByHandle.get(t);
    if (live && live.length) return live;
    return agent.getModes(contextForHandle(t));
  }
  return [];
}
function applyPending(): void {
  adoptPending("model");
  adoptPending("effort");
  adoptPending("mode");
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
  } else {
    const current = currentModeByHandle.get(t);
    const applied = modeByHandle.get(t);
    pendingMode = current || applied || first;
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
  if (role === "target") return targetLabel();
  return talkState;
}
// Send steps to terminal with delay support
async function applyAgentSteps(handle: string, steps: ApplyStep[]): Promise<void> {
  for (const s of steps) {
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    const args = ["terminal", "send", "--terminal", handle, "--text", s.text];
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
    const modelChanged = refreshSessionState(h);
    if (h === t && modelChanged) {
      lastEffortDiscoverAt = 0;
      refreshEfforts().catch(() => {});
    }
  }
  adoptPending("model");
  adoptPending("effort");
  adoptPending("mode");
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
  const currentModel = currentModelByHandle.get(t);
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

type Coords = { column: number; row: number };
const slotViews = new Map<string, { action: any; coordinates?: Coords }>();
const dialViews = new Map<string, { action: any; role: string }>();
const lastImg = new Map<string, string>();
const lastDialImg = new Map<string, string>();

const slotIndex = (c?: Coords) => (c ? c.row * 4 + c.column : 0);

function ensureTarget(): string | undefined {
  if (!targetHandle || !allHandles.includes(targetHandle)) {
    if (targetHandle !== allHandles[0]) {
      targetHandle = allHandles[0];
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
  if (role === "talk") return { full: dialImage("talk", "TALK", v, tick) };
  if (role === "target") {
    // Button-style state rendering: the target session drives the status bar color, glyph and the
    // attention pulse (treated like an already-focused key — waiting/error still pulse, unread-done doesn't).
    const st = tb
      ? {
          state: (tb as any).state,
          color: (tb as any).color as string | undefined,
          attention: needsAttention(tb, true),
          nowMs: Date.now(),
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
  for (const [id, { action: a, coordinates }] of slotViews) {
    const b = deck.slots[slotIndex(coordinates)] ?? { empty: true as const };
    const isTarget = !b.empty && (b as any).handle === targetHandle;
    const dim = boardAttn && !b.empty && !needsAttention(b, isTarget);
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
  for (const { coordinates } of slotViews.values()) {
    const b = deck.slots[slotIndex(coordinates)];
    if (b && !b.empty && needsAttention(b, (b as any).handle === targetHandle)) return true;
  }
  return false;
}

// Check if the target session (dial 4) itself requires attention — blinks even when it sits past
// the 8 visible keys. Treated as an already-focused session (waiting/error pulse, unread-done doesn't).
function targetAttention(): boolean {
  const tb = targetHandle ? sessionByHandle.get(targetHandle) : undefined;
  return Boolean(tb) && needsAttention(tb, true);
}

// Read latest hook states from Orca agent-hooks (last-status.json)
function getHookEvents(): Map<string, { hookEventName?: string; agentType?: string; state?: string; receivedAt?: number }> {
  const map = new Map<string, { hookEventName?: string; agentType?: string; state?: string; receivedAt?: number }>();
  try {
    const filePath = join(homedir(), "Library/Application Support/orca/agent-hooks/last-status.json");
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
    const rl = await orcaJson(["repo", "list"]);
    if (rl?.result?.repos) {
      cachedRepos = rl.result.repos;
      lastRepoFetchAt = Date.now();
      prefetchRepoIcons(cachedRepos);
    }
  } catch (e) {
    streamDeck.logger.error(`fetch repos: ${e}`);
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
    const data = await orcaJson(["account", "list"]);
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
    const [tl, wp] = await Promise.all([
      orcaJson(["terminal", "list", "--include-visual-layouts"]),
      orcaJson(["worktree", "ps"]),
    ]);
    const hookEvents = getHookEvents();
    const visualLayouts = tl.result?.visualLayouts;
    // One shared timestamp so the 8-key page and the full session list always agree on ordering buckets.
    const now = Date.now();
    deck = buildDeck(
      { terminals: tl.result?.terminals ?? [], worktrees: wp.result?.worktrees ?? [], repos: cachedRepos, visualLayouts, hookEventsByPane: hookEvents },
      { page: currentPage, perPage: 8, now, activityBucketMs: ORDER_BUCKET_MS },
    );
    if (currentPage >= deck.pageCount) {
      currentPage = Math.max(0, deck.pageCount - 1);
      deck = buildDeck(
        { terminals: tl.result?.terminals ?? [], worktrees: wp.result?.worktrees ?? [], repos: cachedRepos, visualLayouts, hookEventsByPane: hookEvents },
        { page: currentPage, perPage: 8, now, activityBucketMs: ORDER_BUCKET_MS },
      );
    }
    // Full session list (sidebar total) — target dial can cycle past 8 keys
    const full = buildDeck(
      { terminals: tl.result?.terminals ?? [], worktrees: wp.result?.worktrees ?? [], repos: cachedRepos, visualLayouts, hookEventsByPane: hookEvents },
      { page: 0, perPage: 9999, now, activityBucketMs: ORDER_BUCKET_MS },
    );
    allHandles = [];
    sessionByHandle.clear();
    for (const s of full.slots) {
      if (!s.empty) {
        const h = (s as any).handle;
        allHandles.push(h);
        sessionByHandle.set(h, s);
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
    // Prevent memory leaks for closed sessions
    for (const h of Array.from(agentByHandle.keys())) {
      if (!sessionByHandle.has(h)) {
        agentByHandle.delete(h);
        agentInstanceByHandle.delete(h);
        modelsByHandle.delete(h);
        modesByHandle.delete(h);
        effortsByHandle.delete(h);
        currentModelByHandle.delete(h);
        currentEffortByHandle.delete(h);
        currentModeByHandle.delete(h);
        modelByHandle.delete(h);
        effortByHandle.delete(h);
        modeByHandle.delete(h);
      }
    }
    // Automatically set currently focused session as target
    const activeHandle = resolveActiveTerminal(
      wp.result?.worktrees ?? [],
      tl.result?.terminals ?? [],
      tl.result?.visualLayouts,
      targetHandle,
    );
    if (activeHandle && sessionByHandle.has(activeHandle)) {
      if (!targetHandle) {
        setTarget(activeHandle);
      } else if (Date.now() - lastNav > 1800 && activeHandle !== targetHandle) {
        setTarget(activeHandle);
      }
    }
    refreshDiscovery(); // Periodically load model list for supported agents (throttled)
    refreshCurrentState(); // Track active state (model/effort/mode) from agent interfaces (every poll)
    refreshEfforts(); // Periodically load effort variants (throttled)
    renderAll();
    try {
      writeFileSync(
        "/tmp/agentdeck-debug.json",
        JSON.stringify({ at: new Date().toISOString(), total: deck.total, slotViews: slotViews.size, dialViews: dialViews.size, target: targetHandle, dials: { model: dialValue("model"), effort: dialValue("effort"), mode: dialValue("mode") }, slots: deck.slots }, null, 2),
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
    // Determine next index from existing worktrees in same repo
    const list = await orcaJson(["worktree", "list"]);
    const same = (list?.result?.worktrees ?? []).filter((w: any) => w.repoId === repoId);
    const name = nextWorktreeName(repo, same.map((w: any) => w.displayName || ""));
    const createArgs: string[] = ["worktree", "create", "--repo", `id:${repoId}`, "--name", name];
    // Work around Orca injecting unsupported --permissions argument for opencode
    const isOpenCode = agent === "opencode";
    if (!isOpenCode) createArgs.push("--agent", agent);
    const res = await orcaJson(createArgs);
    const wt = res?.result?.worktree?.id ?? (res?.result ?? res)?.worktreeId;
    const createdWt = wt || (res?.result ?? res)?.id;
    let handle: string | undefined;
    if (isOpenCode) {
      if (createdWt) {
        const created = await orcaJson(["terminal", "create", "--worktree", createdWt, "--command", OPENCODE_CMD, "--focus"]);
        handle = created?.result?.terminal?.handle ?? created?.result?.handle?.handle;
      }
      // fallback: if agent terminal not found yet, find terminal in created worktree
      if (!handle) {
        const terms = await orcaJson(["terminal", "list"]);
        const wtTerm = (terms?.result?.terminals ?? []).find((x: any) => x.worktreeId === createdWt || (x.worktreePath ?? "").includes(name));
        if (wtTerm?.handle) {
          await orcaRun(["terminal", "switch", "--terminal", wtTerm.handle]);
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
        await orcaRun(["terminal", "switch", "--terminal", handle]);
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

let fileDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function pollDebounced(delay = 50): void {
  if (fileDebounceTimer) clearTimeout(fileDebounceTimer);
  fileDebounceTimer = setTimeout(() => {
    fileDebounceTimer = null;
    poll().catch(() => {});
  }, delay);
}

@action({ UUID: "com.byjw.deep.slot" })
class SlotAction extends SingletonAction {
  override onWillAppear(ev: any): void {
    slotViews.set(ev.action.id, { action: ev.action, coordinates: ev.payload?.coordinates });
    renderAll();
    pollDebounced(100);
  }
  override onWillDisappear(ev: any): void {
    slotViews.delete(ev.action.id);
    lastImg.delete(ev.action.id);
  }
  override async onKeyDown(ev: any): Promise<void> {
    const b: any = deck.slots[slotIndex(ev.payload?.coordinates)];
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
      lastNav = Date.now();
      try {
        await orcaRun(["terminal", "switch", "--terminal", b.handle]);
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
    const dir = (ev.payload?.ticks ?? 0) > 0 ? 1 : (ev.payload?.ticks ?? 0) < 0 ? -1 : 0;
    if (!dir) return;
    const t = ensureTarget();
    if (this.role === "model" || this.role === "effort" || this.role === "mode") {
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
      const cur = this.role === "model" ? pendingModel : this.role === "effort" ? pendingEffort : pendingMode;
      const idx = cur ? list.indexOf(cur) : -1;
      const start = idx < 0 ? (dir > 0 ? -1 : 0) : idx;
      const next = list[(start + dir + list.length) % list.length];
      if (this.role === "model") pendingModel = next;
      else if (this.role === "effort") pendingEffort = next;
      else pendingMode = next;
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
    const t = ensureTarget();
    if (this.role === "model" || this.role === "effort" || this.role === "mode") {
      const agent = agentForHandle();
      const kind = this.role as ControlKind;
      if (!t || !agent.supports(kind)) {
        streamDeck.logger.info(`apply ${kind}: unsupported in agent (${agent.label}) — gated`);
        ev.action.showAlert?.();
      } else {
        const value = this.role === "model" ? pendingModel : this.role === "effort" ? pendingEffort : pendingMode;
        if (!value) {
          ev.action.showAlert?.();
          return;
        }
        const prevValue =
          this.role === "model"
            ? (currentModelByHandle.get(t) || modelByHandle.get(t))
            : this.role === "effort"
            ? (currentEffortByHandle.get(t) || effortByHandle.get(t))
            : (currentModeByHandle.get(t) || modeByHandle.get(t));

        if (this.role === "model") {
          modelByHandle.set(t, value);
          currentModelByHandle.set(t, value);
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
        } else {
          modeByHandle.set(t, value);
          currentModeByHandle.set(t, value);
        }
        try {
          const modeList = this.role === "mode" ? dialList("mode") : undefined;
          await applyAgentSteps(t, agent.getApplySteps(kind, value, prevValue, modeList));
          refreshCurrentState();
        } catch (e) {
          streamDeck.logger.error(`apply ${kind}: ${e}`);
          ev.action.showAlert?.();
        }
      }
    } else if (this.role === "target" && t) {
      lastNav = Date.now();
      await orcaRun(["terminal", "switch", "--terminal", t]).catch(() => {});
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
function setupFileWatchers(): void {
  const dirsToWatch = [
    join(homedir(), "Library/Application Support/orca/agent-hooks"),
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
          pollDebounced(50);
        });
      }
    } catch (e) {
      streamDeck.logger.warn(`watch ${dir} failed: ${e}`);
    }
  }
}
setupFileWatchers();

streamDeck.connect();

setInterval(poll, 1000);
// Marquee tick interval (450ms)
setInterval(() => {
  tick++;
  if (anyAttention() || anyMarquee()) renderKeys();
}, 450);
// Smooth pulse loop for keys AND the target dial requiring attention (160ms ≈ 6fps)
let wasAttention = false;
setInterval(() => {
  const attn = anyAttention() || targetAttention();
  if (attn) {
    wasAttention = true;
    renderKeys();
    renderDials();
  } else if (wasAttention) {
    wasAttention = false;
    renderKeys();
    renderDials();
  }
}, 160);
poll();

// Check if any visible session key has long titles requiring marquee animation
function anyMarquee(): boolean {
  for (const { coordinates } of slotViews.values()) {
    const b = deck.slots[slotIndex(coordinates)];
    if (b && !b.empty) {
      const proj = (b as any).repo || ((b as any).worktreePath ? String((b as any).worktreePath).split("/").filter(Boolean).pop() : "") || "";
      if (proj.length > 9) return true;
    }
  }
  return false;
}

