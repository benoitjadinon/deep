// 에이전트별 프로파일 — 어떤 에이전트가 어떤 명령으로 모델/effort를 바꾸는가.
// 순수 함수(테스트 가능). orca worktree ps가 보고하는 agentType(claude/codex/opencode/…)과 연결된다.
// 핵심: 지원하지 않는 에이전트에 잘못된 명령을 보내지 않도록 게이팅. 모르는 에이전트 = 지원 안 함.

export type ControlKind = "model" | "effort";

/** 터미널로 보낼 한 단계(라인). 픽커/드롭다운 등 UI 반응이 필요하면 delayMs로 이전 전송 후 대기. */
export interface ApplyStep {
  text: string;
  enter: boolean;
  delayMs?: number;
}

export interface AgentProfile {
  agentType: string;
  label: string;
  /** 정적 폴백 목록 — 라이브 발견이 없는 에이전트용. 빈 배열이면 발견 전 다이얼 비활성. */
  models: string[];
  efforts: string[];
  model: { supported: boolean; steps: (value: string) => ApplyStep[] };
  effort: { supported: boolean; steps: (value: string) => ApplyStep[] };
}

/** 에이전트 타입 → 모델 목록을 가져올 호스트 CLI (인자가 없으면 발견 없음 = 정적 목록 사용) */
export const DISCOVER_MODEL_CMD: Record<string, string[]> = {
  opencode: ["opencode", "models"],
};

const slash = (cmd: string, value: string): ApplyStep[] => [
  { text: `${cmd} ${value}`, enter: true, delayMs: 120 },
];
// opencode 픽커(모델/변형): 슬래시 명령으로 다이얼로그 연 뒤 필터어를 타이핑하고 Enter.
// TabUI가 fuzzy로 첫 줄을 하이라이트하므로 입력만 하면 Enter로 그 항목이 선택된다.
const picker = (cmd: string, value: string): ApplyStep[] => [
  { text: cmd, enter: true, delayMs: 450 },
  { text: value, enter: true },
];

export const AGENTS: Record<string, AgentProfile> = {
  claude: {
    agentType: "claude",
    label: "Claude",
    models: ["opus", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "ultracode"],
    model: { supported: true, steps: (v) => slash("/model", v) },
    effort: { supported: true, steps: (v) => slash("/effort", v) },
  },
  opencode: {
    agentType: "opencode",
    label: "OpenCode",
    models: [], // 라이브 발견(opencode models)이 채운다. 발견 전엔 비어 있어 다이얼이 잠깐 "…" 표시.
    efforts: ["low", "medium", "high", "max"],
    model: { supported: true, steps: (v) => picker("/models", providerShort(v)) },
    effort: { supported: true, steps: (v) => picker("/variants", v) },
  },
  // 코드엑스/그 밖의 에이전트는 세션 중 모델 변경의 안전한 슬래시 명령이 없음 → 게이팅으로 차단.
};

export const UNSUPPORTED_PROFILE: AgentProfile = {
  agentType: "",
  label: "미지원",
  models: [],
  efforts: [],
  model: { supported: false, steps: () => [] },
  effort: { supported: false, steps: () => [] },
};

/** 모르는 agentType(null 포함)은 무조건 지원 안 함으로 — 잘못된 명령 방지. */
export function profileFor(agentType: string | undefined | null): AgentProfile {
  if (agentType && AGENTS[agentType]) return AGENTS[agentType];
  return UNSUPPORTED_PROFILE;
}

export function supported(p: AgentProfile, kind: ControlKind): boolean {
  return p[kind].supported;
}

export function stepsFor(p: AgentProfile, kind: ControlKind, value: string): ApplyStep[] {
  return p[kind].steps(value);
}

/** 이 에이전트의 모델 목록을 가져오는 호스트 CLI 인자. 없으면 발견 불가(정적 목록) */
export function discoverModelCmd(agentType: string | undefined | null): string[] | undefined {
  return agentType ? DISCOVER_MODEL_CMD[agentType] : undefined;
}

/** 발견 출력(한 줄에 모델 ID 하나) → 모델 ID 배열. 빈 줄/공백/ANSI 코드 제거. */
export function parseModels(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** "provider/model" → "model" — 픽커 필터 타이핑용으로 접두어 제거. */
export function providerShort(id: string): string {
  const i = id.indexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}

/** opencode 모델 상태 파일(~/.local/state/opencode/model.json)에서 현재 선택/최근/즐겨찾기/변형을 뽑는다. 순수 파싱. */
export interface OpenCodeModelState {
  model?: { providerID: string; modelID: string };
  variant?: Record<string, string>;
  /** 최근 사용 순(가장 최근이 첫 번째) 전체 모델 ID — "providerID/modelID" */
  recent?: string[];
  /** 즐겨찾기 순 전체 모델 ID — "providerID/modelID" */
  favorites?: string[];
}
function fullIds(entries: unknown): string[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const out: string[] = [];
  for (const e of entries) {
    if (e && typeof e === "object" && (e as any).providerID && (e as any).modelID) {
      out.push(`${String((e as any).providerID)}/${String((e as any).modelID)}`);
    }
  }
  return out.length ? out : undefined;
}
export function parseOpenCodeState(text: string): OpenCodeModelState {
  try {
    const j = JSON.parse(text);
    const r = Array.isArray(j?.recent) ? j.recent[0] : undefined;
    const model =
      r && typeof r === "object" && r.providerID && r.modelID
        ? { providerID: String(r.providerID), modelID: String(r.modelID) }
        : undefined;
    const variant =
      j?.variant && typeof j?.variant === "object" && !Array.isArray(j.variant) ? j.variant : undefined;
    return { model, variant, recent: fullIds(j?.recent), favorites: fullIds(j?.favorite) };
  } catch {
    return {};
  }
}

/**
 * 다이얼 회전용 모델 목록을 즐겨찾기 우선 → 최근 사용 순 → 나머지(발견 순서 그대로)로 정렬.
 * 발견 목록에 없는(제거된) 항목은 건너뛴다. 순수(stable, 중복 제거).
 */
export function sortModels(discovered: string[], recent?: string[], favorites?: string[]): string[] {
  const have = new Set(discovered);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => {
    if (have.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const f of favorites ?? []) push(f);
  for (const r of recent ?? []) push(r);
  for (const d of discovered) push(d);
  return out;
}