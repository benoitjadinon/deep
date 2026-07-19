// 버튼 모델 → Stream Deck 키에 그릴 SVG. 순수 함수(테스트 가능).
import { needsAttention, type Button, type Deck } from "./deck";

const HEX: Record<string, string> = {
  blue: "#3b82f6", amber: "#f59e0b", green: "#22c55e", red: "#ef4444", white: "#6b7280",
};

const esc = (s: string) =>
  (s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));

// 앞쪽 스피너/브라유 글리프 제거(한글은 보존)
export const stripSpinner = (s: string) =>
  (s ?? "").replace(/^[\s⠀-⣿✨✳✻⏺※*•…]+/u, "").trim();

// 한글은 폭이 넓어 줄당 글자수를 작게. maxLines 넘으면 마지막에 …
export function wrap(s: string, perLine = 6, maxLines = 3): string[] {
  const chars = [...s];
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(""));
  }
  if (chars.length > perLine * maxLines) {
    lines[maxLines - 1] = [...lines[maxLines - 1]].slice(0, perLine - 1).join("") + "…";
  }
  return lines;
}

// 긴 문자열을 win 글자 창으로 잘라 tick마다 한 칸씩 흘린다(마퀴). 짧으면 그대로.
export function marqueeWindow(s: string, win: number, tick: number): string {
  const chars = [...s];
  if (chars.length <= win) return s;
  const loop = [...`${s}   ·   `]; // 끝-처음이 자연스레 이어지도록 구분자 삽입
  const start = ((tick % loop.length) + loop.length) % loop.length;
  const out: string[] = [];
  for (let i = 0; i < win; i++) out.push(loop[(start + i) % loop.length]);
  return out.join("");
}

// 대략적 글자 폭(단위). ASCII는 좁게, 한글/CJK는 넓게 잡아 자동 크기 계산에 사용.
function units(s: string): number {
  let u = 0;
  for (const ch of s) u += /[\x00-\x7F]/.test(ch) ? 0.56 : 1;
  return u || 1;
}

export function keySvg(b: Button, tick = 0, isTarget = false, nowMs = 0, dim = false): string {
  if (b.empty) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="18" fill="#141416"/><circle cx="72" cy="72" r="7" fill="#3a3a3e"/></svg>`;
  }
  // 대상 세션이면 흰색 테두리(대상 다이얼 돌릴 때 이 링이 옮겨감). 상태색과 안 겹치게 흰색.
  const color = HEX[b.color] ?? HEX.white;

  // 가운데=프로젝트명(항상 흰색), 아래=브랜치. 현재(대상) 세션이면 브랜치를 코랄 칩(알약)으로.
  const proj = b.repo || (b.worktreePath ? b.worktreePath.split("/").filter(Boolean).pop() : "") || "?";
  const num = b.dupIndex && b.dupIndex > 0 ? `-${b.dupIndex}` : "";
  const sub = b.branch ? `${b.branch}${num}` : num ? `#${b.dupIndex}` : "";

  // 좌우 패딩(안쪽 여백) — 텍스트가 버튼 가장자리에 안 붙게 폭을 좁혀 맞춤
  const fit = 116 / units(proj);
  const projSvg =
    fit >= 16
      ? `<text x="72" y="84" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="${Math.min(30, Math.floor(fit))}" font-weight="700">${esc(proj)}</text>`
      : `<text x="72" y="84" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="20" font-weight="700">${esc(marqueeWindow(proj, 9, tick))}</text>`;
  let subSvg = "";
  if (sub) {
    subSvg = `<text x="72" y="112" text-anchor="middle" fill="#b8b8be" font-family="sans-serif" font-size="17" font-weight="600">${esc(sub)}</text>`;
  }
  // 주의 필요(입력대기·완료미확인·에러) 키는 배경이 상태색으로 숨쉬듯 글로우 펄스 → 확 띔.
  // 긴급(대기·에러)=강하고 빠르게, 완료=은은하게. 피크에서도 틴트라 흰 글자 가독성 유지. nowMs로 위상(순수).
  const attn = needsAttention(b, isTarget);
  let glow = "";
  if (attn) {
    const urgent = b.color === "amber" || b.color === "red";
    const period = urgent ? 640 : 1300; // ms/주기
    const p = 0.5 - 0.5 * Math.cos((2 * Math.PI * (nowMs % period)) / period); // 0→1→0
    const op = (urgent ? 0.4 : 0.28) * p; // 배경 상태색 틴트 세기(0→피크)
    glow = `<rect width="144" height="144" rx="18" fill="${color}" opacity="${op.toFixed(2)}"/>`;
  }
  // 보드에 주의 키가 있을 때, 주의 없는 키는 어둡게 죽여 대비로 확 띄게(dim). 주의 키는 밝게 유지.
  const g0 = dim ? '<g opacity="0.32">' : "";
  const g1 = dim ? "</g>" : "";
  // 현재 세션(target)은 우측 상단 코랄 점(dot)으로 표시. dim돼도 보이게 그룹 밖에 그림.
  const cornerTag = isTarget
    ? `<circle cx="124" cy="32" r="10" fill="#d97757"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
  <defs><clipPath id="r"><rect width="144" height="144" rx="18"/></clipPath></defs>
  ${g0}<rect width="144" height="144" rx="18" fill="#1c1c1e"/>
  ${glow}
  <rect width="144" height="13" fill="${color}" clip-path="url(#r)"/>
  ${projSvg}${subSvg}${g1}${cornerTag}
</svg>`;
}

// Stream Deck setImage는 data URI를 기대 → SVG를 base64 data URI로 감싼다.
export function keyImage(b: Button, tick = 0, isTarget = false, nowMs = 0, dim = false): string {
  return "data:image/svg+xml;base64," + Buffer.from(keySvg(b, tick, isTarget, nowMs, dim), "utf8").toString("base64");
}

const DIAL_ACCENT: Record<string, string> = {
  model: "#3b82f6", // 파랑
  effort: "#a855f7", // 보라
  talk: "#14b8a6", // 청록
  target: "#f59e0b", // 앰버
};

/** 다이얼 터치스크린(200×100) 커스텀 렌더 — 좌측 색 액센트 + 라벨 + 큰 값 + 적용 배지 */
export function dialImage(role: string, label: string, value: string, tick = 0): string {
  const accent = DIAL_ACCENT[role] ?? "#8a8a90";
  // 값이 조금만 넘쳐도 마퀴로 흐르게(정적은 여백 확보), 아니면 폭 맞춰 자동 크기
  const overflow = units(value) > 5;
  const valText = overflow ? marqueeWindow(value, 6, tick) : value;
  const vfs = overflow ? 28 : Math.min(36, Math.max(20, Math.floor(164 / units(value || " "))));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect width="200" height="100" rx="12" fill="#1c1c1e"/>
  <rect width="7" height="100" fill="${accent}"/>
  <text x="20" y="32" fill="${accent}" font-family="sans-serif" font-size="17" font-weight="800" letter-spacing="1">${esc(label)}</text>
  <text x="20" y="80" fill="#ffffff" font-family="sans-serif" font-size="${vfs}" font-weight="700">${esc(valText)}</text>
</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}
