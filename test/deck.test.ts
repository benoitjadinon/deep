import { describe, it, expect } from "vitest";
import {
  buildDeck,
  activityBucket,
  colorFor,
  projectOf,
  needsAttention,
  findActivePaneInLayout,
  resolveActiveTerminal,
  nextWorktreeName,
  extractTabTitlesFromLayouts,
  statePriority,
  sortSessions,
  sortSessionsByProject,
  representativeOtherState,
  stabilizeTerminalAgents,
  hostLabel,
  environmentArgs,
} from "../src/deck.js";

describe("needsAttention — session attention check for animation triggers", () => {
  const b = (color: any, unread?: boolean) => ({ empty: false as const, handle: "t", label: "x", state: "s" as any, color, unread });
  it("waiting (amber), unread done (green), and error (red) require attention for non-target sessions", () => {
    expect(needsAttention(b("amber"), false)).toBe(true);
    expect(needsAttention(b("green", true), false)).toBe(true);
    expect(needsAttention(b("red"), false)).toBe(true);
  });
  it("working (blue), idle (white), and empty slots do not require attention", () => {
    expect(needsAttention(b("blue"), false)).toBe(false);
    expect(needsAttention(b("white"), false)).toBe(false);
    expect(needsAttention({ empty: true }, false)).toBe(false);
  });
  it("target session stops pulsing for all states when focused (isTarget true)", () => {
    expect(needsAttention(b("amber"), true)).toBe(false);
    expect(needsAttention(b("red"), true)).toBe(false);
    expect(needsAttention(b("green", true), true)).toBe(false);
    expect(needsAttention(b("blue"), true)).toBe(false);
    expect(needsAttention(b("white"), true)).toBe(false);
  });
  it("page button requires attention when other pages have amber/red/unread-done states", () => {
    // Alert on other page (amber/red/unread-done) -> requires attention (blinks)
    expect(needsAttention({ empty: false, isPageButton: true, page: 0, pageCount: 2, otherColor: "amber", otherState: "waiting" } as any, false)).toBe(true);
    expect(needsAttention({ empty: false, isPageButton: true, page: 0, pageCount: 2, otherColor: "red", otherState: "error" } as any, false)).toBe(true);
    expect(needsAttention({ empty: false, isPageButton: true, page: 0, pageCount: 2, otherColor: "green", otherState: "done", otherUnread: true } as any, false)).toBe(true);

    // Calm/quiet states on other page -> does not require attention
    expect(needsAttention({ empty: false, isPageButton: true, page: 0, pageCount: 2, otherColor: "blue", otherState: "working" } as any, false)).toBe(false);
    expect(needsAttention({ empty: false, isPageButton: true, page: 0, pageCount: 2, otherColor: "white", otherState: "idle" } as any, false)).toBe(false);
    expect(needsAttention({ empty: false, isPageButton: true, page: 0, pageCount: 2, otherColor: "green", otherState: "done", otherUnread: false } as any, false)).toBe(false);
    expect(needsAttention({ empty: false, isPageButton: true, page: 0, pageCount: 2 } as any, false)).toBe(false);
  });
});

// orca terminal list --json -> result.terminals[]
// lastOutputAt drives deck ordering (project groups + sessions by most recent activity)
const terminals = [
  { handle: "term_A", tabId: "tab1", leafId: "leaf1", title: "unparkxing post", worktreePath: "/x/unparkxing", lastOutputAt: 1_790_000_000_000 },
  { handle: "term_B", tabId: "tab2", leafId: "leaf2", title: "policy terms work", worktreePath: "/x/policy", lastOutputAt: 1_789_999_000_000 },
  // Shell terminal without agent — should be excluded
  { handle: "term_shell", tabId: "tab3", leafId: "leaf3", title: "Terminal 1", worktreePath: "" },
];

// orca worktree ps --json -> result.worktrees[].agents[] (paneKey = `${tabId}:${leafId}`)
const worktrees = [
  { agents: [{ paneKey: "tab1:leaf1", state: "working", agentType: "claude" }] },
  { agents: [{ paneKey: "tab2:leaf2", state: "waiting", agentType: "opencode" }] },
];

describe("buildDeck — agent type threading + gating meta + tab title", () => {
  it("slots contain matched agentType by paneKey (ordered by recency)", () => {
    const slots = buildDeck({ terminals, worktrees }).slots as any[];
    // term_A is more recent (1_790_000_000_000 vs 1_789_999_000_000) -> slot 0 (claude); term_B -> slot 1 (opencode)
    expect(slots[0].agentType).toBe("claude");
    expect(slots[1].agentType).toBe("opencode");
  });

  it("extracts tabTitle from visualLayouts and fills slot", () => {
    const visualLayouts = [
      {
        worktreeId: "wt1",
        root: {
          type: "group",
          tabs: [
            { tabId: "tab1", title: "Design Feedback URL Browser" },
            { tabId: "tab2", title: "Fix Auth Flow Bug" },
          ],
        },
      },
    ];
    const titles = extractTabTitlesFromLayouts(visualLayouts);
    expect(titles.get("tab1")).toBe("Design Feedback URL Browser");
    expect(titles.get("tab2")).toBe("Fix Auth Flow Bug");

    const slots = buildDeck({ terminals, worktrees, visualLayouts }).slots as any[];
    // term_A (more recent) in slot 0, term_B in slot 1
    expect(slots[0].tabTitle).toBe("Design Feedback URL Browser");
    expect(slots[1].tabTitle).toBe("Fix Auth Flow Bug");
  });

  it("strips the Orca 'OC | ' prefix from opencode titles on the deck", () => {
    const ts = [
      { handle: "term_oc", tabId: "t1", leafId: "l1", title: "OC | Fix Auth Flow Bug", worktreePath: "/x/oc", worktreeId: "wt1", agentIdentity: "opencode" },
      { handle: "term_ca", tabId: "t2", leafId: "l2", title: "OC | Candy crush clone PWA", worktreePath: "/x/cl", worktreeId: "wt2", agentIdentity: "claude" },
    ];
    const wts = [
      { worktreeId: "wt1", repo: "oc", agents: [{ paneKey: "t1:l1", state: "working", agentType: "opencode" }] },
      { worktreeId: "wt2", repo: "cl", agents: [{ paneKey: "t2:l2", state: "working", agentType: "claude" }] },
    ];
    const slots = buildDeck({ terminals: ts, worktrees: wts }).slots as any[];
    const oc = slots.find((s: any) => s.agentType === "opencode");
    const cl = slots.find((s: any) => s.agentType === "claude");
    expect(oc.label).toBe("Fix Auth Flow Bug");
    expect(oc.tabTitle).toBe("Fix Auth Flow Bug");
    expect(cl.label).toBe("OC | Candy crush clone PWA"); // only opencode titles are stripped
  });
});

describe("colorFor — state to color mapping", () => {
  it("maps observed states to colors", () => {
    expect(colorFor("working")).toBe("orange");
    expect(colorFor("waiting")).toBe("violet");
    expect(colorFor("done")).toBe("green");
  });
  it("maps error to red and blocked to violet", () => {
    expect(colorFor("error")).toBe("red");
    expect(colorFor("blocked")).toBe("violet");
  });
  it("unknown/empty state defaults to white", () => {
    expect(colorFor("weird")).toBe("white");
    expect(colorFor(undefined)).toBe("white");
  });
});

describe("projectOf — extract project name from path", () => {
  it("repo (project) wins over the worktree folder name", () => {
    expect(projectOf("/Users/j/Workspaces/Tools/AltReady/screenshot", "AltReady")).toBe("AltReady");
    expect(projectOf("/Users/j/Projects/AcmeApp/ko", "AcmeApp")).toBe("AcmeApp");
    expect(projectOf("/Users/j/Projects/sandbox", "sandbox")).toBe("sandbox");
    expect(projectOf("/Users/j/Library/x/Notes", "Notes")).toBe("Notes");
  });
  it("falls back to path parsing for repo-less folder workspaces", () => {
    // nested under /Projects -> parent project name
    expect(projectOf("/Users/j/Projects/AcmeApp/ko", undefined)).toBe("AcmeApp");
    // otherwise last folder name
    expect(projectOf("/Users/j/Desktop/scratch-workspace", undefined)).toBe("scratch-workspace");
  });
  it("falls back to repo when path is missing", () => {
    expect(projectOf(undefined, "svd")).toBe("svd");
  });
});

describe("duplicate project index (dupIndex)", () => {
  it("assigns 0, 1, 2... for matching project and branch", () => {
    const terms = [
      { handle: "term_A", tabId: "t1", leafId: "l1", title: "Domestic", worktreePath: "/x/Projects/AcmeApp/ko", worktreeId: "wt1", lastOutputAt: 3 },
      { handle: "term_B", tabId: "t2", leafId: "l2", title: "US", worktreePath: "/x/Projects/AcmeApp/us", worktreeId: "wt2", lastOutputAt: 2 },
    ];
    const wts = [
      { worktreeId: "wt1", repo: "AcmeApp", displayName: "main", agents: [{ paneKey: "t1:l1", state: "working" }] },
      { worktreeId: "wt2", repo: "AcmeApp", displayName: "main", agents: [{ paneKey: "t2:l2", state: "done" }] },
    ];
    const slots = buildDeck({ terminals: terms, worktrees: wts }).slots as any[];
    expect(slots[0]).toMatchObject({ repo: "AcmeApp", branch: "main", dupIndex: 0 });
    expect(slots[1]).toMatchObject({ repo: "AcmeApp", branch: "main", dupIndex: 1 });
  });
});

describe("unread & staleness — completion and staleness decay", () => {
  const mk = (state: string, unread: boolean, updatedAt?: number, now?: number) => {
    const terms = [{ handle: "term_A", tabId: "t1", leafId: "l1", title: "x", worktreePath: "/x", worktreeId: "wt1" }];
    const wts = [{ worktreeId: "wt1", repo: "x", displayName: "main", unread, agents: [{ paneKey: "t1:l1", state, updatedAt }] }];
    return buildDeck({ terminals: terms, worktrees: wts }, { now }).slots[0] as any;
  };
  it("done maintains green regardless of read status", () => {
    expect(mk("done", true).color).toBe("green");
    expect(mk("done", false).color).toBe("green");
  });
  it("done + unread needs attention, read does not", () => {
    const unreadSlot = mk("done", true);
    const readSlot = mk("done", false);
    expect(needsAttention(unreadSlot, false)).toBe(true);
    expect(needsAttention(readSlot, false)).toBe(false);
  });
  it("working state past 30m decays to unverifiable (violet)", () => {
    const now = 10000000;
    const fresh = mk("working", false, now - 10 * 60 * 1000, now);
    expect(fresh.state).toBe("working");
    expect(fresh.color).toBe("orange");

    const stale = mk("working", false, now - 35 * 60 * 1000, now);
    expect(stale.state).toBe("unverifiable");
    expect(stale.color).toBe("violet");
    expect(needsAttention(stale, false)).toBe(false);
  });
});

describe("buildDeck — when open agent (agentIdentity) is detected before worktree ps", () => {
  it("shows session using terminal agentIdentity even before worktree ps reports", () => {
    const ts = [
      { handle: "term_fresh", tabId: "t1", leafId: "l1", title: "Terminal 1", worktreePath: "/x/deep", worktreeId: "wt1", agentIdentity: "opencode" },
      { handle: "term_shell", tabId: "t2", leafId: "l2", title: "Terminal 2", worktreePath: "", worktreeId: "wt2", agentIdentity: null },
    ];
    const wts = [{ worktreeId: "wt1", repo: "deep", displayName: "main" }];
    const deck = buildDeck({ terminals: ts, worktrees: wts });
    const handles = deck.slots.filter((s) => !s.empty).map((s: any) => s.handle);
    expect(handles).toEqual(["term_fresh"]);
    expect(deck.slots[0]).toMatchObject({ state: "idle", color: "white", agentType: "opencode" });
  });

  it("prioritizes worktree ps state once reported", () => {
    const ts = [
      { handle: "term_fresh", tabId: "t1", leafId: "l1", title: "T", worktreePath: "/x/deep", worktreeId: "wt1", agentIdentity: "opencode" },
    ];
    const wts = [{ worktreeId: "wt1", repo: "deep", agents: [{ paneKey: "t1:l1", state: "working", agentType: "opencode" }] }];
    const a = buildDeck({ terminals: ts, worktrees: wts }).slots[0] as any;
    expect(a.state).toBe("working");
    expect(a.color).toBe("orange");
    expect(a.agentType).toBe("opencode");
  });

  it("handles worktree ps agent without agentIdentity as before", () => {
    const ts = [{ handle: "term_old", tabId: "t1", leafId: "l1", title: "T", worktreePath: "/x", worktreeId: "wt1" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "done", agentType: "claude" }] }];
    const a = buildDeck({ terminals: ts, worktrees: wts }).slots[0] as any;
    expect(a).toMatchObject({ state: "done", agentType: "claude" });
  });

  it("transitions agy/antigravity working state to waiting (violet) on PreToolUse hook event", () => {
    const ts = [{ handle: "term_agy", tabId: "t1", leafId: "l1", title: "Agy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "agy" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "antigravity" }] }];
    const hookEvents = new Map([["t1:l1", "PreToolUse"]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("waiting");
    expect(a.color).toBe("violet");
  });

  it("keeps working (orange) on PreToolUse when the hook record itself reports the agent working (auto-approved tool run)", () => {
    const ts = [{ handle: "term_claude", tabId: "t1", leafId: "l1", title: "Candy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "claude" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "claude" }] }];
    // Orca stamps the agent state on the hook entry: auto-approved PreToolUse = "working".
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreToolUse", state: "working" }]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("working");
    expect(a.color).toBe("orange");
  });

  it("transitions to waiting (violet) on PreToolUse when the hook record reports the agent paused on the user", () => {
    const ts = [{ handle: "term_claude", tabId: "t1", leafId: "l1", title: "Candy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "claude" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "claude" }] }];
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreToolUse", state: "waiting" }]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("waiting");
    expect(a.color).toBe("violet");
  });

  it("keeps worktree-ps waiting (violet) even when a stale hook record says working", () => {
    const ts = [{ handle: "term_claude", tabId: "t1", leafId: "l1", title: "Candy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "claude" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "waiting", agentType: "claude" }] }];
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreToolUse", state: "working" }]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("waiting");
    expect(a.color).toBe("violet");
  });

  it("maintains working (orange) on PostToolUse hook event", () => {
    const ts = [{ handle: "term_agy", tabId: "t1", leafId: "l1", title: "Agy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "agy" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "antigravity" }] }];
    const hookEvents = new Map([["t1:l1", "PostToolUse"]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("working");
    expect(a.color).toBe("orange");
  });

  it("prioritizes hookEventsByPane agentType over misinferred terminal.agentIdentity", () => {
    const ts = [{ handle: "term_agy", tabId: "t1", leafId: "l1", title: "Agy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "claude" }];
    const wts = [{ worktreeId: "wt1", repo: "x" }];
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreInvocation", agentType: "antigravity" }]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.agentType).toBe("antigravity");
  });

  it("excludes exited agent shell terminal even if stale hook leftovers exist", () => {
    const ts = [{ handle: "term_closed", tabId: "t1", leafId: "l1", title: "Shell", worktreePath: "/x", worktreeId: "wt1", agentIdentity: null }];
    const wts = [{ worktreeId: "wt1", repo: "x" }];
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreInvocation", agentType: "hermes" }]]);
    const deck = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents });
    expect(deck.slots[0]).toEqual({ empty: true });
    expect(deck.total).toBe(0);
  });

  it("shows session with agentIdentity when hermes CLI runs", () => {
    const ts = [{ handle: "term_hermes", tabId: "t1", leafId: "l1", title: "Hermes", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "hermes" }];
    const wts = [{ worktreeId: "wt1", repo: "x" }];
    const deck = buildDeck({ terminals: ts, worktrees: wts });
    expect(deck.slots[0]).toMatchObject({
      empty: false,
      handle: "term_hermes",
      agentType: "hermes",
    });
  });
});

describe("buildDeck — merges orca sources into 8-slot button model", () => {
  it("always fixes to 8 slots, populating first 2 and leaving remainder empty", () => {
    const deck = buildDeck({ terminals, worktrees });
    expect(deck.slots).toHaveLength(8);
    expect(deck.slots.slice(2).every((s) => s.empty)).toBe(true);
    expect(deck.total).toBe(2);
  });

  it("merges handle (terminal) and state (worktree) via paneKey (ordered by recency)", () => {
    const deck = buildDeck({ terminals, worktrees });
    const a = deck.slots[0];
    expect(a.empty).toBe(false);
    expect(a).toMatchObject({ handle: "term_A", state: "working", color: "orange", label: "unparkxing post" });
    const b = deck.slots[1];
    expect(b).toMatchObject({ handle: "term_B", state: "waiting", color: "violet", label: "policy terms work" });
  });

  it("attaches repo and branch via worktreeId", () => {
    const terms = [
      { handle: "term_A", tabId: "t1", leafId: "l1", title: "Task", worktreePath: "/p/unparkxing", worktreeId: "wt1" },
    ];
    const wts = [
      { worktreeId: "wt1", repo: "unparkxing", branch: "refs/heads/feat/login", displayName: "feat/login", agents: [{ paneKey: "t1:l1", state: "working" }] },
    ];
    const a = buildDeck({ terminals: terms, worktrees: wts }).slots[0] as any;
    expect(a.repo).toBe("unparkxing");
    expect(a.branch).toBe("feat/login");
  });

  it("excludes shell terminals without agents", () => {
    const deck = buildDeck({ terminals, worktrees });
    const handles = deck.slots.filter((s) => !s.empty).map((s) => s.handle);
    expect(handles).not.toContain("term_shell");
  });

  it("empty slots are { empty: true }", () => {
    const deck = buildDeck({ terminals, worktrees });
    expect(deck.slots[7]).toEqual({ empty: true });
  });

  // Ordering compares coarse activity buckets (default 60s) — use minute-scale offsets from an aligned base.
  const T = Math.floor(1_790_000_000_000 / 60_000) * 60_000;
  const MIN = 60_000;

  it("orders sessions by most recent activity inside an equal state tier", () => {
    const ts = [
      { handle: "term_a", tabId: "t1", leafId: "l1", title: "a", worktreePath: "/x", lastOutputAt: T },
      { handle: "term_b", tabId: "t2", leafId: "l2", title: "b", worktreePath: "/x", lastOutputAt: T + 5 * MIN },
      { handle: "term_c", tabId: "t3", leafId: "l3", title: "c", worktreePath: "/x", lastOutputAt: T + MIN },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "done" }] }));
    const deck = buildDeck({ terminals: ts, worktrees: wts });
    expect(deck.slots.slice(0, 3).map((s: any) => s.handle)).toEqual(["term_b", "term_c", "term_a"]);
  });

  it("debounces ordering: activity inside the same bucket keeps handle order", () => {
    // Same state, same minute bucket but different seconds -> order stays by handle, no re-sort churn.
    const ts = [
      { handle: "term_a", tabId: "t1", leafId: "l1", title: "a", worktreePath: "/x", lastOutputAt: T },
      { handle: "term_b", tabId: "t2", leafId: "l2", title: "b", worktreePath: "/x", lastOutputAt: T + 5_000 },
      { handle: "term_c", tabId: "t3", leafId: "l3", title: "c", worktreePath: "/x", lastOutputAt: T + 55_000 },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "done" }] }));
    const handles = buildDeck({ terminals: ts, worktrees: wts }, { now: T + 56_000 })
      .slots.filter((s) => !s.empty)
      .map((s: any) => s.handle);
    expect(handles).toEqual(["term_a", "term_b", "term_c"]);

    // Crossing into a newer bucket promotes the session (still debounced to bucket granularity).
    const promoted = ts.map((t) => (t.handle === "term_c" ? { ...t, lastOutputAt: T + MIN } : t));
    const handles2 = buildDeck({ terminals: promoted, worktrees: wts }, { now: T + MIN + 1_000 })
      .slots.filter((s) => !s.empty)
      .map((s: any) => s.handle);
    expect(handles2).toEqual(["term_c", "term_a", "term_b"]);

    // bucketMs = 1 disables the debounce (raw recency wins) — the tuning knob via AGENTDECK_ORDER_BUCKET_MS.
    const raw = buildDeck({ terminals: ts, worktrees: wts }, { now: T + 56_000, activityBucketMs: 1 })
      .slots.filter((s) => !s.empty)
      .map((s: any) => s.handle);
    expect(raw).toEqual(["term_c", "term_b", "term_a"]);
  });

  it("keeps concurrently working sessions steady within a bucket", () => {
    // Both sessions keep producing output every few seconds: order must not flip per poll.
    const ts = [
      { handle: "term_a1", tabId: "a1", leafId: "l1", title: "a1", worktreePath: "/x/alpha", lastOutputAt: T + 10_000 },
      { handle: "term_b1", tabId: "b1", leafId: "l1", title: "b1", worktreePath: "/x/beta", lastOutputAt: T + 40_000 },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "working" }] }));
    const first = buildDeck({ terminals: ts, worktrees: wts }, { now: T + 41_000 }).slots.filter((s) => !s.empty).map((s: any) => s.handle);
    // beta produced output later but both are in the same bucket -> handle order holds (alpha first).
    expect(first).toEqual(["term_a1", "term_b1"]);
    const again = buildDeck({ terminals: ts, worktrees: wts }, { now: T + 58_000 }).slots.filter((s) => !s.empty).map((s: any) => s.handle);
    expect(again).toEqual(first);
    expect(activityBucket(T + 10_000)).toBe(activityBucket(T + 40_000));
  });

  it("orders sessions by activity recency regardless of state tier", () => {
    // Fixture across multiple projects: AltReady, deep, sleep, notes
    const ts = [
      { handle: "term_done_unread", tabId: "d1", leafId: "l1", title: "deep done unread", worktreePath: "/x/deep", worktreeId: "wt_d1", lastOutputAt: T + 10 * MIN },
      { handle: "term_ask_question", tabId: "a1", leafId: "l1", title: "alt question", worktreePath: "/x/AltReady", worktreeId: "wt_a1", lastOutputAt: T + 2 * MIN },
      { handle: "term_working", tabId: "w1", leafId: "l1", title: "sleep active", worktreePath: "/x/Sleepy", worktreeId: "wt_w1", lastOutputAt: T + 5 * MIN },
      { handle: "term_idle", tabId: "i1", leafId: "l1", title: "notes idle", worktreePath: "/x/Notes", worktreeId: "wt_i1", lastOutputAt: T },
      { handle: "term_error", tabId: "e1", leafId: "l1", title: "alt error", worktreePath: "/x/AltReady", worktreeId: "wt_e1", lastOutputAt: T + 4 * MIN },
      { handle: "term_working_older", tabId: "w2", leafId: "l2", title: "deep active", worktreePath: "/x/deep", worktreeId: "wt_w2", lastOutputAt: T + 1 * MIN },
      { handle: "term_done_reviewed", tabId: "d2", leafId: "l2", title: "deep done reviewed", worktreePath: "/x/deep", worktreeId: "wt_d2", lastOutputAt: T + 3 * MIN },
    ];
    const wts = [
      { worktreeId: "wt_d1", unread: true, agents: [{ paneKey: "d1:l1", state: "done" }] },
      { worktreeId: "wt_a1", unread: false, agents: [{ paneKey: "a1:l1", state: "waiting" }] },
      { worktreeId: "wt_w1", unread: false, agents: [{ paneKey: "w1:l1", state: "working" }] },
      { worktreeId: "wt_i1", unread: false, agents: [{ paneKey: "i1:l1", state: "idle" }] },
      { worktreeId: "wt_e1", unread: false, agents: [{ paneKey: "e1:l1", state: "error" }] },
      { worktreeId: "wt_w2", unread: false, agents: [{ paneKey: "w2:l2", state: "working" }] },
      { worktreeId: "wt_d2", unread: false, agents: [{ paneKey: "d2:l2", state: "done" }] },
    ];
    const slots = buildDeck({ terminals: ts, worktrees: wts }).slots.filter((s) => !s.empty) as any[];
    // Pure recency order:
    // T+10m: term_done_unread
    // T+5m:  term_working
    // T+4m:  term_error
    // T+3m:  term_done_reviewed
    // T+2m:  term_ask_question
    // T+1m:  term_working_older
    // T:     term_idle
    expect(slots.map((s) => s.handle)).toEqual([
      "term_done_unread",
      "term_working",
      "term_error",
      "term_done_reviewed",
      "term_ask_question",
      "term_working_older",
      "term_idle",
    ]);
  });

  it("maintains identical slot position when an unread done session is reviewed (no reshuffle on click)", () => {
    const ts = [
      { handle: "term_w", tabId: "w", leafId: "l", title: "working", worktreePath: "/x/a", worktreeId: "wt_w", lastOutputAt: T + 10 * MIN },
      { handle: "term_d", tabId: "d", leafId: "l", title: "done", worktreePath: "/x/b", worktreeId: "wt_d", lastOutputAt: T + 5 * MIN },
      { handle: "term_i", tabId: "i", leafId: "l", title: "idle", worktreePath: "/x/c", worktreeId: "wt_i", lastOutputAt: T },
    ];
    // Before click: unread = true (blinking green)
    const wtsUnread = [
      { worktreeId: "wt_w", unread: false, agents: [{ paneKey: "w:l", state: "working" }] },
      { worktreeId: "wt_d", unread: true, agents: [{ paneKey: "d:l", state: "done" }] },
      { worktreeId: "wt_i", unread: false, agents: [{ paneKey: "i:l", state: "idle" }] },
    ];
    const deckBefore = buildDeck({ terminals: ts, worktrees: wtsUnread });
    expect(deckBefore.slots.slice(0, 3).map((s: any) => s.handle)).toEqual(["term_w", "term_d", "term_i"]);
    expect(needsAttention(deckBefore.slots[1] as any, false)).toBe(true);

    // After click: unread = false (pulse clears in place without reshuffling)
    const wtsReviewed = [
      { worktreeId: "wt_w", unread: false, agents: [{ paneKey: "w:l", state: "working" }] },
      { worktreeId: "wt_d", unread: false, agents: [{ paneKey: "d:l", state: "done" }] },
      { worktreeId: "wt_i", unread: false, agents: [{ paneKey: "i:l", state: "idle" }] },
    ];
    const deckAfter = buildDeck({ terminals: ts, worktrees: wtsReviewed });
    expect(deckAfter.slots.slice(0, 3).map((s: any) => s.handle)).toEqual(["term_w", "term_d", "term_i"]);
    expect(needsAttention(deckAfter.slots[1] as any, false)).toBe(false);
  });

  it("does not group by project: individual sessions stand on their own state and recency", () => {
    const ts = [
      { handle: "term_a", tabId: "t1", leafId: "l1", title: "a", worktreePath: "/x/alpha", lastOutputAt: T },
      { handle: "term_b", tabId: "t2", leafId: "l2", title: "b", worktreePath: "/x/beta", lastOutputAt: T },
      { handle: "term_c", tabId: "t3", leafId: "l3", title: "c", worktreePath: "/x/beta", lastOutputAt: T + 10 * MIN },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "done" }] }));
    const handles = buildDeck({ terminals: ts, worktrees: wts }).slots.filter((s) => !s.empty).map((s: any) => s.handle);
    // term_c (done, T+10m) first, then term_a (done, T) and term_b (done, T) in handle order (no project clustering lifting term_b)
    expect(handles).toEqual(["term_c", "term_a", "term_b"]);
  });

  it("sortSessionsByProject: legacy helper preserves project grouping", () => {
    const ts = [
      { handle: "term_a", tabId: "t1", leafId: "l1", project: "alpha", recency: T },
      { handle: "term_b", tabId: "t2", leafId: "l2", project: "beta", recency: T },
      { handle: "term_c", tabId: "t3", leafId: "l3", project: "beta", recency: T + 10 * MIN },
    ];
    const sorted = sortSessionsByProject(ts, (s) => s.project, (s) => s.recency, (s) => s.handle);
    expect(sorted.map((s) => s.handle)).toEqual(["term_c", "term_b", "term_a"]);
  });

  it("uses agent evidence timestamps when terminal output time is missing", () => {
    const ts = [
      { handle: "term_a", tabId: "t1", leafId: "l1", title: "a", worktreePath: "/x/alpha" },
      { handle: "term_b", tabId: "t2", leafId: "l2", title: "b", worktreePath: "/x/beta" },
    ];
    const wts = [
      { agents: [{ paneKey: "t1:l1", state: "done", updatedAt: T }] },
      { agents: [{ paneKey: "t2:l2", state: "done", updatedAt: T + 5 * MIN }] },
    ];
    const handles = buildDeck({ terminals: ts, worktrees: wts }).slots.filter((s) => !s.empty).map((s: any) => s.handle);
    expect(handles).toEqual(["term_b", "term_a"]);
  });

  it("pagination: splits pages when session count exceeds capacity", () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      handle: `term_${i}`, tabId: `t${i}`, leafId: `l${i}`, title: `s${i}`, worktreePath: `/p/${i}`,
    }));
    const wts = many.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "done" }] }));
    const deck = buildDeck({ terminals: many, worktrees: wts }, { page: 0, perPage: 2 });
    expect(deck.pageCount).toBe(2);
    expect(deck.page).toBe(0);
    expect(deck.slots).toHaveLength(2);
    expect(deck.slots.filter((s) => !s.empty)).toHaveLength(2);

    const p2 = buildDeck({ terminals: many, worktrees: wts }, { page: 1, perPage: 2 });
    expect(p2.slots.filter((s) => !s.empty)).toHaveLength(1);
  });
});

describe("findActivePaneInLayout & resolveActiveTerminal — active terminal detection and target persistence", () => {
  const terms = [
    { handle: "term_1", tabId: "tab_1", leafId: "leaf_1", title: "T1", worktreeId: "wt_1", lastOutputAt: 9999 },
    { handle: "term_2", tabId: "tab_2", leafId: "leaf_2", title: "T2", worktreeId: "wt_1", lastOutputAt: 1000 },
  ];
  const wts = [
    { worktreeId: "wt_1", isActive: true },
    { worktreeId: "wt_2", isActive: false },
  ];

  it("returns terminal specified by activeTabId in visualLayouts", () => {
    const visualLayouts = [
      {
        worktreeId: "wt_1",
        root: {
          type: "group",
          activeTabId: "tab_2",
          tabs: [
            { tabId: "tab_1", activeLeafId: "leaf_1", panes: { type: "terminal", handle: "term_1", active: true } },
            { tabId: "tab_2", activeLeafId: "leaf_2", panes: { type: "terminal", handle: "term_2", active: true } },
          ],
        },
      },
    ];

    const active = resolveActiveTerminal(wts, terms, visualLayouts, "term_2");
    expect(active).toBe("term_2");
  });

  it("maintains current target in active worktree even without visualLayouts", () => {
    const active = resolveActiveTerminal(wts, terms, undefined, "term_2");
    expect(active).toBe("term_2");
  });

  it("selects latest terminal of active worktree when current target is in different worktree", () => {
    const active = resolveActiveTerminal(wts, terms, undefined, "term_other");
    expect(active).toBe("term_1");
  });

  it("prefers agent-bearing terminal over non-agent terminal in fallback selection", () => {
    const termsWithAgent = [
      { handle: "term_plain", tabId: "tab_1", leafId: "leaf_1", title: "Shell", worktreeId: "wt_1", lastOutputAt: 9999 },
      { handle: "term_agent", tabId: "tab_2", leafId: "leaf_2", title: "Agent", worktreeId: "wt_1", lastOutputAt: 1000, agentIdentity: "antigravity" },
    ];
    const active = resolveActiveTerminal(wts, termsWithAgent, undefined, "term_other");
    expect(active).toBe("term_agent");
  });

  it("returns undefined when no active worktree exists", () => {
    const inactiveWts = [{ worktreeId: "wt_1", isActive: false }];
    expect(resolveActiveTerminal(inactiveWts, terms, undefined, "term_1")).toBeUndefined();
  });
});

describe("nextWorktreeName — generate name for new worktree slot", () => {
  it("starts from repo-2 when only repo name exists", () => {
    expect(nextWorktreeName("deep", ["main"])).toBe("deep-2");
    expect(nextWorktreeName("deep", [])).toBe("deep-2");
  });
  it("increments highest existing repo-N number", () => {
    expect(nextWorktreeName("deep", ["main", "deep-2", "deep-3"])).toBe("deep-4");
    expect(nextWorktreeName("deep", ["deep-2", "deep-5", "deep-3"])).toBe("deep-6");
  });
  it("ignores non repo-N pattern names and defaults to repo-2", () => {
    expect(nextWorktreeName("deep", ["algo width", "desktop app"])).toBe("deep-2");
  });
  it("does not count other repo names", () => {
    expect(nextWorktreeName("deep", ["main", "other-2", "deep-7"])).toBe("deep-8");
  });
});

describe("statePriority & sortSessions — priority rankings and un-grouped session ordering", () => {
  it("statePriority: maps states to numeric ranks", () => {
    expect(statePriority("waiting")).toBe(0);
    expect(statePriority("blocked")).toBe(0);
    expect(statePriority("error")).toBe(0);
    expect(statePriority("working")).toBe(10);
    expect(statePriority("done")).toBe(20);
    expect(statePriority("idle")).toBe(20);
    expect(statePriority("unverifiable")).toBe(20);
    expect(statePriority(undefined)).toBe(20);
    expect(statePriority("unknown" as any)).toBe(20);
  });

  it("sortSessions: orders by activity bucket recency, then handle", () => {
    const items = [
      { id: "s1", state: "done" as const, recency: 10000 },
      { id: "s2", state: "waiting" as const, recency: 2000 },
      { id: "s3", state: "working" as const, recency: 5000 },
      { id: "s4", state: "error" as const, recency: 3000 },
      { id: "s5", state: "idle" as const, recency: 8000 },
      { id: "s6", state: "working" as const, recency: 9000 },
      { id: "s7", state: "done" as const, recency: 4000 },
    ];
    // bucketMs = 1 to test direct recency
    const sorted = sortSessions(items, (s) => s.state, (s) => s.recency, (s) => s.id, {
      bucketMs: 1,
    });
    expect(sorted.map((s) => s.id)).toEqual(["s1", "s6", "s5", "s3", "s7", "s4", "s2"]);
  });
});

describe("buildDeck — pagingSlotIndex support", () => {
  const makeTerminals = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      handle: `term_${i}`,
      tabId: `tab_${i}`,
      leafId: `leaf_${i}`,
      title: `Task ${i}`,
      worktreePath: `/x/proj_${i}`,
      lastOutputAt: 1_000_000 + i * 1000,
    }));

  const makeWorktrees = (count: number, alertIndices: number[] = []) =>
    Array.from({ length: count }, (_, i) => ({
      agents: [
        {
          paneKey: `tab_${i}:leaf_${i}`,
          state: alertIndices.includes(i) ? ("waiting" as const) : ("working" as const),
          agentType: "claude",
        },
      ],
    }));

  it("does not insert page button when total sessions fit on one page (total <= perPage)", () => {
    const ts = makeTerminals(6);
    const wts = makeWorktrees(6);
    const deck = buildDeck({ terminals: ts, worktrees: wts }, { perPage: 8, pagingSlotIndex: 7 });

    expect(deck.total).toBe(6);
    expect(deck.pageCount).toBe(1);
    expect(deck.slots).toHaveLength(8);
    // All 6 sessions appear as normal session buttons
    expect(deck.slots.slice(0, 6).every((s) => !s.empty && s.isPageButton !== true)).toBe(true);
    // Slots 6 and 7 are empty, not page buttons
    expect(deck.slots[6].empty).toBe(true);
    expect(deck.slots[7].empty).toBe(true);
  });

  it("inserts page button at pagingSlotIndex when total sessions exceed perPage", () => {
    const ts = makeTerminals(10);
    const wts = makeWorktrees(10);
    // 10 items, 8 per page -> with paging key at index 7, capacity is 7 per page -> 2 pages
    const deckPage0 = buildDeck(
      { terminals: ts, worktrees: wts },
      { perPage: 8, page: 0, pagingSlotIndex: 7 },
    );

    expect(deckPage0.total).toBe(10);
    expect(deckPage0.pageCount).toBe(2);
    expect(deckPage0.slots).toHaveLength(8);

    // Slots 0..6 are normal session slots
    for (let i = 0; i < 7; i++) {
      expect(deckPage0.slots[i].empty).toBe(false);
      expect(deckPage0.slots[i].isPageButton).toBe(false);
    }

    // Slot 7 is the page button
    const pBtn0: any = deckPage0.slots[7];
    expect(pBtn0.empty).toBe(false);
    expect(pBtn0.isPageButton).toBe(true);
    expect(pBtn0.page).toBe(0);
    expect(pBtn0.pageCount).toBe(2);

    // Page 1
    const deckPage1 = buildDeck(
      { terminals: ts, worktrees: wts },
      { perPage: 8, page: 1, pagingSlotIndex: 7 },
    );
    expect(deckPage1.pageCount).toBe(2);
    // Slots 0..2 have the remaining 3 items
    for (let i = 0; i < 3; i++) {
      expect(deckPage1.slots[i].empty).toBe(false);
      expect(deckPage1.slots[i].isPageButton).toBe(false);
    }
    // Slots 3..6 are empty
    for (let i = 3; i < 7; i++) {
      expect(deckPage1.slots[i].empty).toBe(true);
    }
    // Slot 7 is the page button for page 1
    const pBtn1: any = deckPage1.slots[7];
    expect(pBtn1.empty).toBe(false);
    expect(pBtn1.isPageButton).toBe(true);
    expect(pBtn1.page).toBe(1);
    expect(pBtn1.pageCount).toBe(2);
  });

  it("calculates hasAlertOnOtherPage correctly", () => {
    const ts = makeTerminals(10);
    // 1 alert session: sorts to Page 0 (index 0).
    const wtsWith1Alert = makeWorktrees(10, [0]);

    const deckPage0With1Alert = buildDeck(
      { terminals: ts, worktrees: wtsWith1Alert },
      { perPage: 8, page: 0, pagingSlotIndex: 7 },
    );
    // Page 0 contains the alert, other page (Page 1) has no alerts
    expect((deckPage0With1Alert.slots[7] as any).hasAlertOnOtherPage).toBe(false);

    const deckPage1With1Alert = buildDeck(
      { terminals: ts, worktrees: wtsWith1Alert },
      { perPage: 8, page: 1, pagingSlotIndex: 7 },
    );
    // Page 1 is active, and other page (Page 0) contains the alert
    expect((deckPage1With1Alert.slots[7] as any).hasAlertOnOtherPage).toBe(true);

    // 8 alert sessions: 7 fill Page 0, 8th spills over to Page 1
    const wtsWith8Alerts = makeWorktrees(10, [0, 1, 2, 3, 4, 5, 6, 7]);
    const deckPage0With8Alerts = buildDeck(
      { terminals: ts, worktrees: wtsWith8Alerts },
      { perPage: 8, page: 0, pagingSlotIndex: 7 },
    );
    // Page 0 sees the 8th alert on Page 1
    expect((deckPage0With8Alerts.slots[7] as any).hasAlertOnOtherPage).toBe(true);

    // 0 alert sessions: neither page has alerts
    const wtsNoAlerts = makeWorktrees(10, []);
    const deckPage0NoAlerts = buildDeck(
      { terminals: ts, worktrees: wtsNoAlerts },
      { perPage: 8, page: 0, pagingSlotIndex: 7 },
    );
    expect((deckPage0NoAlerts.slots[7] as any).hasAlertOnOtherPage).toBe(false);
  });

  it("handles arbitrary active button counts (e.g. 4 buttons on screen with paging key at index 3)", () => {
    const ts = makeTerminals(6);
    const wts = makeWorktrees(6);

    // 4 buttons on screen, 4th button (index 3) is paging key
    // Capacity per page = 4 - 1 = 3 -> 6 items take 2 pages
    const deckP0 = buildDeck(
      { terminals: ts, worktrees: wts },
      { perPage: 4, page: 0, pagingSlotIndex: 3 },
    );
    expect(deckP0.total).toBe(6);
    expect(deckP0.pageCount).toBe(2);
    expect(deckP0.slots).toHaveLength(4);
    // Slots 0..2 are sessions
    expect(deckP0.slots.slice(0, 3).every((s) => !s.empty && s.isPageButton !== true)).toBe(true);
    // Slot 3 is page button
    expect(deckP0.slots[3]).toMatchObject({ isPageButton: true, page: 0, pageCount: 2 });

    const deckP1 = buildDeck(
      { terminals: ts, worktrees: wts },
      { perPage: 4, page: 1, pagingSlotIndex: 3 },
    );
    expect(deckP1.slots).toHaveLength(4);
    expect(deckP1.slots.slice(0, 3).every((s) => !s.empty && s.isPageButton !== true)).toBe(true);
    expect(deckP1.slots[3]).toMatchObject({ isPageButton: true, page: 1, pageCount: 2 });
  });

  it("handles 3 buttons on screen when total sessions fit on one page (total <= perPage)", () => {
    const ts = makeTerminals(3);
    const wts = makeWorktrees(3);

    const deck = buildDeck(
      { terminals: ts, worktrees: wts },
      { perPage: 3, page: 0, pagingSlotIndex: 2 },
    );
    expect(deck.total).toBe(3);
    expect(deck.pageCount).toBe(1);
    expect(deck.slots).toHaveLength(3);
    // All 3 slots are normal sessions, no paging button
    expect(deck.slots.every((s) => !s.empty && s.isPageButton !== true)).toBe(true);
  });
});

describe("representativeOtherState — priority ranking of states from other pages", () => {
  it("error (red) takes highest precedence", () => {
    const items = [
      { item: { state: "working" as const } },
      { item: { state: "error" as const } },
      { item: { state: "waiting" as const } },
    ];
    expect(representativeOtherState(items)).toEqual({ otherState: "error", otherColor: "red" });
  });

  it("waiting / blocked (violet) takes precedence over done/working/idle", () => {
    const items = [
      { item: { state: "working" as const } },
      { item: { state: "done" as const }, unread: true },
      { item: { state: "waiting" as const } },
    ];
    expect(representativeOtherState(items)).toEqual({ otherState: "waiting", otherColor: "violet" });
  });

  it("done unread (green) takes precedence over working/idle", () => {
    const items = [
      { item: { state: "working" as const } },
      { item: { state: "done" as const }, unread: true },
    ];
    expect(representativeOtherState(items)).toEqual({ otherState: "done", otherColor: "green", otherUnread: true });
  });

  it("working (orange) takes precedence over read done/idle", () => {
    const items = [
      { item: { state: "idle" as const } },
      { item: { state: "working" as const } },
      { item: { state: "done" as const }, unread: false },
    ];
    expect(representativeOtherState(items)).toEqual({ otherState: "working", otherColor: "orange" });
  });

  it("done read (green) takes precedence over idle", () => {
    const items = [
      { item: { state: "idle" as const } },
      { item: { state: "done" as const }, unread: false },
    ];
    expect(representativeOtherState(items)).toEqual({ otherState: "done", otherColor: "green", otherUnread: false });
  });

  it("idle (white) when only idle sessions exist", () => {
    const items = [{ item: { state: "idle" as const } }];
    expect(representativeOtherState(items)).toEqual({ otherState: "idle", otherColor: "white" });
  });

  it("empty items returns empty object", () => {
    expect(representativeOtherState([])).toEqual({});
  });
});

describe("stabilizeTerminalAgents — prevents UI flapping/blinking when Orca process scans momentarily drop agentIdentity", () => {
  it("preserves agentIdentity during momentary drop within grace period", () => {
    const cache = new Map<string, any>();
    const t1 = { handle: "term_1", tabId: "t1", leafId: "l1", title: "SleepyALot", agentIdentity: "claude" };

    // Poll 1: initial detection
    const res1 = stabilizeTerminalAgents([t1], cache, 1000, 15000);
    expect(res1[0].agentIdentity).toBe("claude");
    expect(cache.get("term_1")).toEqual({ agentIdentity: "claude", lastSeenAt: 1000 });

    // Poll 2: Orca blip where agentIdentity is undefined (1 second later)
    const t1_blip = { handle: "term_1", tabId: "t1", leafId: "l1", title: "SleepyALot", agentIdentity: undefined };
    const res2 = stabilizeTerminalAgents([t1_blip], cache, 2000, 15000);
    expect(res2[0].agentIdentity).toBe("claude");
    // lastSeenAt should still be 1000 to keep the timer running
    expect(cache.get("term_1")?.lastSeenAt).toBe(1000);

    // Poll 3: Orca recovers agentIdentity (2 seconds later)
    const res3 = stabilizeTerminalAgents([t1], cache, 3000, 15000);
    expect(res3[0].agentIdentity).toBe("claude");
    expect(cache.get("term_1")?.lastSeenAt).toBe(3000);
  });

  it("expires agentIdentity when missing beyond grace period (e.g. user exited agent)", () => {
    const cache = new Map<string, any>();
    const t1 = { handle: "term_1", tabId: "t1", leafId: "l1", title: "SleepyALot", agentIdentity: "claude" };

    // Initial detection at t=0
    stabilizeTerminalAgents([t1], cache, 0, 15000);

    // After 16 seconds of missing agentIdentity
    const t1_bare = { handle: "term_1", tabId: "t1", leafId: "l1", title: "Terminal", agentIdentity: undefined };
    const res = stabilizeTerminalAgents([t1_bare], cache, 16000, 15000);
    expect(res[0].agentIdentity).toBeUndefined();
    expect(cache.has("term_1")).toBe(false);
  });

  it("immediately deletes closed terminals from cache", () => {
    const cache = new Map<string, any>();
    const t1 = { handle: "term_1", tabId: "t1", leafId: "l1", title: "SleepyALot", agentIdentity: "claude" };
    const t2 = { handle: "term_2", tabId: "t2", leafId: "l2", title: "Deep", agentIdentity: "antigravity" };

    stabilizeTerminalAgents([t1, t2], cache, 1000, 15000);
    expect(cache.size).toBe(2);

    // term_1 closed, only term_2 remaining
    const res = stabilizeTerminalAgents([t2], cache, 2000, 15000);
    expect(res).toHaveLength(1);
    expect(res[0].handle).toBe("term_2");
    expect(cache.has("term_1")).toBe(false);
    expect(cache.has("term_2")).toBe(true);
  });

  it("updates agentIdentity when agent type changes on the same terminal", () => {
    const cache = new Map<string, any>();
    const t1 = { handle: "term_1", tabId: "t1", leafId: "l1", title: "Agent", agentIdentity: "claude" };

    stabilizeTerminalAgents([t1], cache, 1000, 15000);
    expect(cache.get("term_1")?.agentIdentity).toBe("claude");

    const t1_pi = { handle: "term_1", tabId: "t1", leafId: "l1", title: "Agent", agentIdentity: "pi" };
    const res = stabilizeTerminalAgents([t1_pi], cache, 2000, 15000);
    expect(res[0].agentIdentity).toBe("pi");
    expect(cache.get("term_1")?.agentIdentity).toBe("pi");
  });
});

describe("buildDeck — Orca substates (interrupted, monitoring, permissions)", () => {
  it("detects interrupted: true on done agent and maps to state 'interrupted' with color red", () => {
    const ts = [
      { handle: "term_int", tabId: "tab_int", leafId: "leaf_int", title: "Plan my orders panel", worktreePath: "/x/alt", lastOutputAt: 3000 },
      { handle: "term_work", tabId: "tab_work", leafId: "leaf_work", title: "Active work", worktreePath: "/x/alt", lastOutputAt: 2000 },
      { handle: "term_done", tabId: "tab_done", leafId: "leaf_done", title: "Finished task", worktreePath: "/x/alt", lastOutputAt: 1000 },
    ];
    const wts = [
      {
        agents: [
          { paneKey: "tab_int:leaf_int", state: "done" as const, interrupted: true, agentType: "antigravity" },
          { paneKey: "tab_done:leaf_done", state: "done" as const, interrupted: false, agentType: "antigravity" },
          { paneKey: "tab_work:leaf_work", state: "working" as const, interrupted: false, agentType: "claude" },
        ],
      },
    ];

    const deck = buildDeck({ terminals: ts, worktrees: wts }, { activityBucketMs: 1 });
    const slots = deck.slots as any[];

    // term_int (recency 3000) -> slot 0 (red)
    expect(slots[0].handle).toBe("term_int");
    expect(slots[0].state).toBe("interrupted");
    expect(slots[0].interrupted).toBe(true);
    expect(slots[0].color).toBe("red");
    expect(needsAttention(slots[0], false)).toBe(true);
    expect(needsAttention(slots[0], true)).toBe(false); // Stops pulsing when focused on target

    // term_work (recency 2000) -> slot 1 (orange)
    expect(slots[1].handle).toBe("term_work");
    expect(slots[1].state).toBe("working");
    expect(slots[1].color).toBe("orange");

    // term_done (recency 1000) -> slot 2 (green)
    expect(slots[2].handle).toBe("term_done");
    expect(slots[2].state).toBe("done");
    expect(slots[2].interrupted).toBe(false);
    expect(slots[2].color).toBe("green");
  });

  it("detects workingMode: monitoring and maps to state 'monitoring'", () => {
    const ts = [
      { handle: "term_mon", tabId: "tab_mon", leafId: "leaf_mon", title: "Monitoring tests", worktreePath: "/x/alt" },
    ];
    const wts = [
      {
        agents: [
          { paneKey: "tab_mon:leaf_mon", state: "working" as const, workingMode: "monitoring", agentType: "claude" },
        ],
      },
    ];

    const deck = buildDeck({ terminals: ts, worktrees: wts });
    const slots = deck.slots as any[];
    expect(slots[0].state).toBe("monitoring");
    expect(slots[0].workingMode).toBe("monitoring");
    expect(slots[0].color).toBe("orange");
  });
});



describe("hostLabel — machine label shown in the tile footer", () => {
  const hosts = [
    { id: "local", kind: "local", name: "this machine", machineName: "ben-laptop13", platform: "linux" },
    { id: "ssh-1", kind: "ssh", name: "Mac mini" },
  ];

  it("labels the local host by machine name and remote hosts by their configured name", () => {
    expect(hostLabel("local", hosts)).toBe("ben-laptop13");
    expect(hostLabel("ssh-1", hosts)).toBe("Mac mini");
  });

  it("falls back to platform, then to the raw id when the host list lacks the machine", () => {
    expect(hostLabel("local", [{ id: "local", kind: "local", platform: "darwin" }])).toBe("darwin");
    expect(hostLabel("local", [])).toBe("local");
    expect(hostLabel("ssh-unknown", hosts)).toBe("ssh-unknown");
  });

  it("returns undefined when neither a host id nor a host list is known", () => {
    expect(hostLabel(undefined, undefined)).toBeUndefined();
    expect(hostLabel(undefined, [])).toBeUndefined();
  });
});

describe("buildDeck — host threading onto slots", () => {
  const hosts = [
    { id: "local", kind: "local", machineName: "ben-laptop13", platform: "linux" },
    { id: "ssh-1", kind: "ssh", name: "Mac mini" },
  ];

  it("attaches the resolved host label to each slot", () => {
    const ts = [
      { handle: "term_L", tabId: "t1", leafId: "l1", title: "local task", worktreePath: "/x/a", executionHostId: "local" },
      { handle: "term_R", tabId: "t2", leafId: "l2", title: "remote task", worktreePath: "/x/b", executionHostId: "ssh-1" },
    ];
    const wts = [
      { worktreeId: "wt1", hostId: "local", agents: [{ paneKey: "t1:l1", state: "working", agentType: "claude" }] },
      { worktreeId: "wt2", hostId: "ssh-1", agents: [{ paneKey: "t2:l2", state: "working", agentType: "claude" }] },
    ];
    const slots = buildDeck({ terminals: ts, worktrees: wts, hosts }).slots as any[];
    const byHandle = new Map(slots.filter((s) => !s.empty).map((s) => [s.handle, s]));
    expect(byHandle.get("term_L")!.host).toBe("ben-laptop13");
    expect(byHandle.get("term_R")!.host).toBe("Mac mini");
    expect(byHandle.get("term_R")!.hostId).toBe("ssh-1");
  });

  it("falls back to the worktree hostId when the terminal does not report one", () => {
    const ts = [{ handle: "term_A", tabId: "t1", leafId: "l1", title: "x", worktreePath: "/x/a", worktreeId: "wt1" }];
    const wts = [{ worktreeId: "wt1", hostId: "ssh-1", agents: [{ paneKey: "t1:l1", state: "working", agentType: "claude" }] }];
    const slots = buildDeck({ terminals: ts, worktrees: wts, hosts }).slots as any[];
    expect(slots[0].host).toBe("Mac mini");
  });
});

describe("buildDeck — paired remote environments", () => {
  it("labels a remote session by its environment (a paired runtime reports its rows as hostId local)", () => {
    const ts = [
      {
        handle: "term_remote", tabId: "t1", leafId: "l1", title: "remote task",
        worktreePath: "/Users/ben/x", executionHostId: "local",
        environment: "Mac mini", environmentId: "env-1",
      },
    ];
    const wts = [
      {
        worktreeId: "wt1", hostId: "local", terminalPlatform: "darwin",
        environment: "Mac mini", environmentId: "env-1",
        agents: [{ paneKey: "t1:l1", state: "done", agentType: "claude" }],
      },
    ];
    const hosts = [{ id: "local", kind: "local", machineName: "ben-laptop13", platform: "linux" }];
    const slots = buildDeck({ terminals: ts, worktrees: wts, hosts }).slots as any[];
    expect(slots[0].host).toBe("Mac mini");
    expect(slots[0].environment).toBe("Mac mini");
    expect(slots[0].environmentId).toBe("env-1");
    // The raw Orca host id stays available for debugging even though it says "local".
    expect(slots[0].hostId).toBe("local");
  });

  it("keeps local sessions on the host-list label and leaves environment unset", () => {
    const ts = [{ handle: "term_local", tabId: "t2", leafId: "l2", title: "local", worktreePath: "/x/a", executionHostId: "local" }];
    const wts = [{ worktreeId: "wt2", hostId: "local", agents: [{ paneKey: "t2:l2", state: "idle", agentType: "pi" }] }];
    const hosts = [{ id: "local", kind: "local", machineName: "ben-laptop13", platform: "linux" }];
    const slots = buildDeck({ terminals: ts, worktrees: wts, hosts }).slots as any[];
    expect(slots[0].host).toBe("ben-laptop13");
    expect(slots[0].environment).toBeUndefined();
  });
});

describe("environmentArgs — routing commands to a paired remote runtime", () => {
  it("scopes with --environment for remote sessions and stays empty for local ones", () => {
    expect(environmentArgs("Mac mini")).toEqual(["--environment", "Mac mini"]);
    expect(environmentArgs(undefined)).toEqual([]);
    expect(environmentArgs(null)).toEqual([]);
    expect(environmentArgs("")).toEqual([]);
  });
});

describe("buildDeck — pinnedSlots interaction hold", () => {
  const T = 1_700_000_000_000;
  it("preserves exact slot indices when pinnedSlots is provided even if a session becomes more recent", () => {
    const ts = [
      { handle: "term_a", tabId: "t1", leafId: "l1", title: "a", worktreePath: "/x", lastOutputAt: T },
      { handle: "term_b", tabId: "t2", leafId: "l2", title: "b", worktreePath: "/x", lastOutputAt: T + 1000 },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "working" }] }));

    // Unpinned: term_b (more recent) is at slot 0, term_a is at slot 1
    const unpinned = buildDeck({ terminals: ts, worktrees: wts }, { now: T + 2000, activityBucketMs: 1 });
    expect(unpinned.slots[0].handle).toBe("term_b");
    expect(unpinned.slots[1].handle).toBe("term_a");

    // Pinned slot map: freeze term_a at slot 0, term_b at slot 1
    const pinnedMap = new Map([
      ["term_a", 0],
      ["term_b", 1],
    ]);
    const pinned = buildDeck(
      { terminals: ts, worktrees: wts },
      { now: T + 2000, activityBucketMs: 1, pinnedSlots: pinnedMap },
    );
    // Positions stay completely frozen in place
    expect(pinned.slots[0].handle).toBe("term_a");
    expect(pinned.slots[1].handle).toBe("term_b");
  });
});

describe("buildDeck — tabId and leafId preservation", () => {
  it("preserves tabId and leafId on button slots for terminal revelation", () => {
    const ts = [
      {
        handle: "term_remote",
        tabId: "tab_123",
        leafId: "leaf_456",
        title: "Remote Agent",
        worktreePath: "/remote/path",
        environment: "Mac mini",
        environmentId: "env_789",
      },
    ];
    const wts = [
      {
        environment: "Mac mini",
        environmentId: "env_789",
        agents: [{ paneKey: "tab_123:leaf_456", state: "working" as const }],
      },
    ];
    const deck = buildDeck({ terminals: ts, worktrees: wts });
    const slot = deck.slots[0] as any;
    expect(slot.empty).toBe(false);
    expect(slot.handle).toBe("term_remote");
    expect(slot.tabId).toBe("tab_123");
    expect(slot.leafId).toBe("leaf_456");
    expect(slot.environment).toBe("Mac mini");
    expect(slot.environmentId).toBe("env_789");
  });
});
