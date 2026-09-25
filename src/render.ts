// Button model -> SVG rendered to Stream Deck keys. Pure functions (testable).
import { needsAttention, type Button, type Deck } from "./deck";

const HEX: Record<string, string> = {
  blue: "#3b82f6", amber: "#f59e0b", green: "#22c55e", red: "#ef4444", white: "#6b7280",
};

const esc = (s: string) =>
  (s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));

// Strip leading spinner / Braille glyphs
export const stripSpinner = (s: string) =>
  (s ?? "").replace(/^[\s⠀-⣿✨✳✻⏺※*•…]+/u, "").trim();

// Wrap text with perLine limit; appends ellipsis if exceeds maxLines
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

// Truncate and scroll long strings in a fixed character window (marquee)
export function marqueeWindow(s: string, win: number, tick: number): string {
  const chars = [...s];
  if (chars.length <= win) return s;
  const loop = [...`${s}   ·   `]; // Separator for seamless looping
  const start = ((tick % loop.length) + loop.length) % loop.length;
  const out: string[] = [];
  for (let i = 0; i < win; i++) out.push(loop[(start + i) % loop.length]);
  return out.join("");
}

// Agent icon definitions extracted directly from Orca UI bundle (agent-catalog, icons).
// Claude, OpenCode, Codex are pure vector SVG paths; Antigravity is 64x64 PNG data URI.
const CLAUDE_SVG_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

const CODEX_SVG_PATH =
  "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z";

const ANTIGRAVITY_PNG_DATA =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAABYlBMVEVHcEw5iPw2i/IziPztaDo3ifeJwGA6iPhkhug3ifjtVEg6ivgujO00h/8wivRztHQ0iftrgdLrhy41ifA0iPs+mMJNrp7rWEgwifjgryrcVmJ4wXDiUlmPeMCGxWK3w0FhprPZVmJato0pktxVjflCqKqjbqeLxWKQeL/opSZBp6z1Uj3Xuy01ifwwiPg1h/87if8wh/wvivRCiv4vi+8zktxNjPsvjek1ltEwj+Q5nMTwV0BDpK9Rg+hZifJ5e8tMq6C7ZHk+h/k2h/nOW2lXsJBAn7mGdrx1vG9dgd1Jh/SebZ3lU07meDlitoKuZo1kfszdWlOgvlBWk69wgttBhe/Ia14/iOTaZ01Cj87gpSxzfbOHdqeVcaxMh9O7uz90loxwiKFah77GelWfrVdToKGSe4uud2+kcIXlky6Sm22+qENyp37Mh0iHq2pfpo6tmVeuh2LSszGJhonJlkKWi3VeO12PAAAALXRSTlMARBro/o/8f/1lxVMt8q79vAf6/cv6i23YVBo4QcePmg6TzuC5S3QaM6re4bufpM1dAAADxklEQVRYhZ2X+T9iURTAXz2VVIQYxowxY4wxM7wShWwVSrIvlchStopR+P/n3O0t3tqcH933/d5zzj339sFxBjE40dOz3dbxwegbI/z09AEE221tsf9STJyC4IEIYh2t83+aTVEAht+t8l+aRPC4TVJoNYfBi4tms3b6+voIhjw2fG1JcAFRq9WwoJxv2wdB7GMrBcgE5e18Pr8fy7ZSxPgBRKVSe35+fmyUy2VsiMU+WU8A85UKCBpIcAKCbDZrOYURkkDlqfpcbSDDyUl+HxmspjB84HQ6nyCq1epbo3F3d0INVlNwyniIO2RYW0OGbkv8kNOZTnd1ddXr9cvLt5e3WzDEicHanRjGfB3zl5cvL7e39/fxeBwMFmvA/E79LwQIrmSGtX0rwzSUTqd3dtYBv7k5PLyCOEOGXWywUEP3MObXAUcCMBSvzs62qMFKDV0if4ji+rpYLIJhaxcbzPlxzK+uLi5ubBz2AS8z7MbXzGepX+L7+gqFAjLsIcM5TsL8Un9T8oVSqbS3t7dSTFGDqYDxCwtzc8DnmCGVOscGs4MckvjC3OzsbC6XWyqVNsFAFLs/zFog7Y/w+RwyLG1Khs9mLZDx8/PRaDSHFZugoAZjvlvOR6Mzvb29x8fHS0s4CWRInf80FIwp+RlqOMaGoxWkMG5Cv5Kfnp5KJpMJ0QCKlHETfsl5wKeQIJkARYYYQGHEj0j8DOGxAAyZDBja25HAqAlj8v0RHgqFiAAZlrHhyGXUAjUPIYiG5XZQGDWhT1F/iPKCMCk3tOs/rXbF/qGQz+9wu12dvDAZDCbCCSRACpuuwE3nj/C8h/3dFhCCwWA4HIlEkMGhK+iU56/4zI0F4Qwx6AogAbw/4t3KJRsxkBzsOrxXxqvOSm5wa9EQDjpAwHeqV11YgAyR7zqCUfEAfFrLAZZCJKJ9kHapgZoHZReLiHi01jmX2AC/doYu0aBdwyi7QSG9LvvENmiterUnQB50GsLaNTjEG6A/6zwzaBXJTlA9AlLYBGYYUa15WAJJfZ7jBphBvcsAK0BvzHB4BWRACtUKK4A34jnOzwzv9/GzBPQvOw67QA3vNvIyPmDMw2ERQTCsPMkA8NPoDdObISl8NAdFCh46gkZHyMImCEQh/7aX8gPmPLxbzCBl20l+RKwUwIpACrFfbsZr31JVeAVqoJfGy34E9F/bd+GhBgEPg53xGs+YXriYAU0NT/PXeUW0w8EM3Zyr9f3lOTg4fqq1+lm4icDHEd7kBmiFF58mz9n40IDL2r8yqiQCvN/+D+aPcPZ+RgT3AAAAAElFTkSuQmCC";

const HERMES_SVG_PATH =
  "M12 2a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm1 4.1a5.002 5.002 0 00-2 0V7c-1.54-.48-2.78-1.58-3.34-3.03a1 1 0 00-1.87.71C6.67 6.94 8.7 8.5 11 8.9V11c-2.3-.4-4.33-1.96-5.21-4.22a1 1 0 00-1.87.71C4.8 10.3 7.6 12.3 11 12.9V15c-2.3-.4-4.33-1.96-5.21-4.22a1 1 0 00-1.87.71C4.8 14.3 7.6 16.3 11 16.9V21a1 1 0 102 0v-4.1c3.4-.6 6.2-2.6 7.08-5.41a1 1 0 00-1.87-.71C17.33 13.04 15.3 14.6 13 15v-2.1c3.4-.6 6.2-2.6 7.08-5.41a1 1 0 00-1.87-.71C17.33 9.04 15.3 10.6 13 11V8.9c2.3-.4 4.33-1.96 5.21-4.22a1 1 0 00-1.87-.71C15.42 5.76 13.97 6.7 13 7.08V6.1z";

// Pi agent glyph ('π') — no shipped logo asset, so the badge renders the pi letter in the pi accent color.
const PI_ACCENT = "#8abeb7";
function piGlyph(x: number, y: number, size: number): string {
  const font = size * 1.15;
  return `<text x="${(x + size / 2).toFixed(2)}" y="${(y + size / 2 + font * 0.35).toFixed(2)}" text-anchor="middle" fill="${PI_ACCENT}" font-family="sans-serif" font-size="${font.toFixed(2)}" font-weight="700">π</text>`;
}

// Agent badge: Supported agents show original Orca logo icon; unknown agents show 2-character pill fallback.
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
  if (a === "hermes" || a === "hermes-cli" || a === "hermes-agent") {
    const s = (isize / 24).toFixed(4);
    return `${bg}<g transform="translate(${ix}, ${iy}) scale(${s})"><path fill-rule="evenodd" clip-rule="evenodd" d="${HERMES_SVG_PATH}" fill="#10B981"/></g>`;
  }
  if (a === "pi" || a === "pi-cli") {
    return `${bg}${piGlyph(ix, iy, isize)}`;
  }

  // Fallback: 2-character pill for unsupported or unknown agents
  const label = a ? [...a].slice(0, 2).join("").toUpperCase() : "?";
  return `<rect x="104" y="118" width="32" height="18" rx="9" fill="#4b5563"/><text x="120" y="131" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="11" font-weight="800" letter-spacing="0.5">${esc(label)}</text>`;
}

// Wrap text based on word boundaries with maxCharsPerLine and maxLines
export function wrapWords(s: string, maxCharsPerLine = 15, maxLines = 2): string[] {
  const cleaned = stripSpinner(s).trim();
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/);
  const lines: string[] = [];
  let cur = "";

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!cur) {
      if (w.length > maxCharsPerLine) {
        lines.push(w.slice(0, maxCharsPerLine));
        cur = w.slice(maxCharsPerLine);
      } else {
        cur = w;
      }
    } else {
      if ((cur + " " + w).length <= maxCharsPerLine) {
        cur += " " + w;
      } else {
        lines.push(cur);
        cur = w;
        if (lines.length === maxLines) break;
      }
    }
  }
  if (cur && lines.length < maxLines) {
    lines.push(cur);
  }

  const rendered = lines.join(" ");
  if (rendered.length < cleaned.length && lines.length > 0) {
    const last = lines[lines.length - 1];
    if (!last.endsWith("…")) {
      if (last.length >= maxCharsPerLine) {
        lines[lines.length - 1] = last.slice(0, maxCharsPerLine - 1) + "…";
      } else {
        lines[lines.length - 1] = last + "…";
      }
    }
  }

  return lines;
}

// Agent session state icon matching Orca UI badges (placed bottom-left)
// done = green checkmark circle, unverifiable = orange dashed circle, working = blue spinner ring, waiting = amber question, error = red exclamation
export function stateIcon(state?: string): string {
  const s = (state || "").toLowerCase();
  const x = 12;
  const y = 114;
  if (s === "done") {
    return `<g transform="translate(${x}, ${y})"><circle cx="8" cy="8" r="7" fill="none" stroke="#22c55e" stroke-width="2"/><path d="M4.8 8.2 L7.2 10.4 L11.2 5.8" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }
  if (s === "unverifiable") {
    return `<g transform="translate(${x}, ${y})"><circle cx="8" cy="8" r="7" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="2.8 2.2" stroke-linecap="round"/></g>`;
  }
  if (s === "working") {
    return `<g transform="translate(${x}, ${y})"><circle cx="8" cy="8" r="7" fill="none" stroke="#3b82f6" stroke-width="2" stroke-dasharray="8 4" stroke-linecap="round"/></g>`;
  }
  if (s === "waiting") {
    return `<g transform="translate(${x}, ${y})"><circle cx="8" cy="8" r="7" fill="none" stroke="#f59e0b" stroke-width="2"/><text x="8" y="11" text-anchor="middle" fill="#f59e0b" font-family="sans-serif" font-size="9" font-weight="800">?</text></g>`;
  }
  if (s === "error" || s === "blocked" || s === "failed") {
    return `<g transform="translate(${x}, ${y})"><circle cx="8" cy="8" r="7" fill="none" stroke="#ef4444" stroke-width="2"/><text x="8" y="11" text-anchor="middle" fill="#ef4444" font-family="sans-serif" font-size="9" font-weight="800">!</text></g>`;
  }
  return "";
}

// Approximate character width units used for automatic font size calculation
function units(s: string): number {
  let u = 0;
  for (const ch of s) u += /[\x00-\x7F]/.test(ch) ? 0.56 : 1;
  return u || 1;
}

/**
 * Project background watermark icon (144x144 tile full fill/crop, opacity 0.25)
 * - GitHub avatar / local icon.png (Data URI, preserveAspectRatio="xMidYMid slice")
 * - Lucide vector icon (Rocket, Folder, etc., viewBox 24x24 -> scale(6))
 * - Emoji (large text)
 */
export function renderBgIcon(b: Button): string {
  if (b.empty) return "";

  if (b.bgIconUri) {
    return `<image href="${esc(b.bgIconUri)}" xlink:href="${esc(b.bgIconUri)}" x="0" y="0" width="144" height="144" opacity="0.25" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)"/>`;
  }

  if (b.bgIconLucide) {
    const stroke = b.badgeColor && b.badgeColor !== "#737373" ? b.badgeColor : "#ffffff";
    return `<g transform="scale(6)" opacity="0.25" stroke="${stroke}" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#r)">${b.bgIconLucide}</g>`;
  }

  if (b.bgIconEmoji) {
    return `<text x="72" y="108" text-anchor="middle" font-size="108" opacity="0.25" clip-path="url(#r)">${esc(b.bgIconEmoji)}</text>`;
  }

  return "";
}

export function keySvg(b: Button, tick = 0, isTarget = false, nowMs = 0, dim = false): string {
  if (b.empty) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="18" fill="#141416"/><circle cx="72" cy="72" r="7" fill="#3a3a3e"/></svg>`;
  }
  const color = HEX[b.color] ?? HEX.white;

  // 1. Project name (top, white)
  const proj = b.repo || (b.worktreePath ? b.worktreePath.split("/").filter(Boolean).pop() : "") || "?";
  const num = b.dupIndex && b.dupIndex > 0 ? `-${b.dupIndex}` : "";
  const sub = b.branch ? `${b.branch}${num}` : num ? `#${b.dupIndex}` : "";

  // Fit text within available width
  const fit = 116 / units(proj);
  const projSvg =
    fit >= 15
      ? `<text x="72" y="41" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="${Math.min(21, Math.floor(fit))}" font-weight="700">${esc(proj)}</text>`
      : `<text x="72" y="41" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="15" font-weight="700">${esc(marqueeWindow(proj, 10, tick))}</text>`;

  // 2. Branch name (below project name)
  let subSvg = "";
  if (sub) {
    subSvg = `<text x="72" y="58" text-anchor="middle" fill="#a1a1aa" font-family="sans-serif" font-size="15" font-weight="600">${esc(sub)}</text>`;
  }

  // 3. Tab title (2-line summary below branch)
  const titleText = (b as any).tabTitle || b.label || "";
  const rawTitle = titleText !== proj ? titleText : "";
  const titleLines = wrapWords(rawTitle, 15, 2);
  let titleSvg = "";
  if (titleLines.length > 0) {
    const startY = sub ? 77 : 67;
    titleSvg = titleLines
      .map((line, idx) => `<text x="72" y="${startY + idx * 16}" text-anchor="middle" fill="#e4e4e7" font-family="sans-serif" font-size="14" font-weight="500">${esc(line)}</text>`)
      .join("");
  }

  // Pulse animation for attention-needed keys
  const attn = needsAttention(b, isTarget);
  let glow = "";
  if (attn) {
    const urgent = b.color === "amber" || b.color === "red";
    const period = urgent ? 640 : 1300; // ms/cycle
    const p = 0.5 - 0.5 * Math.cos((2 * Math.PI * (nowMs % period)) / period); // 0->1->0
    const op = (urgent ? 0.4 : 0.28) * p;
    glow = `<rect width="144" height="144" rx="18" fill="${color}" opacity="${op.toFixed(2)}"/>`;
  }
  // Dim non-attention keys when attention keys exist
  const g0 = dim ? '<g opacity="0.32">' : "";
  const g1 = dim ? "</g>" : "";
  // Coral dot in top-right for target session
  const cornerTag = isTarget
    ? `<circle cx="124" cy="28" r="8" fill="#d97757"/>`
    : "";
  const stIcon = stateIcon(b.state);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144">
  <defs><clipPath id="r"><rect width="144" height="144" rx="18"/></clipPath></defs>
  ${g0}<rect width="144" height="144" rx="18" fill="#1c1c1e"/>
  ${renderBgIcon(b)}
  ${glow}
  <rect width="144" height="13" fill="${color}" clip-path="url(#r)"/>
  ${projSvg}${subSvg}${titleSvg}${stIcon}${agentBadge(b.agentType)}${g1}${cornerTag}
</svg>`;
}

// Convert SVG into base64 data URI for Stream Deck setImage
export function keyImage(b: Button, tick = 0, isTarget = false, nowMs = 0, dim = false): string {
  return "data:image/svg+xml;base64," + Buffer.from(keySvg(b, tick, isTarget, nowMs, dim), "utf8").toString("base64");
}

const DIAL_ACCENT: Record<string, string> = {
  model: "#3b82f6", // blue
  effort: "#a855f7", // purple
  mode: "#f43f5e", // rose (fallback)
  talk: "#14b8a6", // teal
  target: "#f59e0b", // amber
};

/**
 * Mode color mapping by agent and mode name (for title and accent rail):
 * - AGY:
 *   - 'accept edits' / 'accept-edits' / 'yolo' -> green (#22c55e)
 *   - 'plan' -> blue (#3b82f6)
 *   - 'default' / 'nothing' / 'none' / 'normal' -> gray (#71717a)
 * - Claude:
 *   - 'auto' / 'auto-mode' / 'automode' -> yellow (#eab308)
 *   - 'manual' / 'default' / 'normal' -> gray (#71717a)
 *   - 'accept edits' / 'accept-edits' / 'bypass-permissions' / 'dont-ask' -> purple (#a855f7)
 *   - 'plan' / 'plan mode' -> blue (#3b82f6)
 * - Codex:
 *   - 'workspace-write' / 'write' -> emerald (#10b981)
 *   - 'read-only' / 'readonly' -> cyan/blue (#0ea5e9)
 *   - 'danger-full-access' / 'full-access' / 'danger' / 'yolo' -> red (#ef4444)
 *   - 'plan' -> blue (#3b82f6)
 *   - 'on-request' -> amber (#f59e0b)
 *   - 'never' -> purple (#a855f7)
 * - OpenCode:
 *   - 'build' -> green (#22c55e)
 *   - 'plan' -> blue (#3b82f6)
 *   - 'review' -> purple (#a855f7)
 *   - 'debug' -> amber (#f59e0b)
 */
export function modeColor(mode?: string | null, agentType?: string | null): string {
  if (!mode || mode === "-" || mode === "…" || mode.trim() === "") return "#71717a";
  const m = mode.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const a = (agentType || "").trim().toLowerCase();

  // 1. Antigravity / Agy
  if (a === "agy" || a === "antigravity") {
    if (m === "accept-edits" || m === "acceptedits" || m === "yolo") return "#22c55e"; // green
    if (m === "plan" || m === "plan-mode") return "#3b82f6"; // blue
    if (m === "default" || m === "nothing" || m === "none" || m === "normal") return "#71717a"; // gray
  }

  // 2. Claude
  if (a === "claude" || a === "claude-agent-teams") {
    if (m === "auto" || m === "auto-mode" || m === "automode") return "#eab308"; // yellow
    if (m === "manual" || m === "normal" || m === "default") return "#71717a"; // gray
    if (m === "accept-edits" || m === "acceptedits" || m === "bypass-permissions" || m === "dont-ask" || m === "yolo") return "#a855f7"; // purple
    if (m === "plan" || m === "plan-mode") return "#3b82f6"; // blue
  }

  // 3. Codex
  if (a === "codex" || a === "code") {
    if (m === "workspace-write" || m === "write") return "#10b981"; // emerald
    if (m === "read-only" || m === "readonly") return "#0ea5e9"; // cyan
    if (m === "danger-full-access" || m === "full-access" || m === "danger" || m === "yolo") return "#ef4444"; // danger red
    if (m === "plan" || m === "plan-mode") return "#3b82f6"; // blue
    if (m === "on-request" || m === "ask") return "#f59e0b"; // amber
    if (m === "never" || m === "auto") return "#a855f7"; // violet
  }

  // 4. OpenCode
  if (a === "opencode") {
    if (m === "build") return "#22c55e"; // green
    if (m === "plan") return "#3b82f6"; // blue
    if (m === "review") return "#a855f7"; // purple
    if (m === "debug") return "#f59e0b"; // amber
  }

  // 5. Hermes
  if (a.startsWith("hermes")) {
    if (m === "plan") return "#3b82f6";
    if (m === "default" || m === "normal") return "#71717a";
  }

  // 6. Generic Fallback by keyword
  if (m === "accept-edits" || m === "acceptedits" || m === "build" || m === "write" || m === "workspace-write") {
    return "#22c55e";
  }
  if (m === "plan" || m === "plan-mode" || m === "readonly" || m === "read-only") {
    return "#3b82f6";
  }
  if (m === "auto" || m === "auto-mode" || m === "automode") {
    return "#eab308";
  }
  if (m === "danger" || m === "danger-full-access" || m === "full-access" || m === "yolo") {
    return "#ef4444";
  }
  if (m === "bypass-permissions" || m === "dont-ask" || m === "review") {
    return "#a855f7";
  }
  if (m === "default" || m === "normal" || m === "manual" || m === "nothing" || m === "none") {
    return "#71717a";
  }

  return "#f43f5e";
}

/** Custom render for dial touchscreen (200x100) */
export function dialImage(
  role: string,
  label: string,
  value: string,
  tick = 0,
  disabled = false,
  badge?: string | null,
  sub?: string | null,
  customColor?: string | null,
): string {
  const roleAccent = customColor || (role === "mode" ? modeColor(value, badge) : (DIAL_ACCENT[role] ?? "#8a8a90"));
  const accent = disabled ? "#2e2e34" : roleAccent;
  const labelColor = disabled ? "#4a4a52" : accent;
  const valueColor = disabled ? "#4a4a52" : "#ffffff";
  const val = disabled ? (value && value !== " " && value !== "…" ? value : "-") : (value || " ");
  const textX = 18;
  const avail = 195 - textX; // available width excluding 7px accent rail
  const lineFont = 15;
  const lineH = 16;
  const top = 44;
  const perLine = Math.max(4, Math.floor(avail / (lineFont * 0.56)));

  const oneLineFits = units(val) * 20 <= avail;
  const lines = oneLineFits
    ? [val]
    : splitSlash(val, perLine);
  const singleSize = oneLineFits ? Math.min(28, Math.max(16, Math.floor((avail - 4) / units(val)))) : lineFont;

  const labelSvg = role === "model"
    ? `<text x="${textX}" y="20" fill="${labelColor}" font-family="sans-serif" font-size="11" font-weight="800" letter-spacing="2">${esc(label)}</text>`
    : `<text x="${textX}" y="24" fill="${labelColor}" font-family="sans-serif" font-size="13" font-weight="800" letter-spacing="1">${esc(label)}</text>`;

  const hasSub = Boolean(sub && !disabled);
  const valueY = hasSub ? 48 : 56;
  const valueSvg = lines.length > 1
    ? lines.map((ln, i) => `<text x="${textX}" y="${(hasSub ? 40 : top) + i * lineH}" fill="${valueColor}" font-family="sans-serif" font-size="${lineFont}" font-weight="700">${esc(ln)}</text>`).join("")
    : `<text x="${textX}" y="${valueY}" fill="${valueColor}" font-family="sans-serif" font-size="${singleSize}" font-weight="700">${esc(lines[0])}</text>`;

  const subSvg = hasSub
    ? `<text x="${textX}" y="${valueY + 18}" fill="${disabled ? "#4a4a52" : "#b8b8be"}" font-family="sans-serif" font-size="13" font-weight="600">${esc(sub || "")}</text>`
    : "";

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

// Agent badge for top-right dial position (20x20)
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
  if (a === "hermes" || a === "hermes-cli" || a === "hermes-agent") {
    const s = (isize / 24).toFixed(4);
    return `${bg}<g transform="translate(${ix}, ${iy}) scale(${s})"><path fill-rule="evenodd" clip-rule="evenodd" d="${HERMES_SVG_PATH}" fill="#10B981"/></g>`;
  }
  if (a === "pi" || a === "pi-cli") {
    return `${bg}${piGlyph(ix, iy, isize)}`;
  }

  // Fallback: 2-character pill for unsupported or unknown agents
  const label = a ? [...a].slice(0, 2).join("").toUpperCase() : "?";
  return `<rect x="166" y="6" width="28" height="16" rx="8" fill="#4b5563"/><text x="180" y="18" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="10" font-weight="800" letter-spacing="0.5">${esc(label)}</text>`;
}

// Split text by "/" boundary if multi-part, otherwise wrap by characters
function splitSlash(value: string, perLine: number): string[] {
  const parts = (value || " ").split("/").filter((p) => p !== "");
  if (parts.length <= 3 && parts.every((p) => [...p].length <= perLine)) {
    return parts;
  }
  return wrap(value || " ", perLine, 3);
}
