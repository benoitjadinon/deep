import { describe, it, expect } from "vitest";
import { keySvg, agentBadge, stateIcon, keyImage, wrap, wrapWords, stripSpinner, marqueeWindow, dialImage, modeColor } from "../src/render.js";

describe("stripSpinner / wrap / wrapWords", () => {
  it("strip leading spinner glyph while preserving text", () => {
    expect(stripSpinner("⠂ Task in progress")).toBe("Task in progress");
    expect(stripSpinner("Normal Title")).toBe("Normal Title");
  });
  it("wrap preserves max chars per line and applies ellipsis on overflow", () => {
    expect(wrap("abcdefg", 7, 3)).toEqual(["abcdefg"]);
    const long = wrap("A".repeat(25), 7, 3);
    expect(long).toHaveLength(3);
    expect(long[2].endsWith("…")).toBe(true);
  });
  it("wrapWords wraps on word boundaries and enforces line limit with ellipsis", () => {
    expect(wrapWords("Design Feedback URL Browser", 15, 2)).toEqual([
      "Design Feedback",
      "URL Browser",
    ]);
    expect(wrapWords("This is a very long task description for agent session", 15, 2)).toEqual([
      "This is a very",
      "long task…",
    ]);
    expect(wrapWords("", 15, 2)).toEqual([]);
  });
});

describe("marqueeWindow", () => {
  it("returns original text when shorter than window", () => {
    expect(marqueeWindow("abc", 6, 0)).toBe("abc");
    expect(marqueeWindow("abc", 6, 5)).toBe("abc");
  });
  it("scrolls by tick and maintains window length when longer than window", () => {
    const s = "0123456789";
    expect([...marqueeWindow(s, 6, 0)]).toHaveLength(6);
    expect(marqueeWindow(s, 6, 0)).toBe("012345");
    expect(marqueeWindow(s, 6, 1)).toBe("123456");
    expect(marqueeWindow(s, 6, 2)).toBe("234567");
  });
  it("cycles back to start after one full period", () => {
    const s = "0123456789";
    const period = [...`${s}   ·   `].length;
    expect(marqueeWindow(s, 6, period)).toBe(marqueeWindow(s, 6, 0));
  });
});

describe("keySvg", () => {
  it("empty slot renders dark background", () => {
    expect(keySvg({ empty: true })).toContain("#141416");
  });
  it("renders top color ribbon + project name + branch-num + 2-line tab title", () => {
    const svg = keySvg({
      empty: false, handle: "term_x", tabTitle: "Design Feedback URL",
      state: "working", color: "blue", repo: "svd", branch: "main", dupIndex: 1,
    });
    expect(svg).toContain("#3b82f6");
    expect(svg).not.toContain("WORKING");
    expect(svg).toContain("svd");
    expect(svg).toContain("main-1");
    expect(svg).toContain("Design Feedback");
    expect(svg).toContain("URL");
    // line 1 (project title) 19px max; line 2 (branch) 18px; both with wider line separation
    expect(svg).toContain('font-size="19" font-weight="700"');
    expect(svg).toContain('font-size="18" font-weight="600"');
  });

  it("target slot renders top-right coral dot in the bar, non-target does not", () => {
    const b = { empty: false as const, handle: "t", label: "x", state: "done", color: "green" as const, repo: "svd", branch: "main" };
    const on = keySvg(b, 0, true);
    const off = keySvg(b, 0, false);
    expect(on).toContain('<circle cx="126" cy="126" r="9" fill="#d97757"');
    expect(on).toContain("main");
    expect(on).toContain('fill="#ffffff"');
    expect(off).not.toContain("#d97757");
  });

  it("places state glyph in the top bar and agent badge bottom-left", () => {
    const svg = keySvg({ empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main", agentType: "claude" });
    expect(svg).toContain('width="144" height="18"'); // bar ~20% taller
    expect(svg).toContain('cx="14" cy="8"'); // state glyph inside bar (left)
    expect(svg).toContain('<rect x="23" y="2.5" width="2" height="11" rx="1" fill="#ffffff" opacity="0.35"/>'); // divider
    expect(svg).toContain('x="5" y="112" width="27" height="27"'); // agent badge bottom-left, 50% larger
  });

  it("omits the bar divider when the session has no state icon", () => {
    const svg = keySvg({ empty: false as const, handle: "t", label: "x", state: "idle", color: "white" as const, repo: "svd", branch: "main" });
    expect(svg).not.toContain('x="23" y="2.5"');
  });

  it("renders a 3rd summary line when the tab title is long", () => {
    const svg = keySvg({ empty: false as const, handle: "t", tabTitle: "Fix the flaky integration tests and review the auth refactor", state: "working", color: "blue" as const, repo: "svd", branch: "main" });
    expect(svg).toContain('y="96"');
    expect(svg).toContain('y="114"');
    expect(svg).toContain('y="132"');
  });
});

describe("agentBadge — per-tile agent badge", () => {
  it("known types render Orca logo icons", () => {
    expect(agentBadge("claude")).toContain('fill="#D97757"');
    expect(agentBadge("claude")).toContain("M4.709");
    expect(agentBadge("opencode")).toContain('fill="#F1ECEC"');
    expect(agentBadge("opencode")).toContain("M180 240H60V120H180V240Z");
    expect(agentBadge("codex")).toContain('fill="#A78BFA"');
    expect(agentBadge("codex")).toContain("M9.205");
    expect(agentBadge("agy")).toContain("<image href=\"data:image/png;base64,");
    expect(agentBadge("antigravity")).toContain("<image href=\"data:image/png;base64,");
    expect(agentBadge("hermes")).toContain('fill="#10B981"');
    expect(agentBadge("hermes-cli")).toContain('fill="#10B981"');
    expect(agentBadge("hermes-agent")).toContain('fill="#10B981"');
    expect(agentBadge("pi")).toContain(">π</text>");
    expect(agentBadge("pi")).toContain('fill="#8abeb7"');
  });
  it("case insensitive", () => {
    expect(agentBadge("OpenCode")).toContain('fill="#F1ECEC"');
    expect(agentBadge("Claude")).toContain('fill="#D97757"');
    expect(agentBadge("Hermes")).toContain('fill="#10B981"');
    expect(agentBadge("PI")).toContain(">π</text>");
  });
  it("unknown types render gray pill with first 2 characters, or question mark", () => {
    const g = agentBadge("grok");
    expect(g).toContain('fill="#4b5563"');
    expect(g).toContain(">GR</text>");
    expect(agentBadge(undefined)).toContain(">?</text>");
    expect(agentBadge(null)).toContain(">?</text>");
  });
  it("keySvg embeds agent icon badge", () => {
    const svg = keySvg({ empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main", agentType: "opencode" });
    expect(svg).toContain("M180 240H60V120H180V240Z");
    expect(svg).toContain('fill="#F1ECEC"');
  });
  it("empty slot has no badge", () => {
    expect(keySvg({ empty: true })).not.toContain("</text>");
  });
});

describe("stateIcon — white glyphs for the state-colored top bar", () => {
  it("done is white checkmark circle scaled into the bar", () => {
    const icon = stateIcon("done");
    expect(icon).toContain('stroke="#ffffff"');
    expect(icon).toContain("<circle");
    expect(icon).toContain("<path");
  });
  it("unverifiable (no recent update) is white dashed circle", () => {
    const icon = stateIcon("unverifiable");
    expect(icon).toContain('stroke="#ffffff"');
    expect(icon).toContain("stroke-dasharray");
  });
  it("working is white spinner ring", () => {
    const icon = stateIcon("working");
    expect(icon).toContain('stroke="#ffffff"');
    expect(icon).toContain("stroke-dasharray");
  });
  it("waiting is white question mark", () => {
    const icon = stateIcon("waiting");
    expect(icon).toContain('stroke="#ffffff"');
    expect(icon).toContain(">?</text>");
  });
  it("error/blocked/failed is white exclamation mark", () => {
    expect(stateIcon("error")).toContain('stroke="#ffffff"');
    expect(stateIcon("blocked")).toContain('stroke="#ffffff"');
    expect(stateIcon("failed")).toContain('stroke="#ffffff"');
  });
  it("idle or empty state has no icon", () => {
    expect(stateIcon("idle")).toBe("");
    expect(stateIcon(undefined)).toBe("");
  });
  it("honors custom position and size", () => {
    const icon = stateIcon("working", 40, 30, 4);
    expect(icon).toContain('cx="40" cy="30" r="4"');
  });
});

describe("keySvg attention animation (pulse ring)", () => {
  const attn = { empty: false as const, handle: "t", label: "x", state: "waiting", color: "amber" as const, repo: "svd", branch: "main" };
  const calm = { empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main" };
  it("attention key changes SVG across nowMs timestamps", () => {
    expect(keySvg(attn, 0, false, 0)).not.toBe(keySvg(attn, 0, false, 320));
  });
  it("static (working) key is invariant to nowMs", () => {
    expect(keySvg(calm, 0, false, 0)).toBe(keySvg(calm, 0, false, 999));
  });
  it("target session done state does not animate", () => {
    const done = { empty: false as const, handle: "t", label: "x", state: "done", color: "green" as const, repo: "svd", branch: "main" };
    expect(keySvg(done, 0, true, 0)).toBe(keySvg(done, 0, true, 500));
  });
  it("target session waiting state continues animating for input prompt", () => {
    expect(keySvg(attn, 0, true, 0)).not.toBe(keySvg(attn, 0, true, 320));
  });
  it("attention key pulses background with state color", () => {
    expect((keySvg(attn, 0, false, 200).match(/fill="#f59e0b"/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((keySvg(calm, 0, false, 200).match(/fill="#3b82f6"/g) || []).length).toBe(1);
  });
});

describe("keySvg dim — dim non-attention keys for contrast", () => {
  const calm = { empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main" };
  it("dim applies group opacity", () => {
    expect(keySvg(calm, 0, false, 0, true)).toContain('opacity="0.32"');
  });
  it("non-dim preserves normal brightness", () => {
    expect(keySvg(calm, 0, false, 0, false)).not.toContain('opacity="0.32"');
  });
});

describe("keyImage — exports SVG data URI", () => {
  it("returns base64 SVG data URI", () => {
    const img = keyImage({ empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main", agentType: "opencode" });
    expect(img.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(img.split(",")[1], "base64").toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("M180 240H60V120H180V240Z");
    expect(svg).toContain('fill="#F1ECEC"');
  });
  it("empty slot returns SVG data URI", () => {
    expect(keyImage({ empty: true })).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});

describe("dialImage — dial rendering", () => {
  it("renders data URI without throwing for single line value", () => {
    const img = dialImage("model", "MODEL", "opus", 0);
    expect(img.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
  it("short value renders as single text line", () => {
    const svg = Buffer.from(dialImage("effort", "EFFORT", "high", 0).split(",")[1], "base64").toString("utf8");
    expect(svg.match(/<text/g) || []).toHaveLength(2);
    expect(svg).toContain('font-size="28"');
  });
  it("long value wraps up to 3 lines", () => {
    const long = "opencode/claude-opus-4-6-preview-2025-nerf-extra-long";
    const svg = Buffer.from(dialImage("model", "MODEL", long, 0).split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('font-size="11"');
    const lines = svg.match(/y="[0-9]+"/g) || [];
    expect(lines.length).toBe(4);
    expect(svg).toContain("opencode");
    expect(svg).toContain("claude-opus");
  });
  it("breaks on '/' delimiter when value does not fit in single line", () => {
    const v = "minimax/minimax-m3";
    const svg = Buffer.from(dialImage("model", "MODEL", v, 0).split(",")[1], "base64").toString("utf8");
    const textY = [...svg.matchAll(/text x="18" y="(\d+)"/g)].map((m) => m[1]);
    expect(textY.length).toBeGreaterThan(1);
    expect(svg).toContain(">minimax</text>");
    expect(svg).toContain(">minimax-m3</text>");
  });
  it("disabled dial renders dark gray rails/labels and opacity group", () => {
    const svg = Buffer.from(dialImage("effort", "EFFORT", "-", 0, true).split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('fill="#2e2e34"');
    expect(svg).toContain('fill="#4a4a52"');
    expect(svg).toContain('<g opacity="0.38">');
  });
  it("renders agent icon badge when badge prop is provided", () => {
    const svg = Buffer.from(dialImage("target", "TARGET", "svd", 0, false, "opencode", "main").split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('fill="#F1ECEC"');
    expect(svg).toContain("M180 240H60V120H180V240Z");
    expect(svg).toContain('x="172" y="6"');
  });
  it("renders branch subtitle below value when sub is provided", () => {
    const svg = Buffer.from(dialImage("target", "TARGET", "svd", 0, false, "opencode", "main").split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('fill="#b8b8be"');
    expect(svg).toContain(">main</text>");
    expect(svg).toContain('font-size="13" font-weight="600"');
  });
  it("renders model quota subtitle with threshold-based color coding", () => {
    // 1. Normal usage (<70%) -> gray/muted (#a1a1aa)
    const normal = Buffer.from(dialImage("model", "MODEL", "sonnet-4-6", 0, false, "claude", "39% · 1:59 PM").split(",")[1], "base64").toString("utf8");
    expect(normal).toContain(">39% · 1:59 PM</text>");
    expect(normal).toContain('fill="#a1a1aa"');
    expect(normal).toContain('font-size="12"');

    // 2. Warning usage (70-89%) -> amber (#f59e0b)
    const warning = Buffer.from(dialImage("model", "MODEL", "sonnet-4-6", 0, false, "claude", "75% · 1:59 PM").split(",")[1], "base64").toString("utf8");
    expect(warning).toContain(">75% · 1:59 PM</text>");
    expect(warning).toContain('fill="#f59e0b"');

    // 3. High usage (>=90%) -> red (#ef4444)
    const danger = Buffer.from(dialImage("model", "MODEL", "gpt-5.5", 0, false, "codex", "95% · Sat 7:48 PM").split(",")[1], "base64").toString("utf8");
    expect(danger).toContain(">95% · Sat 7:48 PM</text>");
    expect(danger).toContain('fill="#ef4444"');

    // 4. Multi-line model with quota
    const multi = Buffer.from(dialImage("model", "MODEL", "openrouter/minimax/minimax-m3", 0, false, "opencode", "50% · 2:00 PM").split(",")[1], "base64").toString("utf8");
    expect(multi).toContain(">50% · 2:00 PM</text>");
    expect(multi).toContain(">openrouter</text>");
    expect(multi).toContain(">minimax</text>");
  });
  it("omits top-right badge when badge is not passed", () => {
    const svg = Buffer.from(dialImage("target", "TARGET", "svd", 0).split(",")[1], "base64").toString("utf8");
    expect(svg).not.toContain('x="172" y="6"');
  });

  it("mode dial title and left bar color change according to agent and mode", () => {
    // 1. AGY
    const agyAccept = Buffer.from(dialImage("mode", "MODE", "accept-edits", 0, false, "agy").split(",")[1], "base64").toString("utf8");
    expect(agyAccept).toContain('fill="#22c55e"');
    expect(agyAccept).toContain('>MODE</text>');

    const agyPlan = Buffer.from(dialImage("mode", "MODE", "plan", 0, false, "agy").split(",")[1], "base64").toString("utf8");
    expect(agyPlan).toContain('fill="#3b82f6"');

    const agyNothing = Buffer.from(dialImage("mode", "MODE", "default", 0, false, "agy").split(",")[1], "base64").toString("utf8");
    expect(agyNothing).toContain('fill="#71717a"');

    // 2. Claude
    const claudeAuto = Buffer.from(dialImage("mode", "MODE", "auto", 0, false, "claude").split(",")[1], "base64").toString("utf8");
    expect(claudeAuto).toContain('fill="#eab308"');

    const claudeManual = Buffer.from(dialImage("mode", "MODE", "manual", 0, false, "claude").split(",")[1], "base64").toString("utf8");
    expect(claudeManual).toContain('fill="#71717a"');

    const claudeAccept = Buffer.from(dialImage("mode", "MODE", "accept-edits", 0, false, "claude").split(",")[1], "base64").toString("utf8");
    expect(claudeAccept).toContain('fill="#a855f7"');

    const claudePlan = Buffer.from(dialImage("mode", "MODE", "plan", 0, false, "claude").split(",")[1], "base64").toString("utf8");
    expect(claudePlan).toContain('fill="#3b82f6"');

    // 3. Codex
    const codexWrite = Buffer.from(dialImage("mode", "MODE", "workspace-write", 0, false, "codex").split(",")[1], "base64").toString("utf8");
    expect(codexWrite).toContain('fill="#10b981"');

    const codexRead = Buffer.from(dialImage("mode", "MODE", "read-only", 0, false, "codex").split(",")[1], "base64").toString("utf8");
    expect(codexRead).toContain('fill="#0ea5e9"');

    const codexDanger = Buffer.from(dialImage("mode", "MODE", "danger-full-access", 0, false, "codex").split(",")[1], "base64").toString("utf8");
    expect(codexDanger).toContain('fill="#ef4444"');
  });

  it("target dial with state renders a button-style state status bar instead of the accent rail", () => {
    const svg = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "opencode", "main", undefined, { state: "waiting", color: "amber", attention: false, nowMs: 0 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(svg).toContain('width="200" height="14"'); // status bar, same height language as keys
    expect(svg).toContain('fill="#f59e0b"'); // amber state color on bar + label
    expect(svg).not.toContain('width="7" height="100"'); // static accent rail replaced
    expect(svg).toContain('fill="#ffffff"'); // white state glyph
    expect(svg).toContain(">?</text>"); // waiting question mark
    expect(svg).toContain('x="23" y="2.5" width="2" height="9"'); // glyph divider
  });

  it("target dial state glyph/colors follow session state like a key", () => {
    // done -> green bar + checkmark
    const done = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "claude", "main", undefined, { state: "done", color: "green", attention: false, nowMs: 0 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(done).toContain('fill="#22c55e"');
    expect(done).toContain('M4.8 8.2'); // checkmark path

    // error -> red bar + exclamation
    const err = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "codex", "main", undefined, { state: "error", color: "red", attention: false, nowMs: 0 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(err).toContain('fill="#ef4444"');
    expect(err).toContain(">!</text>");

    // idle -> gray bar, no glyph/divider but the bar still renders
    const idle = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "claude", "main", undefined, { state: "idle", color: "white", attention: false, nowMs: 0 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(idle).toContain('fill="#6b7280"');
    expect(idle).not.toContain('x="23" y="2.5"');
  });

  it("target dial blinks like a button when attention triggers, with urgent amber/red period", () => {
    // amber attention at 160ms of a 640ms cycle -> p=0.5 -> 0.40*0.5 = 0.20
    const mid = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "opencode", "main", undefined, { state: "waiting", color: "amber", attention: true, nowMs: 160 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(mid).toContain('opacity="0.20"');
    expect(mid).toContain('width="200" height="100" fill="#f59e0b" opacity');

    // green (calm) attention: 1300ms period, at 325ms p=0.5 -> 0.28*0.5 = 0.14
    const calm = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "claude", "main", undefined, { state: "done", color: "green", attention: true, nowMs: 325 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(calm).toContain('opacity="0.14"');

    // no attention -> no glow overlay at all
    const off = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "opencode", "main", undefined, { state: "waiting", color: "amber", attention: false, nowMs: 160 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(off).not.toContain('opacity="0.20"');
    expect(off.match(/<rect width="200" height="100" fill/g) || []).toHaveLength(0);
  });

  it("target dial status bar sinks the agent badge below the 14px bar", () => {
    const svg = Buffer.from(
      dialImage("target", "TARGET", "svd", 0, false, "opencode", "main", undefined, { state: "working", color: "blue", attention: false, nowMs: 0 }).split(",")[1],
      "base64",
    ).toString("utf8");
    expect(svg).toContain('x="172" y="15"');
    expect(svg).not.toContain('x="172" y="6"');
  });

  it("target dial without state keeps the legacy amber rail and top-right badge", () => {
    const svg = Buffer.from(dialImage("target", "TARGET", "svd", 0, false, "opencode").split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('width="7" height="100"');
    expect(svg).toContain('fill="#f59e0b"');
    expect(svg).toContain('x="172" y="6"');
    expect(svg).not.toContain('width="200" height="14"');
  });
});

describe("modeColor — mode to color mapping", () => {
  it("AGY mode colors: accept-edits=green, plan=blue, default=gray", () => {
    expect(modeColor("accept-edits", "agy")).toBe("#22c55e");
    expect(modeColor("accept edits", "antigravity")).toBe("#22c55e");
    expect(modeColor("plan", "agy")).toBe("#3b82f6");
    expect(modeColor("default", "agy")).toBe("#71717a");
    expect(modeColor("nothing", "agy")).toBe("#71717a");
  });

  it("Claude mode colors: auto=yellow, manual/default=gray, accept-edits=purple, plan=blue", () => {
    expect(modeColor("auto", "claude")).toBe("#eab308");
    expect(modeColor("auto-mode", "claude")).toBe("#eab308");
    expect(modeColor("automode", "claude")).toBe("#eab308");
    expect(modeColor("manual", "claude")).toBe("#71717a");
    expect(modeColor("default", "claude")).toBe("#71717a");
    expect(modeColor("accept-edits", "claude")).toBe("#a855f7");
    expect(modeColor("accept edits", "claude")).toBe("#a855f7");
    expect(modeColor("plan", "claude")).toBe("#3b82f6");
  });

  it("Codex mode colors: workspace-write=emerald, read-only=sky, danger-full-access=red, plan=blue", () => {
    expect(modeColor("workspace-write", "codex")).toBe("#10b981");
    expect(modeColor("read-only", "codex")).toBe("#0ea5e9");
    expect(modeColor("danger-full-access", "codex")).toBe("#ef4444");
    expect(modeColor("plan", "codex")).toBe("#3b82f6");
  });

  it("OpenCode mode colors: build=green, plan=blue, review=purple, debug=amber", () => {
    expect(modeColor("build", "opencode")).toBe("#22c55e");
    expect(modeColor("plan", "opencode")).toBe("#3b82f6");
    expect(modeColor("review", "opencode")).toBe("#a855f7");
    expect(modeColor("debug", "opencode")).toBe("#f59e0b");
  });
});
