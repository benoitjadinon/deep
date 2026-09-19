import { describe, it, expect } from "vitest";
import { resolveLucideSvg, resolveRepoBgIcon, resolveLocalIconUri } from "../src/icons.js";
import { buildDeck } from "../src/deck.js";
import { keySvg, renderBgIcon } from "../src/render.js";

describe("icons — Lucide SVG and repository icon resolver", () => {
  it("converts Lucide icon name to SVG inner path", () => {
    const rocket = resolveLucideSvg("Rocket");
    expect(rocket).toBeDefined();
    expect(rocket).toContain("path");
    expect(rocket).toContain("M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5");

    // Lowercase / kebab-case support
    const rocketLower = resolveLucideSvg("rocket");
    expect(rocketLower).toBe(rocket);

    const folderGit = resolveLucideSvg("folder-git-2");
    expect(folderGit).toBeDefined();
    expect(folderGit).toContain("circle");

    // Returns undefined for non-existent name
    expect(resolveLucideSvg("non_existent_icon_xyz")).toBeUndefined();
    expect(resolveLucideSvg(undefined)).toBeUndefined();
  });

  it("resolveRepoBgIcon directly converts Lucide type", () => {
    const icon = resolveRepoBgIcon({
      id: "repo-1",
      displayName: "bls-web",
      badgeColor: "#ef4444",
      repoIcon: { type: "lucide", name: "Rocket" },
    });
    expect(icon.lucide).toBeDefined();
    expect(icon.lucide).toContain("M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5");
  });

  it("resolveRepoBgIcon returns Emoji type", () => {
    const icon = resolveRepoBgIcon({
      id: "repo-2",
      displayName: "my-tool",
      repoIcon: { type: "emoji", emoji: "⚡️" },
    });
    expect(icon.emoji).toBe("⚡️");
  });
});

describe("buildDeck — repoIcon and background icon data threading", () => {
  const terminals = [
    { handle: "term_1", tabId: "t1", leafId: "l1", title: "App", worktreeId: "repo-bls::/ws/bls-web", worktreePath: "/ws/bls-web" },
  ];
  const worktrees = [
    { worktreeId: "repo-bls::/ws/bls-web", agents: [{ paneKey: "t1:l1", state: "working" as const, agentType: "claude" }] },
  ];
  const repos = [
    { id: "repo-bls", displayName: "bls-web", badgeColor: "#ef4444", repoIcon: { type: "lucide", name: "Rocket" } },
  ];

  it("propagates repos repoIcon and badgeColor to Button in buildDeck", () => {
    const deck = buildDeck({ terminals, worktrees, repos });
    const slot = deck.slots[0];
    expect(slot.empty).toBe(false);
    if (!slot.empty) {
      expect(slot.badgeColor).toBe("#ef4444");
      expect(slot.repoIcon).toEqual({ type: "lucide", name: "Rocket" });
      expect(slot.bgIconLucide).toBeDefined();
      expect(slot.bgIconLucide).toContain("M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5");
    }
  });
});

describe("renderBgIcon and keySvg background watermark rendering", () => {
  it("renders Lucide icon in keySvg with stroke and scale(6) group", () => {
    const lucideSvg = resolveLucideSvg("Rocket");
    const svg = keySvg({
      empty: false,
      handle: "term_1",
      label: "bls-web",
      state: "working",
      color: "blue",
      repo: "bls-web",
      badgeColor: "#ef4444",
      bgIconLucide: lucideSvg,
    });
    expect(svg).toContain('transform="scale(6)"');
    expect(svg).toContain('stroke="#ef4444"');
    expect(svg).toContain('opacity="0.25"');
  });

  it("renders image URI in keySvg with 144x144 and preserveAspectRatio slice", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const svg = keySvg({
      empty: false,
      handle: "term_2",
      label: "tokengateway",
      state: "working",
      color: "blue",
      repo: "tokengateway",
      bgIconUri: dataUri,
    });
    expect(svg).toContain("<image href=\"data:image/png;base64,");
    expect(svg).toContain('width="144" height="144"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain('opacity="0.25"');
  });

  it("renders emoji with text tag in keySvg", () => {
    const svg = keySvg({
      empty: false,
      handle: "term_3",
      label: "quick-tool",
      state: "working",
      color: "blue",
      repo: "quick-tool",
      bgIconEmoji: "🚀",
    });
    expect(svg).toContain(">🚀</text>");
    expect(svg).toContain('opacity="0.25"');
  });
});
