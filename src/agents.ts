// Per-agent abstract interface and implementations — which agent changes model/effort/mode using which command.
// Pure functions and object-oriented model (fully testable). Connected to agentType (claude/codex/opencode/...) reported by orca worktree ps.
// Core principle: Gate unsupported agents and features to prevent sending invalid commands. Unknown agent = unsupported.

import { readFileSync, existsSync, readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type ControlKind = "model" | "effort" | "mode";

/** A single step (line) to send to terminal. If UI needs reaction delay (e.g. pickers), delayMs waits before/after next send. */
export interface ApplyStep {
  text: string;
  enter: boolean;
  delayMs?: number;
}

export interface AgentContext {
  worktreePath?: string;
  worktreeId?: string;
  handle?: string;
  preview?: string;
}

export interface AgentStateSnapshot {
  model?: string;
  effort?: string;
  mode?: string;
  modes?: string[];
  recentModels?: string[];
  favoriteModels?: string[];
}

/**
 * Abstract Agent Interface
 * Standard interface for inspecting supported features and requesting commands/lists for a given agent.
 */
export abstract class AbstractAgent {
  abstract readonly agentType: string;
  abstract readonly label: string;

  /** Check if a control kind (model, effort, mode) is supported */
  abstract supports(kind: ControlKind): boolean;

  /** Available model list (static fallback or defaults) */
  getModels(): string[] {
    return [];
  }

  /** Available effort list */
  getEfforts(_modelId?: string): string[] {
    return [];
  }

  /** Available modes/agents list */
  getModes(_ctx?: AgentContext): string[] {
    return [];
  }

  /** Generate terminal send sequence for applying a change */
  abstract getApplySteps(kind: ControlKind, value: string, fromValue?: string, modeList?: string[]): ApplyStep[];

  /** Host CLI command to discover models (array of arguments) */
  getDiscoverModelCmd(): string[] | undefined {
    return undefined;
  }

  /** Host CLI command to discover modes */
  getDiscoverAgentCmd(): string[] | undefined {
    return undefined;
  }

  /** Host CLI command to discover model variants (efforts) */
  getDiscoverVariantCmd(): string[] | undefined {
    return undefined;
  }

  /** Parse model list from CLI output */
  parseDiscoveredModels(stdout: string): string[] {
    return parseModels(stdout);
  }

  /** Parse mode list from CLI output */
  parseDiscoveredModes(stdout: string): string[] {
    return parsePrimaryAgents(stdout);
  }

  /** Parse model variants (efforts) from CLI output */
  parseDiscoveredEfforts(stdout: string, modelId: string): string[] {
    return parseModelVariants(stdout, modelId);
  }

  /** Read currently selected state from local state files/configs or workspace logs */
  readCurrentState(_ctx?: AgentContext): AgentStateSnapshot {
    return {};
  }

  /** Return effort/variant bound to or inferred by a selected model */
  getEffortForModel(_model: string): string | undefined {
    return undefined;
  }

  /** Set discovered model id -> display name map (e.g. OpenCode picker filter) */
  setModelNames(_names: Record<string, string>): void {}

  /** Normalize a session/tab title for deck display. Agents whose hosts decorate titles
   * (e.g. Orca prefixes opencode tabs with "OC | ") override this to strip their prefix. */
  cleanTitle(title: string): string {
    return title;
  }

  /** Extract model id -> display name map from discovery output */
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

// OpenCode model picker: Open dialog deterministically with leader (ctrl+x)+m,
// and type 'provider display-name' into the filter without pressing Enter (user confirms).
// Filter text includes provider to disambiguate models with identical names across providers.
const openCodeModelPicker = (value: string, name?: string): ApplyStep[] => [
  { text: "\x18", enter: false, delayMs: 300 }, // ctrl+x (leader)
  { text: "m", enter: false, delayMs: 450 }, // model list dialog
  { text: modelFilterText(value, name), enter: false },
];

// Claude settings, model catalog cache, and projects path
export const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
export const CLAUDE_MODEL_CATALOG_DIR = join(homedir(), ".claude", "cache", "model-catalog");
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export const CLAUDE_DEFAULT_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "opus",
  "sonnet",
  "haiku",
];

export const CLAUDE_MODES = ["default", "accept-edits", "plan"] as const;
export const CLAUDE_BYPASS_MODES = ["default", "accept-edits", "plan", "bypassPermissions"] as const;

export function isClaudeBypassEnabled(ctx?: AgentContext): boolean {
  if (ctx?.preview) {
    const p = ctx.preview.toLowerCase();
    if (
      p.includes("dangerously-skip-permissions") ||
      p.includes("bypass permissions") ||
      p.includes("bypass-permissions") ||
      p.includes("bypasspermissions")
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeClaudeMode(raw?: string): string {
  if (!raw) return "default";
  const s = raw.trim().toLowerCase().replace(/_/g, "-");
  if (s === "manual" || s === "normal" || s === "default" || s === "manual-mode" || s === "default-mode") return "default";
  if (s === "accept-edits" || s === "acceptedits" || s === "accept" || s === "accept edits") return "accept-edits";
  if (s === "plan" || s === "plan-mode" || s === "plan mode") return "plan";
  if (s === "auto" || s === "auto-mode" || s === "automode" || s === "auto mode") return "auto";
  if (
    s === "bypasspermissions" ||
    s === "bypass-permissions" ||
    s === "bypass permissions" ||
    s === "bypass"
  ) {
    return "bypassPermissions";
  }
  return s;
}

export function getClaudeShiftTabSteps(toMode: string, fromMode?: string, modeList?: string[]): ApplyStep[] {
  const list = modeList && modeList.length ? modeList : (CLAUDE_MODES as unknown as string[]);
  const target = normalizeClaudeMode(toMode);
  const current = normalizeClaudeMode(fromMode);
  const targetIdx = list.indexOf(target);
  const currentIdx = list.indexOf(current);
  if (targetIdx < 0) {
    return [];
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

export function parseClaudeSettings(text: string): { model?: string; effort?: string; mode?: string } {
  try {
    const data = JSON.parse(text);
    const model = typeof data?.model === "string" ? data.model : undefined;
    const effort =
      typeof data?.effortLevel === "string"
        ? data.effortLevel
        : typeof data?.effort === "string"
        ? data.effort
        : undefined;
    const rawMode =
      typeof data?.permissionMode === "string"
        ? data.permissionMode
        : typeof data?.mode === "string"
        ? data.mode
        : typeof data?.agent === "string"
        ? data.agent
        : undefined;
    const mode = rawMode ? normalizeClaudeMode(rawMode) : undefined;
    return { model, effort, mode };
  } catch {
    return {};
  }
}

export function parseClaudeModelCatalog(text: string): {
  models: string[];
  modelNames: Record<string, string>;
  effortsByModel: Record<string, string[]>;
} {
  const models: string[] = [];
  const modelNames: Record<string, string> = {};
  const effortsByModel: Record<string, string[]> = {};
  const seen = new Set<string>();

  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") {
      return { models, modelNames, effortsByModel };
    }

    const processModel = (m: any) => {
      if (!m || typeof m !== "object") return;
      const mid = typeof m.id === "string" ? m.id.trim() : "";
      if (!mid) return;
      if (!seen.has(mid)) {
        seen.add(mid);
        models.push(mid);
      }
      const name =
        typeof m.name === "string"
          ? m.name.trim()
          : typeof m.short_name === "string"
          ? m.short_name.trim()
          : "";
      if (name) {
        modelNames[mid] = name;
      }
      const thinking = m.thinking;
      if (thinking && typeof thinking === "object") {
        const effortOpts = thinking.effort_options;
        if (Array.isArray(effortOpts)) {
          const efforts = effortOpts
            .map((opt: any) => (typeof opt?.id === "string" ? opt.id.trim() : ""))
            .filter(Boolean);
          if (efforts.length) {
            effortsByModel[mid] = efforts;
          }
        }
      }
    };

    // Format A: catalog.config.models
    const catModels = data?.catalog?.config?.models;
    if (Array.isArray(catModels)) {
      for (const m of catModels) processModel(m);
    }

    // Format B: document.surfaces.<surface>.model_selector_config[].models
    const surfaces = data?.document?.surfaces;
    if (surfaces && typeof surfaces === "object") {
      const surfaceKeys = ["cc", "cowork", "ccd", "ccr", "chat", ...Object.keys(surfaces)];
      const checked = new Set<string>();
      for (const sname of surfaceKeys) {
        if (checked.has(sname)) continue;
        checked.add(sname);
        const sval = surfaces[sname];
        if (sval && typeof sval === "object" && Array.isArray(sval.model_selector_config)) {
          for (const cfg of sval.model_selector_config) {
            if (cfg && Array.isArray(cfg.models)) {
              for (const m of cfg.models) processModel(m);
            }
          }
        }
      }
    }
  } catch {}

  return { models, modelNames, effortsByModel };
}

export function readClaudeModelsCache(): string[] {
  try {
    if (existsSync(CLAUDE_MODEL_CATALOG_DIR)) {
      const files = readdirSync(CLAUDE_MODEL_CATALOG_DIR).filter((f) => f.endsWith(".json"));
      const allModels: string[] = [];
      const seen = new Set<string>();
      for (const file of files) {
        try {
          const content = readFileSync(join(CLAUDE_MODEL_CATALOG_DIR, file), "utf8");
          const { models } = parseClaudeModelCatalog(content);
          for (const m of models) {
            if (!seen.has(m)) {
              seen.add(m);
              allModels.push(m);
            }
          }
        } catch {}
      }
      if (allModels.length) return allModels;
    }
  } catch {}
  return [];
}

export function readClaudeModelEffortsCache(modelId?: string): string[] {
  if (!modelId) return [];
  try {
    if (existsSync(CLAUDE_MODEL_CATALOG_DIR)) {
      const files = readdirSync(CLAUDE_MODEL_CATALOG_DIR).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const content = readFileSync(join(CLAUDE_MODEL_CATALOG_DIR, file), "utf8");
          const { effortsByModel } = parseClaudeModelCatalog(content);
          if (effortsByModel[modelId]?.length) {
            return effortsByModel[modelId];
          }
        } catch {}
      }
    }
  } catch {}
  return [];
}

export function parseClaudeModeFromText(text?: string): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  const lines = clean.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim().toLowerCase();
    if (!l) continue;
    if (l.includes("plan mode") || (l.includes("plan") && l.includes("shift+tab") && !l.includes("auto") && !l.includes("accept") && !l.includes("bypass"))) {
      return "plan";
    }
    if (l.includes("auto mode") || (l.includes("auto") && l.includes("shift+tab") && !l.includes("accept") && !l.includes("bypass"))) {
      return "auto";
    }
    if (
      l.includes("accept edits") ||
      l.includes("accept-edits") ||
      l.includes("auto-accept") ||
      (l.includes("accept") && l.includes("shift+tab"))
    ) {
      return "accept-edits";
    }
    if (
      l.includes("bypass permissions") ||
      l.includes("bypass-permissions") ||
      l.includes("bypasspermissions") ||
      (l.includes("bypass") && l.includes("shift+tab"))
    ) {
      return "bypassPermissions";
    }
    if (l.includes("manual mode") || l.includes("default mode") || (l.includes("manual") && l.includes("shift+tab"))) {
      return "default";
    }
  }
  return undefined;
}

export function readClaudeState(ctx?: AgentContext): AgentStateSnapshot {
  const state: AgentStateSnapshot = {};

  const isBypass = isClaudeBypassEnabled(ctx);
  state.modes = isBypass ? [...CLAUDE_BYPASS_MODES] : [...CLAUDE_MODES];

  // 1. Live terminal preview priority parsing (real-time TUI state)
  if (ctx?.preview) {
    const previewMode = parseClaudeModeFromText(ctx.preview);
    if (previewMode) {
      state.mode = previewMode;
      if (previewMode === "bypassPermissions") {
        state.modes = [...CLAUDE_BYPASS_MODES];
      } else if (previewMode === "auto" && !state.modes.includes("auto")) {
        state.modes.push("auto");
      }
    }
  }

  // 2. Transcript JSONL inspection in ~/.claude/projects/-<normalized-path>/
  if (ctx?.worktreePath) {
    try {
      const normalizedPath = ctx.worktreePath.replace(/\/+$/, "");
      const projName = normalizedPath.replace(/\//g, "-");
      const projDir = join(CLAUDE_PROJECTS_DIR, projName);
      if (existsSync(projDir)) {
        const jsonlFiles = readdirSync(projDir)
          .filter((f) => f.endsWith(".jsonl") && !f.includes("subagents"))
          .map((f) => ({
            path: join(projDir, f),
            mtime: statSync(join(projDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime);

        for (const item of jsonlFiles.slice(0, 3)) {
          try {
            const fd = openSync(item.path, "r");
            const size = fstatSync(fd).size;
            const readLen = Math.min(size, 64 * 1024);
            const buf = Buffer.alloc(readLen);
            readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
            closeSync(fd);
            const tail = buf.toString("utf8", 0, readLen);
            const lines = tail.split("\n");

            for (let i = lines.length - 1; i >= 0; i--) {
              const line = lines[i].trim();
              if (!line) continue;
              try {
                const d = JSON.parse(line);
                if (!state.model) {
                  if (d.type === "assistant" && typeof d.message === "object" && typeof d.message?.model === "string") {
                    state.model = d.message.model;
                  }
                }
                if (!state.mode) {
                  if (d.type === "permission-mode" && typeof d.permissionMode === "string") {
                    state.mode = normalizeClaudeMode(d.permissionMode);
                    if (state.mode === "bypassPermissions") {
                      state.modes = [...CLAUDE_BYPASS_MODES];
                    } else if (state.mode === "auto" && !state.modes.includes("auto")) {
                      state.modes.push("auto");
                    }
                  } else if (d.type === "mode" && typeof d.mode === "string") {
                    state.mode = normalizeClaudeMode(d.mode);
                    if (state.mode === "bypassPermissions") {
                      state.modes = [...CLAUDE_BYPASS_MODES];
                    } else if (state.mode === "auto" && !state.modes.includes("auto")) {
                      state.modes.push("auto");
                    }
                  }
                }
                if (!state.effort) {
                  if (typeof d.effort === "string") {
                    state.effort = d.effort;
                  } else if (typeof d.effortLevel === "string") {
                    state.effort = d.effortLevel;
                  }
                }
              } catch {}
              if (state.model && state.mode && state.effort) break;
            }
          } catch {}
          if (state.model && state.mode && state.effort) break;
        }
      }
    } catch {}
  }

  // 3. Static configuration file (settings.json) fallback
  const settingsPaths: string[] = [];
  if (ctx?.worktreePath) {
    settingsPaths.push(join(ctx.worktreePath, ".claude", "settings.json"));
    settingsPaths.push(join(ctx.worktreePath, ".claude.json"));
  }
  settingsPaths.push(CLAUDE_SETTINGS);

  for (const p of settingsPaths) {
    try {
      if (existsSync(p)) {
        const parsed = parseClaudeSettings(readFileSync(p, "utf8"));
        if (!state.model && parsed.model) state.model = parsed.model;
        if (!state.effort && parsed.effort) state.effort = parsed.effort;
        if (!state.mode && parsed.mode) {
          state.mode = parsed.mode;
          if (state.mode === "bypassPermissions") {
            state.modes = [...CLAUDE_BYPASS_MODES];
          } else if (state.mode === "auto" && !state.modes.includes("auto")) {
            state.modes.push("auto");
          }
        }
      }
    } catch {}
  }

  return state;
}

// Claude implementation
export class ClaudeAgent extends AbstractAgent {
  readonly agentType = "claude";
  readonly label = "Claude";

  supports(kind: ControlKind): boolean {
    return kind === "model" || kind === "effort" || kind === "mode";
  }

  override getModels(): string[] {
    const cached = readClaudeModelsCache();
    if (cached.length) return cached;
    return [...CLAUDE_DEFAULT_MODELS];
  }

  override getEfforts(modelId?: string): string[] {
    if (modelId) {
      const specific = readClaudeModelEffortsCache(modelId);
      if (specific.length) return specific;
      if (modelId.includes("haiku")) return [];
    }
    return ["low", "medium", "high", "xhigh", "max"];
  }

  override getModes(ctx?: AgentContext): string[] {
    const isBypass = isClaudeBypassEnabled(ctx);
    const hasAuto = ctx?.preview ? parseClaudeModeFromText(ctx.preview) === "auto" : false;
    const base = isBypass ? [...CLAUDE_BYPASS_MODES] : [...CLAUDE_MODES];
    if (hasAuto && !base.includes("auto")) {
      base.push("auto");
    }
    return base;
  }

  getApplySteps(kind: ControlKind, value: string, fromValue?: string, modeList?: string[]): ApplyStep[] {
    if (kind === "model") {
      return slash("/model", value);
    }
    if (kind === "effort") {
      return slash("/effort", value);
    }
    if (kind === "mode") {
      return getClaudeShiftTabSteps(value, fromValue, modeList || this.getModes());
    }
    return [];
  }

  override readCurrentState(ctx?: AgentContext): AgentStateSnapshot {
    return readClaudeState(ctx);
  }
}

// Codex config and models cache file paths
export const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
export const CODEX_MODELS_CACHE = join(homedir(), ".codex", "models_cache.json");

export const CODEX_DEFAULT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-reserve",
];

export function parseCodexConfig(tomlText: string): { model?: string; effort?: string; mode?: string } {
  let model: string | undefined;
  let effort: string | undefined;
  let mode: string | undefined;

  const modelMatch = /model\s*=\s*["']([^"']+)["']/.exec(tomlText || "");
  if (modelMatch) model = modelMatch[1];

  const effortMatch = /model_reasoning_effort\s*=\s*["']([^"']+)["']/.exec(tomlText || "");
  if (effortMatch) effort = effortMatch[1];

  const modeMatch = /sandbox_mode\s*=\s*["']([^"']+)["']/.exec(tomlText || "");
  if (modeMatch) mode = modeMatch[1];

  return { model, effort, mode };
}

export function parseCodexModelsCache(jsonText: string): string[] {
  try {
    const data = JSON.parse(jsonText);
    if (data && Array.isArray(data.models)) {
      return data.models
        .map((m: any) => (typeof m === "string" ? m : m?.slug || m?.id || m?.name))
        .filter((id: any): id is string => typeof id === "string" && id.trim().length > 0 && !id.toLowerCase().includes("auto-review"));
    }
  } catch {}
  return [];
}

export function readCodexState(ctx?: AgentContext): AgentStateSnapshot {
  try {
    if (ctx?.worktreePath) {
      const localCfg = join(ctx.worktreePath, ".codex", "config.toml");
      if (existsSync(localCfg)) {
        const cfg = parseCodexConfig(readFileSync(localCfg, "utf8"));
        return { model: cfg.model, effort: cfg.effort, mode: cfg.mode };
      }
    }
    if (existsSync(CODEX_CONFIG)) {
      const cfg = parseCodexConfig(readFileSync(CODEX_CONFIG, "utf8"));
      return { model: cfg.model, effort: cfg.effort, mode: cfg.mode };
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

// Codex implementation
export class CodexAgent extends AbstractAgent {
  readonly agentType = "codex";
  readonly label = "Codex";

  supports(kind: ControlKind): boolean {
    return kind === "model" || kind === "effort" || kind === "mode";
  }

  override getModels(): string[] {
    const cached = readCodexModelsCache();
    if (cached.length) return cached;
    return [...CODEX_DEFAULT_MODELS];
  }

  override getEfforts(): string[] {
    return ["none", "low", "medium", "high", "xhigh", "max"];
  }

  override getModes(): string[] {
    return ["workspace-write", "read-only", "danger-full-access"];
  }

  getApplySteps(kind: ControlKind, value: string): ApplyStep[] {
    if (kind === "model") {
      return slash("/model", value);
    }
    if (kind === "effort") {
      return slash("/effort", value);
    }
    if (kind === "mode") {
      return slash("/permissions", value);
    }
    return [];
  }

  override readCurrentState(ctx?: AgentContext): AgentStateSnapshot {
    return readCodexState(ctx);
  }
}

// OpenCode state and TUI paths
export const OPENCODE_STATE = join(homedir(), ".local", "state", "opencode", "model.json");
export const OPENCODE_TUI = join(homedir(), ".local", "state", "opencode", "tui");

export function readOpenCodeState(ctx?: AgentContext): OpenCodeModelState {
  try {
    if (ctx?.worktreePath) {
      const localState = join(ctx.worktreePath, ".opencode", "model.json");
      if (existsSync(localState)) {
        return parseOpenCodeState(readFileSync(localState, "utf8"));
      }
    }
    return parseOpenCodeState(readFileSync(OPENCODE_STATE, "utf8"));
  } catch {
    return {};
  }
}

export function readTuiAgent(ctx?: AgentContext): string | undefined {
  try {
    if (ctx?.worktreePath) {
      const localTui = join(ctx.worktreePath, ".opencode", "tui");
      if (existsSync(localTui)) {
        return parseTuiAgent(readFileSync(localTui, "utf8"));
      }
    }
    return parseTuiAgent(readFileSync(OPENCODE_TUI, "utf8"));
  } catch {
    return undefined;
  }
}

// OpenCode implementation
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

  /** Orca prefixes opencode tab titles with "OC | " — strip it for the deck. */
  override cleanTitle(title: string): string {
    return title.replace(/^OC\s*[|｜]\s*/, "");
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

  override readCurrentState(ctx?: AgentContext): AgentStateSnapshot {
    const st = readOpenCodeState(ctx);
    const tuiAgent = readTuiAgent(ctx);
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

// Agy settings path
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

export const AGY_MODES = ["default", "accept-edits", "plan"] as const;

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
  const preferredOrder = ["accept-edits", "plan"];
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
    return [];
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

export function parseAgyLogWorkspace(headerText: string): string[] {
  if (!headerText) return [];
  const dirs: string[] = [];
  const wsMatch = /workspaceDirs=\[([^\]]*)\]/.exec(headerText);
  if (wsMatch && wsMatch[1]) {
    for (const d of wsMatch[1].split(/[,|\s]+/)) {
      const trimmed = d.trim();
      if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed);
    }
  }
  const initMatch = /Initializing CLI store manager for workspace\s+([^\r\n]+)/.exec(headerText);
  if (initMatch && initMatch[1]) {
    const trimmed = initMatch[1].trim();
    if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed);
  }
  return dirs;
}

export function isMatchingWorkspace(wsPath?: string, targetPath?: string): boolean {
  if (!wsPath || !targetPath) return false;
  const normalize = (p: string) => {
    let s = p.trim();
    while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  };
  const w = normalize(wsPath);
  const t = normalize(targetPath);
  if (w === t) return true;
  if (t.startsWith(w + "/") || w.startsWith(t + "/")) return true;
  return false;
}

export function parseAgyLogModel(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m1 = /Propagating selected model override to backend:\s*label="([^"]+)"/.exec(line);
    if (m1 && m1[1].trim()) {
      return m1[1].trim();
    }
    const m2 = /Resolving model\s+([^\r\n]+)/.exec(line);
    if (m2 && m2[1].trim()) {
      return m2[1].trim();
    }
    const m3 = /HandleUserInput called with text:\s*"\/model\s+([^"\r\n]+)"/.exec(line);
    if (m3 && m3[1].trim()) {
      return m3[1].trim();
    }
  }
  return undefined;
}

export function parseAgyLogEffort(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = /HandleUserInput called with text:\s*"\/effort\s+([^"\r\n]+)"/.exec(line);
    if (m && m[1].trim()) {
      return m[1].trim().toLowerCase();
    }
  }
  return undefined;
}

export function parseAgyLogMode(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = /\]\s+SetCycleMode called:\s*([a-zA-Z0-9_\-]*)/.exec(line);
    if (m) {
      return normalizeAgyMode(m[1]);
    }
    const mAgent = /HandleUserInput called with text:\s*"\/agent\s+([^"\r\n]+)"/.exec(line);
    if (mAgent && mAgent[1].trim()) {
      return normalizeAgyMode(mAgent[1].trim());
    }
    const mMode = /HandleUserInput called with text:\s*"\/mode\s+([^"\r\n]+)"/.exec(line);
    if (mMode && mMode[1].trim()) {
      return normalizeAgyMode(mMode[1].trim());
    }
  }
  return undefined;
}

export function readAgyLiveState(ctx?: AgentContext): { model?: string; effort?: string; mode?: string } {
  try {
    if (!existsSync(AGY_LOG_DIR)) return {};
    const allFiles = readdirSync(AGY_LOG_DIR)
      .filter((f) => f.startsWith("cli-") && f.endsWith(".log"))
      .map((f) => ({ path: join(AGY_LOG_DIR, f), mtime: statSync(join(AGY_LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const targetPath = ctx?.worktreePath;
    let candidateFiles: { path: string; mtime: number }[] = [];

    if (targetPath) {
      const matched: { path: string; mtime: number }[] = [];
      for (const file of allFiles.slice(0, 30)) {
        try {
          const fd = openSync(file.path, "r");
          const size = fstatSync(fd).size;
          const readHeaderLen = Math.min(size, 32 * 1024);
          const buf = Buffer.alloc(readHeaderLen);
          readSync(fd, buf, 0, readHeaderLen, 0);
          closeSync(fd);
          const header = buf.toString("utf8", 0, readHeaderLen);
          const workspaces = parseAgyLogWorkspace(header);
          if (workspaces.some((ws) => isMatchingWorkspace(ws, targetPath))) {
            matched.push(file);
          }
        } catch {}
      }
      if (matched.length) {
        candidateFiles = matched;
      }
    }

    if (!candidateFiles.length) {
      candidateFiles = allFiles.slice(0, 5);
    }

    let foundModel: string | undefined;
    let foundEffort: string | undefined;
    let foundMode: string | undefined;

    for (const file of candidateFiles.slice(0, 5)) {
      try {
        const fd = openSync(file.path, "r");
        const size = fstatSync(fd).size;
        const readLen = Math.min(size, 128 * 1024);
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
        closeSync(fd);
        const tail = buf.toString("utf8", 0, readLen);

        if (!foundModel) {
          foundModel = parseAgyLogModel(tail);
        }
        if (!foundEffort) {
          const rawEffort = parseAgyLogEffort(tail);
          if (rawEffort) {
            foundEffort = rawEffort;
          } else if (foundModel) {
            foundEffort = extractEffortFromModel(foundModel);
          }
        }
        if (!foundMode) {
          foundMode = parseAgyLogMode(tail);
        }

        if (foundModel && foundEffort && foundMode) break;
      } catch {}
    }

    return { model: foundModel, effort: foundEffort, mode: foundMode };
  } catch {
    return {};
  }
}

export function readAgyLiveMode(ctx?: AgentContext): string | undefined {
  return readAgyLiveState(ctx).mode;
}

export function parseAgyModeFromText(text?: string): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  const lines = clean.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim().toLowerCase();
    if (!l) continue;
    if (l.includes("plan mode") || (l.includes("plan") && l.includes("shift+tab") && !l.includes("auto") && !l.includes("accept"))) {
      return "plan";
    }
    if (
      l.includes("auto-approve") ||
      l.includes("accept edits") ||
      l.includes("accept-edits") ||
      (l.includes("accept") && l.includes("shift+tab"))
    ) {
      return "accept-edits";
    }
    if (l.includes("default mode") || l.includes("manual mode") || (l.includes("default") && l.includes("shift+tab"))) {
      return "default";
    }
  }
  return undefined;
}

export function readAgyState(ctx?: AgentContext): AgentStateSnapshot {
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

  const live = readAgyLiveState(ctx);
  if (live.model) {
    model = live.model;
    effort = extractEffortFromModel(live.model) || live.effort || effort;
  } else if (live.effort) {
    effort = live.effort;
  }
  if (live.mode) {
    mode = live.mode;
  }

  // Live terminal preview priority parsing
  if (ctx?.preview) {
    const previewMode = parseAgyModeFromText(ctx.preview);
    if (previewMode) {
      mode = previewMode;
    }
  }

  return { model, effort, mode };
}

// Agy implementation
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

  getApplySteps(kind: ControlKind, value: string, fromValue?: string, modeList?: string[]): ApplyStep[] {
    if (kind === "model") {
      return slash("/model", value);
    }
    if (kind === "effort") {
      return slash("/effort", value);
    }
    if (kind === "mode") {
      return getAgyShiftTabSteps(value, fromValue, modeList || this.getModes());
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

  override readCurrentState(ctx?: AgentContext): AgentStateSnapshot {
    return readAgyState(ctx);
  }

  override getEffortForModel(model: string): string | undefined {
    return extractEffortFromModel(model);
  }
}

// Hermes config and models cache paths
export const HERMES_CONFIG = join(homedir(), ".hermes", "config.yaml");
export const HERMES_MODELS_CACHE = join(homedir(), ".hermes", "provider_models_cache.json");

export function parseHermesConfig(yamlText: string): { model?: string; effort?: string } {
  let model: string | undefined;
  let effort: string | undefined;

  const defaultModelMatch = /^\s*default:\s*['"]?([^'"\r\n]+)['"]?/m.exec(yamlText || "");
  if (defaultModelMatch) {
    model = defaultModelMatch[1].trim();
  } else {
    const rootModelMatch = /^model:\s*['"]?([^'"\r\n{]+)['"]?/m.exec(yamlText || "");
    if (rootModelMatch && rootModelMatch[1].trim()) {
      model = rootModelMatch[1].trim();
    }
  }

  const effortMatch = /reasoning_effort:\s*['"]?([^'"\r\n]+)['"]?/m.exec(yamlText || "");
  if (effortMatch && effortMatch[1].trim()) {
    effort = effortMatch[1].trim();
  }

  return { model, effort };
}

export function parseHermesModelsCache(jsonText: string): string[] {
  try {
    const data = JSON.parse(jsonText);
    const set = new Set<string>();
    const out: string[] = [];
    if (data && typeof data === "object") {
      for (const val of Object.values(data as Record<string, any>)) {
        if (val && Array.isArray(val.models)) {
          for (const m of val.models) {
            if (typeof m === "string" && m.trim()) {
              const id = m.trim();
              if (!set.has(id)) {
                set.add(id);
                out.push(id);
              }
            }
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readHermesState(ctx?: AgentContext): AgentStateSnapshot {
  try {
    if (ctx?.worktreePath) {
      const localCfg = join(ctx.worktreePath, ".hermes", "config.yaml");
      if (existsSync(localCfg)) {
        const cfg = parseHermesConfig(readFileSync(localCfg, "utf8"));
        return { model: cfg.model, effort: cfg.effort };
      }
    }
    if (existsSync(HERMES_CONFIG)) {
      const cfg = parseHermesConfig(readFileSync(HERMES_CONFIG, "utf8"));
      return { model: cfg.model, effort: cfg.effort };
    }
  } catch {}
  return {};
}

export function readHermesModelsCache(): string[] {
  try {
    if (existsSync(HERMES_MODELS_CACHE)) {
      return parseHermesModelsCache(readFileSync(HERMES_MODELS_CACHE, "utf8"));
    }
  } catch {}
  return [];
}

// Hermes implementation
export class HermesAgent extends AbstractAgent {
  readonly agentType = "hermes";
  readonly label = "Hermes";

  supports(kind: ControlKind): boolean {
    return kind === "model" || kind === "effort";
  }

  override getModels(): string[] {
    const cached = readHermesModelsCache();
    if (cached.length) return cached;
    return [
      "deepseek/deepseek-v4-flash-0731",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.6-luna",
      "google/gemini-3.8-flash",
      "minimax/minimax-m3",
    ];
  }

  override getEfforts(): string[] {
    return ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  }

  override getModes(): string[] {
    return [];
  }

  getApplySteps(kind: ControlKind, value: string): ApplyStep[] {
    if (kind === "model") {
      return slash("/model", value);
    }
    if (kind === "effort") {
      return slash("/reasoning", value);
    }
    return [];
  }

  override readCurrentState(ctx?: AgentContext): AgentStateSnapshot {
    return readHermesState(ctx);
  }
}

// ---- Pi (pi coding agent) ----
// State sources:
//   1. Session JSONL `~/.pi/agent/sessions/--<hyphenated-cwd>--/*.jsonl` — `model_change` (provider + modelId)
//      and `thinking_level_change` (thinkingLevel) entries are the live truth of the running TUI.
//   2. settings.json defaults (`defaultProvider`/`defaultModel`/`defaultThinkingLevel`) — startup values.
// Model catalog comes from the `pi --list-models` table (live, auth-filtered) or the local
// `models-store.json` catalog as fallback; `reasoning: false` models clamp effort to `off`.
// Apply commands are deterministic slash commands: `/model <provider/id>` (exact match applies directly)
// and `/thinking <level>` (applies directly). Pi has no permission modes, so `mode` is gated off.
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
export const PI_SETTINGS = join(PI_AGENT_DIR, "settings.json");
export const PI_MODELS_STORE = join(PI_AGENT_DIR, "models-store.json");

/** Resolve the pi CLI across common install locations (Stream Deck's launch env may lack ~/.local/bin). */
function firstExistingPath(candidates: string[], fallback: string): string {
  for (const p of candidates) if (existsSync(p)) return p;
  return fallback;
}
export const PI_CMD = firstExistingPath(
  [join(homedir(), ".local", "bin", "pi"), "/opt/homebrew/bin/pi", "/usr/local/bin/pi"],
  "pi",
);

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const PI_DEFAULT_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "openai-codex/gpt-5.6-luna",
  "opencode/claude-opus-4-6",
  "openrouter/~anthropic/claude-sonnet-latest",
];

/** Sessions root: PI_CODING_AGENT_SESSION_DIR > settings.json `sessionDir` > ~/.pi/agent/sessions */
export function piSessionsRoot(): string {
  const resolve = (p: string) =>
    p.startsWith("~") ? join(homedir(), p.slice(1)) : p.startsWith("/") ? p : join(PI_AGENT_DIR, p);
  const env = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (env) return resolve(env);
  try {
    const cfg = JSON.parse(readFileSync(PI_SETTINGS, "utf8"));
    if (typeof cfg?.sessionDir === "string" && cfg.sessionDir.trim()) return resolve(cfg.sessionDir.trim());
  } catch {}
  return join(PI_AGENT_DIR, "sessions");
}

/** Pi stores sessions per working directory as `--<cwd-with-leading-slash-stripped-and-/:-replaced>--`.
 * Mirrors pi's own encoder (core/session-manager.js `getDefaultSessionDirPath`). */
export function piSessionDir(worktreePath: string): string {
  const resolved = resolve(worktreePath);
  const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(piSessionsRoot(), safePath);
}

/** Tail-parse session JSONL entries: newest model_change / thinking_level_change, plus recently used models.
 * The current model is also taken from the newest assistant message, because a `model_change` entry can sit far
 * before EOF (long sessions) and fall outside the tail window. */
export function parsePiSessionTail(text: string): { model?: string; effort?: string; recentModels?: string[] } {
  let model: string | undefined;
  let effort: string | undefined;
  const recent: string[] = [];
  const lines = (text || "").split("\n");

  const idOf = (provider?: unknown, modelId?: unknown): string => {
    const mid = typeof modelId === "string" ? modelId.trim() : "";
    if (!mid) return "";
    const prov = typeof provider === "string" ? provider.trim() : "";
    if (!prov) return mid;
    // Pi's canonical reference is always `provider/id`, even when the id itself contains slashes.
    return mid.startsWith(`${prov}/`) ? mid : `${prov}/${mid}`;
  };

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw.startsWith("{")) continue;
    let d: any;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!model && d?.type === "model_change") {
      const id = idOf(d.provider, d.modelId ?? d.model);
      if (id) model = id;
    }
    if (!effort && d?.type === "thinking_level_change" && typeof d.thinkingLevel === "string" && d.thinkingLevel.trim()) {
      effort = d.thinkingLevel.trim();
    }
    const id =
      d?.type === "model_change" ? idOf(d.provider, d.modelId ?? d.model) : idOf(d?.message?.provider, d?.message?.model);
    if (id) {
      // Newest message wins as the live model when no model_change is inside the tail window.
      if (!model) model = id;
      if (!recent.includes(id) && recent.length < 8) recent.push(id);
    }
  }

  return { model, effort, ...(recent.length ? { recentModels: recent } : {}) };
}

/** Global/project settings defaults (`defaultProvider` + `defaultModel` + `defaultThinkingLevel`). */
export function parsePiSettings(text: string): { model?: string; effort?: string } {
  try {
    const data = JSON.parse(text);
    const provider = typeof data?.defaultProvider === "string" ? data.defaultProvider.trim() : "";
    const modelId = typeof data?.defaultModel === "string" ? data.defaultModel.trim() : "";
    const effort =
      typeof data?.defaultThinkingLevel === "string" && data.defaultThinkingLevel.trim()
        ? data.defaultThinkingLevel.trim()
        : undefined;
    const model = modelId ? (provider && !modelId.includes("/") ? `${provider}/${modelId}` : modelId) : undefined;
    return { model, effort };
  } catch {
    return {};
  }
}

/** Parse the `pi --list-models` table into `provider/model` ids (header row and non-table lines skipped). */
export function parsePiListModels(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (stdout || "").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const [provider, model] = cols;
    if (provider.toLowerCase() === "provider" && model.toLowerCase() === "model") continue;
    if (!/^[A-Za-z0-9_.~:-]+$/.test(provider) || !/^[A-Za-z0-9_.~:/-]+$/.test(model)) continue;
    const id = `${provider}/${model}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Parse `models-store.json` (provider -> models[]) into ids plus reasoning support and available levels. */
export function parsePiModelsStore(text: string): {
  models: string[];
  reasoning: Record<string, boolean>;
  efforts: Record<string, string[]>;
} {
  const models: string[] = [];
  const reasoning: Record<string, boolean> = {};
  const efforts: Record<string, string[]> = {};
  const seen = new Set<string>();
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return { models, reasoning, efforts };
    for (const [provider, val] of Object.entries<any>(data)) {
      const list = Array.isArray(val?.models) ? val.models : [];
      for (const m of list) {
        const id = typeof m?.id === "string" ? m.id.trim() : "";
        if (!id) continue;
        const full = `${provider}/${id}`;
        if (!seen.has(full)) {
          seen.add(full);
          models.push(full);
        }
        reasoning[full] = m?.reasoning === true;
        // `thinkingLevelMap` null entries mark levels the model cannot use.
        const map = m?.thinkingLevelMap;
        if (map && typeof map === "object") {
          const levels = PI_THINKING_LEVELS.filter((lvl) => (map as Record<string, unknown>)[lvl] !== null);
          if (levels.length) efforts[full] = levels;
        }
      }
    }
  } catch {}
  return { models, reasoning, efforts };
}

let piStoreCache: {
  mtimeMs: number;
  data: { models: string[]; reasoning: Record<string, boolean>; efforts: Record<string, string[]> };
} | null = null;

/** Cached read of the local pi model catalog (1.9MB file — cached by mtime). */
export function readPiModelsStore(): {
  models: string[];
  reasoning: Record<string, boolean>;
  efforts: Record<string, string[]>;
} {
  try {
    const mtimeMs = statSync(PI_MODELS_STORE).mtimeMs;
    if (piStoreCache && piStoreCache.mtimeMs === mtimeMs) return piStoreCache.data;
    const data = parsePiModelsStore(readFileSync(PI_MODELS_STORE, "utf8"));
    piStoreCache = { mtimeMs, data };
    return data;
  } catch {
    return { models: [], reasoning: {}, efforts: {} };
  }
}

/** Merge two tail parses (newer wins), de-duplicating recent models. */
function mergePiSessionParses(
  newer: { model?: string; effort?: string; recentModels?: string[] },
  older: { model?: string; effort?: string; recentModels?: string[] },
): { model?: string; effort?: string; recentModels?: string[] } {
  const recent: string[] = [];
  for (const m of [...(newer.recentModels ?? []), ...(older.recentModels ?? [])]) {
    if (!recent.includes(m) && recent.length < 8) recent.push(m);
  }
  return {
    model: newer.model ?? older.model,
    effort: newer.effort ?? older.effort,
    ...(recent.length ? { recentModels: recent } : {}),
  };
}

/** Read one pi session file: first `headBytes` (session-start state) plus last `tailBytes` (live state, newer wins).
 * `model_change`/`thinking_level_change` entries are only written on change, so they can sit far from both ends
 * in long sessions — the tail also carries the newest assistant message, which tracks the live model continuously. */
export function readPiSessionState(
  path: string,
  opts: { headBytes?: number; tailBytes?: number } = {},
): { model?: string; effort?: string; recentModels?: string[] } {
  const headBytes = opts.headBytes ?? 16 * 1024;
  const tailBytes = opts.tailBytes ?? 1024 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= headBytes + tailBytes) {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return parsePiSessionTail(buf.toString("utf8", 0, size));
    }
    const hlen = Math.min(size, headBytes);
    const headBuf = Buffer.alloc(hlen);
    readSync(fd, headBuf, 0, hlen, 0);
    const head = parsePiSessionTail(headBuf.toString("utf8", 0, hlen));

    const tlen = Math.min(size, tailBytes);
    const tailBuf = Buffer.alloc(tlen);
    readSync(fd, tailBuf, 0, tlen, size - tlen);
    const tail = parsePiSessionTail(tailBuf.toString("utf8", 0, tlen));

    return mergePiSessionParses(tail, head);
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Live pi state: newest session transcript for the worktree, falling back to settings defaults. */
export function readPiState(ctx?: AgentContext): AgentStateSnapshot {
  const state: AgentStateSnapshot = {};

  if (ctx?.worktreePath) {
    try {
      const dir = piSessionDir(ctx.worktreePath);
      if (existsSync(dir)) {
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        const recent: string[] = [];
        for (const item of files.slice(0, 3)) {
          const parsed = readPiSessionState(item.path);
          if (!state.model && parsed.model) state.model = parsed.model;
          if (!state.effort && parsed.effort) state.effort = parsed.effort;
          for (const m of parsed.recentModels ?? []) {
            if (!recent.includes(m) && recent.length < 8) recent.push(m);
          }
          if (state.model && state.effort && recent.length >= 8) break;
        }
        if (recent.length) state.recentModels = recent;
      }
    } catch {}
  }

  // Settings defaults: global first, project `.pi/settings.json` overrides.
  const cfgPaths = [PI_SETTINGS];
  if (ctx?.worktreePath) cfgPaths.push(join(ctx.worktreePath, ".pi", "settings.json"));
  let cfgModel: string | undefined;
  let cfgEffort: string | undefined;
  for (const p of cfgPaths) {
    try {
      if (!existsSync(p)) continue;
      const parsed = parsePiSettings(readFileSync(p, "utf8"));
      if (parsed.model) cfgModel = parsed.model;
      if (parsed.effort) cfgEffort = parsed.effort;
    } catch {}
  }
  if (!state.model && cfgModel) state.model = cfgModel;
  if (!state.effort && cfgEffort) state.effort = cfgEffort;

  return state;
}

// Pi implementation
export class PiAgent extends AbstractAgent {
  readonly agentType = "pi";
  readonly label = "Pi";

  supports(kind: ControlKind): boolean {
    return kind === "model" || kind === "effort";
  }

  override getModels(): string[] {
    const cached = readPiModelsStore().models;
    if (cached.length) return cached;
    return [...PI_DEFAULT_MODELS];
  }

  override getEfforts(modelId?: string): string[] {
    if (modelId) {
      const store = readPiModelsStore();
      if (store.reasoning[modelId] === false) return ["off"];
      const levels = store.efforts[modelId];
      if (levels && levels.length) return [...levels];
    }
    return [...PI_THINKING_LEVELS];
  }

  getApplySteps(kind: ControlKind, value: string): ApplyStep[] {
    if (kind === "model") {
      // `/model <provider/id>` applies directly on exact match, otherwise opens the filtered picker.
      return slash("/model", value);
    }
    if (kind === "effort") {
      // `/thinking <level>` applies directly (pi validates the level itself).
      return slash("/thinking", value);
    }
    return [];
  }

  override getDiscoverModelCmd(): string[] | undefined {
    return [PI_CMD, "--list-models"];
  }

  override parseDiscoveredModels(stdout: string): string[] {
    return parsePiListModels(stdout);
  }

  override readCurrentState(ctx?: AgentContext): AgentStateSnapshot {
    return readPiState(ctx);
  }

  override getEffortForModel(model: string): string | undefined {
    // Non-reasoning models can only run `off`; other models keep pi's current level (pi clamps it itself).
    return readPiModelsStore().reasoning[model] === false ? "off" : undefined;
  }
}

// Unsupported agent fallback
export class UnsupportedAgent extends AbstractAgent {
  readonly agentType = "";
  readonly label = "Unsupported";

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
  hermes: new HermesAgent(),
  "hermes-cli": new HermesAgent(),
  "hermes-agent": new HermesAgent(),
  pi: new PiAgent(),
  "pi-cli": new PiAgent(),
};

export const UNSUPPORTED_AGENT = new UnsupportedAgent();

/** Return abstract agent instance for given agent type */
export function agentFor(agentType: string | undefined | null): AbstractAgent {
  if (!agentType) return UNSUPPORTED_AGENT;
  const key = agentType.trim().toLowerCase();
  return AGENT_INSTANCES[key] ?? UNSUPPORTED_AGENT;
}

// Profile interface for backwards compatibility
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
  hermes: profileFor("hermes"),
  "hermes-cli": profileFor("hermes-cli"),
  "hermes-agent": profileFor("hermes-agent"),
  pi: profileFor("pi"),
  "pi-cli": profileFor("pi-cli"),
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
  pi: [PI_CMD, "--list-models"],
  "pi-cli": [PI_CMD, "--list-models"],
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
    // opencode prints verbose blocks with the model id without its outer provider prefix
    // (e.g. canonical `openrouter/deepseek/deepseek-v4-flash-0731` -> block id
    // `deepseek/deepseek-v4-flash-0731` + providerID `openrouter`; `~` kept on tilded
    // openrouter models), so reconstruct the canonical `providerID/id` form. Blocks without
    // a providerID (older fixtures) fall back to an exact id match.
    const idMatches =
      block.id === modelId ||
      (typeof block.providerID === "string" &&
        typeof block.id === "string" &&
        modelId === `${block.providerID}/${block.id}`);
    if (idMatches && block.variants && typeof block.variants === "object") {
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

// Extract only 'providerID/modelID' lines from discovery output (--verbose) — excluding JSON body/other lines.
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

// Extract model id -> display name map from --verbose JSON blocks (used for picker filter text).
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

// Picker filter text: '<provider> <display-name>'. If name is unknown, leaves provider so user picks inside it.
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