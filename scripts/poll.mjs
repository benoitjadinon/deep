// 실 데이터 스모크: orca에서 라이브로 읽어 8칸 상태판을 콘솔에 그린다.
// Stream Deck 실물 대신 터미널에 미리보기. `npm run poll` 또는 `node scripts/poll.mjs`.
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
const deck = buildDeck({ terminals, worktrees }, { page, perPage: 8 });

const cell = (b) => (b.empty ? `⚪ ${"·".padEnd(14)}` : `${DOT[b.color]} ${clip(b.label, 14)}`);
console.log(`\n  AgentDeck — page ${deck.page + 1}/${deck.pageCount} · 세션 ${deck.total}개\n`);
for (let r = 0; r < 2; r++) {
  const row = deck.slots.slice(r * 4, r * 4 + 4).map(cell);
  console.log("  " + row.map((c) => `[ ${c} ]`).join(" "));
}
console.log("\n  🔵working 🟡waiting 🟢done 🔴error ⚪empty\n");
// 탭 매핑 참고용: 각 버튼이 어떤 handle로 switch/send 될지
deck.slots.forEach((b, i) => {
  if (!b.empty) console.log(`  S${i + 1} → orca terminal switch --terminal ${b.handle}`);
});
