// AgentDeck core: Pure function converting Orca's two sources (terminal list + worktree ps)
// into a Stream Deck Plus 8-slot button model.
// This layer is fully testable without physical hardware.

import { agentFor } from "./agents.ts";
import { resolveRepoBgIcon, type ResolvedBgIcon } from "./icons.ts";

export type AgentState =
  | "working"
  | "monitoring"
  | "waiting"
  | "permission"
  | "blocked"
  | "interrupted"
  | "done"
  | "error"
  | "failed"
  | "unverifiable"
  | "idle"
  | string
  | undefined;
export type Color = "orange" | "violet" | "green" | "red" | "white" | "blue" | "amber";

/** Inactivity decay duration matching Orca (30 minutes) */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000;

/** Grace period (ms) to keep terminal agent identity when Orca momentarily fails to report it during process scans (15 seconds) */
export const DEFAULT_TERMINAL_AGENT_GRACE_MS = 15_000;

export interface CachedTerminalAgent {
  agentIdentity: string;
  lastSeenAt: number;
}

/**
 * Stabilize terminal agentIdentity across poll cycles to prevent UI flapping/blinking
 * when Orca's process scan intermittently reports undefined.
 */
export function stabilizeTerminalAgents(
  terminals: OrcaTerminal[],
  cache: Map<string, CachedTerminalAgent>,
  now: number = Date.now(),
  graceMs: number = DEFAULT_TERMINAL_AGENT_GRACE_MS,
): OrcaTerminal[] {
  const result: OrcaTerminal[] = [];
  const liveHandles = new Set<string>();

  for (const t of terminals ?? []) {
    liveHandles.add(t.handle);
    const copy = { ...t };
    if (copy.agentIdentity) {
      cache.set(copy.handle, { agentIdentity: copy.agentIdentity, lastSeenAt: now });
    } else {
      const cached = cache.get(copy.handle);
      if (cached && now - cached.lastSeenAt < graceMs) {
        copy.agentIdentity = cached.agentIdentity;
      } else if (cached) {
        cache.delete(copy.handle);
      }
    }
    result.push(copy);
  }

  // Clean up closed terminal handles immediately
  for (const h of Array.from(cache.keys())) {
    if (!liveHandles.has(h)) {
      cache.delete(h);
    }
  }

  return result;
}

/** Fields used from `orca terminal list --json` -> `result.terminals[]` */
export interface OrcaTerminal {
  handle: string;
  tabId: string;
  leafId: string;
  title: string;
  worktreePath?: string;
  worktreeId?: string;
  lastOutputAt?: number | null;
  /** Whether agent process is alive in terminal — detected immediately before worktree ps reports it. null/undefined = pure shell. */
  agentIdentity?: string | null;
  /** Host running this terminal (`local` or an ssh/environment host id from `orca host list`). */
  executionHostId?: string | null;
  /** Paired Orca environment name when this terminal lives on a remote runtime (undefined = this machine). */
  environment?: string;
  /** Id of that paired environment (from `orca environment list`). */
  environmentId?: string;
}

/** Fields used from `orca worktree ps --json` -> `result.worktrees[]` */
export interface OrcaWorktree {
  worktreeId?: string;
  /** Host running this worktree (`local` or an ssh/environment host id from `orca host list`). */
  hostId?: string | null;
  /** Paired Orca environment name when this worktree lives on a remote runtime (undefined = this machine). */
  environment?: string;
  /** Id of that paired environment (from `orca environment list`). */
  environmentId?: string;
  repo?: string;
  branch?: string;
  displayName?: string;
  unread?: boolean; // true if user hasn't viewed latest output yet (automatically set to false when viewed in Orca)
  status?: string;
  agents?: Array<{
    paneKey: string;
    state?: AgentState;
    status?: string;
    workingMode?: string;
    interrupted?: boolean;
    agentType?: string;
    updatedAt?: number;
    stateStartedAt?: number;
    evidenceObservedAt?: number;
  }>;
}

/** Icon/color fields from `orca repo list --json` / `project list --json` */
export interface OrcaRepoIcon {
  type?: "image" | "lucide" | "emoji" | string;
  src?: string;
  source?: "github" | "file" | string;
  label?: string;
  name?: string;
  emoji?: string;
  value?: string;
}

export interface OrcaRepo {
  id: string;
  path?: string;
  displayName?: string;
  badgeColor?: string;
  repoIcon?: OrcaRepoIcon | null;
}

/** Fields used from `orca host list --json` -> `result.hosts[]` */
export interface OrcaHost {
  id?: string;
  /** `local` | `ssh` | `environment` */
  kind?: string;
  name?: string;
  /** Hostname of the local machine (kind = local) */
  machineName?: string;
  platform?: string;
}

export interface HookInfo {
  hookEventName?: string;
  agentType?: string;
  state?: string;
  status?: string;
  workingMode?: string;
  interrupted?: boolean;
  receivedAt?: number;
}

export interface DeckInput {
  terminals: OrcaTerminal[];
  worktrees: OrcaWorktree[];
  repos?: OrcaRepo[];
  /** Hosts from `orca host list --json` — used to label where each session runs. */
  hosts?: OrcaHost[];
  visualLayouts?: any[];
  tabTitles?: Map<string, string> | Record<string, string>;
  hookEventsByPane?: Map<string, string | HookInfo> | Record<string, string | HookInfo>;
}

export interface DeckOptions {
  page?: number;
  perPage?: number;
  now?: number;
  /** Activity bucket size (ms) used for ordering. Sessions/groups active in the same bucket keep their
   * relative order instead of re-sorting on every output line. Default 60_000. */
  activityBucketMs?: number;
  /** Slot index (0-7) designated as the page switcher key when total sessions exceed perPage. */
  pagingSlotIndex?: number;
  /**
   * Pinned slot mapping: maps handle -> slot index that must not change.
   * Preserves exact tile positions across poll updates during user interaction hold.
   */
  pinnedSlots?: Map<string, number>;
}

export type Button =
  | { empty: true; isPageButton?: false }
  | {
      empty?: false;
      isPageButton: true;
      page: number;
      pageCount: number;
      hasAlertOnOtherPage?: boolean;
      otherState?: AgentState;
      otherStatus?: string;
      otherColor?: Color;
      otherUnread?: boolean;
    }
  | {
      empty: false;
      isPageButton?: false;
      handle: string;
      tabId?: string;
      leafId?: string;
      label: string;
      tabTitle?: string; // Orca tab title (for 2-line summary rendering)
      state: AgentState;
      status?: string;
      workingMode?: string;
      interrupted?: boolean;
      color: Color;
      worktreePath?: string;
      worktreeId?: string; // `<repoId>::<path>` — used to extract repoId when spawning a new worktree in the same repo from an empty slot
      preview?: string; // Live terminal preview text (for mode/state detection)
      lastOutputAt?: number | null;
      repo?: string;
      branch?: string;
      dupIndex?: number; // Sequence index within same repo/branch (0=first, >=1 shows -N suffix)
      unread?: boolean; // Indicates completed session not yet viewed
      agentType?: string; // Agent type reported by Orca (claude/codex/opencode/...) — used for dial gating
      host?: string; // Short label of the machine running the session (laptop / Mac mini)
      hostId?: string; // Raw Orca host id (`local` or an ssh/environment id)
      environment?: string; // Paired Orca environment name (remote runtime) — also routes terminal send/switch
      environmentId?: string; // Paired environment id, used to spawn worktrees on that runtime
      badgeColor?: string; // Orca project badge color (e.g. #ef4444)
      repoIcon?: OrcaRepoIcon | null; // Orca project original icon metadata
      bgIconUri?: string; // Image Data URI to draw in tile background (GitHub avatar, local icon.png)
      bgIconLucide?: string; // Lucide SVG inner tags to draw in tile background (Rocket, Folder, etc.)
      bgIconEmoji?: string; // Emoji to draw in tile background
    };

export interface Deck {
  slots: Button[];
  page: number;
  pageCount: number;
  total: number;
}

const STATE_COLOR: Record<string, Color> = {
  working: "orange",
  monitoring: "orange",
  waiting: "violet",
  permission: "violet",
  blocked: "violet",
  interrupted: "red",
  error: "red",
  failed: "red",
  done: "green",
  idle: "white",
  unverifiable: "violet",
};

/**
 * CLI args that scope an Orca command to a paired remote runtime. A session's terminal handle
 * belongs to the runtime that issued it, so `terminal switch`/`send` must carry `--environment`
 * or the command resolves against this machine. Local sessions need no flag.
 */
export function environmentArgs(environment?: string | null): string[] {
  return environment ? ["--environment", environment] : [];
}

/**
 * Short label for the machine running a session, from `orca host list`.
 * - local host -> machine name (e.g. `ben-laptop13`), falling back to platform (`linux`)
 * - ssh / environment host -> its configured name (e.g. `Mac mini`)
 * Returns undefined when neither a host id nor a host list is available (nothing to draw).
 */
export function hostLabel(hostId?: string | null, hosts?: OrcaHost[]): string | undefined {
  if (!hostId && !hosts?.length) return undefined;
  const id = hostId || "local";
  const host = (hosts ?? []).find((h) => h?.id === id);
  if (!host) return id === "local" ? "local" : id;
  if (host.kind === "local" || host.id === "local") {
    return host.machineName || host.platform || host.name || "local";
  }
  return host.name || host.machineName || host.id || id;
}

/**
 * Extract human-readable project name for a worktree/session.
 * A git worktree carries its repo — that IS the project (e.g. the AltReady
 * "screenshot" worktree under .../AltReady/screenshot shows "AltReady", not
 * "screenshot"). Only fall back to path parsing for repo-less folder workspaces:
 * `/Projects/<X>/...` returns X (e.g. AcmeApp/ko -> "AcmeApp"),
 * otherwise the last folder name (e.g. .../Notes -> "Notes").
 */
export function projectOf(path?: string, repo?: string): string | undefined {
  if (repo) return repo;
  if (path) {
    const segs = path.split("/").filter(Boolean);
    const i = segs.indexOf("Projects");
    if (i >= 0 && segs[i + 1]) return segs[i + 1];
    if (segs.length) return segs[segs.length - 1];
  }
  return undefined;
}

/** State -> button color mapping. Unknown/empty state defaults to white. */
export function colorFor(state: AgentState): Color {
  if (state && STATE_COLOR[state]) return STATE_COLOR[state];
  return "white";
}

/** Latest evidence of activity among candidate timestamps (0 when unknown). */
export function sessionRecency(...times: Array<number | null | undefined>): number {
  let max = 0;
  for (const t of times) {
    if (typeof t === "number" && Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/** Ordering debounce: sessions active in the same wall-clock bucket tie, so the deck only re-sorts when
 * activity crosses a bucket boundary instead of on every output line. Default 60s. */
export const DEFAULT_ACTIVITY_BUCKET_MS = 60 * 1000;

/** Coarse activity epoch of a timestamp (0 when unknown = oldest). */
export function activityBucket(
  timestamp: number | null | undefined,
  bucketMs: number = DEFAULT_ACTIVITY_BUCKET_MS,
): number {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return Math.floor(timestamp / Math.max(1, bucketMs));
}

/** State sorting priority rank: lower number = placed higher/earlier on the deck */
export function statePriority(state: AgentState, unread?: boolean): number {
  if (state === "done") {
    return unread ? 0 : 20; // unread done needs attention (active tier); reviewed done is inactive tier
  }
  switch (state) {
    case "working":
    case "monitoring":
    case "waiting":
    case "permission":
    case "blocked":
    case "interrupted":
    case "error":
    case "failed":
      return 0; // Active / In-progress / Attention tier
    case "idle":
    case "unverifiable":
    default:
      return 20; // Inactive / Completed tier
  }
}

/**
 * Deck ordering: sort sessions by importance (active/attention first, completed/idle last),
 * then by activity recency bucket.
 * Inside each tier, sessions are ordered by activity bucket (freshest bucket first),
 * with the terminal handle as deterministic tiebreak.
 */
export function sortSessions<T>(
  sessions: T[],
  stateOf: (s: T) => AgentState,
  recencyOf: (s: T) => number,
  handleOf: (s: T) => string,
  opts: {
    bucketMs?: number;
    unreadOf?: (s: T) => boolean | undefined;
    usePriority?: boolean;
  } = {},
): T[] {
  const bucketMs = opts.bucketMs ?? DEFAULT_ACTIVITY_BUCKET_MS;
  const usePriority = opts.usePriority ?? true;
  const entries = sessions.map((s) => ({
    s,
    priority: usePriority ? statePriority(stateOf(s), opts.unreadOf?.(s)) : 0,
    bucket: activityBucket(recencyOf(s), bucketMs),
    handle: handleOf(s),
  }));

  entries.sort((a, b) => {
    // 1. Primary sort: state priority (active/attention tier first, completed/idle last)
    if (a.priority !== b.priority) return a.priority - b.priority;
    // 2. Secondary sort: activity recency bucket (most recently active session first inside tier)
    if (a.bucket !== b.bucket) return b.bucket - a.bucket;
    // 3. Deterministic handle tiebreak
    return a.handle.localeCompare(b.handle);
  });

  return entries.map((e) => e.s);
}

/**
 * Legacy project-grouped deck ordering.
 */
export function sortSessionsByProject<T>(
  sessions: T[],
  projectOf: (s: T) => string | undefined,
  recencyOf: (s: T) => number,
  handleOf: (s: T) => string,
  opts: { bucketMs?: number } = {},
): T[] {
  const bucketMs = opts.bucketMs ?? DEFAULT_ACTIVITY_BUCKET_MS;
  const entries = sessions.map((s) => ({
    s,
    project: projectOf(s) ?? "",
    bucket: activityBucket(recencyOf(s), bucketMs),
    handle: handleOf(s),
  }));

  const groupBucket = new Map<string, number>();
  for (const e of entries) {
    const prev = groupBucket.get(e.project) ?? 0;
    if (e.bucket > prev) groupBucket.set(e.project, e.bucket);
  }

  entries.sort((a, b) => {
    if (a.project !== b.project) {
      const ra = groupBucket.get(a.project) ?? 0;
      const rb = groupBucket.get(b.project) ?? 0;
      if (ra !== rb) return rb - ra; // most recently active project group first
      return a.project.localeCompare(b.project); // deterministic group order
    }
    if (a.bucket !== b.bucket) return b.bucket - a.bucket; // most recently active session first
    return a.handle.localeCompare(b.handle);
  });

  return entries.map((e) => e.s);
}

/**
 * Generate a new worktree name with max existing `repo-N` index + 1.
 * Considering the base repo as 1, the first new worktree will be `repo-2`.
 */
export function nextWorktreeName(repo: string, existingNames: string[]): string {
  const prefix = `${repo}-`;
  let maxN = 1;
  for (const n of existingNames ?? []) {
    if (n && n.startsWith(prefix)) {
      const num = Number(n.slice(prefix.length));
      if (Number.isInteger(num) && num > maxN) maxN = num;
    }
  }
  return `${prefix}${maxN + 1}`;
}

/**
 * Check whether a session requires attention (animation/pulse) — draws eye when Orca signals done or awaiting reply.
 * Non-target sessions: waiting (amber/violet), unread done (green), error/interrupted (red) pulse to alert the user.
 * When focused/viewing the session (isTarget), pulsing animation stops so it does not distract the user while focused.
 * The session maintains its state color and glyph (e.g. red for interrupted) as long as it remains in that state.
 */
export function needsAttention(b: Button, isTarget: boolean = false): boolean {
  if (b.empty) return false;
  if ("isPageButton" in b && b.isPageButton) {
    if (!b.otherColor || b.otherColor === "white" || b.otherColor === "orange" || b.otherColor === "blue") return false;
    if (b.otherColor === "green") return Boolean(b.otherUnread);
    return b.otherColor === "violet" || b.otherColor === "amber" || b.otherColor === "red";
  }
  if (isTarget) return false;
  if (b.state === "done") return Boolean(b.unread);
  if (b.state === "unverifiable") return false;
  if (b.state === "interrupted") return true;
  if (b.color === "green") return Boolean(b.unread);
  return b.color === "violet" || b.color === "amber" || b.color === "red";
}

/**
 * Extract the highest priority representative state and color from sessions on other pages:
 * 1. error / interrupted / failed (red)
 * 2. waiting / permission / blocked (violet)
 * 3. done (green, unread)
 * 4. working / monitoring (orange)
 * 5. done (green, read)
 * 6. idle / unverifiable (white)
 */
export function representativeOtherState(
  otherItems: Array<{ item: { state: AgentState; status?: string }; unread?: boolean }>,
): {
  otherState?: AgentState;
  otherStatus?: string;
  otherColor?: Color;
  otherUnread?: boolean;
} {
  if (!otherItems.length) return {};

  if (otherItems.some((e) => e.item.state === "error" || e.item.state === "failed" || e.item.state === "interrupted")) {
    const s = otherItems.find((e) => e.item.state === "interrupted")?.item.state ?? "error";
    return { otherState: s, otherColor: "red" };
  }
  if (otherItems.some((e) => e.item.state === "waiting" || e.item.state === "permission" || e.item.state === "blocked")) {
    return { otherState: "waiting", otherColor: "violet" };
  }
  if (otherItems.some((e) => e.item.state === "done" && Boolean(e.unread))) {
    return { otherState: "done", otherColor: "green", otherUnread: true };
  }
  if (otherItems.some((e) => e.item.state === "working" || e.item.state === "monitoring")) {
    return { otherState: "working", otherColor: "orange" };
  }
  if (otherItems.some((e) => e.item.state === "done")) {
    return { otherState: "done", otherColor: "green", otherUnread: false };
  }
  return { otherState: "idle", otherColor: "white" };
}

const EMPTY: Button = { empty: true };

/**
 * Merge two Orca sources into an 8-slot (default) button model.
 * - Join terminal (handle) and worktree agent (state) by paneKey (`tabId:leafId`).
 * - Exclude pure shell terminals without agent state.
 * - Group by project: a project's agents are adjacent, groups ordered by most recent activity
 *   (freshest activity bucket first), most recent session first inside a group, handle as deterministic
 *   tiebreak. Activity is bucketed (`activityBucketMs`, default 60s) so concurrently working projects
 *   do not re-sort the deck on every output line.
 * - Paginate by perPage (default 8), padding empty slots with `{ empty: true }`.
 */
export function buildDeck(input: DeckInput, opts: DeckOptions = {}): Deck {
  const perPage = Math.max(1, opts.perPage ?? 8);
  const now = opts.now ?? Date.now();

  const getHook = (pane: string): HookInfo | undefined => {
    if (!input.hookEventsByPane) return undefined;
    const raw =
      input.hookEventsByPane instanceof Map
        ? input.hookEventsByPane.get(pane)
        : (input.hookEventsByPane as Record<string, string | HookInfo>)[pane];
    if (!raw) return undefined;
    if (typeof raw === "string") return { hookEventName: raw };
    return raw;
  };

  // paneKey -> state map + fallback agent type + worktreeId -> {repo, branch} metadata
  const stateByPane = new Map<string, AgentState>();
  const statusByPane = new Map<string, string>();
  const workingModeByPane = new Map<string, string>();
  const interruptedByPane = new Map<string, boolean>();
  const agentByPane = new Map<string, string>();
  const timeByPane = new Map<string, number>(); // latest agent evidence timestamp per pane (for ordering)
  const metaByWt = new Map<string, { repo?: string; branch?: string; unread?: boolean; hostId?: string }>();
  for (const wt of input.worktrees ?? []) {
    for (const a of wt.agents ?? []) {
      let st: AgentState = a.state;
      if (a.interrupted === true || a.status === "interrupted" || st === "interrupted") {
        st = "interrupted";
      } else if (st === "working" && a.workingMode === "monitoring") {
        st = "monitoring";
      }
      const observedAt = a.evidenceObservedAt ?? a.updatedAt ?? a.stateStartedAt;
      if (
        st &&
        st !== "done" &&
        st !== "idle" &&
        st !== "interrupted" &&
        (st === "working" || st === "waiting" || st === "blocked" || st === "monitoring") &&
        observedAt &&
        now - observedAt > AGENT_STATUS_STALE_AFTER_MS
      ) {
        st = "unverifiable";
      }
      stateByPane.set(a.paneKey, st);
      if (a.status) statusByPane.set(a.paneKey, a.status);
      if (a.workingMode) workingModeByPane.set(a.paneKey, a.workingMode);
      if (a.interrupted !== undefined) interruptedByPane.set(a.paneKey, a.interrupted);
      // If multiple agents on same paneKey, keep first as fallback (normally 0-1)
      if (!agentByPane.has(a.paneKey)) agentByPane.set(a.paneKey, a.agentType ?? "");
      timeByPane.set(a.paneKey, sessionRecency(timeByPane.get(a.paneKey), observedAt));
    }
    if (wt.worktreeId) {
      const branch = wt.displayName || (wt.branch ?? "").replace(/^refs\/heads\//, "");
      metaByWt.set(wt.worktreeId, {
        repo: wt.repo,
        branch: branch || undefined,
        unread: wt.unread,
        hostId: wt.hostId || undefined,
      });
    }
  }

  const tabTitlesFromLayouts = extractTabTitlesFromLayouts(input.visualLayouts);
  const getTabTitle = (tabId: string): string | undefined => {
    if (input.tabTitles) {
      const explicit =
        input.tabTitles instanceof Map
          ? input.tabTitles.get(tabId)
          : (input.tabTitles as Record<string, string>)[tabId];
      if (explicit) return explicit;
    }
    return tabTitlesFromLayouts.get(tabId);
  };

  // Keep only agent-bearing terminals as sessions. Grouped/sorted below for deck placement.
  // Validation: session is recognized if reported by worktree ps (hasWt) or active agent process detected (t.agentIdentity).
  const sessionsRaw = (input.terminals ?? [])
    .map((t) => {
      const pane = `${t.tabId}:${t.leafId}`;
      const hasWt = stateByPane.has(pane);
      const idFromWt = agentByPane.get(pane);
      const hook = getHook(pane);

      const hasAgent = hasWt || Boolean(t.agentIdentity);
      if (!hasAgent) {
        return null;
      }

      // Priority: worktree ps registered agent > hook original agent > terminal process estimate
      const agent = idFromWt || hook?.agentType || t.agentIdentity || "";
      const hookEvent = hook?.hookEventName;
      const tabTitle = getTabTitle(t.tabId) || t.title || undefined;

      let state: AgentState;
      let status = statusByPane.get(pane) || hook?.status;
      let workingMode = workingModeByPane.get(pane) || hook?.workingMode;
      let interrupted = interruptedByPane.get(pane) ?? hook?.interrupted;

      if (hasWt) {
        state = stateByPane.get(pane) || "idle";
        // Does not overwrite unverifiable (stale), interrupted, or done states with old hook remnants
        if (state !== "unverifiable" && state !== "done" && state !== "interrupted") {
          if (hook?.interrupted) {
            state = "interrupted";
            interrupted = true;
          } else if (hookEvent === "PreToolUse" || hookEvent === "Notification") {
            // PreToolUse fires on *every* tool call — including auto-approved ones that never
            // ask the user anything (Claude runs Bash/MCP freely once permissions allow it).
            // So escalate to waiting (amber) only when:
            //  1. Orca stamped the hook record and reports the agent paused on the user
            //     (state waiting/blocked), or
            //  2. the hook record carries no state AND the event genuinely requests attention,
            //     or the agent's hooks fire before every approval pause (agy/antigravity).
            // A stamped "working" record is never downgraded to waiting.
            const hookSaysWaiting = hook.state === "waiting" || hook.state === "blocked";
            const pauseOnTool = agent === "agy" || agent === "antigravity";
            if (hookSaysWaiting || (!hook.state && (hookEvent === "Notification" || pauseOnTool))) {
              state = "waiting";
            }
          } else if (hookEvent === "PostToolUse" || hookEvent === "UserPrompt") {
            state = "working";
          }
        }
      } else {
        // Detected via terminal agentIdentity before worktree ps reports
        if (hook?.interrupted) {
          state = "interrupted";
          interrupted = true;
        } else if (hook?.state) {
          let st = hook.state;
          if (
            st !== "done" &&
            st !== "idle" &&
            st !== "interrupted" &&
            (st === "working" || st === "waiting" || st === "blocked") &&
            hook.receivedAt &&
            now - hook.receivedAt > AGENT_STATUS_STALE_AFTER_MS
          ) {
            st = "unverifiable";
          }
          state = st;
        } else if (hookEvent === "PreToolUse" || hookEvent === "Notification") {
          state = "waiting";
        } else if (hookEvent === "Stop" || hookEvent === "SessionEnd") {
          state = "done";
        } else if (hookEvent === "SessionStart" || hookEvent === "UserPrompt" || hookEvent === "PostToolUse") {
          state = "working";
        } else {
          state = "idle";
        }
      }

      const meta = t.worktreeId ? metaByWt.get(t.worktreeId) : undefined;
      const unread = meta?.unread;
      const agentTime = sessionRecency(timeByPane.get(pane), hook?.receivedAt);
      // For completed & reviewed sessions, do not let terminal cursor/timer ticks fake fresh activity
      const recency = (state === "done" && !unread)
        ? (agentTime || t.lastOutputAt || 0)
        : sessionRecency(t.lastOutputAt, agentTime);

      return {
        t,
        pane,
        hasWt,
        agent,
        state,
        status,
        workingMode,
        interrupted,
        agentType: agent,
        tabTitle,
        unread,
        // Prefer the terminal's execution host; fall back to the worktree's host.
        hostId: t.executionHostId || meta?.hostId,
        environment: t.environment,
        environmentId: t.environmentId,
        recency,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Sort sessions: alerts/questions first -> active working -> inactive -> reviewed done; most recent activity first inside each tier.
  const sessions = sortSessions(
    sessionsRaw,
    (s) => s.state,
    (s) => s.recency,
    (s) => s.t.handle,
    { bucketMs: opts.activityBucketMs, unreadOf: (s) => s.unread },
  );

  // Repository metadata index by repoId, path, and displayName
  const repoById = new Map<string, OrcaRepo>();
  const repoByPath = new Map<string, OrcaRepo>();
  const repoByName = new Map<string, OrcaRepo>();
  for (const r of input.repos ?? []) {
    if (r.id) repoById.set(r.id, r);
    if (r.path) repoByPath.set(r.path, r);
    if (r.displayName) repoByName.set(r.displayName.toLowerCase(), r);
  }

  // Assign project name, branch, and dupIndex across entire (sorted) session list -> stable across pages
  const dupCount = new Map<string, number>();
  const enriched = sessions.map((item) => {
    const meta = item.t.worktreeId ? metaByWt.get(item.t.worktreeId) : undefined;
    const project = projectOf(item.t.worktreePath, meta?.repo);
    const branch = meta?.branch;
    const key = `${project ?? ""}|${branch ?? ""}`;
    const dupIndex = dupCount.get(key) ?? 0;
    dupCount.set(key, dupIndex + 1);
    return { item, project, branch, dupIndex, unread: meta?.unread };
  });

  const total = enriched.length;
  const pagingIndex = opts.pagingSlotIndex;
  const hasPagingKey = pagingIndex !== undefined && pagingIndex >= 0 && pagingIndex < perPage;
  const needsPaging = hasPagingKey && total > perPage;

  const sessionCapacityPerPage = Math.max(1, needsPaging ? perPage - 1 : perPage);
  const pageCount = Math.max(1, Math.ceil(total / sessionCapacityPerPage));
  const page = Math.min(Math.max(0, opts.page ?? 0), pageCount - 1);
  const start = page * sessionCapacityPerPage;
  let pageItems = enriched.slice(start, start + sessionCapacityPerPage);

  // If pinned slot positions are provided (e.g. during interaction hold), stabilize pageItems
  // so every session already on the board keeps its exact slot index.
  if (opts.pinnedSlots) {
    const pinned = opts.pinnedSlots;
    const stabilized: typeof pageItems = [];
    const usedItems = new Set<any>();

    // 1. Place items with assigned pinned slot indices
    for (let i = 0; i < sessionCapacityPerPage; i++) {
      const found = enriched.find((e) => pinned.get(e.item.t.handle) === i);
      if (found) {
        stabilized[i] = found;
        usedItems.add(found);
      }
    }

    // 2. Fill remaining unpinned positions with remaining items in recency order
    const remaining = enriched.filter((e) => !usedItems.has(e));
    let remIdx = 0;
    for (let i = 0; i < sessionCapacityPerPage; i++) {
      if (!stabilized[i] && remIdx < remaining.length) {
        stabilized[i] = remaining[remIdx++];
      }
    }
    pageItems = stabilized.filter(Boolean);
  }

  // Calculate representative state of sessions on other pages (error > waiting > unread done > working > read done > idle)
  let hasAlertOnOtherPage = false;
  let otherInfo: { otherState?: AgentState; otherStatus?: string; otherColor?: Color; otherUnread?: boolean } = {};
  if (needsPaging) {
    const otherItems = [...enriched.slice(0, start), ...enriched.slice(start + sessionCapacityPerPage)];
    otherInfo = representativeOtherState(otherItems);
    hasAlertOnOtherPage = Boolean(
      otherInfo.otherColor === "red" ||
      otherInfo.otherColor === "violet" ||
      otherInfo.otherColor === "amber" ||
      (otherInfo.otherColor === "green" && otherInfo.otherUnread),
    );
  }

  const slots: Button[] = [];
  let itemIdx = 0;
  for (let i = 0; i < perPage; i++) {
    if (needsPaging && i === pagingIndex) {
      slots.push({
        empty: false,
        isPageButton: true,
        page,
        pageCount,
        hasAlertOnOtherPage,
        otherState: otherInfo.otherState,
        otherStatus: otherInfo.otherStatus,
        otherColor: otherInfo.otherColor,
        otherUnread: otherInfo.otherUnread,
      });
      continue;
    }

    const e = pageItems[itemIdx++];
    if (!e) {
      slots.push(EMPTY);
      continue;
    }
    const repoId = e.item.t.worktreeId ? e.item.t.worktreeId.split("::")[0] : undefined;
    // Repo metadata (icon/badge color) is local-only: a remote runtime's repo ids and paths aren't in
    // this machine's `orca repo list`, and the name fallback would attach a same-named local repo's icon.
    const repo = e.item.t.environment
      ? undefined
      : (repoId ? repoById.get(repoId) : undefined) ||
        (e.item.t.worktreePath ? repoByPath.get(e.item.t.worktreePath) : undefined) ||
        (e.project ? repoByName.get(e.project.toLowerCase()) : undefined);

    const iconInfo = repo ? resolveRepoBgIcon(repo) : undefined;
    // Per-agent display normalization (e.g. opencode strips Orca's "OC | " prefix) — deck stays agent-agnostic.
    const shownTitle = agentFor(e.item.agentType).cleanTitle(e.item.tabTitle || e.item.t.title || "");

    slots.push({
      empty: false,
      isPageButton: false,
      handle: e.item.t.handle,
      tabId: e.item.t.tabId,
      leafId: e.item.t.leafId,
      label: shownTitle,
      tabTitle: shownTitle || undefined,
      state: e.item.state,
      status: e.item.status,
      workingMode: e.item.workingMode,
      interrupted: e.item.interrupted,
      color: colorFor(e.item.state),
      worktreePath: e.item.t.worktreePath,
      worktreeId: e.item.t.worktreeId,
      preview: e.item.t.preview,
      lastOutputAt: e.item.t.lastOutputAt,
      repo: e.project,
      branch: e.branch,
      dupIndex: e.dupIndex,
      unread: e.unread,
      agentType: e.item.agentType,
      // A remote runtime reports its own worktrees as hostId `local`, so the environment name is the
      // only truthful machine label there. Local sessions resolve through `orca host list`.
      host: e.item.environment || hostLabel(e.item.hostId, input.hosts),
      hostId: e.item.hostId,
      environment: e.item.environment,
      environmentId: e.item.environmentId,
      badgeColor: repo?.badgeColor,
      repoIcon: repo?.repoIcon,
      bgIconUri: iconInfo?.uri,
      bgIconLucide: iconInfo?.lucide,
      bgIconEmoji: iconInfo?.emoji,
    });
  }

  return { slots, page, pageCount, total };
}

/** Extract (tabId -> title) map of all tabs from visualLayouts tree */
export function extractTabTitlesFromLayouts(visualLayouts?: any[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!visualLayouts) return map;

  function walk(node: any) {
    if (!node) return;
    if (Array.isArray(node.tabs)) {
      for (const t of node.tabs) {
        if (t.tabId && t.title) map.set(t.tabId, t.title);
        if (t.panes) walk(t.panes);
      }
    }
    if (node.first) walk(node.first);
    if (node.second) walk(node.second);
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }

  for (const vl of visualLayouts) {
    if (vl?.root) walk(vl.root);
  }
  return map;
}

/** Recursively find all active tab/terminal info (tabId, leafId, handle) from visualLayouts pane/tab tree */
export function findAllActivePanesInLayout(node: any): Array<{ tabId?: string; leafId?: string; handle?: string }> {
  if (!node) return [];
  if (node.type === "terminal" && node.active) {
    return [{ tabId: node.tabId, leafId: node.leafId, handle: node.handle }];
  }
  if (node.type === "group" && Array.isArray(node.tabs)) {
    const activeTab = node.tabs.find((t: any) => t.tabId === node.activeTabId) || node.tabs[0];
    if (activeTab) {
      if (activeTab.panes) {
        const sub = findAllActivePanesInLayout(activeTab.panes);
        if (sub.length > 0) {
          return sub.map((s) => ({ tabId: activeTab.tabId, leafId: activeTab.activeLeafId, ...s }));
        }
      }
      return [{ tabId: activeTab.tabId, leafId: activeTab.activeLeafId }];
    }
    return [];
  }
  const results: Array<{ tabId?: string; leafId?: string; handle?: string }> = [];
  if (node.first) {
    results.push(...findAllActivePanesInLayout(node.first));
  }
  if (node.second) {
    results.push(...findAllActivePanesInLayout(node.second));
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      results.push(...findAllActivePanesInLayout(child));
    }
  }
  return results;
}

/** Find first active terminal info in visualLayouts pane/tab tree (backwards compatibility) */
export function findActivePaneInLayout(node: any): { tabId?: string; leafId?: string; handle?: string } | undefined {
  const all = findAllActivePanesInLayout(node);
  return all[0];
}

/**
 * Resolve the terminal handle that the user is currently viewing/focused on,
 * merging Orca worktrees, terminals, and visualLayouts.
 * - Extracts active tabs/terminals from visualLayouts (including split layouts).
 * - If current target is one of the active tabs in the layout, preserves it (avoids bouncing).
 * - Even without visualLayouts, if current target belongs to active worktree, preserves it.
 */
export function resolveActiveTerminal(
  worktrees: OrcaWorktree[],
  terminals: OrcaTerminal[],
  visualLayouts?: any[],
  currentTargetHandle?: string,
): string | undefined {
  const activeWt = (worktrees ?? []).find((w: any) => (w as any).isActive);
  const activeWtId = activeWt?.worktreeId;
  if (!activeWtId) return undefined;

  // 1. If visualLayouts exist, find all active panes in that worktree
  if (visualLayouts && visualLayouts.length > 0) {
    const vl = visualLayouts.find((v: any) => v.worktreeId === activeWtId);
    if (vl?.root) {
      const activePanes = findAllActivePanesInLayout(vl.root);
      const activeHandles: string[] = [];
      for (const p of activePanes) {
        if (p.handle) {
          activeHandles.push(p.handle);
        } else if (p.tabId) {
          const termsInTab = terminals.filter((t) => t.worktreeId === activeWtId && t.tabId === p.tabId);
          if (p.leafId) {
            const matchLeaf = termsInTab.find((t) => t.leafId === p.leafId);
            if (matchLeaf) activeHandles.push(matchLeaf.handle);
          } else if (termsInTab.length > 0) {
            const agentTerm = termsInTab.find((t) => Boolean(t.agentIdentity));
            activeHandles.push(agentTerm ? agentTerm.handle : termsInTab[0].handle);
          }
        }
      }
      // If currently selected target is one of the active tabs, preserve it
      if (currentTargetHandle && activeHandles.includes(currentTargetHandle)) {
        return currentTargetHandle;
      }
      if (activeHandles.length > 0) {
        return activeHandles[0];
      }
    }
  }

  // 2. If visualLayouts unavailable or indeterminate:
  // If current target belongs to active worktree, preserve it
  const termsInWt = terminals.filter((t) => t.worktreeId === activeWtId);
  if (currentTargetHandle && termsInWt.some((t) => t.handle === currentTargetHandle)) {
    return currentTargetHandle;
  }

  // 3. Fallback to latest output terminal or first terminal in worktree (preferring agent terminals)
  const agentTerms = termsInWt.filter((t) => Boolean(t.agentIdentity));
  const candidateTerms = agentTerms.length > 0 ? agentTerms : termsInWt;
  const sorted = candidateTerms.slice().sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0));
  return sorted[0]?.handle;
}

