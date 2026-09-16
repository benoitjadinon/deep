// AgentDeck 코어: orca의 두 소스(terminal list + worktree ps)를
// Stream Deck Plus 버튼 8칸 모델로 변환하는 순수 함수.
// 실물 Stream Deck 없이도 이 계층은 전부 테스트 가능하다.

import { resolveRepoBgIcon, type ResolvedBgIcon } from "./icons.ts";

export type AgentState = "working" | "waiting" | "done" | "error" | "unverifiable" | "idle" | string | undefined;
export type Color = "blue" | "amber" | "green" | "red" | "white";

/** Orca와 동일한 비활성 상태 감쇠 시간 (30분) */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000;

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
  agents?: Array<{
    paneKey: string;
    state?: AgentState;
    agentType?: string;
    updatedAt?: number;
    stateStartedAt?: number;
    evidenceObservedAt?: number;
  }>;
}

/** orca repo list --json / project list --json 중 아이콘/색상 관련 필드 */
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
}

export type Button =
  | { empty: true }
  | {
      empty: false;
      handle: string;
      label: string;
      tabTitle?: string; // Orca 탭 제목 (2줄 요약 렌더용)
      state: AgentState;
      color: Color;
      worktreePath?: string;
      worktreeId?: string; // `<repoId>::<path>` — 빈 슬롯에서 같은 repo에 새 워크트리를 만들 때 repoId 추출용
      lastOutputAt?: number | null;
      repo?: string;
      branch?: string;
      dupIndex?: number; // 같은 repo(branch) 내 순번 (0=첫째, 1↑는 -N 표기)
      unread?: boolean; // 완료됐지만 아직 안 본 상태 표시용
      agentType?: string; // orca가 보고한 에이전트 종류 (claude/codex/opencode/…) — 다이얼 게이팅에 사용
      badgeColor?: string; // orca 프로젝트 뱃지 색상 (예: #ef4444)
      repoIcon?: OrcaRepoIcon | null; // orca 프로젝트 원본 아이콘 메타
      bgIconUri?: string; // 타일 배경에 그릴 이미지 Data URI (GitHub 아바타, 로컬 icon.png)
      bgIconLucide?: string; // 타일 배경에 그릴 Lucide SVG 내부 태그 (Rocket, Folder 등)
      bgIconEmoji?: string; // 타일 배경에 그릴 이모지
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
 * 같은 repo에 이미 있는 워크트리 이름들 중 `repo-N` 번호 최대값 + 1로 새 워크트리 이름을 만든다.
 * repo 자체가 1번이라고 보고 첫 새 워크트리는 `repo-2`가 된다. 이름은 곧 브랜치/표시명이 된다.
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
 * 주의(애니메이션)가 필요한 세션인지 — orca가 "다 됐다/대답 필요"를 알릴 때 키가 확 띄게.
 * 대상 = 입력대기(amber)·완료 미확인(green)·에러(red). 작업중(blue)·idle(white)·stale(unverifiable)은 조용히.
 * 현재 보고 있는 세션(target)이라도 대답/승인 필요(amber)나 에러(red)는 행동이 필요하므로 펄스 유지.
 * 완료 미확인(green)은 이미 보고 있으므로 제외, 이미 읽은 완료 세션(unread===false)도 펄스 불필요.
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
 * orca 두 소스를 병합해 8칸(기본) 버튼 모델을 만든다.
 * - paneKey(`tabId:leafId`)로 terminal(handle)과 worktree agent(state)를 join
 * - 에이전트 상태가 없는 순수 셸 터미널은 세션판에서 제외
 * - handle 기준 안정 정렬(활동에 따라 버튼이 춤추지 않도록 = 근육 기억 보존)
 * - perPage(기본 8) 단위 페이지네이션, 빈 칸은 { empty: true }로 패딩
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

  // paneKey → state 맵 + 폴백 에이전트 타입 + worktreeId → {repo, branch} 메타
  const stateByPane = new Map<string, AgentState>();
  const agentByPane = new Map<string, string>();
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
      // 같은 paneKey의 에이전트가 여럿일 수 있으니 첫 번째만 (폴백), 보통 0~1개
      if (!agentByPane.has(a.paneKey)) agentByPane.set(a.paneKey, a.agentType ?? "");
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

  // 에이전트가 붙은 터미널만 세션으로. 위치 고정 = handle 기준 안정 정렬.
  // (최근순으로 하면 세션이 출력할 때마다 자리가 바뀌어 헷갈림 → 세션 수명 동안 자리 고정)
  // 판정: worktree ps가 그 paneKey의 에이전트를 아직 안 보고했더라도
  // 터미널의 agentIdentity가 있으면 "열려 있는 에이전트"로 취급한다.
  const sessions = (input.terminals ?? [])
    .map((t) => {
      const pane = `${t.tabId}:${t.leafId}`;
      const hasWt = stateByPane.has(pane);
      const idFromWt = agentByPane.get(pane);
      const hook = getHook(pane);
      // 에이전트 세션 유효성 판정:
      // worktree ps에 에이전트가 있거나(hasWt) 터미널에 활성 에이전트 프로세스가 감지된 경우(t.agentIdentity)만 인정.
      // 이미 종료된 셸 터미널에 이전 세션의 훅 잔여물이 있더라도 세션으로 부활시키지 않는다.
      const hasAgent = hasWt || Boolean(t.agentIdentity);
      if (!hasAgent) {
        return null;
      }

      // 우선순위: worktree ps 등록 에이전트 > 훅 원본 에이전트 > 터미널 프로세스 추정치
      const agent = idFromWt || hook?.agentType || t.agentIdentity || "";
      const hookEvent = hook?.hookEventName;
      const tabTitle = getTabTitle(t.tabId) || t.title || undefined;

      let state: AgentState;
      if (hasWt) {
        state = stateByPane.get(pane) || "idle";
        // PreToolUse/Notification 단계는 도구 실행 승인/응답 대기 중이므로 waiting(amber)으로 표시
        // 단, 이미 unverifiable(비활성 감쇠)이거나 done인 경우 오래된 훅 이벤트 잔여물로 덮어쓰지 않음
        if (state !== "unverifiable" && state !== "done") {
          if (hookEvent === "PreToolUse" || hookEvent === "Notification") {
            state = "waiting";
          } else if (hookEvent === "PostToolUse" || hookEvent === "UserPrompt") {
            state = "working";
          }
        }
      } else {
        // worktree ps 보고 전이지만 터미널 agentIdentity로 감지된 경우
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
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.t.handle.localeCompare(b.t.handle));

  // 저장소 메타 색인: repoId, path, displayName 기준
  const repoById = new Map<string, OrcaRepo>();
  const repoByPath = new Map<string, OrcaRepo>();
  const repoByName = new Map<string, OrcaRepo>();
  for (const r of input.repos ?? []) {
    if (r.id) repoById.set(r.id, r);
    if (r.path) repoByPath.set(r.path, r);
    if (r.displayName) repoByName.set(r.displayName.toLowerCase(), r);
  }

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
    const repoId = e.item.t.worktreeId ? e.item.t.worktreeId.split("::")[0] : undefined;
    const repo =
      (repoId ? repoById.get(repoId) : undefined) ||
      (e.item.t.worktreePath ? repoByPath.get(e.item.t.worktreePath) : undefined) ||
      (e.project ? repoByName.get(e.project.toLowerCase()) : undefined);

    const iconInfo = repo ? resolveRepoBgIcon(repo) : undefined;

    slots.push({
      empty: false,
      handle: e.item.t.handle,
      label: e.item.tabTitle || e.item.t.title || "",
      tabTitle: e.item.tabTitle || e.item.t.title || undefined,
      state: e.item.state,
      color: colorFor(e.item.state),
      worktreePath: e.item.t.worktreePath,
      worktreeId: e.item.t.worktreeId,
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

/** visualLayouts 트리에서 모든 탭의 (tabId -> title) 맵을 추출 */
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

/** visualLayouts의 pane/tab 트리에서 모든 활성 탭/터미널 정보(tabId, leafId, handle)를 재귀 탐색 */
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

/** visualLayouts의 pane/tab 트리에서 첫 번째 활성 터미널 정보 탐색 (하위 호환) */
export function findActivePaneInLayout(node: any): { tabId?: string; leafId?: string; handle?: string } | undefined {
  const all = findAllActivePanesInLayout(node);
  return all[0];
}

/**
 * Orca의 worktrees, terminals, visualLayouts 정보를 종합하여
 * 현재 사용자가 보고 있는(활성화된) 터미널 handle을 찾아낸다.
 * - visualLayouts에서 활성 탭/터미널 목록을 추출 (스플릿 레이아웃 포함).
 * - 현재 타깃이 레이아웃의 활성 탭들 중 하나라면 그대로 유지 (스플릿의 다른 쪽 탭으로 튕기지 않음).
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

  // 1. visualLayouts가 있으면 해당 워크트리의 모든 활성 탭/터미널을 찾는다
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
      // 현재 선택된 타깃이 레이아웃의 활성 탭들 중 하나라면 유지
      if (currentTargetHandle && activeHandles.includes(currentTargetHandle)) {
        return currentTargetHandle;
      }
      if (activeHandles.length > 0) {
        return activeHandles[0];
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

