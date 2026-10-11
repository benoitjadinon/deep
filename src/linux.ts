// Linux (Hyprland + PipeWire + whisper.cpp) counterparts of the macOS-only integrations in plugin.ts:
// window focus / previous-app toggle via hyprctl, Orca's data dir, and push-to-talk STT.
// Pure helpers are exported for unit tests; the exec wrappers take an injected runner.
import { join } from "node:path";

export const IS_LINUX = process.platform === "linux";

// Window classes that must never be remembered as "the previous app" (Orca itself, the deck host)
export const ORCA_CLASSES = ["orca"];
export const DECK_HOST_CLASSES = ["opendeck", "streamdeck"];

export interface HyprClient {
  address: string;
  class: string;
  title: string;
  pid?: number;
  focusHistoryID: number;
  mapped?: boolean;
  hidden?: boolean;
}

/** Orca's Electron userData dir: ~/Library/Application Support/orca on macOS, $XDG_CONFIG_HOME/orca on Linux. */
export function orcaDataDir(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined> = {},
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "orca");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "orca");
}

/**
 * Extra PATH entries for host-spawned plugin processes. OpenDeck's Flatpak starts plugins via
 * `flatpak-spawn --host`, whose PATH omits user bin dirs where agent CLIs usually live.
 */
export function linuxExtraPath(home: string): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".cargo", "bin"),
    join(home, "Tools", "bin"),
    join(home, ".config", "orca", "linux-orca-cli-shim"),
  ];
}

export function withExtraPath(current: string | undefined, extra: string[]): string {
  const parts = (current ?? "").split(":").filter(Boolean);
  for (const p of [...extra].reverse()) if (!parts.includes(p)) parts.unshift(p);
  return parts.join(":");
}

export function parseHyprClients(json: string): HyprClient[] {
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c) => c && typeof c.address === "string")
      .map((c) => ({
        address: c.address,
        class: String(c.class ?? ""),
        title: String(c.title ?? ""),
        pid: typeof c.pid === "number" ? c.pid : undefined,
        focusHistoryID: typeof c.focusHistoryID === "number" ? c.focusHistoryID : Number.MAX_SAFE_INTEGER,
        mapped: c.mapped,
        hidden: c.hidden,
      }));
  } catch {
    return [];
  }
}

const matchesAny = (cls: string, classes: string[]) => classes.includes(cls.toLowerCase());

export function isOrcaClass(cls: string | undefined): boolean {
  return !!cls && matchesAny(cls, ORCA_CLASSES);
}

export function isDeckHostClass(cls: string | undefined): boolean {
  return !!cls && matchesAny(cls, DECK_HOST_CLASSES);
}

/** Most recently focused window that isn't Orca or the deck host (Hyprland's focus history, 0 = current). */
export function previousWindow(clients: HyprClient[]): HyprClient | undefined {
  return clients
    .filter((c) => c.mapped !== false && !isOrcaClass(c.class) && !isDeckHostClass(c.class))
    .sort((a, b) => a.focusHistoryID - b.focusHistoryID)[0];
}

export function orcaWindow(clients: HyprClient[]): HyprClient | undefined {
  return clients
    .filter((c) => isOrcaClass(c.class))
    .sort((a, b) => a.focusHistoryID - b.focusHistoryID)[0];
}

/**
 * hyprctl dispatch arguments to focus a window, newest syntax first: Hyprland >= 0.55 with a Lua
 * config only accepts `hl.dsp.*` expressions, older hyprlang configs only the classic dispatcher.
 */
export function hyprFocusDispatches(address: string): string[][] {
  return [
    ["dispatch", `hl.dsp.focus({ window = 'address:${address}' })`],
    ["dispatch", "focuswindow", `address:${address}`],
  ];
}

// ---------- Push-to-talk (PipeWire capture + whisper.cpp) ----------

export const WHISPER_BIN_CANDIDATES = ["/usr/bin/whisper-cli", "/usr/local/bin/whisper-cli"];

export function whisperModelPath(home: string, env: Record<string, string | undefined> = {}): string {
  return env.AGENTDECK_WHISPER_MODEL?.trim() || join(home, ".local", "share", "agentdeck", "whisper", "ggml-base.bin");
}

/** STT_LOCALE / locale file value (e.g. "fr-FR", "en_US.UTF-8") -> whisper language code, default auto-detect. */
export function whisperLanguage(locale: string | undefined): string {
  const m = (locale ?? "").trim().match(/^([a-zA-Z]{2,3})(?:[-_.@]|$)/);
  return m ? m[1].toLowerCase() : "auto";
}

export function whisperArgs(model: string, wav: string, language: string, threads: number): string[] {
  return ["-m", model, "-f", wav, "-l", language, "-t", String(threads), "-nt", "-np"];
}

/** Join whisper-cli stdout lines and drop non-speech markers like [BLANK_AUDIO], [Music], (silence). */
export function cleanTranscript(stdout: string): string {
  return stdout
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pwRecordArgs(wav: string): string[] {
  return ["--rate", "16000", "--channels", "1", "--format", "s16", wav];
}
