import { describe, it, expect } from "vitest";
import { resolveLucideSvg, resolveRepoBgIcon, resolveLocalIconUri } from "../src/icons.js";
import { buildDeck } from "../src/deck.js";
import { keySvg, renderBgIcon } from "../src/render.js";

describe("icons — Lucide SVG 및 저장소 아이콘 리졸버", () => {
  it("Lucide 아이콘 이름을 SVG 내부 경로로 변환한다", () => {
    const rocket = resolveLucideSvg("Rocket");
    expect(rocket).toBeDefined();
    expect(rocket).toContain("path");
    expect(rocket).toContain("M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5");

    // 소문자 / kebab-case도 지원
    const rocketLower = resolveLucideSvg("rocket");
    expect(rocketLower).toBe(rocket);

    const folderGit = resolveLucideSvg("folder-git-2");
    expect(folderGit).toBeDefined();
    expect(folderGit).toContain("circle");

    // 없는 이름은 undefined
    expect(resolveLucideSvg("non_existent_icon_xyz")).toBeUndefined();
    expect(resolveLucideSvg(undefined)).toBeUndefined();
  });

  it("resolveRepoBgIcon은 Lucide 타입을 바로 변환한다", () => {
    const icon = resolveRepoBgIcon({
      id: "repo-1",
      displayName: "bls-web",
      badgeColor: "#ef4444",
      repoIcon: { type: "lucide", name: "Rocket" },
    });
    expect(icon.lucide).toBeDefined();
    expect(icon.lucide).toContain("M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5");
  });

  it("resolveRepoBgIcon은 Emoji 타입을 반환한다", () => {
    const icon = resolveRepoBgIcon({
      id: "repo-2",
      displayName: "my-tool",
      repoIcon: { type: "emoji", emoji: "⚡️" },
    });
    expect(icon.emoji).toBe("⚡️");
  });
});

describe("buildDeck — repoIcon 및 배경 아이콘 데이터 스레딩", () => {
  const terminals = [
    { handle: "term_1", tabId: "t1", leafId: "l1", title: "App", worktreeId: "repo-bls::/ws/bls-web", worktreePath: "/ws/bls-web" },
  ];
  const worktrees = [
    { worktreeId: "repo-bls::/ws/bls-web", agents: [{ paneKey: "t1:l1", state: "working" as const, agentType: "claude" }] },
  ];
  const repos = [
    { id: "repo-bls", displayName: "bls-web", badgeColor: "#ef4444", repoIcon: { type: "lucide", name: "Rocket" } },
  ];

  it("buildDeck에서 repos의 repoIcon과 badgeColor가 Button으로 전파된다", () => {
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

describe("renderBgIcon 및 keySvg 배경 워터마크 렌더링", () => {
  it("Lucide 아이콘이 있으면 keySvg에 stroke와 scale(6) 그룹으로 렌더된다", () => {
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

  it("이미지 URI가 있으면 keySvg에 144x144 및 preserveAspectRatio slice로 렌더된다", () => {
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

  it("이모지가 있으면 text 태그로 렌더된다", () => {
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
