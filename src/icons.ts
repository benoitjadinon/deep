// Orca 프로젝트 및 저장소 아이콘 리졸버.
// GitHub 아바타(원격 이미지), 로컬 에셋(icon.png 등), Lucide 벡터 아이콘, 이모지를
// Stream Deck 타일 배경 워터마크에 사용할 수 있는 형태로 변환 및 캐싱한다.
import * as lucide from "lucide-static";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { OrcaRepo, OrcaRepoIcon } from "./deck";

export interface ResolvedBgIcon {
  uri?: string; // 이미지 base64 Data URI
  lucide?: string; // Lucide SVG 내부 요소(path/circle 등)
  emoji?: string; // 이모지 문자열
}

// 메모리 캐시: URL or 경로 or lucide명 -> ResolvedBgIcon
const memCache = new Map<string, ResolvedBgIcon>();
// 원격 이미지 다운로드 진행 중 Promise (중복 요청 방지)
const inflightFetches = new Map<string, Promise<string | undefined>>();

const CACHE_DIR = join(tmpdir(), "agentdeck-icons");

function ensureCacheDir(): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  } catch {}
}

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

/**
 * Lucide 아이콘 이름(PascalCase, kebab-case, snake_case 등)을 받아
 * SVG 내부 요소(viewBox 0 0 24 24 기준) 문자열을 반환한다.
 */
export function resolveLucideSvg(name?: string): string | undefined {
  if (!name) return undefined;
  const key = `lucide:${name}`;
  if (memCache.has(key)) return memCache.get(key)?.lucide;

  const pascal = name
    .replace(/[-_ ]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase());

  const raw = (lucide as Record<string, string>)[pascal] || (lucide as Record<string, string>)[name];
  if (!raw) return undefined;

  const inner = raw.replace(/<svg[^>]*>/i, "").replace(/<\/svg>/i, "").trim();
  const res: ResolvedBgIcon = { lucide: inner };
  memCache.set(key, res);
  return inner;
}

/**
 * 로컬 파일 경로를 읽어 base64 Data URI로 변환한다.
 */
export function resolveLocalIconUri(repoPath?: string, relPath?: string): string | undefined {
  if (!relPath) return undefined;
  const fullPath = isAbsolute(relPath) ? relPath : repoPath ? join(repoPath, relPath) : undefined;
  if (!fullPath) return undefined;

  const key = `local:${fullPath}`;
  if (memCache.has(key)) return memCache.get(key)?.uri;

  try {
    if (existsSync(fullPath)) {
      const buf = readFileSync(fullPath);
      const ext = extname(fullPath).toLowerCase();
      const mime = MIME_MAP[ext] || "image/png";
      const uri = `data:${mime};base64,${buf.toString("base64")}`;
      memCache.set(key, { uri });
      return uri;
    }
  } catch {}
  return undefined;
}

/**
 * 단순 해시 함수 (디스크 캐시 파일명용)
 */
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * 원격 URL(GitHub 아바타 등)을 백그라운드로 다운로드하고 base64 Data URI로 변환한다.
 */
export async function fetchRemoteIconUri(url?: string): Promise<string | undefined> {
  if (!url) return undefined;
  const key = `remote:${url}`;
  if (memCache.has(key)) return memCache.get(key)?.uri;

  if (inflightFetches.has(url)) {
    return inflightFetches.get(url);
  }

  ensureCacheDir();
  const diskPath = join(CACHE_DIR, `${hashStr(url)}.dat`);
  if (existsSync(diskPath)) {
    try {
      const uri = readFileSync(diskPath, "utf8");
      memCache.set(key, { uri });
      return uri;
    } catch {}
  }

  const p = (async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get("content-type") || "image/png";
      const uri = `data:${mime};base64,${buf.toString("base64")}`;
      memCache.set(key, { uri });
      try {
        writeFileSync(diskPath, uri, "utf8");
      } catch {}
      return uri;
    } catch {
      return undefined;
    } finally {
      inflightFetches.delete(url);
    }
  })();

  inflightFetches.set(url, p);
  return p;
}

/**
 * OrcaRepo 정보를 받아 즉시 사용 가능한 배경 아이콘 정보를 반환한다.
 * 원격 이미지인 경우 이미 캐시되어 있으면 즉시 반환하고, 아니면 백그라운드 프리페치를 시작한다.
 */
export function resolveRepoBgIcon(repo: OrcaRepo): ResolvedBgIcon {
  const icon = repo.repoIcon;
  if (!icon) return {};

  if (icon.type === "lucide") {
    const lucide = resolveLucideSvg(icon.name);
    return { lucide };
  }

  if (icon.type === "emoji") {
    const emoji = icon.emoji || icon.value;
    return { emoji };
  }

  if (icon.type === "image") {
    if (icon.source === "file" || (!icon.src?.startsWith("http") && (icon.label || icon.src))) {
      const uri = resolveLocalIconUri(repo.path, icon.label || icon.src);
      if (uri) return { uri };
    }
    if (icon.src && icon.src.startsWith("http")) {
      const key = `remote:${icon.src}`;
      const cached = memCache.get(key);
      if (cached) return cached;

      // 비동기 프리페치 트리거 (다음 렌더에 반영)
      fetchRemoteIconUri(icon.src).catch(() => {});
    }
  }

  return {};
}

/**
 * 여러 저장소의 원격 아이콘을 미리 가져오도록 트리거
 */
export function prefetchRepoIcons(repos: OrcaRepo[]): void {
  for (const r of repos) {
    if (r.repoIcon?.type === "image" && r.repoIcon.src?.startsWith("http")) {
      fetchRemoteIconUri(r.repoIcon.src).catch(() => {});
    }
  }
}
