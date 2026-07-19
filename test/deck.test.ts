import { describe, it, expect } from "vitest";
import { buildDeck, colorFor, projectOf, needsAttention } from "../src/deck.js";

describe("needsAttention — 주의 필요 세션 판정(애니메이션 트리거)", () => {
  const b = (color: any, unread?: boolean) => ({ empty: false as const, handle: "t", label: "x", state: "s" as any, color, unread });
  it("입력대기(amber)·완료미확인(green)·에러(red)는 주의 필요", () => {
    expect(needsAttention(b("amber"), false)).toBe(true);
    expect(needsAttention(b("green", true), false)).toBe(true);
    expect(needsAttention(b("red"), false)).toBe(true);
  });
  it("작업중(blue)·idle(white)·빈칸은 주의 불필요", () => {
    expect(needsAttention(b("blue"), false)).toBe(false);
    expect(needsAttention(b("white"), false)).toBe(false);
    expect(needsAttention({ empty: true }, false)).toBe(false);
  });
  it("현재 보는 세션(target)은 이미 보고 있어 애니메이션 안 함", () => {
    expect(needsAttention(b("amber"), true)).toBe(false);
    expect(needsAttention(b("green", true), true)).toBe(false);
  });
});

// orca terminal list --json  →  result.terminals[]
const terminals = [
  { handle: "term_A", tabId: "tab1", leafId: "leaf1", title: "unparkxing 포스팅", worktreePath: "/x/unparkxing" },
  { handle: "term_B", tabId: "tab2", leafId: "leaf2", title: "policy 약관 작업", worktreePath: "/x/policy" },
  // 에이전트 없는 순수 셸 터미널 — 세션판에서 제외돼야 함
  { handle: "term_shell", tabId: "tab3", leafId: "leaf3", title: "Terminal 1", worktreePath: "" },
];

// orca worktree ps --json  →  result.worktrees[].agents[]  (paneKey = `${tabId}:${leafId}`)
const worktrees = [
  { agents: [{ paneKey: "tab1:leaf1", state: "working", agentType: "claude" }] },
  { agents: [{ paneKey: "tab2:leaf2", state: "waiting", agentType: "claude" }] },
];

describe("colorFor — 상태→색 매핑", () => {
  it("관측된 상태를 색으로", () => {
    expect(colorFor("working")).toBe("blue");
    expect(colorFor("waiting")).toBe("amber");
    expect(colorFor("done")).toBe("green");
  });
  it("error는 방어적으로 빨강", () => {
    expect(colorFor("error")).toBe("red");
  });
  it("모르는/빈 상태는 기본 흰색", () => {
    expect(colorFor("weird")).toBe("white");
    expect(colorFor(undefined)).toBe("white");
  });
});

describe("projectOf — 경로에서 프로젝트명", () => {
  it("Projects 하위 중첩 레포는 상위 프로젝트명", () => {
    expect(projectOf("/Users/j/Projects/AcmeApp/ko", "ko")).toBe("AcmeApp");
    expect(projectOf("/Users/j/Projects/AcmeApp/us", "us")).toBe("AcmeApp");
  });
  it("일반 레포는 폴더명", () => {
    expect(projectOf("/Users/j/Projects/sandbox", "sandbox")).toBe("sandbox");
    expect(projectOf("/Users/j/Library/x/Notes", "Notes")).toBe("Notes");
  });
  it("경로 없으면 repo fallback", () => {
    expect(projectOf(undefined, "svd")).toBe("svd");
  });
});

describe("중복 프로젝트 순번(dupIndex)", () => {
  it("같은 프로젝트+브랜치는 0,1,2… 부여", () => {
    const terms = [
      { handle: "term_A", tabId: "t1", leafId: "l1", title: "국내", worktreePath: "/x/Projects/AcmeApp/ko", worktreeId: "wt1", lastOutputAt: 3 },
      { handle: "term_B", tabId: "t2", leafId: "l2", title: "미국", worktreePath: "/x/Projects/AcmeApp/us", worktreeId: "wt2", lastOutputAt: 2 },
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

describe("unread — 완료 후 확인 여부로 색 전환", () => {
  const mk = (state: string, unread: boolean) => {
    const terms = [{ handle: "term_A", tabId: "t1", leafId: "l1", title: "x", worktreePath: "/x", worktreeId: "wt1" }];
    const wts = [{ worktreeId: "wt1", repo: "x", displayName: "main", unread, agents: [{ paneKey: "t1:l1", state }] }];
    return buildDeck({ terminals: terms, worktrees: wts }).slots[0] as any;
  };
  it("done + 안읽음 → 초록", () => expect(mk("done", true).color).toBe("green"));
  it("done + 읽음 → 흰색(idle)", () => expect(mk("done", false).color).toBe("white"));
  it("working은 읽어도 파랑 유지(unread는 done에만)", () => expect(mk("working", false).color).toBe("blue"));
});

describe("buildDeck — orca 두 소스를 8칸 버튼 모델로", () => {
  it("항상 8칸 고정, 앞 2칸만 채워지고 나머진 빈칸", () => {
    const deck = buildDeck({ terminals, worktrees });
    expect(deck.slots).toHaveLength(8);
    expect(deck.slots.slice(2).every((s) => s.empty)).toBe(true);
    expect(deck.total).toBe(2);
  });

  it("handle(터미널) + state(워크트리)를 paneKey로 병합", () => {
    const deck = buildDeck({ terminals, worktrees });
    const a = deck.slots[0];
    expect(a.empty).toBe(false);
    expect(a).toMatchObject({ handle: "term_A", state: "working", color: "blue", label: "unparkxing 포스팅" });
    const b = deck.slots[1];
    expect(b).toMatchObject({ handle: "term_B", state: "waiting", color: "amber" });
  });

  it("worktreeId로 repo·branch를 붙임(displayName 우선, refs/heads/ 제거)", () => {
    const terms = [
      { handle: "term_A", tabId: "t1", leafId: "l1", title: "작업", worktreePath: "/p/unparkxing", worktreeId: "wt1" },
    ];
    const wts = [
      { worktreeId: "wt1", repo: "unparkxing", branch: "refs/heads/feat/login", displayName: "feat/login", agents: [{ paneKey: "t1:l1", state: "working" }] },
    ];
    const a = buildDeck({ terminals: terms, worktrees: wts }).slots[0] as any;
    expect(a.repo).toBe("unparkxing");
    expect(a.branch).toBe("feat/login");
  });

  it("에이전트 없는 셸 터미널은 세션판에서 제외", () => {
    const deck = buildDeck({ terminals, worktrees });
    const handles = deck.slots.filter((s) => !s.empty).map((s) => s.handle);
    expect(handles).not.toContain("term_shell");
  });

  it("빈 칸은 { empty: true }", () => {
    const deck = buildDeck({ terminals, worktrees });
    expect(deck.slots[7]).toEqual({ empty: true });
  });

  it("위치 고정 — handle 기준 안정 정렬(활동 순서 무관)", () => {
    const ts = [
      { handle: "term_c", tabId: "t1", leafId: "l1", title: "c", worktreePath: "/x", lastOutputAt: 100 },
      { handle: "term_a", tabId: "t2", leafId: "l2", title: "a", worktreePath: "/x", lastOutputAt: 999 },
      { handle: "term_b", tabId: "t3", leafId: "l3", title: "b", worktreePath: "/x", lastOutputAt: 500 },
    ];
    const wts = ts.map((t) => ({ agents: [{ paneKey: `${t.tabId}:${t.leafId}`, state: "done" }] }));
    const deck = buildDeck({ terminals: ts, worktrees: wts });
    // lastOutputAt과 무관하게 handle 순서(a,b,c)로 고정
    expect(deck.slots.slice(0, 3).map((s: any) => s.handle)).toEqual(["term_a", "term_b", "term_c"]);
  });

  it("페이지네이션 — 8칸 초과 시 페이지 분할", () => {
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
