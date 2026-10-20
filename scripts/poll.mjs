// Live data smoke test: poll orca live and render 8-slot status board to console.
// Terminal preview without hardware Stream Deck. `npm run poll` or `node scripts/poll.mjs`.
import { execFileSync } from "node:child_process";
import { buildDeck } from "../src/deck.ts";

function orca(args) {
  const out = execFileSync("orca", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

const DOT = { orange: "🟠", violet: "🟣", blue: "🔵", amber: "🟡", green: "🟢", red: "🔴", white: "⚪" };
const clip = (s, n) => {
  const t = (s ?? "").replace(/^[\s⠀-⣿✽✳✻⏺※*•…]+/u, "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(n);
};

const page = Number(process.argv[2] ?? 0);
const terminals = orca(["terminal", "list", "--json"]).result?.terminals ?? [];
const worktrees = orca(["worktree", "ps", "--json"]).result?.worktrees ?? [];
const repos = orca(["repo", "list", "--json"]).result?.repos ?? [];
const hosts = orca(["host", "list", "--json"]).result?.hosts ?? [];
// Paired remote runtimes (e.g. a Mac mini) are polled per environment, same as the plugin does.
const envs = orca(["environment", "list", "--json"]).result?.environments ?? [];
for (const env of envs) {
  const tag = { environment: env.name, environmentId: env.id };
  const rt = orca(["terminal", "list", "--json", "--environment", env.name]).result?.terminals ?? [];
  const rw = orca(["worktree", "ps", "--json", "--environment", env.name]).result?.worktrees ?? [];
  terminals.push(...rt.map((t) => ({ ...t, ...tag })));
  worktrees.push(...rw.map((w) => ({ ...w, ...tag })));
}
const deck = buildDeck({ terminals, worktrees, repos, hosts }, { page, perPage: 8 });

const cell = (b) => {
  if (b.empty) return `⚪ ${"·".padEnd(14)}`;
  const dot = b.state === "unverifiable" ? "🟣" : (DOT[b.color] ?? "⚪");
  return `${dot} ${clip(b.label, 14)}`;
};
console.log(`\n  AgentDeck — page ${deck.page + 1}/${deck.pageCount} · Sessions: ${deck.total}\n`);
for (let r = 0; r < 2; r++) {
  const row = deck.slots.slice(r * 4, r * 4 + 4).map(cell);
  console.log("  " + row.map((c) => `[ ${c} ]`).join(" "));
}
console.log("\n  🟠working 🟣waiting 🟢done 🔴error ⚪idle/empty\n");
// Reference for tap mapping: which handle each button switches/sends to
deck.slots.forEach((b, i) => {
  if (!b.empty) {
    const env = b.environment ? `--environment "${b.environment}" ` : "";
    console.log(`  S${i + 1} → orca terminal switch ${env}--terminal ${b.handle}   [host: ${b.host ?? "?"}]`);
  }
});
