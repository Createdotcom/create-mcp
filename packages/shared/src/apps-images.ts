/**
 * Create App Hosting, slice E5 — image optimization at the edge (app hosting spec 2026-09-25 §7, §13A
 * row E5). Dependency-free: read by the dispatch Worker (`apps/app-edge/src/images.ts`), the control
 * plane (`apps/api/src/apps-hosting/edge/images.ts`), the hosting MCP tools and the CLI.
 *
 *   GET /_create/image?url=<source>&w=<width>&q=<quality>[&f=auto|avif|webp|original]
 *
 * served by the dispatch Worker on every edge frontend's hostnames (and, for Next.js, at Next's own
 * `/_next/image`, so `next/image` works unmodified). `url` is either a path of the SAME deployment
 * (`/hero.png`, served from the version's static files or its Worker) or an `https://` URL whose host
 * is on the project's allowlist (`images.remotePatterns`-style). Widths snap UP to a fixed ladder and
 * qualities to steps of 5, so a page cannot mint unbounded unique transforms (each costs money).
 *
 * The per-project config lives in KV next to the routing records (see apps-edge.ts):
 *
 *   i:<projectId>  → EdgeImageConfig   written by the control plane when the allowlist changes and on
 *                                      every deploy/rollback (so the plan's quota follows the project)
 */

export const EDGE_IMAGES_VERSION = 1 as const;

/** The framework-neutral endpoint. */
export const IMAGE_ENDPOINT = '/_create/image';
/** Next.js's default loader path: served as an alias of IMAGE_ENDPOINT for Next.js frontends. */
export const NEXT_IMAGE_ENDPOINT = '/_next/image';

/**
 * Widths an image is ever resized to: Next.js's default `imageSizes` + `deviceSizes` (so `next/image`
 * with default settings never snaps), capped at 3840. A requested width snaps UP to the next rung;
 * anything past the top is served at the top.
 */
export const IMAGE_WIDTH_LADDER: readonly number[] = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const IMAGE_QUALITY_DEFAULT = 75;
export const IMAGE_QUALITY_MIN = 10;
export const IMAGE_QUALITY_MAX = 100;
export const IMAGE_QUALITY_STEP = 5;

export const IMAGE_LIMITS = {
  /** A source image larger than this is refused (413) — before it is read in full. */
  maxSourceBytes: 25 * 1024 * 1024,
  /** Longest side of a source image (Cloudflare Images' own ceiling is 12,000 px). */
  maxSourceSide: 12_000,
  /** Total pixels of a source image (a decompression-bomb guard: 50 megapixels). */
  maxSourcePixels: 50_000_000,
  /** Redirect hops a remote source may take; every hop is re-checked against the allowlist. */
  maxRedirects: 3,
  /** Patterns on one project's allowlist (project settings + the build's own, together). */
  maxPatterns: 50,
  /** How long an edge-cached transform of a REMOTE source is kept (the remote may change). */
  remoteEdgeTtlSeconds: 24 * 60 * 60,
  /** Browser cache for a remote source's transform and a non-fingerprinted local one. */
  browserTtlSeconds: 60 * 60,
} as const;

/**
 * Transforms (cache misses that reach Cloudflare Images) a project may run per calendar month (UTC),
 * and per minute, by plan. The free tier (Hobby) gets the constant below; past it the endpoint answers
 * 429 with a fix until the month turns. Cached transforms never count.
 */
export const APPS_IMAGES_FREE_MONTHLY_TRANSFORMS = 1_000;
/**
 * `accountMonthlyTransforms` (security review MED-1/L): a ceiling across ALL of an account's projects
 * on that plan, so a free account cannot multiply its allowance by opening projects. Null = none.
 */
export const APPS_IMAGES_FREE_ACCOUNT_MONTHLY_TRANSFORMS = 3_000;
export const IMAGE_PLAN_QUOTAS: Readonly<Record<'hobby' | 'pro', { monthlyTransforms: number; perMinute: number; accountMonthlyTransforms: number | null }>> = {
  hobby: { monthlyTransforms: APPS_IMAGES_FREE_MONTHLY_TRANSFORMS, perMinute: 60, accountMonthlyTransforms: APPS_IMAGES_FREE_ACCOUNT_MONTHLY_TRANSFORMS },
  pro: { monthlyTransforms: 50_000, perMinute: 600, accountMonthlyTransforms: null },
};

/**
 * Security review MED-1: new transforms one client address may cause per minute on one project (the
 * dispatch Worker's rate-limiting binding, in front of the per-project meter). Cached images are free.
 */
export const IMAGE_CLIENT_PER_MINUTE = 60;

/**
 * Past its monthly quota a project's images are served as ORIGINALS (never a broken page). Those are
 * edge-cached for this long, and at most this many uncached original serves per project per minute
 * reach the source (the rest answer 429) — a quota-exhausted project cannot become a free proxy.
 */
export const IMAGE_ORIGINAL_EDGE_TTL_SECONDS = 300;
export const IMAGE_ORIGINAL_PER_MINUTE = 120;

/**
 * Qualities a project serves (MED-1: every distinct q is a new, billed transform). Like Next.js
 * `images.qualities`: a requested q snaps to the nearest allowed value. Default: 75 only.
 */
export const IMAGE_DEFAULT_QUALITIES: readonly number[] = [IMAGE_QUALITY_DEFAULT];
export const IMAGE_MAX_QUALITIES = 5;

/** The usage meter A8 reads (`apps_image_usage`): transforms per project per UTC month. */
export const IMAGE_USAGE_METER = 'edge_image_transforms' as const;

/**
 * One allowlist entry, the shape of Next.js `images.remotePatterns` minus what Create never allows
 * (http, ports): `hostname` is exact, `*.example.com` (one label) or `**.example.com` (any depth, not
 * the apex); `pathname` is an optional glob (`/images/**`, `*` = within one segment).
 */
export type EdgeImagePattern = { hostname: string; pathname?: string };

/** `i:<projectId>` */
export type EdgeImageConfig = {
  v: typeof EDGE_IMAGES_VERSION;
  accountId: string;
  projectId: string;
  plan: 'hobby' | 'pro';
  monthlyTransforms: number;
  perMinute: number;
  /** The project's allowlist (settings, MCP `set_image_domains`, CLI `create images domains`). */
  domains: EdgeImagePattern[];
  /** Allowed qualities (default [75]); a requested q snaps to the nearest. */
  qualities?: number[];
  /** The account-wide monthly ceiling for this plan (null: none). */
  accountMonthlyTransforms?: number | null;
};

export const edgeImageKey = (projectId: string): string => `i:${projectId}`;

export type ImageFormat = 'avif' | 'webp' | 'original';

// ---------------------------------------------------------------------------------------------
// Ladders and negotiation
// ---------------------------------------------------------------------------------------------

/** Snap a requested width UP to the ladder (a width past the top is served at the top). Null = invalid. */
export function snapImageWidth(raw: string | number | null | undefined): number | null {
  const n = typeof raw === 'number' ? raw : raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const rung of IMAGE_WIDTH_LADDER) if (rung >= n) return rung;
  return IMAGE_WIDTH_LADDER[IMAGE_WIDTH_LADDER.length - 1]!;
}

/** Clamp to [10, 100] and round to the nearest step of 5; missing or invalid → the default (75). */
export function clampImageQuality(raw: string | number | null | undefined): number {
  const n = typeof raw === 'number' ? raw : raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return IMAGE_QUALITY_DEFAULT;
  const clamped = Math.min(IMAGE_QUALITY_MAX, Math.max(IMAGE_QUALITY_MIN, n));
  return Math.min(IMAGE_QUALITY_MAX, Math.max(IMAGE_QUALITY_MIN, Math.round(clamped / IMAGE_QUALITY_STEP) * IMAGE_QUALITY_STEP));
}

/** The allowed quality nearest the request (ties go lower); no q → 75 when allowed, else the first allowed. */
export function pickImageQuality(raw: string | number | null | undefined, allowed: readonly number[] = IMAGE_DEFAULT_QUALITIES): number {
  const set = allowed.length ? [...allowed].sort((a, b) => a - b) : [IMAGE_QUALITY_DEFAULT];
  const n = typeof raw === 'number' ? raw : raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return set.includes(IMAGE_QUALITY_DEFAULT) ? IMAGE_QUALITY_DEFAULT : set[0]!;
  const want = clampImageQuality(n);
  return set.reduce((best, q) => (Math.abs(q - want) < Math.abs(best - want) ? q : best), set[0]!);
}

/** Validate a project's quality list: 1–5 distinct values, each 10–100 in steps of 5. */
export function parseImageQualities(input: readonly number[]): number[] | null {
  const out = [...new Set(input)].sort((a, b) => a - b);
  if (out.length === 0 || out.length > IMAGE_MAX_QUALITIES) return null;
  return out.every((q) => Number.isInteger(q) && q >= IMAGE_QUALITY_MIN && q <= IMAGE_QUALITY_MAX && q % IMAGE_QUALITY_STEP === 0) ? out : null;
}

function accepts(accept: string, type: string): boolean {
  return accept
    .toLowerCase()
    .split(',')
    .some((part) => {
      const [name, ...params] = part.trim().split(';');
      if (name!.trim() !== type) return false;
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return !q || Number(q.slice(2)) > 0;
    });
}

/**
 * The output format: an explicit `f=avif|webp` when the browser accepts it, `f=original` as asked,
 * otherwise (`f=auto`, the default) AVIF, then WebP, then the source's own format — by the request's
 * Accept header. A wildcard Accept does not count as AVIF/WebP support (old browsers send it).
 */
export function negotiateImageFormat(accept: string | null | undefined, requested?: string | null): ImageFormat {
  const a = accept ?? '';
  const f = (requested ?? 'auto').toLowerCase();
  if (f === 'original') return 'original';
  if (f === 'avif' && accepts(a, 'image/avif')) return 'avif';
  if (f === 'webp' && accepts(a, 'image/webp')) return 'webp';
  if (f !== 'auto' && f !== 'avif' && f !== 'webp') return 'original';
  if (accepts(a, 'image/avif')) return 'avif';
  if (accepts(a, 'image/webp')) return 'webp';
  return 'original';
}

// ---------------------------------------------------------------------------------------------
// The loader (what next/image, Astro, SvelteKit, Nuxt snippets and plain <img srcset> emit)
// ---------------------------------------------------------------------------------------------

/**
 * The URL a loader emits: `/_create/image?url=<encoded src>&w=<ladder width>&q=<quality>`. Same
 * signature as a Next.js custom loader (`({ src, width, quality }) => string`), so it can be dropped
 * into any framework's image component.
 */
export function createImageLoader({ src, width, quality }: { src: string; width: number; quality?: number | null }): string {
  const w = snapImageWidth(width) ?? IMAGE_WIDTH_LADDER[0]!;
  const q = clampImageQuality(quality ?? IMAGE_QUALITY_DEFAULT);
  return `${IMAGE_ENDPOINT}?url=${encodeURIComponent(src)}&w=${w}&q=${q}`;
}

/** The loader as source text, for llms.txt and the docs (kept next to the function it mirrors). */
export const IMAGE_LOADER_SNIPPET = `export default function createLoader({ src, width, quality }) {
  return \`/_create/image?url=\${encodeURIComponent(src)}&w=\${width}&q=\${quality || 75}\`;
}`;

// ---------------------------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------------------------

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'arpa', 'test', 'invalid', 'example'];

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\d+$/.test(host) || /^0x[0-9a-f]+/i.test(host);
}

/**
 * Security review LOW: a wildcard over a public suffix (`*.github.io`, `**.co.uk`, `*.workers.dev`)
 * allows every tenant of that platform. A bundled subset of the Public Suffix List (the ICANN
 * second-level suffixes most seen, plus the hosting platforms whose customers share a registrable
 * suffix) — a wildcard whose base is one of these is refused; an exact host under them is fine.
 */
export const IMAGE_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'com.br', 'net.br', 'org.br',
  'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my', 'co.in', 'net.in', 'org.in',
  'co.za', 'org.za', 'com.mx', 'com.ar', 'com.tr', 'co.il', 'com.ua', 'co.id', 'com.ph', 'com.vn',
  'github.io', 'githubusercontent.com', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'now.sh',
  'netlify.app', 'netlify.com', 'herokuapp.com', 'fly.dev', 'onrender.com', 'railway.app', 'web.app',
  'firebaseapp.com', 'appspot.com', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'azurewebsites.net',
  'cloudapp.net', 'azureedge.net', 'blob.core.windows.net', 'cloudfront.net', 's3.amazonaws.com',
  'amazonaws.com', 'elasticbeanstalk.com', 'storage.googleapis.com', 'googleusercontent.com',
  'r2.dev', 'r2.cloudflarestorage.com', 'digitaloceanspaces.com', 'ondigitalocean.app', 'glitch.me',
  'repl.co', 'replit.app', 'surge.sh', 'neocities.org', 'myshopify.com', 'wixsite.com', 'squarespace.com',
  'webflow.io', 'framer.app', 'bubbleapps.io', 'deno.dev', 'supabase.co', 'ngrok.io', 'ngrok-free.app',
]);

export type ImageDomainOptions = {
  /** Create's own apps / anonymous domains: no entry (exact or wildcard) may fall under them. */
  reservedDomains?: readonly string[];
};

export class ImageDomainError extends Error {
  constructor(
    readonly input: string,
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

/**
 * Parse one allowlist entry as a person or an agent writes it: `cdn.example.com`, `*.example.com`,
 * `**.example.com`, or `https://cdn.example.com/images/**`. Refused: `http://`, ports, credentials,
 * IP literals, internal names (localhost, *.internal, …), a bare wildcard or one over a single label
 * (`*.com`), queries and fragments.
 */
export function parseImageDomain(input: string, options: ImageDomainOptions = {}): EdgeImagePattern {
  const raw = input.trim();
  const fail = (message: string, fix: string): never => {
    throw new ImageDomainError(input, message, fix);
  };
  if (!raw || raw.length > 300) fail('An image domain must be 1–300 characters', 'Pass a hostname such as cdn.example.com.');
  let rest = raw;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    if (scheme[1]!.toLowerCase() !== 'https') fail(`${raw}: only https:// sources are allowed`, 'Serve the images over HTTPS and add the https:// address.');
    rest = rest.slice(scheme[0].length);
  }
  if (/[?#]/.test(rest)) fail(`${raw}: a query or fragment is not allowed`, 'Give the hostname and, optionally, a path such as /images/**.');
  const slash = rest.indexOf('/');
  const hostPart = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase().replace(/\.$/, '');
  const path = slash === -1 ? '' : rest.slice(slash);
  if (hostPart.includes('@')) fail(`${raw}: credentials are not allowed`, 'Remove the user:password@ part.');
  if (/:\d*$/.test(hostPart) && !hostPart.startsWith('[')) fail(`${raw}: a port is not allowed`, 'Image sources are fetched on the default HTTPS port (443) only.');
  if (hostPart.startsWith('[') || isIpLiteral(hostPart)) fail(`${raw}: an IP address is not allowed`, 'Use the hostname the images are served from.');
  const labels = hostPart.split('.');
  const wildcard = labels[0] === '*' || labels[0] === '**' ? labels[0] : null;
  const named = wildcard ? labels.slice(1) : labels;
  if (named.some((l) => l.includes('*'))) fail(`${raw}: a wildcard may only be the first label (*.example.com or **.example.com)`, 'Write the wildcard as the leftmost label.');
  if (named.length < 2 || !named.every((l) => LABEL.test(l))) fail(`${raw}: not a valid public hostname`, 'Use a full hostname such as cdn.example.com.');
  const suffix = named.slice(-2).join('.');
  if (INTERNAL_SUFFIXES.some((s) => named[named.length - 1] === s || suffix === s || hostPart.endsWith(`.${s}`))) fail(`${raw}: internal names are not allowed`, 'Only public hostnames can be image sources.');
  const base = named.join('.');
  if (wildcard && IMAGE_PUBLIC_SUFFIXES.has(base)) fail(`${raw}: a wildcard over a public suffix (${base}) would allow every site hosted there`, `Name your own host exactly, e.g. yoursite.${base}.`);
  for (const reserved of options.reservedDomains ?? []) {
    const r = reserved.toLowerCase().replace(/\.$/, '');
    if (r && (base === r || base.endsWith(`.${r}`) || (wildcard && r.endsWith(`.${base}`)))) fail(`${raw}: Create's own app domains cannot be image sources`, 'Use the image’s path inside your own app (url=/images/…), which is always allowed.');
  }
  let pathname: string | undefined;
  if (path && path !== '/' && path !== '/**') {
    if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/.test(path) || path.includes('..')) fail(`${raw}: the path has characters that are not allowed`, 'Use a path such as /images/** (letters, digits, - _ . / and * wildcards).');
    pathname = path;
  }
  return pathname ? { hostname: hostPart, pathname } : { hostname: hostPart };
}

/** The canonical text of a pattern (what the API lists and the CLI prints). */
export function formatImageDomain(p: EdgeImagePattern): string {
  return p.pathname ? `${p.hostname}${p.pathname}` : p.hostname;
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('**.')) {
    const base = pattern.slice(3);
    return host.endsWith(`.${base}`) && host.length > base.length + 1;
  }
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    if (!host.endsWith(`.${base}`)) return false;
    const label = host.slice(0, -(base.length + 1));
    return label.length > 0 && !label.includes('.');
  }
  return host === pattern;
}

/** Next.js-style path glob: `**` any characters, `*` any within one segment. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') out += '[^/]*';
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Does an absolute https URL match any pattern? (The caller has already refused http, ports, IPs.) */
export function imageUrlAllowed(url: URL, patterns: readonly EdgeImagePattern[]): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIpLiteral(host.replace(/^\[|\]$/g, ''))) return false;
  // Security review LOW: globs match the RAW path (what the origin routes on); an encoded separator or
  // a dot-segment that only appears after decoding is refused rather than guessed about.
  const path = url.pathname;
  if (/%2f|%5c/i.test(path)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (/(^|\/)\.\.(\/|$)/.test(decoded) || decoded.includes('\\')) return false;
  return patterns.some((p) => hostMatches(p.hostname, host) && (!p.pathname || globToRegExp(p.pathname).test(path)));
}

/**
 * Next.js `images.remotePatterns` / `images.domains` (as `.next/required-server-files.json` records
 * them) → Create patterns. An entry Create would refuse (http, a port, an IP, an internal name) is
 * skipped and reported, never widened.
 */
export function fromNextImagesConfig(images: unknown): { patterns: EdgeImagePattern[]; skipped: string[]; qualities: number[] | null } {
  const patterns: EdgeImagePattern[] = [];
  const skipped: string[] = [];
  const cfg = (images && typeof images === 'object' ? images : {}) as { remotePatterns?: unknown; domains?: unknown; qualities?: unknown };
  const add = (text: string) => {
    try {
      const p = parseImageDomain(text);
      if (!patterns.some((q) => q.hostname === p.hostname && q.pathname === p.pathname)) patterns.push(p);
    } catch (error) {
      skipped.push(error instanceof ImageDomainError ? error.message : text);
    }
  };
  if (Array.isArray(cfg.remotePatterns)) {
    for (const entry of cfg.remotePatterns) {
      const e = (typeof entry === 'string' ? (() => {
        try {
          const u = new URL(entry);
          return { protocol: u.protocol.slice(0, -1), hostname: u.hostname, port: u.port, pathname: u.pathname };
        } catch {
          return null;
        }
      })() : entry) as { protocol?: string; hostname?: string; port?: string; pathname?: string; search?: string } | null;
      if (!e || typeof e.hostname !== 'string') continue;
      // Security review LOW: a pattern limited by `search` cannot be honoured exactly: drop it, never widen.
      if (e.search) {
        skipped.push(`${e.hostname}: patterns restricted by a query (search) are not supported`);
        continue;
      }
      if (e.protocol && e.protocol.replace(/:$/, '') !== 'https') {
        skipped.push(`${e.hostname}: only https:// sources are allowed`);
        continue;
      }
      if (e.port) {
        skipped.push(`${e.hostname}: a port is not allowed`);
        continue;
      }
      add(`https://${e.hostname}${e.pathname && e.pathname !== '**' ? e.pathname : ''}`);
    }
  }
  if (Array.isArray(cfg.domains)) for (const d of cfg.domains) if (typeof d === 'string') add(d);
  let qualities: number[] | null = null;
  if (Array.isArray(cfg.qualities)) {
    qualities = parseImageQualities(cfg.qualities.filter((q): q is number => typeof q === 'number'));
    if (!qualities) skipped.push(`images.qualities: 1–${IMAGE_MAX_QUALITIES} values from 10 to 100 in steps of 5 are supported; using the default [75]`);
  }
  return { patterns: patterns.slice(0, IMAGE_LIMITS.maxPatterns), skipped, qualities };
}

/** The current UTC month, `YYYY-MM` — the quota window and the usage row key. */
export function imageUsageMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}
