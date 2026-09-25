import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  CLAUDE_MODES,
  CLAUDE_BYPASS_MODES,
  isClaudeBypassEnabled,
  normalizeClaudeMode,
  getClaudeShiftTabSteps,
  parseClaudeModeFromText,
  parseAgyModels,
  parseAgyAgents,
  parseAgySettings,
  parseAgyHelpModes,
  parseAgyLogWorkspace,
  isMatchingWorkspace,
  parseAgyLogModel,
  parseAgyLogEffort,
  parseAgyLogMode,
  parseAgyModeFromText,
  readAgyState,
  extractEffortFromModel,
  AGY_MODES,
  normalizeAgyMode,
  getAgyShiftTabSteps,
  parseHermesConfig,
  parseHermesModelsCache,
  parsePiSessionTail,
  readPiSessionState,
  parsePiSettings,
  parsePiListModels,
  parsePiModelsStore,
  readPiState,
  piSessionDir,
  PI_THINKING_LEVELS,
  PI_DEFAULT_MODELS,
  PiAgent,
  HermesAgent,
  ClaudeAgent,
  CodexAgent,
  OpenCodeAgent,
  AgyAgent,
  UnsupportedAgent,
  UNSUPPORTED_AGENT,
  UNSUPPORTED_PROFILE,
} from "../src/agents.js";

describe("agentFor / profileFor — agent type to abstract interface and profile", () => {
  it("known agents return concrete class instances", () => {
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
  it("case and whitespace insensitive", () => {
    expect(agentFor(" Claude ")).toBeInstanceOf(ClaudeAgent);
    expect(agentFor("OpenCode")).toBeInstanceOf(OpenCodeAgent);
    expect(agentFor("AGY")).toBeInstanceOf(AgyAgent);
    expect(agentFor(" Hermes ")).toBeInstanceOf(HermesAgent);
  });
  it("unknown agents (null/empty) map to unsupported", () => {
    expect(agentFor("grok")).toBe(UNSUPPORTED_AGENT);
    expect(agentFor("")).toBe(UNSUPPORTED_AGENT);
    expect(agentFor(undefined)).toBe(UNSUPPORTED_AGENT);
    expect(agentFor(null)).toBe(UNSUPPORTED_AGENT);

    expect(profileFor("grok").label).toBe("Unsupported");
  });
});

describe("supported — per-agent capability gating", () => {
  it("claude: supports model, effort, and mode", () => {
    const a = agentFor("claude");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
    expect(supported(a, "model")).toBe(true);
    expect(supported(a, "effort")).toBe(true);
    expect(supported(a, "mode")).toBe(true);
  });
  it("codex: supports model, effort, and mode", () => {
    const a = agentFor("codex");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
    expect(supported(a, "model")).toBe(true);
    expect(supported(a, "effort")).toBe(true);
    expect(supported(a, "mode")).toBe(true);
  });
  it("opencode: supports model, effort, and mode (pickers)", () => {
    const a = agentFor("opencode");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
  });
  it("agy: supports model, effort, and mode", () => {
    const a = agentFor("agy");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(true);
  });
  it("hermes: supports model and effort, mode unsupported", () => {
    const a = agentFor("hermes");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(false);
  });
  it("unsupported agents are completely blocked", () => {
    const a = agentFor("grok");
    expect(a.supports("model")).toBe(false);
    expect(a.supports("effort")).toBe(false);
    expect(a.supports("mode")).toBe(false);
  });
});

describe("cleanTitle — per-agent deck title normalization", () => {
  it("opencode strips the Orca 'OC | ' prefix (also fullwidth bar + loose spacing)", () => {
    const oc = agentFor("opencode");
    expect(oc.cleanTitle("OC | Fix Auth Flow Bug")).toBe("Fix Auth Flow Bug");
    expect(oc.cleanTitle("OC｜Fix Auth Flow Bug")).toBe("Fix Auth Flow Bug");
    expect(oc.cleanTitle("OC|Fix Auth Flow Bug")).toBe("Fix Auth Flow Bug");
    expect(oc.cleanTitle("Trade state update")).toBe("Trade state update"); // no prefix -> unchanged
  });

  it("other agents keep the title as-is until they need their own cleaning", () => {
    expect(agentFor("claude").cleanTitle("OC | Candy crush clone PWA")).toBe("OC | Candy crush clone PWA");
    expect(agentFor("hermes").cleanTitle("OC | anything")).toBe("OC | anything");
    expect(agentFor("unknown").cleanTitle("OC | anything")).toBe("OC | anything");
    expect(agentFor("opencode").cleanTitle("")).toBe("");
  });
});

describe("stepsFor — apply command sequences", () => {
  it("claude: slash commands (/model <m>, /effort <e>) and Shift+Tab mode cycling", () => {
    const a = agentFor("claude");
    expect(stepsFor(a, "model", "claude-sonnet-5")).toEqual([
      { text: "/model claude-sonnet-5", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "effort", "high")).toEqual([
      { text: "/effort high", enter: true, delayMs: 120 },
    ]);
    // default -> accept-edits (1 step)
    expect(stepsFor(a, "mode", "accept-edits", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // default -> plan (2 steps)
    expect(stepsFor(a, "mode", "plan", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
      { text: "\x1b[Z", enter: false, delayMs: 120 },
    ]);
    // plan -> default (1 step)
    expect(stepsFor(a, "mode", "default", "plan")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // accept-edits -> plan (1 step)
    expect(stepsFor(a, "mode", "plan", "accept-edits")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
  });
  it("codex: slash commands (/model <m>, /effort <e>, /permissions <m>)", () => {
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
  it("opencode: model picker (leader+m) -> provider-qualified filter text", () => {
    const a = agentFor("opencode");
    a.setModelNames({ "openrouter/minimax/minimax-m3": "MiniMax-M3" });
    expect(stepsFor(a, "model", "openrouter/minimax/minimax-m3")).toEqual([
      { text: "\x18", enter: false, delayMs: 300 },
      { text: "m", enter: false, delayMs: 450 },
      { text: "openrouter MiniMax-M3", enter: false },
    ]);
    a.setModelNames({});
  });
  it("opencode: unknown model name falls back to provider filter", () => {
    expect(stepsFor(new OpenCodeAgent(), "model", "openrouter/minimax/minimax-m3")).toEqual([
      { text: "\x18", enter: false, delayMs: 300 },
      { text: "m", enter: false, delayMs: 450 },
      { text: "openrouter", enter: false },
    ]);
  });
  it("opencode effort: /variants picker", () => {
    expect(stepsFor(agentFor("opencode"), "effort", "high")).toEqual([
      { text: "/variants", enter: true, delayMs: 450 },
      { text: "high", enter: true },
    ]);
  });
  it("opencode mode: leader (ctrl+x) -> a -> mode name -> enter", () => {
    expect(stepsFor(agentFor("opencode"), "mode", "plan")).toEqual([
      { text: "\x18", enter: false, delayMs: 300 },
      { text: "a", enter: false, delayMs: 450 },
      { text: "plan", enter: true },
    ]);
  });
  it("agy: slash commands (/model <m>, /effort <e>) and Shift+Tab mode cycling (default -> accept-edits -> plan)", () => {
    const a = agentFor("agy");
    expect(stepsFor(a, "model", "gemini-3.8-flash-medium")).toEqual([
      { text: "/model gemini-3.8-flash-medium", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "effort", "high")).toEqual([
      { text: "/effort high", enter: true, delayMs: 120 },
    ]);
    // default -> accept-edits: 1x Shift-Tab
    expect(stepsFor(a, "mode", "accept-edits", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // default -> plan: 2x Shift-Tab
    expect(stepsFor(a, "mode", "plan", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
      { text: "\x1b[Z", enter: false, delayMs: 120 },
    ]);
    // accept-edits -> plan: 1x Shift-Tab
    expect(stepsFor(a, "mode", "plan", "accept-edits")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // plan -> default: 1x Shift-Tab
    expect(stepsFor(a, "mode", "default", "plan")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // same mode: no change
    expect(stepsFor(a, "mode", "plan", "plan")).toEqual([]);
  });
  it("hermes: slash commands (/model <m>, /reasoning <e>), mode is unsupported empty array", () => {
    const a = agentFor("hermes");
    expect(stepsFor(a, "model", "deepseek/deepseek-v4-flash-0731")).toEqual([
      { text: "/model deepseek/deepseek-v4-flash-0731", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "effort", "medium")).toEqual([
      { text: "/reasoning medium", enter: true, delayMs: 120 },
    ]);
    expect(stepsFor(a, "mode", "plan")).toEqual([]);
  });
  it("unsupported agents return empty step sequence", () => {
    expect(stepsFor(agentFor("grok"), "model", "x")).toEqual([]);
    expect(stepsFor(agentFor("grok"), "mode", "plan")).toEqual([]);
  });
});

describe("discoverModelCmd / parseModels — live model discovery", () => {
  it("opencode and agy have discovery CLI, claude/codex/unsupported do not", () => {
    expect(discoverModelCmd("opencode")).toEqual(["opencode", "models", "--verbose"]);
    expect(discoverModelCmd("agy")).toEqual(["agy", "models"]);
    expect(discoverModelCmd("claude")).toBeUndefined();
    expect(discoverModelCmd("codex")).toBeUndefined();
    expect(discoverModelCmd(undefined)).toBeUndefined();
  });
  it("parseModels: line by line + strip empty lines / ANSI + deduplicate", () => {
    const out = parseModels("opencode/claude-opus-4-7\r\nopencode/claude-sonnet-4-5\n\nopencode/claude-opus-4-7\n\x1b[32mopencode/gpt-5\x1b[0m\n");
    expect(out).toEqual([
      "opencode/claude-opus-4-7",
      "opencode/claude-sonnet-4-5",
      "opencode/gpt-5",
    ]);
  });
  it("parseModelIdLines: extract provider/model lines from --verbose output (excluding JSON body)", () => {
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
  it("parseOpenCodeModelNames: extract id to display name mapping from --verbose JSON blocks", () => {
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
  it("modelFilterText: provider + display name, or provider only if name missing", () => {
    expect(modelFilterText("openrouter/minimax/minimax-m3", "MiniMax-M3")).toBe("openrouter MiniMax-M3");
    expect(modelFilterText("opencode/minimax-m3", "MiniMax-M3")).toBe("opencode MiniMax-M3");
    expect(modelFilterText("openrouter/minimax/minimax-m3")).toBe("openrouter");
    expect(modelFilterText("gpt-5", "GPT-5")).toBe("gpt-5 GPT-5");
  });
  it("parseOpenCodeState: extract recent model and variant", () => {
    const s = parseOpenCodeState(JSON.stringify({
      recent: [{ providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash-0731" }],
      variant: { "openrouter/deepseek/deepseek-v4-flash-0731": "high" },
    }));
    expect(s.model).toEqual({ providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash-0731" });
    expect(s.variant?.["openrouter/deepseek/deepseek-v4-flash-0731"]).toBe("high");
  });
  it("parseOpenCodeState: empty when recent is missing or unparseable", () => {
    expect(parseOpenCodeState("{}").model).toBeUndefined();
    expect(parseOpenCodeState("[").model).toBeUndefined();
    expect(parseOpenCodeState(JSON.stringify({ recent: [] })).model).toBeUndefined();
  });
  it("parseOpenCodeState: convert recent/favorites array to providerID/modelID strings", () => {
    const s = parseOpenCodeState(JSON.stringify({
      recent: [{ providerID: "openrouter", modelID: "a/" },
               { providerID: "opencode", modelID: "b" }],
      favorite: [{ providerID: "openrouter", modelID: "x" }],
    }));
    expect(s.recent?.[0]).toBe("openrouter/a/");
    expect(s.recent?.[1]).toBe("opencode/b");
    expect(s.favorites).toEqual(["openrouter/x"]);
  });
  it("parseTuiAgent: extract agent from TOML", () => {
    const toml = `theme = "opencode"
provider = "opencode"
model = "grok-code"
agent = "plan"
`;
    expect(parseTuiAgent(toml)).toBe("plan");
  });
  it("parseTuiAgent: undefined if agent is missing or empty", () => {
    expect(parseTuiAgent("")).toBeUndefined();
    expect(parseTuiAgent("theme = \"x\"\nmodel = \"y\"")).toBeUndefined();
  });
  it("parsePrimaryAgents: only primary agents excluding internal helpers (compaction/summary/title)", () => {
    const out = parsePrimaryAgents(
      "build (primary)\n  [\n  ...permissions...\ncompaction (primary)\n  [\nplan (primary)\n  [\nexplore (subagent)\n  [\nsummary (primary)\n  [\ntitle (primary)\n  [\n"
    );
    expect(out).toEqual(["build", "plan"]);
  });
  it("parsePrimaryAgents: handle ANSI/whitespace/empty lines and exclude subagents", () => {
    expect(parsePrimaryAgents("\x1b[32mbuild (primary)\x1b[0m\n\ncustom (primary)\nexplore (subagent)\n")).toEqual(["build", "custom"]);
  });
  it("discoverAgentCmd: opencode and agy have CLI, claude/unsupported do not", () => {
    expect(discoverAgentCmd("opencode")).toEqual(["opencode", "agent", "list"]);
    expect(discoverAgentCmd("agy")).toEqual(["agy", "--help"]);
    expect(discoverAgentCmd("claude")).toBeUndefined();
    expect(discoverAgentCmd(undefined)).toBeUndefined();
  });
  it("discoverVariantCmd: opencode has verbose models CLI", () => {
    expect(discoverVariantCmd("opencode")).toEqual(["opencode", "models", "--verbose"]);
    expect(discoverVariantCmd("claude")).toBeUndefined();
  });
  it("parseModelVariants: model variants keys with default prepended", () => {
    const stdout = `deepseek/deepseek-v4-flash-0731\n{\n  "id": "deepseek/deepseek-v4-flash-0731",\n  "variants": { "low": {"reasoning":{"effort":"low"}}, "high": {"reasoning":{"effort":"high"}}, "max": {"reasoning":{"effort":"max"}} }\n}\nsome-other\n{\n  "id": "x/y",\n  "variants": {}\n}\n`;
    expect(parseModelVariants(stdout, "deepseek/deepseek-v4-flash-0731")).toEqual(["default", "low", "high", "max"]);
  });
  it("parseModelVariants: empty array when variants or model missing", () => {
    expect(parseModelVariants("", "a/b")).toEqual([]);
    expect(parseModelVariants('{"id":"x","variants":{}}', "x")).toEqual([]);
    expect(parseModelVariants('{"id":"x","variants":{"low":{}}}', "nope")).toEqual([]);
  });
  it("sortModels: favorites first -> recent -> remaining, deduplicated", () => {
    const discovered = ["openrouter/a", "openrouter/b", "openrouter/c", "openrouter/d"];
    const sorted = sortModels(discovered,
      ["openrouter/b", "openrouter/d"], // recent
      ["openrouter/d", "openrouter/z"], // favorites (z not in discovered -> skipped)
    );
    expect(sorted).toEqual(["openrouter/d", "openrouter/b", "openrouter/a", "openrouter/c"]);
  });
  it("sortModels: preserve discovered order when no history", () => {
    expect(sortModels(["openrouter/a", "openrouter/b"])).toEqual(["openrouter/a", "openrouter/b"]);
    expect(sortModels(["openrouter/a"], ["openrouter/a"])).toEqual(["openrouter/a"]);
  });
});

describe("Claude parser and state reader", () => {
  it("parseClaudeSettings: extract model, effortLevel, permissionMode from settings.json", () => {
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

  it("parseClaudeModelCatalog: format A (catalog.config.models) parsing", () => {
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

  it("parseClaudeModelCatalog: format B (document.surfaces.cc.model_selector_config) parsing", () => {
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

  it("ClaudeAgent: getModels, getEfforts, getModes default behavior", () => {
    const a = agentFor("claude");
    const models = a.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(a.getEfforts("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(a.getEfforts("claude-haiku-4-5-20251001")).toEqual([]);
    expect(a.getModes()).toEqual(["default", "accept-edits", "plan"]);
  });

  it("normalizeClaudeMode: alias normalization", () => {
    expect(normalizeClaudeMode("manual")).toBe("default");
    expect(normalizeClaudeMode("default")).toBe("default");
    expect(normalizeClaudeMode("accept-edits")).toBe("accept-edits");
    expect(normalizeClaudeMode("acceptedits")).toBe("accept-edits");
    expect(normalizeClaudeMode("accept_edits")).toBe("accept-edits");
    expect(normalizeClaudeMode("plan")).toBe("plan");
    expect(normalizeClaudeMode("plan-mode")).toBe("plan");
    expect(normalizeClaudeMode("auto")).toBe("auto");
    expect(normalizeClaudeMode("bypass-permissions")).toBe("bypassPermissions");
  });

  it("getClaudeShiftTabSteps: calculate exact Shift+Tab count (3 modes default)", () => {
    // default -> accept-edits: 1 step
    expect(getClaudeShiftTabSteps("accept-edits", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // default -> plan: 2 steps
    expect(getClaudeShiftTabSteps("plan", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
      { text: "\x1b[Z", enter: false, delayMs: 120 },
    ]);
    // accept-edits -> plan: 1 step
    expect(getClaudeShiftTabSteps("plan", "accept-edits")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // plan -> default: 1 step
    expect(getClaudeShiftTabSteps("default", "plan")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // same mode: 0 steps
    expect(getClaudeShiftTabSteps("default", "default")).toEqual([]);
    expect(getClaudeShiftTabSteps("plan", "plan")).toEqual([]);
  });

  it("parseClaudeModeFromText: detect current mode from live terminal preview (including bypassPermissions)", () => {
    expect(parseClaudeModeFromText("⏵⏵ auto mode on (shift+tab to cycle) · ← for agents")).toBe("auto");
    expect(parseClaudeModeFromText("⏸ plan mode on (shift+tab to cycle) · ← for agents")).toBe("plan");
    expect(parseClaudeModeFromText("⏵⏵ accept edits on (shift+tab to cycle) · ← for agents")).toBe("accept-edits");
    expect(parseClaudeModeFromText("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents")).toBe("bypassPermissions");
    expect(parseClaudeModeFromText("⏸ manual mode on · ← for agents")).toBe("default");
    expect(parseClaudeModeFromText("[auto mode on]")).toBe("auto");
    expect(parseClaudeModeFromText("[plan mode on]")).toBe("plan");
    expect(parseClaudeModeFromText("[accept edits on]")).toBe("accept-edits");
    expect(parseClaudeModeFromText("[bypass permissions on]")).toBe("bypassPermissions");
    expect(parseClaudeModeFromText("[manual mode on]")).toBe("default");
    expect(parseClaudeModeFromText("\x1b[33m⏵⏵ auto mode on (shift+tab to cycle)\x1b[0m")).toBe("auto");
    expect(parseClaudeModeFromText("")).toBeUndefined();
    expect(parseClaudeModeFromText("just some text with no mode")).toBeUndefined();
  });

  it("isClaudeBypassEnabled: detect dangerously-skip-permissions or bypass permissions", () => {
    expect(isClaudeBypassEnabled({ preview: "claude '--dangerously-skip-permissions'" })).toBe(true);
    expect(isClaudeBypassEnabled({ preview: "⏵⏵ bypass permissions on" })).toBe(true);
    expect(isClaudeBypassEnabled({ preview: "claude" })).toBe(false);
    expect(isClaudeBypassEnabled(undefined)).toBe(false);
  });

  it("getClaudeShiftTabSteps: 4-mode cycle calculation when bypassPermissions is active", () => {
    const bypassList = [...CLAUDE_BYPASS_MODES]; // ["default", "accept-edits", "plan", "bypassPermissions"]
    // plan -> bypassPermissions: 1 step
    expect(getClaudeShiftTabSteps("bypassPermissions", "plan", bypassList)).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // bypassPermissions -> default: 1 step
    expect(getClaudeShiftTabSteps("default", "bypassPermissions", bypassList)).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // plan -> default: 2 steps (via bypassPermissions)
    expect(getClaudeShiftTabSteps("default", "plan", bypassList)).toEqual([
      { text: "\x1b[Z", enter: false },
      { text: "\x1b[Z", enter: false, delayMs: 120 },
    ]);
    // bypassPermissions -> accept-edits: 2 steps (via default)
    expect(getClaudeShiftTabSteps("accept-edits", "bypassPermissions", bypassList)).toEqual([
      { text: "\x1b[Z", enter: false },
      { text: "\x1b[Z", enter: false, delayMs: 120 },
    ]);
  });

  it("readClaudeState: prioritize real-time TUI mode when ctx.preview is present", () => {
    const st = readClaudeState({ preview: "⏸ plan mode on (shift+tab to cycle) · ← for agents" });
    expect(st.mode).toBe("plan");

    const stAuto = readClaudeState({ preview: "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents" });
    expect(stAuto.mode).toBe("auto");

    const stAccept = readClaudeState({ preview: "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents" });
    expect(stAccept.mode).toBe("accept-edits");

    const stBypass = readClaudeState({ preview: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents" });
    expect(stBypass.mode).toBe("bypassPermissions");
    expect(stBypass.modes).toEqual(["default", "accept-edits", "plan", "bypassPermissions"]);

    const stManual = readClaudeState({ preview: "⏸ manual mode on · ← for agents" });
    expect(stManual.mode).toBe("default");
  });

  it("readClaudeState: read local and workspace state", () => {
    const st = readClaudeState({ worktreePath: "/Users/ben/Workspaces/Tools/deep" });
    expect(st).toBeDefined();
    expect(typeof st).toBe("object");
  });
});

describe("Codex & Agy parser and state reader", () => {
  it("parseCodexConfig: extract model, model_reasoning_effort, sandbox_mode from TOML", () => {
    const toml = `model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "workspace-write"\n`;
    expect(parseCodexConfig(toml)).toEqual({
      model: "gpt-5.6-luna",
      effort: "medium",
      mode: "workspace-write",
    });
  });
  it("parseCodexConfig: undefined when missing", () => {
    expect(parseCodexConfig("")).toEqual({ model: undefined, effort: undefined, mode: undefined });
  });
  it("parseCodexModelsCache: extract model slugs excluding auto-review from JSON cache", () => {
    const json = JSON.stringify({
      models: [
        { slug: "gpt-reserve" },
        { slug: "gpt-5.6-luna" },
        { slug: "codex-auto-review" },
      ],
    });
    expect(parseCodexModelsCache(json)).toEqual(["gpt-reserve", "gpt-5.6-luna"]);
  });
  it("CodexAgent: getModels, getEfforts, getModes default behavior", () => {
    const a = agentFor("codex");
    expect(a.getModels().length).toBeGreaterThan(0);
    expect(a.getEfforts()).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(a.getModes()).toEqual(["workspace-write", "read-only", "danger-full-access"]);
  });
  it("readCodexState: read local state", () => {
    const st = readCodexState();
    expect(st).toBeDefined();
    expect(typeof st).toBe("object");
  });
  it("parseAgyModels: strip 'Fetching...' and extract ID before tab", () => {
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
  it("parseAgySettings: extract and normalize model and mode/agent from settings.json", () => {
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

  it("normalizeAgyMode: normalize mode string to default / plan / accept-edits", () => {
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

  it("AgyAgent.getModes: return default, accept-edits, plan", () => {
    expect(agentFor("agy").getModes()).toEqual(["default", "accept-edits", "plan"]);
    expect(AGY_MODES).toEqual(["default", "accept-edits", "plan"]);
  });

  it("getAgyShiftTabSteps: calculate exact Shift+Tab count", () => {
    // default -> accept-edits: 1 step
    expect(getAgyShiftTabSteps("accept-edits", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // default -> plan: 2 steps
    expect(getAgyShiftTabSteps("plan", "default")).toEqual([
      { text: "\x1b[Z", enter: false },
      { text: "\x1b[Z", enter: false, delayMs: 120 },
    ]);
    // accept-edits -> plan: 1 step
    expect(getAgyShiftTabSteps("plan", "accept-edits")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // plan -> default: 1 step
    expect(getAgyShiftTabSteps("default", "plan")).toEqual([
      { text: "\x1b[Z", enter: false },
    ]);
    // same mode: 0 steps
    expect(getAgyShiftTabSteps("default", "default")).toEqual([]);
    expect(getAgyShiftTabSteps("plan", "plan")).toEqual([]);
  });

  it("parseAgyHelpModes: parse modes from agy --help output", () => {
    const helpText = `Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --model                         Model for the current CLI session
`;
    expect(parseAgyHelpModes(helpText)).toEqual(["default", "accept-edits", "plan"]);
    expect(parseAgyHelpModes("")).toEqual([]);
    expect(parseAgyHelpModes("no mode flag here")).toEqual([]);
  });

  it("extractEffortFromModel: extract implicit effort from model name or slug", () => {
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

  it("AgyAgent.getEffortForModel: return implicit effort in model name", () => {
    const agy = agentFor("agy");
    expect(agy.getEffortForModel("gemini-3.8-flash-high")).toBe("high");
    expect(agy.getEffortForModel("Gemini 3.8 Flash (Medium)")).toBe("medium");
    expect(agy.getEffortForModel("claude-sonnet-4-6")).toBeUndefined();
  });

  it("parseAgyLogWorkspace: extract workspaceDirs and store manager paths from log header", () => {
    const header1 = `I0913 16:36:45.100430       1 server.go:299] Creating CLI server backend: product=antigravity workspaceDirs=[/Users/ben/Workspaces/Tools/deep] appDataDir=/Users/ben/.gemini/antigravity-cli cascadeManager=true codeAssist=true`;
    expect(parseAgyLogWorkspace(header1)).toEqual(["/Users/ben/Workspaces/Tools/deep"]);

    const header2 = `I0912 02:17:26.375160       1 server.go:285] Creating CLI server backend: product=antigravity workspaceDirs=[/Users/ben/Workspaces/Tools/AltReady] appDataDir=...
I0912 02:17:26.378614       1 manager.go:426] Initializing CLI store manager for workspace /Users/ben/Workspaces/Tools/AltReady`;
    expect(parseAgyLogWorkspace(header2)).toEqual(["/Users/ben/Workspaces/Tools/AltReady"]);

    expect(parseAgyLogWorkspace("")).toEqual([]);
  });

  it("isMatchingWorkspace: workspace path matching and normalization", () => {
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep", "/Users/ben/Workspaces/Tools/deep")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep/", "/Users/ben/Workspaces/Tools/deep")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep", "/Users/ben/Workspaces/Tools/deep/.orca/worktrees/feat")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep/com.byjw.deep.sdPlugin", "/Users/ben/Workspaces/Tools/deep")).toBe(true);
    expect(isMatchingWorkspace("/Users/ben/Workspaces/Tools/deep", "/Users/ben/Workspaces/Tools/AltReady")).toBe(false);
    expect(isMatchingWorkspace("", "/Users/ben/Workspaces/Tools/deep")).toBe(false);
  });

  it("parseAgyLogModel: parse model override and user input from CLI log", () => {
    const log1 = `I0913 16:48:15.672433   11525 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.7 Flash (High)"`;
    expect(parseAgyLogModel(log1)).toBe("Gemini 3.7 Flash (High)");

    const log2 = `I0913 16:48:15.672342   11525 model_resolver.go:93] Resolving model Gemini 3.7 Flash (Medium)`;
    expect(parseAgyLogModel(log2)).toBe("Gemini 3.7 Flash (Medium)");

    const log3 = `I0913 16:48:15.672342   11525 input_loop.go:94] HandleUserInput called with text: "/model gemini-3.8-flash-low"`;
    expect(parseAgyLogModel(log3)).toBe("gemini-3.8-flash-low");

    expect(parseAgyLogModel("")).toBeUndefined();
  });

  it("parseAgyLogEffort: parse /effort command from CLI log", () => {
    const log1 = `I0913 16:48:15.672342   11525 input_loop.go:94] HandleUserInput called with text: "/effort high"`;
    expect(parseAgyLogEffort(log1)).toBe("high");

    const log2 = `I0913 16:48:15.672342   11525 input_loop.go:94] HandleUserInput called with text: "/effort medium"`;
    expect(parseAgyLogEffort(log2)).toBe("medium");

    expect(parseAgyLogEffort("")).toBeUndefined();
  });

  it("parseAgyLogMode: parse SetCycleMode, /mode, and /agent from CLI log", () => {
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

  it("parseAgyModeFromText: detect current mode from live terminal preview", () => {
    expect(parseAgyModeFromText("> Plan mode: research & plan only to-approved (shift+tab to cycle)")).toBe("plan");
    expect(parseAgyModeFromText("> Auto-approve edits on (shift+tab to cycle)")).toBe("accept-edits");
    expect(parseAgyModeFromText("> Default mode on (shift+tab to cycle)")).toBe("default");
    expect(parseAgyModeFromText("> Manual mode on")).toBe("default");
    expect(parseAgyModeFromText("\x1b[32m> Plan mode: active\x1b[0m")).toBe("plan");
    expect(parseAgyModeFromText("")).toBeUndefined();
    expect(parseAgyModeFromText("regular terminal output")).toBeUndefined();
  });

  it("readAgyState: prioritize real-time TUI mode when ctx.preview is present", () => {
    const st = readAgyState({ preview: "> Plan mode: research & plan only to-approved (shift+tab to cycle)" });
    expect(st.mode).toBe("plan");

    const stAccept = readAgyState({ preview: "> Auto-approve edits on (shift+tab to cycle)" });
    expect(stAccept.mode).toBe("accept-edits");
  });

  it("readAgyState: read currently running agy session state per workspace", () => {
    const stDeep = readAgyState({ worktreePath: "/Users/ben/Workspaces/Tools/deep" });
    expect(stDeep).toBeDefined();
    expect(typeof stDeep).toBe("object");

    const stAlt = readAgyState({ worktreePath: "/Users/ben/Workspaces/Tools/AltReady" });
    expect(stAlt).toBeDefined();
    expect(typeof stAlt).toBe("object");

    if (stDeep.effort && stAlt.effort) {
      expect(typeof stDeep.effort).toBe("string");
      expect(typeof stAlt.effort).toBe("string");
    }
  });
});

describe("Hermes parser and models cache", () => {
  it("parseHermesConfig: extract default model and reasoning_effort from config.yaml", () => {
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

  it("parseHermesConfig: undefined when missing", () => {
    expect(parseHermesConfig("")).toEqual({ model: undefined, effort: undefined });
  });

  it("parseHermesModelsCache: extract deduplicated models from provider_models_cache.json", () => {
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

  it("HermesAgent.getEfforts: return hermes supported reasoning levels", () => {
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

describe("Pi parser and state reader", () => {
  it("agentFor / profileFor: pi maps to PiAgent and supports model + effort only", () => {
    expect(agentFor("pi")).toBeInstanceOf(PiAgent);
    expect(agentFor(" Pi ")).toBeInstanceOf(PiAgent);
    expect(agentFor("pi-cli")).toBeInstanceOf(PiAgent);
    expect(profileFor("pi").label).toBe("Pi");

    const a = agentFor("pi");
    expect(a.supports("model")).toBe(true);
    expect(a.supports("effort")).toBe(true);
    expect(a.supports("mode")).toBe(false);
  });

  it("apply steps: /model <provider/id> and /thinking <level>", () => {
    const a = agentFor("pi");
    expect(a.getApplySteps("model", "opencode/deepseek-v4-flash")).toEqual([
      { text: "/model opencode/deepseek-v4-flash", enter: true, delayMs: 120 },
    ]);
    expect(a.getApplySteps("effort", "high")).toEqual([
      { text: "/thinking high", enter: true, delayMs: 120 },
    ]);
    expect(a.getApplySteps("mode", "plan")).toEqual([]);
  });

  it("discovery: pi --list-models command", () => {
    const cmd = discoverModelCmd("pi");
    expect(cmd?.[1]).toBe("--list-models");
    expect(cmd?.[0].endsWith("pi")).toBe(true);
    expect(discoverAgentCmd("pi")).toBeUndefined();
    expect(discoverVariantCmd("pi")).toBeUndefined();
  });

  it("parsePiSessionTail: newest model_change / thinking_level_change win, recent models collected", () => {
    const tail = [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/Users/ben/w" }),
      JSON.stringify({ type: "model_change", provider: "opencode", modelId: "deepseek-v4-flash" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "opencode", model: "deepseek-v4-flash" } }),
      JSON.stringify({ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-4-6" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    ].join("\n");

    expect(parsePiSessionTail(tail)).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
      recentModels: ["anthropic/claude-sonnet-4-6", "opencode/deepseek-v4-flash"],
    });
  });

  it("parsePiSessionTail: provider-qualifies ids that already contain slashes", () => {
    const tail = [
      JSON.stringify({ type: "model_change", provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" }),
      JSON.stringify({ type: "model_change", provider: "openrouter", modelId: "openrouter/anthropic/claude-sonnet-4-6" }),
    ].join("\n");
    expect(parsePiSessionTail(tail).model).toBe("openrouter/anthropic/claude-sonnet-4-6");

    const only = JSON.stringify({ type: "model_change", provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" });
    expect(parsePiSessionTail(only).model).toBe("openrouter/deepseek/deepseek-v4.1-flash");
  });

  it("parsePiSessionTail: falls back to the newest assistant message when no model_change is in the window", () => {
    const tail = [
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" } }),
    ].join("\n");
    expect(parsePiSessionTail(tail)).toEqual({
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      effort: "high",
      recentModels: ["openrouter/deepseek/deepseek-v4.1-flash"],
    });
  });

  it("readPiSessionState: keeps session-start effort from the head and live model from the tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-pi-"));
    const file = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/Users/ben/w" }),
      JSON.stringify({ type: "model_change", provider: "opencode", modelId: "deepseek-v4-flash" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
      // Filler larger than the head window, pushing the model_change out of the head.
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "opencode", model: "deepseek-v4-flash", content: "x".repeat(40 * 1024) } }),
      JSON.stringify({ type: "model_change", provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" }),
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" } }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const st = readPiSessionState(file, { headBytes: 16 * 1024, tailBytes: 256 * 1024 });
    expect(st.model).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(st.effort).toBe("high");
    expect(st.recentModels?.[0]).toBe("openrouter/deepseek/deepseek-v4.1-flash");

    rmSync(dir, { recursive: true, force: true });
  });

  it("readPiSessionState: tolerates missing files and huge files with no state entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdeck-pi-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/w" }) + "\n" + "y".repeat(300 * 1024));
    expect(readPiSessionState(file, { headBytes: 1024, tailBytes: 8 * 1024 })).toEqual({});
    expect(readPiSessionState(join(dir, "nope.jsonl"))).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it("parsePiSessionTail: tolerate partial/corrupt trailing lines", () => {
    const tail = `${JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna" })}\n{"type":"model_cha`;
    expect(parsePiSessionTail(tail)).toEqual({
      model: "openai-codex/gpt-5.6-luna",
      recentModels: ["openai-codex/gpt-5.6-luna"],
    });
    expect(parsePiSessionTail("")).toEqual({});
  });

  it("parsePiSettings: qualify defaultModel with defaultProvider, project overrides handled by reader", () => {
    expect(
      parsePiSettings(JSON.stringify({ defaultProvider: "opencode", defaultModel: "deepseek-v4-flash", defaultThinkingLevel: "high" })),
    ).toEqual({ model: "opencode/deepseek-v4-flash", effort: "high" });
    expect(parsePiSettings(JSON.stringify({ defaultModel: "anthropic/claude-sonnet-4-6" }))).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      effort: undefined,
    });
    expect(parsePiSettings("invalid")).toEqual({});
  });

  it("parsePiListModels: parse table rows into provider/model ids, skipping header and noise", () => {
    const stdout = `provider      model                                                     context  max-out  thinking  images
anthropic     claude-sonnet-4-6                                         1M       128K     yes       yes
opencode      deepseek-v4-flash                                         131.1K   32.8K    yes       no
openai-codex  gpt-5.6-luna                                              400K     128K     yes       yes

some trailing noise
`;
    expect(parsePiListModels(stdout)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "opencode/deepseek-v4-flash",
      "openai-codex/gpt-5.6-luna",
    ]);
    expect(parsePiListModels(`\u001b[32manthropic\u001b[0m     claude-sonnet-4-6   1M  128K  yes  yes`)).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("parsePiModelsStore: ids plus reasoning support and available thinking levels", () => {
    const json = JSON.stringify({
      anthropic: { models: [{ id: "claude-sonnet-4-6", reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }] },
      lmstudio: { models: [{ id: "gemma-4-e4b", reasoning: false }, { id: "qwen3-30b" }] },
      anthropic2: { models: [] },
    });
    const parsed = parsePiModelsStore(json);
    expect(parsed.models).toEqual([
      "anthropic/claude-sonnet-4-6",
      "lmstudio/gemma-4-e4b",
      "lmstudio/qwen3-30b",
    ]);
    expect(parsed.reasoning["anthropic/claude-sonnet-4-6"]).toBe(true);
    expect(parsed.reasoning["lmstudio/gemma-4-e4b"]).toBe(false);
    expect(parsed.reasoning["lmstudio/qwen3-30b"]).toBe(false);
    expect(parsed.efforts["anthropic/claude-sonnet-4-6"]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(parsePiModelsStore("nope")).toEqual({ models: [], reasoning: {}, efforts: {} });
  });

  it("piSessionDir: encodes the worktree path the way pi stores sessions", () => {
    const dir = piSessionDir("/Users/ben/Workspaces/Tools/deep/");
    expect(dir.endsWith("--Users-ben-Workspaces-Tools-deep--")).toBe(true);
  });

  it("PiAgent: thinking levels and model fallback", () => {
    const a = agentFor("pi");
    expect(a.getEfforts()).toEqual([...PI_THINKING_LEVELS]);
    expect(a.getEfforts("not-a-real-provider/not-a-real-model")).toEqual([...PI_THINKING_LEVELS]);
    expect(a.getModels().length).toBeGreaterThan(0);
    expect(PI_DEFAULT_MODELS.length).toBeGreaterThan(0);
  });

  it("readPiState: returns an object (live session state or settings defaults)", () => {
    const st = readPiState();
    expect(st).toBeDefined();
    expect(typeof st).toBe("object");
  });
});