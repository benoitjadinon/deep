import { describe, it, expect } from "vitest";
import {
  profileFor,
  supported,
  stepsFor,
  discoverModelCmd,
  parseModels,
  providerShort,
  parseOpenCodeState,
  parseTuiAgent,
  parsePrimaryAgents,
  parseModelVariants,
  discoverAgentCmd,
  discoverVariantCmd,
  sortModels,
  UNSUPPORTED_PROFILE,
} from "../src/agents.js";

describe("profileFor — 에이전트 타입 → 프로파일", () => {
  it("알려진 에이전트는 프로파일 반환", () => {
    expect(profileFor("claude").label).toBe("Claude");
    expect(profileFor("opencode").label).toBe("OpenCode");
  });
  it("모르는 에이전트(null/빈 값 포함)는 미지원 프로파일", () => {
    expect(profileFor("codex")).toBe(UNSUPPORTED_PROFILE);
    expect(profileFor("grok")).toBe(UNSUPPORTED_PROFILE);
    expect(profileFor("")).toBe(UNSUPPORTED_PROFILE);
    expect(profileFor(undefined)).toBe(UNSUPPORTED_PROFILE);
    expect(profileFor(null)).toBe(UNSUPPORTED_PROFILE);
  });
});

describe("supported — 게이팅", () => {
  it("claude: 모델·effort 둘 다 지원, 모드는 미지원(안전 명령 없음)", () => {
    const p = profileFor("claude");
    expect(supported(p, "model")).toBe(true);
    expect(supported(p, "effort")).toBe(true);
    expect(supported(p, "mode")).toBe(false);
  });
  it("opencode: 모델·effort·모드 지원(픽커)", () => {
    const p = profileFor("opencode");
    expect(supported(p, "model")).toBe(true);
    expect(supported(p, "effort")).toBe(true);
    expect(supported(p, "mode")).toBe(true);
  });
  it("미지원 프로파일은 전부 차단", () => {
    const p = profileFor("codex");
    expect(supported(p, "model")).toBe(false);
    expect(supported(p, "effort")).toBe(false);
    expect(supported(p, "mode")).toBe(false);
  });
});

describe("stepsFor — 적용 명령 시퀀스", () => {
  it("claude: 슬래시 명령 한 줄(/model <m>)", () => {
    expect(stepsFor(profileFor("claude"), "model", "opus")).toEqual([
      { text: "/model opus", enter: true, delayMs: 120 },
    ]);
  });
  it("claude effort: /effort <e>", () => {
    expect(stepsFor(profileFor("claude"), "effort", "high")).toEqual([
      { text: "/effort high", enter: true, delayMs: 120 },
    ]);
  });
  it("opencode: /models 픽커 열기 → 필터어(프로바이더 제거) → Enter", () => {
    expect(stepsFor(profileFor("opencode"), "model", "opencode/claude-opus-4-7")).toEqual([
      { text: "/models", enter: true, delayMs: 450 },
      { text: "claude-opus-4-7", enter: true },
    ]);
  });
  it("opencode effort: /variants 픽커", () => {
    expect(stepsFor(profileFor("opencode"), "effort", "high")).toEqual([
      { text: "/variants", enter: true, delayMs: 450 },
      { text: "high", enter: true },
    ]);
  });
  it("opencode mode: 리더(ctrl+x)→a→모드명→Enter", () => {
    expect(stepsFor(profileFor("opencode"), "mode", "plan")).toEqual([
      { text: "\x18", enter: false, delayMs: 300 },
      { text: "a", enter: false, delayMs: 450 },
      { text: "plan", enter: true },
    ]);
  });
  it("미지원 프로파일은 빈 시퀀스", () => {
    expect(stepsFor(profileFor("codex"), "model", "x")).toEqual([]);
    expect(stepsFor(profileFor("codex"), "mode", "plan")).toEqual([]);
  });
});

describe("discoverModelCmd / parseModels — 라이브 모델 발견", () => {
  it("opencode는 발견 CLI 보유, claude/미지원은 없음", () => {
    expect(discoverModelCmd("opencode")).toEqual(["opencode", "models"]);
    expect(discoverModelCmd("claude")).toBeUndefined();
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
  it("providerShort: provider 접두어 제거", () => {
    expect(providerShort("opencode/claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(providerShort("gpt-5")).toBe("gpt-5");
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
  it("discoverAgentCmd: opencode는 CLI 보유, claude/미지원은 없음", () => {
    expect(discoverAgentCmd("opencode")).toEqual(["opencode", "agent", "list"]);
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