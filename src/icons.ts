// Orca project and repository icon resolver.
// Converts and caches GitHub avatars (remote images), local assets (icon.png), Lucide vector icons, and emojis
// for use as Stream Deck tile background watermarks.
import * as lucide from "lucide-static";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { OrcaRepo, OrcaRepoIcon } from "./deck";

export interface ResolvedBgIcon {
  uri?: string; // Image base64 Data URI
  lucide?: string; // Lucide SVG inner tags (path/circle/etc.)
  emoji?: string; // Emoji character string
}

// Memory cache: URL or path or lucideName -> ResolvedBgIcon
const memCache = new Map<string, ResolvedBgIcon>();
// In-flight fetch promises to prevent redundant requests
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
 * Given a Lucide icon name (PascalCase, kebab-case, snake_case),
 * returns inner SVG element string (viewBox 0 0 24 24).
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
 * Read local file path and convert to base64 Data URI.
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
 * Simple hash function for disk cache file names
 */
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Download remote URL (e.g. GitHub avatar) in background and convert to base64 Data URI.
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
 * Resolve background icon info for given OrcaRepo.
 * Returns immediately if cached; otherwise triggers background prefetch.
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

      // Trigger background prefetch for next render
      fetchRemoteIconUri(icon.src).catch(() => {});
    }
  }

  return {};
}

/**
 * Prefetch remote icons for multiple repositories
 */
export function prefetchRepoIcons(repos: OrcaRepo[]): void {
  for (const r of repos) {
    if (r.repoIcon?.type === "image" && r.repoIcon.src?.startsWith("http")) {
      fetchRemoteIconUri(r.repoIcon.src).catch(() => {});
    }
  }
}
