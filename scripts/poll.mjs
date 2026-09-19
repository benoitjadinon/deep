// Live data smoke test: poll orca live and render 8-slot status board to console.
// Terminal preview without hardware Stream Deck. `npm run poll` or `node scripts/poll.mjs`.
import { execFileSync } from "node:child_process";
import { buildDeck } from "../src/deck.ts";

function orca(args) {
  const out = execFileSync("orca", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

const DOT = { blue: "🔵", amber: "🟡", green: "🟢", red: "🔴", white: "⚪" };
const clip = (s, n) => {
  const t = (s ?? "").replace(/^[\s⠀-⣿✽✳✻⏺※*•…]+/u, "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t.padEnd(n);
};

const page = Number(process.argv[2] ?? 0);
const terminals = orca(["terminal", "list", "--json"]).result?.terminals ?? [];
const worktrees = orca(["worktree", "ps", "--json"]).result?.worktrees ?? [];
const repos = orca(["repo", "list", "--json"]).result?.repos ?? [];
const deck = buildDeck({ terminals, worktrees, repos }, { page, perPage: 8 });

const cell = (b) => {
  if (b.empty) return `⚪ ${"·".padEnd(14)}`;
  const dot = b.state === "unverifiable" ? "🟠" : (DOT[b.color] ?? "⚪");
  return `${dot} ${clip(b.label, 14)}`;
};
console.log(`\n  AgentDeck — page ${deck.page + 1}/${deck.pageCount} · Sessions: ${deck.total}\n`);
for (let r = 0; r < 2; r++) {
  const row = deck.slots.slice(r * 4, r * 4 + 4).map(cell);
  console.log("  " + row.map((c) => `[ ${c} ]`).join(" "));
}
console.log("\n  🔵working 🟡waiting 🟠no recent update 🟢done 🔴error ⚪idle/empty\n");
// Reference for tap mapping: which handle each button switches/sends to
deck.slots.forEach((b, i) => {
  if (!b.empty) console.log(`  S${i + 1} → orca terminal switch --terminal ${b.handle}`);
});
