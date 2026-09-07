// 에이전트별 추상 인터페이스 및 구현체 — 어떤 에이전트가 어떤 명령으로 모델/effort를 바꾸는가.
// 순수 함수 및 객체 지향 모델(테스트 가능). orca worktree ps가 보고하는 agentType(claude/codex/opencode/…)과 연결된다.
// 핵심: 지원하지 않는 에이전트 및 미구현 기능에 잘못된 명령을 보내지 않도록 게이팅. 모르는 에이전트 = 지원 안 함.

import { readFileSync, existsSync, readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type ControlKind = "model" | "effort" | "mode";

/** 터미널로 보낼 한 단계(라인). 픽커/드롭다운 등 UI 반응이 필요하면 delayMs로 이전 전송 후 대기. */
export interface ApplyStep {
  text: string;
  enter: boolean;
  delayMs?: number;
}

export interface AgentStateSnapshot {
  model?: string;
  effort?: string;
  mode?: string;
  recentModels?: string[];
  favoriteModels?: string[];
}

/**
 * 에이전트 추상 클래스 (Abstract Agent Interface)
 * 플러그인이 선택된 에이전트에서 어떤 기능이 지원되는지 검사하고 명령/목록을 요청하는 표준 인터페이스.
 */
export abstract class AbstractAgent {
  abstract readonly agentType: string;
  abstract readonly label: string;

  /** 특정 제어 기능(모델, effort, 모드) 지원 여부 */
  abstract supports(kind: ControlKind): boolean;

  /** 사용 가능한 모델 목록 (정적 폴백 또는 기본값) */
  getModels(): string[] {
    return [];
  }

  /** 사용 가능한 effort 목록 */
  getEfforts(_modelId?: string): string[] {
    return [];
  }

  /** 사용 가능한 모드/에이전트 목록 */
  getModes(): string[] {
    return [];
  }

  /** 변경 적용을 위한 터미널 전송 시퀀스 생성 */
  abstract getApplySteps(kind: ControlKind, value: string, fromValue?: string): ApplyStep[];

  /** 모델 목록을 가져올 호스트 CLI (인자 배열) */
  getDiscoverModelCmd(): string[] | undefined {
    return undefined;
  }

  /** 모드 목록을 가져올 호스트 CLI */
  getDiscoverAgentCmd(): string[] | undefined {
    return undefined;
  }

  /** 모델별 변형(effort)을 가져올 호스트 CLI */
  getDiscoverVariantCmd(): string[] | undefined {
    return undefined;
  }

  /** CLI 출력에서 모델 목록 파싱 */
  parseDiscoveredModels(stdout: string): string[] {
    return parseModels(stdout);
  }

  /** CLI 출력에서 모드 목록 파싱 */
  parseDiscoveredModes(stdout: string): string[] {
    return parsePrimaryAgents(stdout);
  }

  /** CLI 출력에서 모델별 변형(effort) 파싱 */
  parseDiscoveredEfforts(stdout: string, modelId: string): string[] {
    return parseModelVariants(stdout, modelId);
  }

  /** 로컬 상태 파일/설정에서 현재 선택된 상태 읽기 */
  readCurrentState(): AgentStateSnapshot {
    return {};
  }

  /** 모델 선택 시 해당 모델에 귀속되거나 내포된 effort(변형)가 있다면 반환 */
  getEffortForModel(_model: string): string | undefined {
    return undefined;
  }

  /** 발견된 모델 id→표시이름 맵 설정 (opencode 등 — 픽커 필터 텍스트에 사용) */
  setModelNames(_names: Record<string, string>): void {}

  /** 발견 출력에서 모델 id→표시이름 맵 추출 */
  parseDiscoveredModelNames(_stdout: string): Record<string, string> {
    return {};
  }
}

const slash = (cmd: string, value: string): ApplyStep[] => [
  { text: `${cmd} ${value}`, enter: true, delayMs: 120 },
];

const picker = (cmd: string, value: string): ApplyStep[] => [
  { text: cmd, enter: true, delayMs: 450 },
  { text: value, enter: true },
];

const modePicker = (value: string): ApplyStep[] => [
  { text: "\x18", enter: false, delayMs: 300 }, // ctrl+x (leader)
  { text: "a", enter: false, delayMs: 450 }, // agent list dialog
  { text: value, enter: true },
];

// opencode 모델 픽커: 리더(ctrl+x)+m으로 다이얼로그를 확정적으로 열고, 필터에
// '프로바이더 표시이름'을 입력한다. Enter는 보내지 않는다 — 사용자가 픽커에서 확인한다.
// 필터 텍스트에 프로바이더가 들어가야 opencode/openrouter처럼 같은 이름의 모델을 구분할 수 있다.
const openCodeModelPicker = (value: string, name?: string): ApplyStep[] => [
  { text: "\x18", enter: false, delayMs: 300 }, // ctrl+x (leader)
  { text: "m", enter: false, delayMs: 450 }, // model list dialog
  { text: modelFilterText(value, name), enter: false },
];

// Claude 구현체
export class ClaudeAgent extends AbstractAgent {
  readonly agentType = "claude";
  readonly label = "Claude";

  supports(kind: ControlKind): boolean {
    return kind === "model";
  }

  override getModels(): string[] {
    return ["opus", "sonnet", "haiku"];
  }

  override getEfforts(): string[] {
    return [];
  }

  override getModes(): string[] {
    return [];
  }

  getApplySteps(kind: ControlKind, value: string): ApplyStep[] {
    if (kind === "model") {
      return slash("/model", value);
    }
    return [];
  }
}

// Codex 설정 및 모델 캐시 파일 경로
export const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
export const CODEX_MODELS_CACHE = join(homedir(), ".codex", "models_cache.json");

export function parseCodexConfig(toml: string): { model?: string; effort?: string } {
  const modelMatch = /^model\s*=\s*"([^"]+)"/m.exec(toml || "");
  const effortMatch = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml || "");
  return {
    model: modelMatch ? modelMatch[1] : undefined,
    effort: effortMatch ? effortMatch[1] : undefined,
  };
}

export function parseCodexModelsCache(text: string): string[] {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j?.models)) {
      return j.models
        .map((m: any) => m?.slug)
        .filter((s: any) => typeof s === "string" && s && !s.includes("auto-review"));
    }
  } catch {}
  return [];
}

export function readCodexState(): AgentStateSnapshot {
  try {
    if (existsSync(CODEX_CONFIG)) {
      const cfg = parseCodexConfig(readFileSync(CODEX_CONFIG, "utf8"));
      return { model: cfg.model };
    }
  } catch {}
  return {};
}

export function readCodexModelsCache(): string[] {
  try {
    if (existsSync(CODEX_MODELS_CACHE)) {
      return parseCodexModelsCache(readFileSync(CODEX_MODELS_CACHE, "utf8"));
    }
  } catch {}
  return [];
}

// Codex 구현체
export class CodexAgent extends AbstractAgent {
  readonly agentType = "codex";
  readonly label = "Codex";

  supports(kind: ControlKind): boolean {
    return kind === "model";
  }

  override getModels(): string[] {
    const cached = readCodexModelsCache();
    if (cached.length) return cached;
    return ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-mini", "gpt-reserve"];
  }

  override getEfforts(): string[] {
    return [];
  }

  override getModes(): string[] {
    return [];
  }

  getApplySteps(kind: ControlKind, value: string): ApplyStep[] {
    if (kind === "model") {
      return slash("/model", value);
    }
    return [];
  }

  override readCurrentState(): AgentStateSnapshot {
    return readCodexState();
  }
}

// OpenCode 상태 및 TUI 경로
export const OPENCODE_STATE = join(homedir(), ".local", "state", "opencode", "model.json");
export const OPENCODE_TUI = join(homedir(), ".local", "state", "opencode", "tui");

export function readOpenCodeState(): OpenCodeModelState {
  try {
    return parseOpenCodeState(readFileSync(OPENCODE_STATE, "utf8"));
  } catch {
    return {};
  }
}

export function readTuiAgent(): string | undefined {
  try {
    return parseTuiAgent(readFileSync(OPENCODE_TUI, "utf8"));
  } catch {
    return undefined;
  }
}

// OpenCode 구현체
export class OpenCodeAgent extends AbstractAgent {
  readonly agentType = "opencode";
  readonly label = "OpenCode";

  private modelNames: Record<string, string> = {};

  supports(kind: ControlKind): boolean {
    return kind === "model" || kind === "effort" || kind === "mode";
  }

  override getModels(): string[] {
    return [];
  }

  override getEfforts(): string[] {
    return ["low", "medium", "high", "max"];
  }

  override getModes(): string[] {
    return ["build", "plan"];
  }

  override setModelNames(names: Record<string, string>): void {
    this.modelNames = names;
  }

  getApplySteps(kind: ControlKind, value: string): ApplyStep[] {
    if (kind === "model") {
      return openCodeModelPicker(value, this.modelNames[value]);
    }
    if (kind === "effort") {
      return picker("/variants", value);
    }
    if (kind === "mode") {
      return modePicker(value);
    }
    return [];
  }

  override getDiscoverModelCmd(): string[] | undefined {
    return ["opencode", "models", "--verbose"];
  }

  override parseDiscoveredModels(stdout: string): string[] {
    return parseModelIdLines(stdout);
  }

  override parseDiscoveredModelNames(stdout: string): Record<string, string> {
    return parseOpenCodeModelNames(stdout);
  }

  override getDiscoverAgentCmd(): string[] | undefined {
    return ["opencode", "agent", "list"];
  }

  override getDiscoverVariantCmd(): string[] | undefined {
    return ["opencode", "models", "--verbose"];
  }

  override readCurrentState(): AgentStateSnapshot {
    const st = readOpenCodeState();
    const tuiAgent = readTuiAgent();
    const model = st.model ? `${st.model.providerID}/${st.model.modelID}` : undefined;
    const effort = model && st.variant ? st.variant[model] : undefined;
    return {
      model,
      effort,
      mode: tuiAgent,
      recentModels: st.recent,
      favoriteModels: st.favorites,
    };
  }

  override getEffortForModel(model: string): string | undefined {
    const st = readOpenCodeState();
    return st.variant ? st.variant[model] : undefined;
  }
}

// Agy 설정 경로
export const AGY_SETTINGS = join(homedir(), ".gemini", "antigravity-cli", "settings.json");

export function extractEffortFromModel(modelName?: string): string | undefined {
  if (!modelName) return undefined;
  const s = modelName.trim().toLowerCase();
  const parenMatch = s.match(/\((low|medium|high|max|thinking)\)/);
  if (parenMatch) return parenMatch[1];
  const hyphenMatch = s.match(/-(low|medium|high|max|thinking)$/);
  if (hyphenMatch) return hyphenMatch[1];
  return undefined;
}

export const AGY_MODES = ["default", "plan", "accept-edits"] as const;

export function normalizeAgyMode(mode?: string): string {
  if (!mode) return "default";
  const m = mode.trim().toLowerCase();
  if (m === "nothing" || m === "none" || m === "normal" || m === "default" || m === "") return "default";
  if (m === "plan") return "plan";
  if (m === "accept-edits" || m === "acceptedits" || m === "accept_edits" || m === "yolo") return "accept-edits";
  return m;
}

export function parseAgyHelpModes(text: string): string[] {
  const match = /--mode\s+.*?\((\s*[\w\-_,\s]+\s*)\)/i.exec(text || "");
  if (!match) return [];
  const rawList = match[1]
    .split(/[,|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!rawList.length) return [];
  const set = new Set<string>(["default"]);
  const out: string[] = ["default"];
  const preferredOrder = ["plan", "accept-edits"];
  for (const p of preferredOrder) {
    if (rawList.some((r) => normalizeAgyMode(r) === p)) {
      set.add(p);
      out.push(p);
    }
  }
  for (const item of rawList) {
    const normalized = normalizeAgyMode(item);
    if (normalized && !set.has(normalized)) {
      set.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function getAgyShiftTabSteps(toMode: string, fromMode?: string, modeList?: string[]): ApplyStep[] {
  const list = modeList && modeList.length ? modeList : (AGY_MODES as unknown as string[]);
  const target = normalizeAgyMode(toMode);
  const current = normalizeAgyMode(fromMode);
  const targetIdx = list.indexOf(target);
  const currentIdx = list.indexOf(current);
  if (targetIdx < 0) {
    return [{ text: "\x1b[Z", enter: false }];
  }
  const fromIdx = currentIdx < 0 ? 0 : currentIdx;
  const count = (targetIdx - fromIdx + list.length) % list.length;
  if (count === 0) return [];
  const steps: ApplyStep[] = [];
  for (let i = 0; i < count; i++) {
    steps.push({
      text: "\x1b[Z",
      enter: false,
      ...(i > 0 ? { delayMs: 120 } : {}),
    });
  }
  return steps;
}

export function parseAgySettings(text: string): { model?: string; mode?: string } {
  try {
    const data = JSON.parse(text);
    const out: { model?: string; mode?: string } = {};
    if (typeof data?.model === "string" && data.model) {
      out.model = data.model;
    }
    const rawMode = typeof data?.mode === "string" ? data.mode : typeof data?.agent === "string" ? data.agent : undefined;
    if (rawMode) {
      out.mode = normalizeAgyMode(rawMode);
    }
    return out;
  } catch {}
  return {};
}

export function parseAgyModels(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (stdout || "").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line || line.startsWith("Fetching")) continue;
    const parts = line.split("\t");
    const id = parts[0]?.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function parseAgyAgents(stdout: string): string[] {
  const seen = new Set<string>(["default"]);
  const out: string[] = ["default"];
  for (const raw of (stdout || "").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line || line.toLowerCase().startsWith("available agents:") || line.startsWith("Fetching")) continue;
    const name = line.split(/\s+/)[0]?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export const AGY_LOG_DIR = join(homedir(), ".gemini", "antigravity-cli", "log");

export function parseAgyLogMode(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\]\s+SetCycleMode called:\s*([a-zA-Z0-9_\-]*)/.exec(lines[i]);
    if (m) {
      return normalizeAgyMode(m[1]);
    }
  }
  return undefined;
}

export function readAgyLiveMode(): string | undefined {
  try {
    if (!existsSync(AGY_LOG_DIR)) return undefined;
    const files = readdirSync(AGY_LOG_DIR)
      .filter((f) => f.startsWith("cli-") && f.endsWith(".log"))
      .map((f) => ({ path: join(AGY_LOG_DIR, f), mtime: statSync(join(AGY_LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const file of files.slice(0, 3)) {
      try {
        const fd = openSync(file.path, "r");
        const size = fstatSync(fd).size;
        const readLen = Math.min(size, 128 * 1024);
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
        closeSync(fd);
        const mode = parseAgyLogMode(buf.toString("utf8", 0, readLen));
        if (mode) return mode;
      } catch {}
    }
  } catch {}
  return undefined;
}

export function readAgyState(): AgentStateSnapshot {
  let model: string | undefined;
  let effort: string | undefined;
  let mode: string | undefined;
  try {
    if (existsSync(AGY_SETTINGS)) {
      const cfg = parseAgySettings(readFileSync(AGY_SETTINGS, "utf8"));
      model = cfg.model;
      effort = extractEffortFromModel(cfg.model);
      if (cfg.mode) mode = normalizeAgyMode(cfg.mode);
    }
  } catch {}

  const liveMode = readAgyLiveMode();
  if (liveMode) {
    mode = liveMode;
  }
  return { model, effort, mode };
}

// Agy 구현체
export class AgyAgent extends AbstractAgent {
  readonly agentType = "agy";
  readonly label = "Agy";

  supports(kind: ControlKind): boolean {
    return kind === "model" || kind === "effort" || kind === "mode";
  }

  override getModels(): string[] {
    return [
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.7-flash-medium",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
    ];
  }

  override getEfforts(): string[] {
    return ["low", "medium", "high"];
  }

  override getModes(): string[] {
    return [...AGY_MODES];
  }

  getApplySteps(kind: ControlKind, value: string, fromValue?: string): ApplyStep[] {
    if (kind === "model") {
      return slash("/model", value);
    }
    if (kind === "effort") {
      return slash("/effort", value);
    }
    if (kind === "mode") {
      return getAgyShiftTabSteps(value, fromValue);
    }
    return [];
  }

  override getDiscoverModelCmd(): string[] | undefined {
    return ["agy", "models"];
  }

  override getDiscoverAgentCmd(): string[] | undefined {
    return ["agy", "--help"];
  }

  override parseDiscoveredModels(stdout: string): string[] {
    return parseAgyModels(stdout);
  }

  override parseDiscoveredModes(stdout: string): string[] {
    return parseAgyHelpModes(stdout);
  }

  override readCurrentState(): AgentStateSnapshot {
    return readAgyState();
  }

  override getEffortForModel(model: string): string | undefined {
    return extractEffortFromModel(model);
  }
}

// 미지원 에이전트 폴백
export class UnsupportedAgent extends AbstractAgent {
  readonly agentType = "";
  readonly label = "미지원";

  supports(_kind: ControlKind): boolean {
    return false;
  }

  getApplySteps(_kind: ControlKind, _value: string): ApplyStep[] {
    return [];
  }
}

const AGENT_INSTANCES: Record<string, AbstractAgent> = {
  claude: new ClaudeAgent(),
  codex: new CodexAgent(),
  code: new CodexAgent(),
  opencode: new OpenCodeAgent(),
  agy: new AgyAgent(),
  antigravity: new AgyAgent(),
};

export const UNSUPPORTED_AGENT = new UnsupportedAgent();

/** 에이전트 타입에 해당하는 추상 에이전트 인스턴스 반환 */
export function agentFor(agentType: string | undefined | null): AbstractAgent {
  if (!agentType) return UNSUPPORTED_AGENT;
  const key = agentType.trim().toLowerCase();
  return AGENT_INSTANCES[key] ?? UNSUPPORTED_AGENT;
}

// 하위 호환성용 프로파일 인터페이스
export interface AgentProfile {
  agentType: string;
  label: string;
  models: string[];
  efforts: string[];
  modes: string[];
  model: { supported: boolean; steps: (value: string, fromValue?: string) => ApplyStep[] };
  effort: { supported: boolean; steps: (value: string, fromValue?: string) => ApplyStep[] };
  mode: { supported: boolean; steps: (value: string, fromValue?: string) => ApplyStep[] };
}

export function profileFor(agentType: string | undefined | null): AgentProfile {
  const agent = agentFor(agentType);
  return {
    agentType: agent.agentType,
    label: agent.label,
    models: agent.getModels(),
    efforts: agent.getEfforts(),
    modes: agent.getModes(),
    model: {
      supported: agent.supports("model"),
      steps: (v, from) => agent.getApplySteps("model", v, from),
    },
    effort: {
      supported: agent.supports("effort"),
      steps: (v, from) => agent.getApplySteps("effort", v, from),
    },
    mode: {
      supported: agent.supports("mode"),
      steps: (v, from) => agent.getApplySteps("mode", v, from),
    },
  };
}

export const UNSUPPORTED_PROFILE: AgentProfile = profileFor("");

export const AGENTS: Record<string, AgentProfile> = {
  claude: profileFor("claude"),
  codex: profileFor("codex"),
  code: profileFor("code"),
  opencode: profileFor("opencode"),
  agy: profileFor("agy"),
  antigravity: profileFor("antigravity"),
};

export function supported(agent: AbstractAgent | AgentProfile, kind: ControlKind): boolean {
  if ("supports" in agent && typeof agent.supports === "function") {
    return agent.supports(kind);
  }
  return (agent as AgentProfile)[kind].supported;
}

export function stepsFor(agent: AbstractAgent | AgentProfile, kind: ControlKind, value: string, fromValue?: string): ApplyStep[] {
  if ("getApplySteps" in agent && typeof agent.getApplySteps === "function") {
    return agent.getApplySteps(kind, value, fromValue);
  }
  return (agent as AgentProfile)[kind].steps(value, fromValue);
}

export const DISCOVER_MODEL_CMD: Record<string, string[]> = {
  opencode: ["opencode", "models", "--verbose"],
  agy: ["agy", "models"],
  antigravity: ["agy", "models"],
};
export const DISCOVER_AGENT_CMD: Record<string, string[]> = {
  opencode: ["opencode", "agent", "list"],
  agy: ["agy", "--help"],
  antigravity: ["agy", "--help"],
};
export const DISCOVER_VARIANT_CMD: Record<string, string[]> = {
  opencode: ["opencode", "models", "--verbose"],
};

export const HIDDEN_PRIMARY_AGENTS = new Set(["compaction", "summary", "title"]);

export function discoverModelCmd(agentType: string | undefined | null): string[] | undefined {
  return agentFor(agentType).getDiscoverModelCmd();
}
export function discoverAgentCmd(agentType: string | undefined | null): string[] | undefined {
  return agentFor(agentType).getDiscoverAgentCmd();
}
export function discoverVariantCmd(agentType: string | undefined | null): string[] | undefined {
  return agentFor(agentType).getDiscoverVariantCmd();
}

export function parsePrimaryAgents(stdout: string): string[] {
  const out: string[] = [];
  for (let line of (stdout || "").split("\n")) {
    line = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const m = /^([\w.-]+)\s*\(primary\)$/.exec(line);
    if (m && !HIDDEN_PRIMARY_AGENTS.has(m[1])) out.push(m[1]);
  }
  return out;
}

export function parseModelVariants(stdout: string, modelId: string): string[] {
  for (const block of splitJsonBlocks(stdout || "")) {
    if (block.id === modelId && block.variants && typeof block.variants === "object") {
      const keys = Object.keys(block.variants);
      if (keys.length) return ["default", ...keys];
    }
  }
  return [];
}

export function splitJsonBlocks(text: string): Array<{ id?: string; variants?: unknown; [k: string]: unknown }> {
  const out: Array<{ id?: string; variants?: unknown; [k: string]: unknown }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("{")) continue;
    const buf = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      buf.push(lines[j]);
      try {
        const o = JSON.parse(buf.join("\n"));
        if (typeof o === "object" && o !== null) {
          out.push(o);
          i = j;
          break;
        }
      } catch {}
    }
  }
  return out;
}

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

// 모델 발견 출력(--verbose)에서 'providerID/modelID' 줄만 추출 — JSON 본문/기타 라인 제외.
export function parseModelIdLines(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (stdout || "").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    if (/^[A-Za-z0-9_~.:-]+\/[A-Za-z0-9_~./:-]+$/.test(line) && !seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

// --verbose JSON 블록에서 모델 id→표시이름 맵 추출 (픽커 필터 텍스트에 사용).
export function parseOpenCodeModelNames(stdout: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const block of splitJsonBlocks(stdout || "")) {
    const pid = block.providerID;
    const id = block.id;
    const name = block.name;
    if (typeof pid === "string" && typeof id === "string" && typeof name === "string" && name) {
      names[`${pid}/${id}`] = name;
    }
  }
  return names;
}

// 픽커 필터 텍스트: '프로바이더 표시이름'. 이름을 모르면 프로바이더만 남겨 사용자가 그 안에서 고른다.
export function modelFilterText(id: string, name?: string): string {
  const provider = id.split("/")[0] ?? "";
  const display = name?.trim();
  return display ? `${provider} ${display}` : provider;
}

export interface OpenCodeModelState {
  model?: { providerID: string; modelID: string };
  variant?: Record<string, string>;
  recent?: string[];
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

export function parseTuiAgent(text: string): string | undefined {
  const m = /^agent\s*=\s*"([^"]+)"/m.exec(text || "");
  return m ? m[1] : undefined;
}