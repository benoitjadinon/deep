// AgentDeck 코어: orca의 두 소스(terminal list + worktree ps)를
// Stream Deck Plus 버튼 8칸 모델로 변환하는 순수 함수.
// 실물 Stream Deck 없이도 이 계층은 전부 테스트 가능하다.

export type AgentState = "working" | "waiting" | "done" | "error" | string | undefined;
export type Color = "blue" | "amber" | "green" | "red" | "white";

/** orca terminal list --json → result.terminals[] 중 우리가 쓰는 필드 */
export interface OrcaTerminal {
  handle: string;
  tabId: string;
  leafId: string;
  title: string;
  worktreePath?: string;
  worktreeId?: string;
  lastOutputAt?: number | null;
}

/** orca worktree ps --json → result.worktrees[] 중 우리가 쓰는 필드 */
export interface OrcaWorktree {
  worktreeId?: string;
  repo?: string;
  branch?: string;
  displayName?: string;
  unread?: boolean; // 사용자가 최신 출력을 아직 안 봤으면 true (Orca가 열람 시 자동 false)
  agents?: Array<{ paneKey: string; state?: AgentState; agentType?: string }>;
}

export interface DeckInput {
  terminals: OrcaTerminal[];
  worktrees: OrcaWorktree[];
}

export interface DeckOptions {
  page?: number;
  perPage?: number;
}

export type Button =
  | { empty: true }
  | {
      empty: false;
      handle: string;
      label: string;
      state: AgentState;
      color: Color;
      worktreePath?: string;
      lastOutputAt?: number | null;
      repo?: string;
      branch?: string;
      dupIndex?: number; // 같은 repo(branch) 내 순번 (0=첫째, 1↑는 -N 표기)
      unread?: boolean; // 완료됐지만 아직 안 본 상태 표시용
      agentType?: string; // orca가 보고한 에이전트 종류 (claude/codex/opencode/…) — 다이얼 게이팅에 사용
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
  done: "green",
  error: "red",
};

/**
 * 경로에서 사람이 아는 "프로젝트명"을 뽑는다.
 * `/Projects/<X>/...` 면 X (예: AcmeApp/ko → "AcmeApp"),
 * 아니면 마지막 폴더명(예: .../Notes → "Notes"), 그것도 없으면 orca repo.
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

/** 상태 → 버튼 색. 모르는/빈 상태는 흰색(기본). */
export function colorFor(state: AgentState): Color {
  if (state && STATE_COLOR[state]) return STATE_COLOR[state];
  return "white";
}

/**
 * 주의(애니메이션)가 필요한 세션인지 — orca가 "다 됐다/대답 필요"를 알릴 때 키가 확 띄게.
 * 대상 = 입력대기(amber)·완료 미확인(green)·에러(red). 작업중(blue)·idle(white)은 조용히.
 * 지금 보는 세션(target)은 이미 눈앞이라 제외.
 */
export function needsAttention(b: Button, isTarget: boolean): boolean {
  if (b.empty || isTarget) return false;
  return b.color === "amber" || b.color === "green" || b.color === "red";
}

const EMPTY: Button = { empty: true };

/**
 * orca 두 소스를 병합해 8칸(기본) 버튼 모델을 만든다.
 * - paneKey(`tabId:leafId`)로 terminal(handle)과 worktree agent(state)를 join
 * - 에이전트 상태가 없는 순수 셸 터미널은 세션판에서 제외
 * - handle 기준 안정 정렬(활동에 따라 버튼이 춤추지 않도록 = 근육 기억 보존)
 * - perPage(기본 8) 단위 페이지네이션, 빈 칸은 { empty: true }로 패딩
 */
export function buildDeck(input: DeckInput, opts: DeckOptions = {}): Deck {
  const page = opts.page ?? 0;
  const perPage = opts.perPage ?? 8;

  // paneKey → state 맵 + 폴백 에이전트 타입 + worktreeId → {repo, branch} 메타
  const stateByPane = new Map<string, AgentState>();
  const agentByPane = new Map<string, string>();
  const metaByWt = new Map<string, { repo?: string; branch?: string; unread?: boolean }>();
  for (const wt of input.worktrees ?? []) {
    for (const a of wt.agents ?? []) {
      stateByPane.set(a.paneKey, a.state);
      // 같은 paneKey의 에이전트가 여럿일 수 있으니 첫 번째만 (폴백), 보통 0~1개
      if (!agentByPane.has(a.paneKey)) agentByPane.set(a.paneKey, a.agentType ?? "");
    }
    if (wt.worktreeId) {
      const branch = wt.displayName || (wt.branch ?? "").replace(/^refs\/heads\//, "");
      metaByWt.set(wt.worktreeId, { repo: wt.repo, branch: branch || undefined, unread: wt.unread });
    }
  }

  // 에이전트가 붙은 터미널만 세션으로. 위치 고정 = handle 기준 안정 정렬.
  // (최근순으로 하면 세션이 출력할 때마다 자리가 바뀌어 헷갈림 → 세션 수명 동안 자리 고정)
  const sessions = (input.terminals ?? [])
    .map((t) => ({ t, state: stateByPane.get(`${t.tabId}:${t.leafId}`) }))
    .filter((x) => stateByPane.has(`${x.t.tabId}:${x.t.leafId}`))
    .sort((a, b) => a.t.handle.localeCompare(b.t.handle));

  // 프로젝트명·브랜치·중복순번을 전체(정렬된) 세션 기준으로 부여 → 페이지 넘어도 안정
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
    // done인데 이미 읽었으면(unread===false) idle(흰색)로 — "끝났고 확인함"
    const reviewed = e.item.state === "done" && e.unread === false;
    slots.push({
      empty: false,
      handle: e.item.t.handle,
      label: e.item.t.title,
      state: e.item.state,
      color: reviewed ? "white" : colorFor(e.item.state),
      worktreePath: e.item.t.worktreePath,
      lastOutputAt: e.item.t.lastOutputAt,
      repo: e.project,
      branch: e.branch,
      dupIndex: e.dupIndex,
      unread: e.unread,
      agentType: agentByPane.get(`${e.item.t.tabId}:${e.item.t.leafId}`),
    });
  }

  return { slots, page, pageCount, total };
}
