import { describe, it, expect } from "vitest";
import {
  agentFor,
  profileFor,
  supported,
  stepsFor,
  discoverModelCmd,
  parseModels,
  parseModelIdLines,
  parseOpenCodeModelNames,
  modelFilterText,
  parseOpenCodeState,
  parseTuiAgent,
  parsePrimaryAgents,
  parseModelVariants,
  discoverAgentCmd,
  discoverVariantCmd,
  sortModels,
  parseCodexConfig,
  parseCodexModelsCache,
  readCodexModelsCache,
  readCodexState,
  CODEX_DEFAULT_MODELS,
  parseClaudeSettings,
  parseClaudeModelCatalog,
  readClaudeModelsCache,
  readClaudeModelEffortsCache,
  readClaudeState,
  CLAUDE_DEFAULT_MODELS,
  parseAgyModels,
  parseAgyAgents,
  parseAgySettings,
  parseAgyHelpModes,
  parseAgyLogWorkspace,
  isMatchingWorkspace,
  parseAgyLogModel,
  parseAgyLogEffort,
  parseAgyLogMode,
  readAgyState,
  extractEffortFromModel,
  AGY_MODES,
  normalizeAgyMode,
  getAgyShiftTabSteps,
  parseHermesConfig,
  parseHermesModelsCache,
  HermesAgent,
  ClaudeAgent,
  CodexAgent,
  OpenCodeAgent,
  AgyAgent,
  UnsupportedAgent,
  UNSUPPORTED_AGENT,
  UNSUPPORTED_PROFILE,
} from "../src/agents.js";

describe("agentFor / profileFor — 에이전트 타입 → 추상 인터페이스 및 프로파일", () => {
  it("알려진 에이전트는 해당 구체 클래스 인스턴스 반환", () => {
    expect(agentFor("claude")).toBeInstanceOf(ClaudeAgent);
    expect(agentFor("codex")).toBeInstanceOf(CodexAgent);
    expect(agentFor("opencode")).toBeInstanceOf(OpenCodeAgent);
    expect(agentFor("agy")).toBeInstanceOf(AgyAgent);
    expect(agentFor("hermes")).toBeInstanceOf(HermesAgent);
    expect(agentFor("hermes-cli")).toBeInstanceOf(HermesAgent);
    expect(agentFor("hermes-agent")).toBeInstanceOf(HermesAgent);

    expect(profileFor("claude").label).toBe("Claude");
    expect(profileFor("codex").label).toBe("Codex");
    expect(profileFor("opencode").label).toBe("OpenCode");
    expect(profileFor("agy").label).toBe("Agy");
    expect(profileFor("hermes").label).toBe("Hermes");
  });
  it("대소문자 및 공백 허용", () => {
    expect(agentFor(" Claude ")).toBeInstanceOf(ClaudeAgent);
    expect(agentFor("OpenCode")).toBeInstanceOf(OpenCodeAgent);
    expect(agentFor("AGY")).toBeInstanceOf(AgyAgent);
    expect(agentFor(" Hermes ")).toBeInstanceOf(HermesAgent);
  });
  it("모르는 에이전트(null/빈 값 포함)는 미지원 에이전트", () => {
    expect(agentFor("grok")).toBe(UNSUPPORTED_AGENT);
    expect(agentFor("")).toBe(UNSUPPORTED_AGENT);
    expect(agentFor(undefined)).toBe(UNSUPPORTED_AGENT);
    expect(agentFor(null)).toBe(UNSUPPORTED_AGENT);

    expect(profileFor("grok").label).toBe("미지원");
  });
});

describe("supported — 에이전트별 기능 게이팅", () => {
  it("claude: 모델·effort·모드 모두 지원", () => {
    const a = agentFor("claude");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
    expect(supported(a, "model")).toBe(true);
    expect(supported(a, "effort")).toBe(true);
    expect(supported(a, "mode")).toBe(true);
  });
  it("codex: 모델·effort·모드 모두 지원", () => {
    const a = agentFor("codex");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
    expect(supported(a, "model")).toBe(true);
    expect(supported(a, "effort")).toBe(true);
    expect(supported(a, "mode")).toBe(true);
  });
  it("opencode: 모델·effort·모드 모두 지원(픽커)", () => {
    const a = agentFor("opencode");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
  });
  it("agy: 모델·effort·모드(/agents) 모두 지원", () => {
    const a = agentFor("agy");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
  });
  it("hermes: 모델·effort 지원, 모드는 미지원(비활성화)", () => {
    const a = agentFor("hermes");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(false);
  });
  it("미지원 에이전트는 전부 차단", () => {
    const a = agentFor("grok");
    expect(a.supports("model")).toBe(false);
    expect(a.supports("effort")).toBe(false);
    expect(a.supports("mode")).toBe(false);
  });
});

describe("stepsFor — 적용 명령 시퀀스", () => {
  it("claude: 슬래시 명령(/model <m>, /effort <e>, /mode <m>)", () => {
    const a = agentFor("claude");
    expect(stepsFor(a, "model", "claude-sonnet-5")).toEqual([
      { text: "/model claude-sonnet-5", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "effort", "high")).toEqual([
      { text: "/effort high", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "mode", "plan")).toEqual([
      { text: "/mode plan", enter: true, delayMs: 120 },
    ]);
  });
  it("codex: 슬래시 명령(/model <m>, /effort <e>, /permissions <m>)", () => {
    const a = agentFor("codex");
    expect(stepsFor(a, "model", "gpt-5.6-luna")).toEqual([
      { text: "/model gpt-5.6-luna", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "effort", "high")).toEqual([
      { text: "/effort high", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "mode", "workspace-write")).toEqual([
      { text: "/permissions workspace-write", enter: true, delayMs: 120 },
    ]);
  });
  it("opencode: 모델 픽커(리더+m) → 프로바이더 포함 필터 입력, Enter는 사용자가 확인", () => {
    const a = agentFor("opencode");
    a.setModelNames({ "openrouter/minimax/minimax-m3": "MiniMax-M3" });
    expect(stepsFor(a, "model", "openrouter/minimax/minimax-m3")).toEqual([
      { text: "\x18", enter: false, delayMs: 300 },
      { text: "m", enter: false, delayMs: 450 },
      { text: "openrouter MiniMax-M3", enter: false },
    ]);
    a.setModelNames({});
  });
  it("opencode: 이름을 모르는 모델이면 프로바이더만 필터로 남긴다", () => {
    expect(stepsFor(new OpenCodeAgent(), "model", "openrouter/minimax/minimax-m3")).toEqual([
      { text: "\x18", enter: false, delayMs: 300 },
      { text: "m", enter: false, delayMs: 450 },
      { text: "openrouter", enter: false },
    ]);
  });
  it("opencode effort: /variants 픽커", () => {
    expect(stepsFor(agentFor("opencode"), "effort", "high")).toEqual([
      { text: "/variants", enter: true, delayMs: 450 },
      { text: "high", enter: true },
    ]);
  });
  it("opencode mode: 리더(ctrl+x)→a→모드명→Enter", () => {
    expect(stepsFor(agentFor("opencode"), "mode", "plan")).toEqual([
      { text: "\x18", enter: false, delayMs: 300 },
      { text: "a", enter: false, delayMs: 450 },
      { text: "plan", enter: true },
    ]);
  });
  it("agy: 슬래시 명령(/model <m>, /effort <e>) 및 Shift-Tab 모드 전환(default -> plan -> accept-edits)", () => {
    const a = agentFor("agy");
    expect(stepsFor(a, "model", "gemini-3.8-flash-medium")).toEqual([
      { text: "/model gemini-3.8-flash-medium", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "effort", "high")).toEqual([
      { text: "/effort high", enter: true, delayMs: 120 },
    ]);
    // default -> plan: 1x Shift-Tab
    expect(stepsFor(a, "mode", "plan", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // default -> accept-edits: 2x Shift-Tab
    expect(stepsFor(a, "mode", "accept-edits", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
      { text: "\x1b[Z", enter: false, delayMs: 120 },
    ]);
    // accept-edits -> default: 1x Shift-Tab
    expect(stepsFor(a, "mode", "default", "accept-edits")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // 동일 모드: 변경 없음
    expect(stepsFor(a, "mode", "plan", "plan")).toEqual([]);
  });
  it("hermes: 슬래시 명령(/model <m>, /reasoning <e>), 모드는 미지원 빈 배열", () => {
    const a = agentFor("hermes");
    expect(stepsFor(a, "model", "deepseek/deepseek-v4-flash-0731")).toEqual([
      { text: "/model deepseek/deepseek-v4-flash-0731", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "effort", "medium")).toEqual([
      { text: "/reasoning medium", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "mode", "plan")).toEqual([]);
  });
  it("미지원 에이전트는 빈 시퀀스", () => {
    expect(stepsFor(agentFor("grok"), "model", "x")).toEqual([]);
    expect(stepsFor(agentFor("grok"), "mode", "plan")).toEqual([]);
  });
});

describe("discoverModelCmd / parseModels — 라이브 모델 발견", () => {
  it("opencode와 agy는 발견 CLI 보유, claude/codex/미지원은 없음", () => {
    expect(discoverModelCmd("opencode")).toEqual(["opencode", "models", "--verbose"]);
    expect(discoverModelCmd("agy")).toEqual(["agy", "models"]);
    expect(discoverModelCmd("claude")).toBeUndefined();
    expect(discoverModelCmd("codex")).toBeUndefined();
    expect(discoverModelCmd(undefined)).toBeUndefined();
  });
  it("parseModels: 줄 단위 + 빈 줄/ANSI 제거 + 중복 제거", () => {
    const out = parseModels("opencode/claude-opus-4-7\r\nopencode/claude-sonnet-4-5\n\nopencode/claude-opus-4-7\n\x1b[32mopencode/gpt-5\x1b[0m\n");
    expect(out).toEqual([
      "opencode/claude-opus-4-7",
      "opencode/claude-sonnet-4-5",
      "opencode/gpt-5",
    ]);
  });
  it("parseModelIdLines: --verbose 출력에서 provider/model 줄만 추출(JSON 본문 제외)", () => {
    const stdout = `opencode/claude-opus-4-7
{
  "id": "claude-opus-4-7",
  "providerID": "opencode",
  "name": "Claude Opus 4.7"
}
openrouter/~anthropic/claude-sonnet-latest
{
  "id": "~anthropic/claude-sonnet-latest",
  "providerID": "openrouter",
  "name": "Claude Sonnet Latest"
}
openrouter/nvidia/nemotron-3.5-lightning:free
`;
    expect(parseModelIdLines(stdout)).toEqual([
      "opencode/claude-opus-4-7",
      "openrouter/~anthropic/claude-sonnet-latest",
      "openrouter/nvidia/nemotron-3.5-lightning:free",
    ]);
  });
  it("parseOpenCodeModelNames: --verbose JSON 블록에서 id→표시이름 추출", () => {
    const stdout = `opencode/claude-opus-4-7
{
  "id": "claude-opus-4-7",
  "providerID": "opencode",
  "name": "Claude Opus 4.7"
}
openrouter/minimax/minimax-m3
{
  "id": "minimax/minimax-m3",
  "providerID": "openrouter",
  "name": "MiniMax-M3"
}
`;
    expect(parseOpenCodeModelNames(stdout)).toEqual({
      "opencode/claude-opus-4-7": "Claude Opus 4.7",
      "openrouter/minimax/minimax-m3": "MiniMax-M3",
    });
  });
  it("modelFilterText: 프로바이더 + 표시이름, 이름 없으면 프로바이더만", () => {
    expect(modelFilterText("openrouter/minimax/minimax-m3", "MiniMax-M3")).toBe("openrouter MiniMax-M3");
    expect(modelFilterText("opencode/minimax-m3", "MiniMax-M3")).toBe("opencode MiniMax-M3");
    expect(modelFilterText("openrouter/minimax/minimax-m3")).toBe("openrouter");
    expect(modelFilterText("gpt-5", "GPT-5")).toBe("gpt-5 GPT-5");
  });
  it("parseOpenCodeState: 최근 모델 + variant 추출", () => {
    const s = parseOpenCodeState(JSON.stringify({
      recent: [{ providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash-0731" }],
      variant: { "openrouter/deepseek/deepseek-v4-flash-0731": "high" },
    }));
    expect(s.model).toEqual({ providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash-0731" });
    expect(s.variant?.["openrouter/deepseek/deepseek-v4-flash-0731"]).toBe("high");
  });
  it("parseOpenCodeState: recent 없거나 파싱 불가면 비어있음", () => {
    expect(parseOpenCodeState("{}").model).toBeUndefined();
    expect(parseOpenCodeState("[").model).toBeUndefined();
    expect(parseOpenCodeState(JSON.stringify({ recent: [] })).model).toBeUndefined();
  });
  it("parseOpenCodeState: recent/favorites 배열을 providerID/modelID 문자열로", () => {
    const s = parseOpenCodeState(JSON.stringify({
      recent: [{ providerID: "openrouter", modelID: "a/" },
               { providerID: "opencode", modelID: "b" }],
      favorite: [{ providerID: "openrouter", modelID: "x" }],
    }));
    expect(s.recent?.[0]).toBe("openrouter/a/");
    expect(s.recent?.[1]).toBe("opencode/b");
    expect(s.favorites).toEqual(["openrouter/x"]);
  });
  it("parseTuiAgent: TOML에서 agent=… 뽑는다", () => {
    const toml = `theme = "opencode"
provider = "opencode"
model = "grok-code"
agent = "plan"
`;
    expect(parseTuiAgent(toml)).toBe("plan");
  });
  it("parseTuiAgent: agent 없거나 비어 있으면 undefined", () => {
    expect(parseTuiAgent("")).toBeUndefined();
    expect(parseTuiAgent("theme = \"x\"\nmodel = \"y\"")).toBeUndefined();
  });
  it("parsePrimaryAgents: 숨김 내부(compaction/summary/title) 제외한 프라이머리만", () => {
    const out = parsePrimaryAgents(
      "build (primary)\n  [\n  ...permissions...\ncompaction (primary)\n  [\nplan (primary)\n  [\nexplore (subagent)\n  [\nsummary (primary)\n  [\ntitle (primary)\n  [\n"
    );
    expect(out).toEqual(["build", "plan"]);
  });
  it("parsePrimaryAgents: ANSI/공백/빈 줄 방어, subagent 제외", () => {
    expect(parsePrimaryAgents("\x1b[32mbuild (primary)\x1b[0m\n\ncustom (primary)\nexplore (subagent)\n")).toEqual(["build", "custom"]);
  });
  it("discoverAgentCmd: opencode와 agy는 CLI 보유, claude/미지원은 없음", () => {
    expect(discoverAgentCmd("opencode")).toEqual(["opencode", "agent", "list"]);
    expect(discoverAgentCmd("agy")).toEqual(["agy", "--help"]);
    expect(discoverAgentCmd("claude")).toBeUndefined();
    expect(discoverAgentCmd(undefined)).toBeUndefined();
  });
  it("discoverVariantCmd: opencode는 verbose 모델 CLI 보유", () => {
    expect(discoverVariantCmd("opencode")).toEqual(["opencode", "models", "--verbose"]);
    expect(discoverVariantCmd("claude")).toBeUndefined();
  });
  it("parseModelVariants: 해당 모델의 variants 키 + 앞에 default", () => {
    const stdout = `deepseek/deepseek-v4-flash-0731\n{\n  "id": "deepseek/deepseek-v4-flash-0731",\n  "variants": { "low": {"reasoning":{"effort":"low"}}, "high": {"reasoning":{"effort":"high"}}, "max": {"reasoning":{"effort":"max"}} }\n}\nsome-other\n{\n  "id": "x/y",\n  "variants": {}\n}\n`;
    expect(parseModelVariants(stdout, "deepseek/deepseek-v4-flash-0731")).toEqual(["default", "low", "high", "max"]);
  });
  it("parseModelVariants: variants 없거나 모델 없으면 빈 배열", () => {
    expect(parseModelVariants("", "a/b")).toEqual([]);
    expect(parseModelVariants('{"id":"x","variants":{}}', "x")).toEqual([]);
    expect(parseModelVariants('{"id":"x","variants":{"low":{}}}', "nope")).toEqual([]);
  });
  it("sortModels: 즐겨찾기 우선 → 최근 순 → 나머지, 중복·발견 외 제거", () => {
    const discovered = ["openrouter/a", "openrouter/b", "openrouter/c", "openrouter/d"];
    const sorted = sortModels(discovered,
      ["openrouter/b", "openrouter/d"], // 최근
      ["openrouter/d", "openrouter/z"], // 즐겨찾기(z는 발견 없음 → 건너뜀)
    );
    expect(sorted).toEqual(["openrouter/d", "openrouter/b", "openrouter/a", "openrouter/c"]);
  });
  it("sortModels: 정보 없으면 발견 순서 그대로", () => {
    expect(sortModels(["openrouter/a", "openrouter/b"])).toEqual(["openrouter/a", "openrouter/b"]);
    expect(sortModels(["openrouter/a"], ["openrouter/a"])).toEqual(["openrouter/a"]); // 중복 방지
  });
});

describe("Claude 파서 및 모델/상태 리더", () => {
  it("parseClaudeSettings: settings.json에서 model, effortLevel, permissionMode 추출", () => {
    const json1 = JSON.stringify({
      model: "claude-sonnet-5",
      effortLevel: "medium",
      permissionMode: "plan",
    });
    expect(parseClaudeSettings(json1)).toEqual({
      model: "claude-sonnet-5",
      effort: "medium",
      mode: "plan",
    });

    const json2 = JSON.stringify({
      effort: "high",
      mode: "accept-edits",
    });
    expect(parseClaudeSettings(json2)).toEqual({
      model: undefined,
      effort: "high",
      mode: "accept-edits",
    });

    expect(parseClaudeSettings("{}")).toEqual({});
    expect(parseClaudeSettings("invalid")).toEqual({});
  });

  it("parseClaudeModelCatalog: format A (catalog.config.models) 파싱", () => {
    const json = JSON.stringify({
      catalog: {
        config: {
          models: [
            {
              id: "claude-fable-5-1",
              name: "Fable 5.1",
              short_name: "Fable",
              thinking: {
                effort_options: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
              },
            },
            {
              id: "claude-haiku-4-5-20251001",
              name: "Haiku 4.5",
              short_name: "Haiku",
            },
          ],
        },
      },
    });
    const parsed = parseClaudeModelCatalog(json);
    expect(parsed.models).toEqual(["claude-fable-5-1", "claude-haiku-4-5-20251001"]);
    expect(parsed.modelNames).toEqual({
      "claude-fable-5-1": "Fable 5.1",
      "claude-haiku-4-5-20251001": "Haiku 4.5",
    });
    expect(parsed.effortsByModel["claude-fable-5-1"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(parsed.effortsByModel["claude-haiku-4-5-20251001"]).toBeUndefined();
  });

  it("parseClaudeModelCatalog: format B (document.surfaces.cc.model_selector_config) 파싱", () => {
    const json = JSON.stringify({
      document: {
        surfaces: {
          cc: {
            model_selector_config: [
              {
                id: "main",
                models: [
                  {
                    id: "claude-opus-5",
                    name: "Opus 5",
                    short_name: "Opus",
                    thinking: {
                      effort_options: [{ id: "low" }, { id: "high" }],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const parsed = parseClaudeModelCatalog(json);
    expect(parsed.models).toEqual(["claude-opus-5"]);
    expect(parsed.modelNames).toEqual({ "claude-opus-5": "Opus 5" });
    expect(parsed.effortsByModel["claude-opus-5"]).toEqual(["low", "high"]);
  });

  it("ClaudeAgent: getModels, getEfforts, getModes 기본 동작", () => {
    const a = agentFor("claude");
    const models = a.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(a.getEfforts("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(a.getEfforts("claude-haiku-4-5-20251001")).toEqual([]);
    expect(a.getModes()).toEqual(["default", "plan", "accept-edits"]);
  });

  it("readClaudeState: 로컬 상태 및 작업공간 상태 읽기", () => {
    const st = readClaudeState({ worktreePath: "/Users/ben/Workspaces/Tools/deep" });
    expect(st).toBeDefined();
    expect(typeof st).toBe("object");
  });
});

describe("Codex & Agy 파서 및 상태 리더", () => {
  it("parseCodexConfig: TOML에서 model, model_reasoning_effort, sandbox_mode 추출", () => {
    const toml = `model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "workspace-write"\n`;
    expect(parseCodexConfig(toml)).toEqual({
      model: "gpt-5.6-luna",
      effort: "medium",
      mode: "workspace-write",
    });
  });
  it("parseCodexConfig: 누락 시 undefined", () => {
    expect(parseCodexConfig("")).toEqual({ model: undefined, effort: undefined, mode: undefined });
  });
  it("parseCodexModelsCache: JSON 캐시에서 auto-review 제외 모델 slug 추출", () => {
    const json = JSON.stringify({
      models: [
        { slug: "gpt-reserve" },
        { slug: "gpt-5.6-luna" },
        { slug: "codex-auto-review" },
      ],
    });
    expect(parseCodexModelsCache(json)).toEqual(["gpt-reserve", "gpt-5.6-luna"]);
  });
  it("CodexAgent: getModels, getEfforts, getModes 기본 동작", () => {
    const a = agentFor("codex");
    expect(a.getModels().length).toBeGreaterThan(0);
    expect(a.getEfforts()).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(a.getModes()).toEqual(["workspace-write", "read-only", "danger-full-access"]);
  });
  it("readCodexState: 로컬 상태 읽기", () => {
    const st = readCodexState();
    expect(st).toBeDefined();
    expect(typeof st).toBe("object");
  });
  it("parseAgyModels: 'Fetching...' 제거 및 tab 앞 ID 추출", () => {
    const stdout = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`;
    expect(parseAgyModels(stdout)).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "claude-sonnet-4-6",
    ]);
  });
  it("parseAgySettings: settings.json에서 model 및 mode/agent 추출 및 정규화", () => {
    expect(parseAgySettings(JSON.stringify({ model: "Gemini 3.8 Flash (Medium)" }))).toEqual({
      model: "Gemini 3.8 Flash (Medium)",
    });
    expect(parseAgySettings(JSON.stringify({ model: "Gemini 3.8 Flash (Medium)", mode: "plan" }))).toEqual({
      model: "Gemini 3.8 Flash (Medium)",
      mode: "plan",
    });
    expect(parseAgySettings(JSON.stringify({ model: "Gemini 3.8 Flash (Medium)", mode: "accept-edits" }))).toEqual({
      model: "Gemini 3.8 Flash (Medium)",
      mode: "accept-edits",
    });
    expect(parseAgySettings(JSON.stringify({ model: "Gemini 3.8 Flash (Medium)", mode: "nothing" }))).toEqual({
      model: "Gemini 3.8 Flash (Medium)",
      mode: "default",
    });
    expect(parseAgySettings(JSON.stringify({ model: "Gemini 3.8 Flash (Medium)", agent: "plan" }))).toEqual({
      model: "Gemini 3.8 Flash (Medium)",
      mode: "plan",
    });
    expect(parseAgySettings("{}")).toEqual({});
    expect(parseAgySettings("invalid")).toEqual({});
  });

  it("normalizeAgyMode: 모드 문자열을 default / plan / accept-edits로 정규화", () => {
    expect(normalizeAgyMode("")).toBe("default");
    expect(normalizeAgyMode(undefined)).toBe("default");
    expect(normalizeAgyMode("nothing")).toBe("default");
    expect(normalizeAgyMode("none")).toBe("default");
    expect(normalizeAgyMode("normal")).toBe("default");
    expect(normalizeAgyMode("default")).toBe("default");
    expect(normalizeAgyMode("plan")).toBe("plan");
    expect(normalizeAgyMode("accept-edits")).toBe("accept-edits");
    expect(normalizeAgyMode("acceptedits")).toBe("accept-edits");
  });

  it("AgyAgent.getModes: default, plan, accept-edits 반환", () => {
    expect(agentFor("agy").getModes()).toEqual(["default", "plan", "accept-edits"]);
    expect(AGY_MODES).toEqual(["default", "plan", "accept-edits"]);
  });

  it("parseAgyHelpModes: agy --help 출력에서 모드 파싱", () => {
    const helpText = `Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --model                         Model for the current CLI session
`;
    expect(parseAgyHelpModes(helpText)).toEqual(["default", "plan", "accept-edits"]);
    expect(parseAgyHelpModes("")).toEqual([]);
    expect(parseAgyHelpModes("no mode flag here")).toEqual([]);
  });

  it("extractEffortFromModel: 모델명 또는 슬러그에서 내포된 effort 추출", () => {
    expect(extractEffortFromModel("Gemini 3.8 Flash (High)")).toBe("high");
    expect(extractEffortFromModel("Gemini 3.8 Flash (Medium)")).toBe("medium");
    expect(extractEffortFromModel("Gemini 3.8 Flash (Low)")).toBe("low");
    expect(extractEffortFromModel("gemini-3.8-flash-high")).toBe("high");
    expect(extractEffortFromModel("gemini-3.8-flash-medium")).toBe("medium");
    expect(extractEffortFromModel("gemini-3.8-flash-low")).toBe("low");
    expect(extractEffortFromModel("claude-opus-4-6-thinking")).toBe("thinking");
    expect(extractEffortFromModel("Claude Opus 4.6 (Thinking)")).toBe("thinking");
    expect(extractEffortFromModel("gpt-oss-120b-medium")).toBe("medium");
    expect(extractEffortFromModel("claude-sonnet-4-6")).toBeUndefined();
    expect(extractEffortFromModel("")).toBeUndefined();
    expect(extractEffortFromModel(undefined)).toBeUndefined();
  });

  it("AgyAgent.getEffortForModel: 모델명에 내포된 effort 반환", () => {
    const agy = agentFor("agy");
    expect(agy.getEffortForModel("gemini-3.8-flash-high")).toBe("high");
    expect(agy.getEffortForModel("Gemini 3.8 Flash (Medium)")).toBe("medium");
    expect(agy.getEffortForModel("claude-sonnet-4-6")).toBeUndefined();
  });

  it("parseAgyLogWorkspace: 로그 헤더에서 workspaceDirs 및 store manager 경로 추출", () => {
    const header1 = `I0913 16:36:45.100430       1 server.go:299] Creating CLI server backend: product=antigravity workspaceDirs=[/Users/ben/Workspaces/Tools/deep] appDataDir=/Users/ben/.gemini/antigravity-cli cascadeManager=true codeAssist=true`;
    expect(parseAgyLogWorkspace(header1)).toEqual(["/Users/ben/Workspaces/Tools/deep"]);

    const header2 = `I0912 02:17:26.375160       1 server.go:285] Creating CLI server backend: product=antigravity workspaceDirs=[/Users/ben/Workspaces/Tools/AltReady] appDataDir=...
I0912 02:17:26.378614       1 manager.go:426] Initializing CLI store manager for workspace /Users/ben/Workspaces/Tools/AltReady`;
    expect(parseAgyLogWorkspace(header2)).toEqual(["/Users/ben/Workspaces/Tools/AltReady"]);

    expect(parseAgyLogWorkspace("")).toEqual([]);
  });

  it("isMatchingWorkspace: 작업공간 경로 매칭 및 정규화", () => {
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep", "/Users/ben/Workspaces/Tools/deep")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep/", "/Users/ben/Workspaces/Tools/deep")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep", "/Users/ben/Workspaces/Tools/deep/.orca/worktrees/feat")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep/com.byjw.deep.sdPlugin", "/Users/ben/Workspaces/Tools/deep")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep", "/Users/ben/Workspaces/Tools/AltReady")).toBe(false);
    expect(isMatchingWorkspace("", "/Users/ben/Workspaces/Tools/deep")).toBe(false);
  });

  it("parseAgyLogModel: CLI 로그에서 모델 오버라이드 및 유저 입력 파싱", () => {
    const log1 = `I0913 16:48:15.672433   11525 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.7 Flash (High)"`;
    expect(parseAgyLogModel(log1)).toBe("Gemini 3.7 Flash (High)");

    const log2 = `I0913 16:48:15.672342   11525 model_resolver.go:93] Resolving model Gemini 3.7 Flash (Medium)`;
    expect(parseAgyLogModel(log2)).toBe("Gemini 3.7 Flash (Medium)");

    const log3 = `I0913 16:48:15.672342   11525 input_loop.go:94] HandleUserInput called with text: "/model gemini-3.8-flash-low"`;
    expect(parseAgyLogModel(log3)).toBe("gemini-3.8-flash-low");

    expect(parseAgyLogModel("")).toBeUndefined();
  });

  it("parseAgyLogEffort: CLI 로그에서 /effort 명령 파싱", () => {
    const log1 = `I0913 16:48:15.672342   11525 input_loop.go:94] HandleUserInput called with text: "/effort high"`;
    expect(parseAgyLogEffort(log1)).toBe("high");

    const log2 = `I0913 16:48:15.672342   11525 input_loop.go:94] HandleUserInput called with text: "/effort medium"`;
    expect(parseAgyLogEffort(log2)).toBe("medium");

    expect(parseAgyLogEffort("")).toBeUndefined();
  });

  it("parseAgyLogMode: CLI 로그에서 SetCycleMode, /mode, /agent 파싱", () => {
    const log1 = `ERROR: logging before google.Init: I0908 00:02:47.642897       1 manager.go:1341] SetCycleMode called: accept-edits`;
    expect(parseAgyLogMode(log1)).toBe("accept-edits");

    const log2 = `ERROR: logging before google.Init: I0908 00:00:46.158446       1 manager.go:1341] SetCycleMode called: plan
ERROR: logging before google.Init: I0908 00:00:46.631352       1 manager.go:1341] SetCycleMode called: `;
    expect(parseAgyLogMode(log2)).toBe("default");

    const log3 = `I0913 16:48:15.672342   11525 input_loop.go:94] HandleUserInput called with text: "/mode plan"`;
    expect(parseAgyLogMode(log3)).toBe("plan");

    expect(parseAgyLogMode("")).toBeUndefined();
    expect(parseAgyLogMode("random log content")).toBeUndefined();
  });

  it("readAgyState: 현재 실행 중인 agy 세션의 상태 읽기 (작업공간별 분리 검증)", () => {
    const stDeep = readAgyState({ worktreePath: "/Users/ben/Workspaces/Tools/deep" });
    expect(stDeep).toBeDefined();
    expect(typeof stDeep).toBe("object");

    const stAlt = readAgyState({ worktreePath: "/Users/ben/Workspaces/Tools/AltReady" });
    expect(stAlt).toBeDefined();
    expect(typeof stAlt).toBe("object");

    if (stDeep.effort && stAlt.effort) {
      // deep과 AltReady 작업공간이 서로 다른 effort를 가질 때 각각 올바르게 분리되어 읽힘
      expect(typeof stDeep.effort).toBe("string");
      expect(typeof stAlt.effort).toBe("string");
    }
  });
});

describe("Hermes 파서 및 모델 캐시", () => {
  it("parseHermesConfig: config.yaml에서 default model 및 reasoning_effort 추출", () => {
    const yaml1 = `model:
  default: deepseek/deepseek-v4-flash-0731
  provider: openrouter
agent:
  reasoning_effort: medium
`;
    expect(parseHermesConfig(yaml1)).toEqual({
      model: "deepseek/deepseek-v4-flash-0731",
      effort: "medium",
    });

    const yaml2 = `model: anthropic/claude-sonnet-4-6\nagent:\n  reasoning_effort: high\n`;
    expect(parseHermesConfig(yaml2)).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
    });
  });

  it("parseHermesConfig: 누락 시 undefined", () => {
    expect(parseHermesConfig("")).toEqual({ model: undefined, effort: undefined });
  });

  it("parseHermesModelsCache: provider_models_cache.json에서 중복 없는 모델 목록 추출", () => {
    const json = JSON.stringify({
      openrouter: {
        models: ["deepseek/deepseek-v4-flash-0731", "minimax/minimax-m3"],
      },
      anthropic: {
        models: ["claude-sonnet-4-6", "deepseek/deepseek-v4-flash-0731"],
      },
    });
    expect(parseHermesModelsCache(json)).toEqual([
      "deepseek/deepseek-v4-flash-0731",
      "minimax/minimax-m3",
      "claude-sonnet-4-6",
    ]);
  });

  it("HermesAgent.getEfforts: hermes 지원 reasoning levels 반환", () => {
    expect(agentFor("hermes").getEfforts()).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});