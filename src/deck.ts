// AgentDeck core: Pure function converting Orca's two sources (terminal list + worktree ps)
// into a Stream Deck Plus 8-slot button model.
// This layer is fully testable without physical hardware.

import { agentFor } from "./agents.ts";
import { resolveRepoBgIcon, type ResolvedBgIcon } from "./icons.ts";

export type AgentState = "working" | "waiting" | "done" | "error" | "unverifiable" | "idle" | string | undefined;
export type Color = "blue" | "amber" | "green" | "red" | "white";

/** Inactivity decay duration matching Orca (30 minutes) */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000;

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
}

/** Fields used from `orca worktree ps --json` -> `result.worktrees[]` */
export interface OrcaWorktree {
  worktreeId?: string;
  repo?: string;
  branch?: string;
  displayName?: string;
  unread?: boolean; // true if user hasn't viewed latest output yet (automatically set to false when viewed in Orca)
  agents?: Array<{
    paneKey: string;
    state?: AgentState;
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

export interface HookInfo {
  hookEventName?: string;
  agentType?: string;
  state?: string;
  receivedAt?: number;
}

export interface DeckInput {
  terminals: OrcaTerminal[];
  worktrees: OrcaWorktree[];
  repos?: OrcaRepo[];
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
}

export type Button =
  | { empty: true }
  | {
      empty: false;
      handle: string;
      label: string;
      tabTitle?: string; // Orca tab title (for 2-line summary rendering)
      state: AgentState;
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
  working: "blue",
  waiting: "amber",
  blocked: "amber",
  unverifiable: "amber",
  done: "green",
  error: "red",
  idle: "white",
};

/**
 * Extract human-readable project name from path.
 * If `/Projects/<X>/...`, returns X (e.g. AcmeApp/ko -> "AcmeApp"),
 * otherwise the last folder name (e.g. .../Notes -> "Notes"), or fallback to orca repo.
 */
export function projectOf(path?: string, repo?: string): string | undefined {
  if (path) {
    const segs = path.split("/").filter(Boolean);
    const i = segs.indexOf("Projects");
    if (i >= 0 && segs[i + 1]) return segs[i + 1];
    if (segs.length) return segs[segs.length - 1];
  }
  return repo;
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

/**
 * Deck ordering: group sessions by project so a project's agents sit next to each other,
 * order the groups by most recent activity (freshest bucket first), then most recent session first
 * inside a group; the handle is the deterministic tiebreak so positions stay steady while activity
 * is comparable (muscle memory for slots that never move). Activity is compared in coarse buckets
 * (see `activityBucket`) so several concurrently working projects do not re-sort the deck constantly.
 * Unknown projects (empty key) group together and sort last when they have no timestamps.
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
 * Targets: waiting (amber), unread done (green), error (red). Working (blue), idle (white), stale (unverifiable) stay quiet.
 * Even if currently focused (target), waiting (amber) and error (red) maintain pulse since they require action.
 * Unread done (green) on the active target does not pulse because the user is already viewing it.
 */
export function needsAttention(b: Button, isTarget: boolean): boolean {
  if (b.empty) return false;
  if (isTarget && b.color === "green") return false;
  if (b.state === "done" && b.unread === false) return false;
  if (b.state === "unverifiable") return false;
  return b.color === "amber" || b.color === "green" || b.color === "red";
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
  const page = opts.page ?? 0;
  const perPage = opts.perPage ?? 8;
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
  const agentByPane = new Map<string, string>();
  const timeByPane = new Map<string, number>(); // latest agent evidence timestamp per pane (for ordering)
  const metaByWt = new Map<string, { repo?: string; branch?: string; unread?: boolean }>();
  for (const wt of input.worktrees ?? []) {
    for (const a of wt.agents ?? []) {
      let st = a.state;
      const observedAt = a.evidenceObservedAt ?? a.updatedAt ?? a.stateStartedAt;
      if (
        st &&
        st !== "done" &&
        st !== "idle" &&
        (st === "working" || st === "waiting" || st === "blocked") &&
        observedAt &&
        now - observedAt > AGENT_STATUS_STALE_AFTER_MS
      ) {
        st = "unverifiable";
      }
      stateByPane.set(a.paneKey, st);
      // If multiple agents on same paneKey, keep first as fallback (normally 0-1)
      if (!agentByPane.has(a.paneKey)) agentByPane.set(a.paneKey, a.agentType ?? "");
      timeByPane.set(a.paneKey, sessionRecency(timeByPane.get(a.paneKey), observedAt));
    }
    if (wt.worktreeId) {
      const branch = wt.displayName || (wt.branch ?? "").replace(/^refs\/heads\//, "");
      metaByWt.set(wt.worktreeId, { repo: wt.repo, branch: branch || undefined, unread: wt.unread });
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
      if (hasWt) {
        state = stateByPane.get(pane) || "idle";
        // Does not overwrite unverifiable (stale) or done states with old hook remnants
        if (state !== "unverifiable" && state !== "done") {
          if (hookEvent === "PreToolUse" || hookEvent === "Notification") {
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
        if (hook?.state) {
          let st = hook.state;
          if (
            st !== "done" &&
            st !== "idle" &&
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

      return {
        t,
        pane,
        hasWt,
        agent,
        state,
        agentType: agent,
        tabTitle,
        recency: sessionRecency(t.lastOutputAt, timeByPane.get(pane), hook?.receivedAt),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Group by project; groups sorted by most recent activity bucket, most recent session first inside a group.
  const sessions = sortSessionsByProject(
    sessionsRaw,
    (s) => projectOf(s.t.worktreePath, s.t.worktreeId ? metaByWt.get(s.t.worktreeId)?.repo : undefined),
    (s) => s.recency,
    (s) => s.t.handle,
    { bucketMs: opts.activityBucketMs },
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
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const start = page * perPage;
  const pageItems = enriched.slice(start, start + perPage);

  const slots: Button[] = [];
  for (let i = 0; i < perPage; i++) {
    const e = pageItems[i];
    if (!e) {
      slots.push(EMPTY);
      continue;
    }
    const repoId = e.item.t.worktreeId ? e.item.t.worktreeId.split("::")[0] : undefined;
    const repo =
      (repoId ? repoById.get(repoId) : undefined) ||
      (e.item.t.worktreePath ? repoByPath.get(e.item.t.worktreePath) : undefined) ||
      (e.project ? repoByName.get(e.project.toLowerCase()) : undefined);

    const iconInfo = repo ? resolveRepoBgIcon(repo) : undefined;
    // Per-agent display normalization (e.g. opencode strips Orca's "OC | " prefix) — deck stays agent-agnostic.
    const shownTitle = agentFor(e.item.agentType).cleanTitle(e.item.tabTitle || e.item.t.title || "");

    slots.push({
      empty: false,
      handle: e.item.t.handle,
      label: shownTitle,
      tabTitle: shownTitle || undefined,
      state: e.item.state,
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
            activeHandles.push(termsInTab[0].handle);
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

  // 3. Fallback to latest output terminal or first terminal in worktree
  const sorted = termsInWt.slice().sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0));
  return sorted[0]?.handle;
}

