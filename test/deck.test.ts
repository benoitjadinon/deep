import { describe, it, expect } from "vitest";
import { buildDeck, activityBucket, colorFor, projectOf, needsAttention, findActivePaneInLayout, resolveActiveTerminal, nextWorktreeName, extractTabTitlesFromLayouts } from "../src/deck.js";

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
  it("waiting (amber) or error (red) on target session still requires attention for user action", () => {
    expect(needsAttention(b("amber"), true)).toBe(true);
    expect(needsAttention(b("red"), true)).toBe(true);
  });
  it("done (green) on target session does not require attention as user is viewing it", () => {
    expect(needsAttention(b("green", true), true)).toBe(false);
    expect(needsAttention(b("blue"), true)).toBe(false);
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
  it("slots contain matched agentType by paneKey", () => {
    const slots = buildDeck({ terminals, worktrees }).slots as any[];
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
    expect(colorFor("working")).toBe("blue");
    expect(colorFor("waiting")).toBe("amber");
    expect(colorFor("done")).toBe("green");
  });
  it("maps error to red and blocked to amber", () => {
    expect(colorFor("error")).toBe("red");
    expect(colorFor("blocked")).toBe("amber");
  });
  it("unknown/empty state defaults to white", () => {
    expect(colorFor("weird")).toBe("white");
    expect(colorFor(undefined)).toBe("white");
  });
});

describe("projectOf — extract project name from path", () => {
  it("nested repos under Projects return parent project name", () => {
    expect(projectOf("/Users/j/Projects/AcmeApp/ko", "ko")).toBe("AcmeApp");
    expect(projectOf("/Users/j/Projects/AcmeApp/us", "us")).toBe("AcmeApp");
  });
  it("standard repo returns directory name", () => {
    expect(projectOf("/Users/j/Projects/sandbox", "sandbox")).toBe("sandbox");
    expect(projectOf("/Users/j/Library/x/Notes", "Notes")).toBe("Notes");
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
      { worktreeId: "wt1", repo: "ko", displayName: "main", agents: [{ paneKey: "t1:l1", state: "working" }] },
      { worktreeId: "wt2", repo: "us", displayName: "main", agents: [{ paneKey: "t2:l2", state: "done" }] },
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
  it("working state past 30m decays to unverifiable (amber)", () => {
    const now = 10000000;
    const fresh = mk("working", false, now - 10 * 60 * 1000, now);
    expect(fresh.state).toBe("working");
    expect(fresh.color).toBe("blue");

    const stale = mk("working", false, now - 35 * 60 * 1000, now);
    expect(stale.state).toBe("unverifiable");
    expect(stale.color).toBe("amber");
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
    expect(a.color).toBe("blue");
    expect(a.agentType).toBe("opencode");
  });

  it("handles worktree ps agent without agentIdentity as before", () => {
    const ts = [{ handle: "term_old", tabId: "t1", leafId: "l1", title: "T", worktreePath: "/x", worktreeId: "wt1" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "done", agentType: "claude" }] }];
    const a = buildDeck({ terminals: ts, worktrees: wts }).slots[0] as any;
    expect(a).toMatchObject({ state: "done", agentType: "claude" });
  });

  it("transitions agy/antigravity working state to waiting (amber) on PreToolUse hook event", () => {
    const ts = [{ handle: "term_agy", tabId: "t1", leafId: "l1", title: "Agy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "agy" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "antigravity" }] }];
    const hookEvents = new Map([["t1:l1", "PreToolUse"]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("waiting");
    expect(a.color).toBe("amber");
  });

  it("keeps working (blue) on PreToolUse when the hook record itself reports the agent working (auto-approved tool run)", () => {
    const ts = [{ handle: "term_claude", tabId: "t1", leafId: "l1", title: "Candy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "claude" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "claude" }] }];
    // Orca stamps the agent state on the hook entry: auto-approved PreToolUse = "working".
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreToolUse", state: "working" }]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("working");
    expect(a.color).toBe("blue");
  });

  it("transitions to waiting (amber) on PreToolUse when the hook record reports the agent paused on the user", () => {
    const ts = [{ handle: "term_claude", tabId: "t1", leafId: "l1", title: "Candy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "claude" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "claude" }] }];
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreToolUse", state: "waiting" }]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("waiting");
    expect(a.color).toBe("amber");
  });

  it("keeps worktree-ps waiting (amber) even when a stale hook record says working", () => {
    const ts = [{ handle: "term_claude", tabId: "t1", leafId: "l1", title: "Candy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "claude" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "waiting", agentType: "claude" }] }];
    const hookEvents = new Map([["t1:l1", { hookEventName: "PreToolUse", state: "working" }]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("waiting");
    expect(a.color).toBe("amber");
  });

  it("maintains working (blue) on PostToolUse hook event", () => {
    const ts = [{ handle: "term_agy", tabId: "t1", leafId: "l1", title: "Agy", worktreePath: "/x", worktreeId: "wt1", agentIdentity: "agy" }];
    const wts = [{ worktreeId: "wt1", repo: "x", agents: [{ paneKey: "t1:l1", state: "working", agentType: "antigravity" }] }];
    const hookEvents = new Map([["t1:l1", "PostToolUse"]]);
    const a = buildDeck({ terminals: ts, worktrees: wts, hookEventsByPane: hookEvents }).slots[0] as any;
    expect(a.state).toBe("working");
    expect(a.color).toBe("blue");
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

  it("merges handle (terminal) and state (worktree) via paneKey", () => {
    const deck = buildDeck({ terminals, worktrees });
    const a = deck.slots[0];
    expect(a.empty).toBe(false);
    expect(a).toMatchObject({ handle: "term_A", state: "working", color: "blue", label: "unparkxing post" });
    const b = deck.slots[1];
    expect(b).toMatchObject({ handle: "term_B", state: "waiting", color: "amber" });
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

  it("orders sessions by most recent activity inside an equal project", () => {
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
    // Same project, same minute bucket but different seconds -> order stays by handle, no re-sort churn.
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

  it("keeps concurrently working project groups steady within a bucket", () => {
    // Both projects keep producing output every few seconds: group order must not flip per poll.
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

  it("groups agents of the same project together, groups ordered by most recent activity", () => {
    // Fixture mirrors the example: two AltReady sessions, two deep sessions.
    const ts = [
      { handle: "term_deep_old", tabId: "d1", leafId: "l1", title: "deep stale", worktreePath: "/x/deep", lastOutputAt: T + 2 * MIN },
      { handle: "term_alt_fresh", tabId: "a1", leafId: "l1", title: "alt question", worktreePath: "/x/AltReady", lastOutputAt: T + 6 * MIN },
      { handle: "term_deep_new", tabId: "d2", leafId: "l2", title: "deep finished", worktreePath: "/x/deep", lastOutputAt: T + 4 * MIN },
      { handle: "term_alt_fresh2", tabId: "a2", leafId: "l2", title: "alt working", worktreePath: "/x/AltReady", lastOutputAt: T + 7 * MIN },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "done" }] }));
    const slots = buildDeck({ terminals: ts, worktrees: wts }).slots.filter((s) => !s.empty) as any[];
    expect(slots.map((s) => s.repo)).toEqual(["AltReady", "AltReady", "deep", "deep"]);
    expect(slots.map((s) => s.handle)).toEqual([
      "term_alt_fresh2",
      "term_alt_fresh",
      "term_deep_new",
      "term_deep_old",
    ]);
  });

  it("sorts project groups by the newest member activity (fresh stale agent lifts its project)", () => {
    const ts = [
      { handle: "term_a", tabId: "t1", leafId: "l1", title: "a", worktreePath: "/x/alpha", lastOutputAt: T },
      { handle: "term_b", tabId: "t2", leafId: "l2", title: "b", worktreePath: "/x/beta", lastOutputAt: T },
      { handle: "term_c", tabId: "t3", leafId: "l3", title: "c", worktreePath: "/x/beta", lastOutputAt: T + 10 * MIN },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "done" }] }));
    const handles = buildDeck({ terminals: ts, worktrees: wts }).slots.filter((s) => !s.empty).map((s: any) => s.handle);
    expect(handles).toEqual(["term_c", "term_b", "term_a"]); // beta (T+10m) before alpha (T)
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
