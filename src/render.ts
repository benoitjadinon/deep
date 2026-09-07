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

// 에이전트 아이콘 정의 — Orca UI 번들(agent-catalog, icons)에서 직접 추출.
// Claude, OpenCode, Codex는 순수 벡터 SVG 패스, Antigravity는 64x64 PNG 데이터 URI.
const CLAUDE_SVG_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

const CODEX_SVG_PATH =
  "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z";

const ANTIGRAVITY_PNG_DATA =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAABYlBMVEVHcEw5iPw2i/IziPztaDo3ifeJwGA6iPhkhug3ifjtVEg6ivgujO00h/8wivRztHQ0iftrgdLrhy41ifA0iPs+mMJNrp7rWEgwifjgryrcVmJ4wXDiUlmPeMCGxWK3w0FhprPZVmJato0pktxVjflCqKqjbqeLxWKQeL/opSZBp6z1Uj3Xuy01ifwwiPg1h/87if8wh/wvivRCiv4vi+8zktxNjPsvjek1ltEwj+Q5nMTwV0BDpK9Rg+hZifJ5e8tMq6C7ZHk+h/k2h/nOW2lXsJBAn7mGdrx1vG9dgd1Jh/SebZ3lU07meDlitoKuZo1kfszdWlOgvlBWk69wgttBhe/Ia14/iOTaZ01Cj87gpSxzfbOHdqeVcaxMh9O7uz90loxwiKFah77GelWfrVdToKGSe4uud2+kcIXlky6Sm22+qENyp37Mh0iHq2pfpo6tmVeuh2LSszGJhonJlkKWi3VeO12PAAAALXRSTlMARBro/o/8f/1lxVMt8q79vAf6/cv6i23YVBo4QcePmg6TzuC5S3QaM6re4bufpM1dAAADxklEQVRYhZ2X+T9iURTAXz2VVIQYxowxY4wxM7wShWwVSrIvlchStopR+P/n3O0t3tqcH933/d5zzj339sFxBjE40dOz3dbxwegbI/z09AEE221tsf9STJyC4IEIYh2t83+aTVEAht+t8l+aRPC4TVJoNYfBi4tms3b6+voIhjw2fG1JcAFRq9WwoJxv2wdB7GMrBcgE5e18Pr8fy7ZSxPgBRKVSe35+fmyUy2VsiMU+WU8A85UKCBpIcAKCbDZrOYURkkDlqfpcbSDDyUl+HxmspjB84HQ6nyCq1epbo3F3d0INVlNwyniIO2RYW0OGbkv8kNOZTnd1ddXr9cvLt5e3WzDEicHanRjGfB3zl5cvL7e39/fxeBwMFmvA/E79LwQIrmSGtX0rwzSUTqd3dtYBv7k5PLyCOEOGXWywUEP3MObXAUcCMBSvzs62qMFKDV0if4ji+rpYLIJhaxcbzPlxzK+uLi5ubBz2AS8z7MbXzGepX+L7+gqFAjLsIcM5TsL8Un9T8oVSqbS3t7dSTFGDqYDxCwtzc8DnmCGVOscGs4MckvjC3OzsbC6XWyqVNsFAFLs/zFog7Y/w+RwyLG1Khs9mLZDx8/PRaDSHFZugoAZjvlvOR6Mzvb29x8fHS0s4CWRInf80FIwp+RlqOMaGoxWkMG5Cv5Kfnp5KJpMJ0QCKlHETfsl5wKeQIJkARYYYQGHEj0j8DOGxAAyZDBja25HAqAlj8v0RHgqFiAAZlrHhyGXUAjUPIYiG5XZQGDWhT1F/iPKCMCk3tOs/rXbF/qGQz+9wu12dvDAZDCbCCSRACpuuwE3nj/C8h/3dFhCCwWA4HIlEkMGhK+iU56/4zI0F4Qwx6AogAbw/4t3KJRsxkBzsOrxXxqvOSm5wa9EQDjpAwHeqV11YgAyR7zqCUfEAfFrLAZZCJKJ9kHapgZoHZReLiHi01jmX2AC/doYu0aBdwyi7QSG9LvvENmiterUnQB50GsLaNTjEG6A/6zwzaBXJTlA9AlLYBGYYUa15WAJJfZ7jBphBvcsAK0BvzHB4BWRACtUKK4A34jnOzwzv9/GzBPQvOw67QA3vNvIyPmDMw2ERQTCsPMkA8NPoDdObISl8NAdFCh46gkZHyMImCEQh/7aX8gPmPLxbzCBl20l+RKwUwIpACrFfbsZr31JVeAVqoJfGy34E9F/bd+GhBgEPg53xGs+YXriYAU0NT/PXeUW0w8EM3Zyr9f3lOTg4fqq1+lm4icDHEd7kBmiFF58mz9n40IDL2r8yqiQCvN/+D+aPcPZ+RgT3AAAAAElFTkSuQmCC";

// 에이전트 뱃지: 지원 에이전트는 Orca의 원본 로고 아이콘, 모르는 에이전트는 2글자 텍스트 알약 폴백.
export function agentBadge(agentType?: string | null): string {
  const a = (agentType || "").toLowerCase();
  const boxX = 108;
  const boxY = 110;
  const boxSize = 26;
  const iconPad = 4;
  const ix = boxX + iconPad;
  const iy = boxY + iconPad;
  const isize = boxSize - iconPad * 2; // 18px

  const bg = `<rect x="${boxX}" y="${boxY}" width="${boxSize}" height="${boxSize}" rx="6" fill="#222225" stroke="#38383e" stroke-width="1"/>`;

  if (a === "claude" || a === "claude-agent-teams") {
    const s = (isize / 24).toFixed(4);
    return `${bg}<g transform="translate(${ix}, ${iy}) scale(${s})"><path d="${CLAUDE_SVG_PATH}" fill="#D97757"/></g>`;
  }
  if (a === "opencode") {
    const s = isize / 300;
    const ox = (ix + (isize - 240 * s) / 2).toFixed(2);
    return `${bg}<g transform="translate(${ox}, ${iy}) scale(${s.toFixed(4)})"><path d="M180 240H60V120H180V240Z" fill="#F1ECEC" fill-opacity="0.35"/><path fill-rule="evenodd" clip-rule="evenodd" d="M240 300H0V0H240V300ZM180 60H60V240H180V60Z" fill="#F1ECEC"/></g>`;
  }
  if (a === "codex" || a === "code") {
    const s = (isize / 24).toFixed(4);
    return `${bg}<g transform="translate(${ix}, ${iy}) scale(${s})"><path fill-rule="evenodd" d="${CODEX_SVG_PATH}" fill="#A78BFA"/></g>`;
  }
  if (a === "antigravity" || a === "agy") {
    return `${bg}<image href="${ANTIGRAVITY_PNG_DATA}" xlink:href="${ANTIGRAVITY_PNG_DATA}" x="${ix}" y="${iy}" width="${isize}" height="${isize}"/>`;
  }

  // 폴백: 미지원 또는 미확인 에이전트는 2글자 텍스트 알약
  const label = a ? [...a].slice(0, 2).join("").toUpperCase() : "?";
  return `<rect x="104" y="118" width="32" height="18" rx="9" fill="#4b5563"/><text x="120" y="131" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="11" font-weight="800" letter-spacing="0.5">${esc(label)}</text>`;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144">
  <defs><clipPath id="r"><rect width="144" height="144" rx="18"/></clipPath></defs>
  ${g0}<rect width="144" height="144" rx="18" fill="#1c1c1e"/>
  ${glow}
  <rect width="144" height="13" fill="${color}" clip-path="url(#r)"/>
  ${projSvg}${subSvg}${agentBadge(b.agentType)}${g1}${cornerTag}
</svg>`;
}

// Stream Deck setImage는 data URI를 기대 → SVG를 base64 data URI로 감싼다.
// (뱃지는 글자 기반이라 Elgato 렌더러에서 어김없이 동작 — 이미지-in-SVG·래스터 라이브러리 불필요)
export function keyImage(b: Button, tick = 0, isTarget = false, nowMs = 0, dim = false): string {
  return "data:image/svg+xml;base64," + Buffer.from(keySvg(b, tick, isTarget, nowMs, dim), "utf8").toString("base64");
}

const DIAL_ACCENT: Record<string, string> = {
  model: "#3b82f6", // 파랑
  effort: "#a855f7", // 보라
  mode: "#f43f5e", // 로즈
  talk: "#14b8a6", // 청록
  target: "#f59e0b", // 앰버
};

/** 다이얼 터치스크린(200×100) 커스텀 렌더 — 좌측 색 레일 + 상단 작은 라벨 + 값(가득 채운 3줄 래핑, 위로 정렬).
 *  disabled인 경우 시각적으로 비활성화(어둡고 흐린 레일/라벨/값 + 투명도 딤).
 *  badge가 주어지면 우상단에 에이전트 알약(2글자)을 겹쳐 보여준다(대상 세션 다이얼용).
 *  sub가 주어지면 값 아래에 작은 보조 줄(브랜치 등)을 그린다 — 키(세션 슬롯)와 같은 문법. */
export function dialImage(role: string, label: string, value: string, tick = 0, disabled = false, badge?: string | null, sub?: string | null): string {
  const accent = disabled ? "#2e2e34" : (DIAL_ACCENT[role] ?? "#8a8a90");
  const labelColor = disabled ? "#4a4a52" : accent;
  const valueColor = disabled ? "#4a4a52" : "#ffffff";
  const val = disabled ? (value && value !== " " && value !== "…" ? value : "-") : (value || " ");
  const textX = 18;
  const avail = 195 - textX; // 레일(7px) 제외 실제 텍스트 가용 폭
  const lineFont = 15; // 3줄 값 폰트
  const lineH = 16;
  const top = 44;
  // 실제 글자 폭(units: ASCII≈0.56, CJK≈1) 기준 줄당 글자수 — 8px 하드코딩 제거.
  const perLine = Math.max(4, Math.floor(avail / (lineFont * 0.56)));

  // 한 줄로 렌더할 때 실제 폭(자동 크기) 기준으로 판정 — lineFont로 판단하면 그보다 큰
  // 자동크기로 그릴 때 글자가 잘리는 회귀가 난다. 읽기 가능(≥20px) 한 줄이면 그대로,
  // 아니면 "/"(provider/model 등) 기준으로 줄바꿈해 두 번째 줄로 넘긴다.
  const oneLineFits = units(val) * 20 <= avail;
  const lines = oneLineFits
    ? [val]
    : splitSlash(val, perLine);
  const singleSize = oneLineFits ? Math.min(28, Math.max(16, Math.floor((avail - 4) / units(val)))) : lineFont;

  const labelSvg = role === "model"
    ? `<text x="${textX}" y="20" fill="${labelColor}" font-family="sans-serif" font-size="11" font-weight="800" letter-spacing="2">${esc(label)}</text>`
    : `<text x="${textX}" y="24" fill="${labelColor}" font-family="sans-serif" font-size="13" font-weight="800" letter-spacing="1">${esc(label)}</text>`;

  // 3줄 렌더(위로 정렬) — 100px 다이얼에서 top부터 lineH 간격. sub(브랜치)가 있으면 값은 위로 올려 여백 확보.
  const hasSub = Boolean(sub && !disabled);
  const valueY = hasSub ? 48 : 56;
  const valueSvg = lines.length > 1
    ? lines.map((ln, i) => `<text x="${textX}" y="${(hasSub ? 40 : top) + i * lineH}" fill="${valueColor}" font-family="sans-serif" font-size="${lineFont}" font-weight="700">${esc(ln)}</text>`).join("")
    : `<text x="${textX}" y="${valueY}" fill="${valueColor}" font-family="sans-serif" font-size="${singleSize}" font-weight="700">${esc(lines[0])}</text>`;

  // 보조 줄(브랜치) — 세션 키의 브랜치와 같은 문법(작고 흐린 회색, 600 weight).
  const subSvg = hasSub
    ? `<text x="${textX}" y="${valueY + 18}" fill="${disabled ? "#4a4a52" : "#b8b8be"}" font-family="sans-serif" font-size="13" font-weight="600">${esc(sub || "")}</text>`
    : "";

  // 에이전트 알약(우상단) — 세션 버튼의 agentBadge와 같은 색/글자, 다이얼(200×100)에 맞게 배치.
  const badgeSvg = badge ? agentBadgeForDial(badge) : "";

  const dimG0 = disabled ? '<g opacity="0.38">' : "";
  const dimG1 = disabled ? "</g>" : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100">
  <rect width="200" height="100" rx="12" fill="#1c1c1e"/>
  ${dimG0}<rect width="7" height="100" fill="${accent}"/>
  ${labelSvg}
  ${valueSvg}${subSvg}${dimG1}
  ${badgeSvg}
</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

// 다이얼 우상단용 에이전트 뱃지 — 세션 버튼의 agentBadge와 같은 로고 아이콘, 다이얼(200×100)에 맞게 20x20으로 배치.
function agentBadgeForDial(agentType?: string | null): string {
  const a = (agentType || "").toLowerCase();
  const boxX = 172;
  const boxY = 6;
  const boxSize = 20;
  const iconPad = 3;
  const ix = boxX + iconPad;
  const iy = boxY + iconPad;
  const isize = boxSize - iconPad * 2;

  const bg = `<rect x="${boxX}" y="${boxY}" width="${boxSize}" height="${boxSize}" rx="5" fill="#222225" stroke="#38383e" stroke-width="1"/>`;

  if (a === "claude" || a === "claude-agent-teams") {
    const s = (isize / 24).toFixed(4);
    return `${bg}<g transform="translate(${ix}, ${iy}) scale(${s})"><path d="${CLAUDE_SVG_PATH}" fill="#D97757"/></g>`;
  }
  if (a === "opencode") {
    const s = isize / 300;
    const ox = (ix + (isize - 240 * s) / 2).toFixed(2);
    return `${bg}<g transform="translate(${ox}, ${iy}) scale(${s.toFixed(4)})"><path d="M180 240H60V120H180V240Z" fill="#F1ECEC" fill-opacity="0.35"/><path fill-rule="evenodd" clip-rule="evenodd" d="M240 300H0V0H240V300ZM180 60H60V240H180V60Z" fill="#F1ECEC"/></g>`;
  }
  if (a === "codex" || a === "code") {
    const s = (isize / 24).toFixed(4);
    return `${bg}<g transform="translate(${ix}, ${iy}) scale(${s})"><path fill-rule="evenodd" d="${CODEX_SVG_PATH}" fill="#A78BFA"/></g>`;
  }
  if (a === "antigravity" || a === "agy") {
    return `${bg}<image href="${ANTIGRAVITY_PNG_DATA}" xlink:href="${ANTIGRAVITY_PNG_DATA}" x="${ix}" y="${iy}" width="${isize}" height="${isize}"/>`;
  }

  // 폴백: 미지원 또는 미확인 에이전트는 2글자 텍스트 알약
  const label = a ? [...a].slice(0, 2).join("").toUpperCase() : "?";
  return `<rect x="166" y="6" width="28" height="16" rx="8" fill="#4b5563"/><text x="180" y="18" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="10" font-weight="800" letter-spacing="0.5">${esc(label)}</text>`;
}

// 값이 한 줄에 안 들어가면 "/"(provider/model 등) 경계에서 줄을 나눈다.
// 각 파트가 perLine 안에 들어가고 파트 수가 3을 안 넘으면 그대로 여러 줄, 아니면 글자 단위 래핑.
function splitSlash(value: string, perLine: number): string[] {
  const parts = (value || " ").split("/").filter((p) => p !== "");
  if (parts.length <= 3 && parts.every((p) => [...p].length <= perLine)) {
    return parts;
  }
  return wrap(value || " ", perLine, 3);
}
