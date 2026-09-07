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
  /** 터미널에 에이전트가 살아 있는지 — orca가 worktree ps에 보고하기 전이라도 즉시 감지. null/없음 = 순수 셸. */
  agentIdentity?: string | null;
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

export interface HookInfo {
  hookEventName?: string;
  agentType?: string;
}

export interface DeckInput {
  terminals: OrcaTerminal[];
  worktrees: OrcaWorktree[];
  hookEventsByPane?: Map<string, string | HookInfo> | Record<string, string | HookInfo>;
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
  blocked: "amber",
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
 * 현재 보고 있는 세션(target)이라도 대답/승인 필요(amber)나 에러(red)는 행동이 필요하므로 펄스 유지.
 * 완료 미확인(green)은 이미 보고 있으므로 제외.
 */
export function needsAttention(b: Button, isTarget: boolean): boolean {
  if (b.empty) return false;
  if (isTarget && b.color === "green") return false;
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
  // 판정: worktree ps가 그 paneKey의 에이전트를 아직 안 보고했더라도
  // 터미널의 agentIdentity가 있으면 "열려 있는 에이전트"로 취급한다.
  // 그 경우 state는 아직 몰라도 되니 기본 waiting(amber)으로 — 다이얼 게이팅이 제출 전부터 살아 있다.
  const sessions = (input.terminals ?? [])
    .map((t) => {
      const pane = `${t.tabId}:${t.leafId}`;
      const hasWt = stateByPane.has(pane);
      const idFromWt = agentByPane.get(pane);
      const hook = getHook(pane);
      // 우선순위: worktree ps 등록 에이전트 > 훅 원본 에이전트 > 터미널 프로세스 추정치
      const agent = idFromWt || hook?.agentType || t.agentIdentity || "";
      const wtState = hasWt ? stateByPane.get(pane) : "waiting";
      const hookEvent = hook?.hookEventName;

      let state = wtState;
      // agy/antigravity: PreToolUse 단계는 도구 실행 승인/응답 대기 중이므로 waiting(amber)으로 표시
      const isAgy =
        agent === "agy" ||
        agent === "antigravity" ||
        idFromWt === "agy" ||
        idFromWt === "antigravity" ||
        hook?.agentType === "agy" ||
        hook?.agentType === "antigravity";
      if (isAgy && hookEvent === "PreToolUse") {
        state = "waiting";
      }

      return {
        t,
        pane,
        hasWt,
        agent,
        state,
        agentType: agent,
      };
    })
    .filter((x) => x.hasWt || Boolean(x.agent))
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
      agentType: e.item.agentType,
    });
  }

  return { slots, page, pageCount, total };
}

/** visualLayouts의 pane/tab 트리에서 활성 터미널 정보(tabId, leafId, handle)를 재귀 탐색 */
export function findActivePaneInLayout(node: any): { tabId?: string; leafId?: string; handle?: string } | undefined {
  if (!node) return undefined;
  if (node.type === "terminal" && node.active) {
    return { tabId: node.tabId, leafId: node.leafId, handle: node.handle };
  }
  if (node.type === "group" && Array.isArray(node.tabs)) {
    const activeTab = node.tabs.find((t: any) => t.tabId === node.activeTabId) || node.tabs[0];
    if (activeTab) {
      if (activeTab.panes) {
        const found = findActivePaneInLayout(activeTab.panes);
        if (found) return { tabId: activeTab.tabId, leafId: activeTab.activeLeafId, ...found };
      }
      return { tabId: activeTab.tabId, leafId: activeTab.activeLeafId };
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findActivePaneInLayout(child);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Orca의 worktrees, terminals, visualLayouts 정보를 종합하여
 * 현재 사용자가 보고 있는(활성화된) 터미널 handle을 찾아낸다.
 * - visualLayouts에서 활성 탭/터미널을 최우선으로 반영.
 * - visualLayouts가 없더라도 현재 타깃이 이미 활성 워크트리에 있다면 튕기지 않고 유지.
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

  // 1. visualLayouts가 있으면 해당 워크트리의 실제 활성 탭/리프 터미널을 먼저 찾는다
  if (visualLayouts && visualLayouts.length > 0) {
    const vl = visualLayouts.find((v: any) => v.worktreeId === activeWtId);
    if (vl?.root) {
      const activePane = findActivePaneInLayout(vl.root);
      if (activePane?.handle) return activePane.handle;
      if (activePane?.tabId) {
        const termsInTab = terminals.filter((t) => t.worktreeId === activeWtId && t.tabId === activePane.tabId);
        if (activePane.leafId) {
          const matchLeaf = termsInTab.find((t) => t.leafId === activePane.leafId);
          if (matchLeaf) return matchLeaf.handle;
        }
        if (termsInTab.length > 0) return termsInTab[0].handle;
      }
    }
  }

  // 2. visualLayouts가 없거나 판별 불가인 경우:
  // 현재 타깃이 이미 활성 워크트리에 속해 있다면 유지 (불필요하게 1번째 세션으로 튕기지 않음)
  const termsInWt = terminals.filter((t) => t.worktreeId === activeWtId);
  if (currentTargetHandle && termsInWt.some((t) => t.handle === currentTargetHandle)) {
    return currentTargetHandle;
  }

  // 3. 현재 타깃이 다른 워크트리에 있는 경우에만 최신 출력 또는 첫 번째 터미널 선택
  const sorted = termsInWt.slice().sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0));
  return sorted[0]?.handle;
}

