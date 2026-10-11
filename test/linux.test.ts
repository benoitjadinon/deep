import { describe, it, expect } from "vitest";
import {
  orcaDataDir,
  linuxExtraPath,
  withExtraPath,
  parseHyprClients,
  isOrcaClass,
  isDeckHostClass,
  previousWindow,
  orcaWindow,
  hyprFocusDispatches,
  whisperLanguage,
  whisperArgs,
  cleanTranscript,
  whisperModelPath,
} from "../src/linux";

const clients = JSON.stringify([
  { address: "0xa", class: "orca", title: "Orca", focusHistoryID: 0, mapped: true },
  { address: "0xb", class: "zen", title: "Zen Browser", focusHistoryID: 1, mapped: true },
  { address: "0xc", class: "opendeck", title: "OpenDeck", focusHistoryID: 2, mapped: true },
  { address: "0xd", class: "carelo", title: "Carelo", focusHistoryID: 3, mapped: true },
]);

describe("orcaDataDir", () => {
  it("uses Application Support on macOS", () => {
    expect(orcaDataDir("darwin", "/Users/a")).toBe("/Users/a/Library/Application Support/orca");
  });
  it("uses ~/.config on Linux, honouring XDG_CONFIG_HOME", () => {
    expect(orcaDataDir("linux", "/home/a")).toBe("/home/a/.config/orca");
    expect(orcaDataDir("linux", "/home/a", { XDG_CONFIG_HOME: "/x/cfg" })).toBe("/x/cfg/orca");
  });
});

describe("PATH helpers", () => {
  it("prepends missing dirs once", () => {
    const extra = linuxExtraPath("/home/a");
    const once = withExtraPath("/usr/bin", extra);
    expect(once.startsWith("/home/a/.local/bin:")).toBe(true);
    expect(withExtraPath(once, extra)).toBe(once);
    expect(once.endsWith(":/usr/bin")).toBe(true);
  });
  it("handles an undefined PATH", () => {
    expect(withExtraPath(undefined, ["/a"])).toBe("/a");
  });
});

describe("hyprland windows", () => {
  const list = parseHyprClients(clients);
  it("parses clients and tolerates garbage", () => {
    expect(list).toHaveLength(4);
    expect(parseHyprClients("nope")).toEqual([]);
    expect(parseHyprClients("{}")).toEqual([]);
  });
  it("recognises Orca and the deck host", () => {
    expect(isOrcaClass("orca")).toBe(true);
    expect(isOrcaClass("Orca")).toBe(true);
    expect(isOrcaClass("zen")).toBe(false);
    expect(isDeckHostClass("opendeck")).toBe(true);
  });
  it("previous window skips Orca and OpenDeck", () => {
    expect(previousWindow(list)?.address).toBe("0xb");
  });
  it("skips unmapped windows and returns undefined when nothing is left", () => {
    expect(previousWindow(list.map((c) => (c.class === "zen" ? { ...c, mapped: false } : c)))?.address).toBe("0xd");
    expect(previousWindow(list.filter((c) => isOrcaClass(c.class)))).toBeUndefined();
  });
  it("finds the Orca window", () => {
    expect(orcaWindow(list)?.address).toBe("0xa");
  });
  it("emits Lua dispatch first, classic dispatch as fallback", () => {
    const [lua, classic] = hyprFocusDispatches("0xa");
    expect(lua).toEqual(["dispatch", "hl.dsp.focus({ window = 'address:0xa' })"]);
    expect(classic).toEqual(["dispatch", "focuswindow", "address:0xa"]);
  });
});

describe("whisper helpers", () => {
  it("maps locales to language codes", () => {
    expect(whisperLanguage("fr-FR")).toBe("fr");
    expect(whisperLanguage("en_US.UTF-8\n")).toBe("en");
    expect(whisperLanguage("")).toBe("auto");
    expect(whisperLanguage(undefined)).toBe("auto");
  });
  it("builds quiet, timestamp-free args", () => {
    expect(whisperArgs("/m.bin", "/a.wav", "auto", 4)).toEqual(["-m", "/m.bin", "-f", "/a.wav", "-l", "auto", "-t", "4", "-nt", "-np"]);
  });
  it("cleans whisper output", () => {
    expect(cleanTranscript("\n [BLANK_AUDIO]\n")).toBe("");
    expect(cleanTranscript(" Run the tests. \n (silence)\n and push [Music]\n")).toBe("Run the tests. and push");
  });
  it("lets the model be overridden", () => {
    expect(whisperModelPath("/h", {})).toBe("/h/.local/share/agentdeck/whisper/ggml-base.bin");
    expect(whisperModelPath("/h", { AGENTDECK_WHISPER_MODEL: "/x.bin" })).toBe("/x.bin");
  });
});
