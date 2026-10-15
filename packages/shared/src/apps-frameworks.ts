/**
 * Create App Hosting, slice E2 — the framework detector (app hosting spec 2026-09-25 §7.4, §7.6).
 *
 * One pure function, read by every party that has to decide "edge or container" for a folder of
 * source, so they can never disagree about a rule:
 *
 * - the control plane (`apps/api`), over an UPLOAD as it streams in (the authoritative decision: the
 *   upload row stores the result and every deploy of that upload reads it);
 * - the `create` CLI, over the local folder, to say what it is about to do before uploading;
 * - the hosting MCP's `deploy_files`, over the inline file map, for the same reason.
 *
 * INPUT is a list of the source's file paths plus the contents of the few files the rules read
 * (`package.json`, framework config files, lockfiles and — within a byte budget — application source
 * files). `detectorWantsContent` says which paths those are, so a streaming reader captures exactly
 * them and nothing else.
 *
 * OUTPUT names the framework, the TARGET (`edge` or `container`), the adapter an edge build uses, and
 * a REASON sentence a person or an agent can act on. §7.6: the detector recommends container when a
 * rule says the app cannot run in a Worker — native Node addons, long-lived WebSocket servers or
 * background schedulers, writes to the local filesystem or `child_process`, Next.js Node middleware,
 * a custom Next.js server, a framework configured for a Node server, or the customer choosing
 * "Server". Each such finding is a BLOCKING reason; everything else it noticed is a note. The size
 * rule (the bundle over the Worker size limit) can only be known after the build: the build pod and
 * the control plane enforce it then (`edge_bundle_too_large`, with `alternative: "container"`).
 *
 * Detection is deliberately conservative: when unsure, container — Next.js and every other framework
 * here also run on the container tier (Railpack), so nothing is stranded (§7.6 last paragraph).
 */

export const APPS_FRAMEWORK_DETECTOR_VERSION = 1 as const;

export const APPS_FRAMEWORKS = ['nextjs', 'astro', 'sveltekit', 'react-router', 'remix', 'nuxt', 'static', 'unknown'] as const;
export type AppsFramework = (typeof APPS_FRAMEWORKS)[number];

export const APPS_DEPLOY_TARGETS = ['edge', 'container'] as const;
export type AppsDeployTarget = (typeof APPS_DEPLOY_TARGETS)[number];
/** What a caller may ask for: the detector's choice (`auto`), or an explicit override. */
export const APPS_TARGET_CHOICES = ['auto', 'edge', 'container'] as const;
export type AppsTargetChoice = (typeof APPS_TARGET_CHOICES)[number];

export const FRAMEWORK_LABELS: Readonly<Record<AppsFramework, string>> = {
  nextjs: 'Next.js',
  astro: 'Astro',
  sveltekit: 'SvelteKit',
  'react-router': 'React Router',
  remix: 'Remix',
  nuxt: 'Nuxt',
  static: 'Static site',
  unknown: 'Unknown',
};

/**
 * The adapters an edge build runs, pinned (§7.4; npm registry, read 2026-09-26). The build pod adds
 * an adapter at exactly this version when the project does not already depend on it; a project that
 * pins its own version keeps it. Wrangler bundles the adapter's output into Worker modules
 * (`wrangler deploy --dry-run --outdir`), the step Cloudflare's own tooling uses.
 */
export const EDGE_ADAPTER_PINS = {
  /** @opennextjs/cloudflare 1.20.6 (2026-09-02). Peer range: next ">=15.5.24 <16 || >=16.3.3". */
  opennext: '1.20.6',
  wrangler: '4.141.0',
  sveltekitCloudflare: '7.2.9',
} as const;

/**
 * The Node image edge builds run in, inside the build pod's rootless BuildKit (a stage of a generated
 * Dockerfile). Pinned by the multi-arch index digest (Docker Hub, read 2026-09-26), like every image
 * a build touches.
 */
export const EDGE_BUILD_NODE_IMAGE = 'docker.io/library/node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';

export type FrameworkReason = {
  /** Stable, for tests, summaries and agents. */
  code: string;
  message: string;
  /** The file the finding came from, when there is one. */
  path?: string;
  /** A blocking reason sends the app to the container tier. */
  blocking: boolean;
};

export type EdgeAdapter = {
  /** `opennext` | `astro-cloudflare` | `sveltekit-cloudflare` | `cloudflare-vite` | `nitro-cloudflare` | `static`. */
  name: string;
  /** The npm package that adapts the framework, or null (Nitro's preset, plain static output). */
  package: string | null;
  /** The version the build uses when the project has none of its own. */
  version: string | null;
  /** A Worker (server rendering) plus static files, or static files only. */
  mode: 'worker' | 'static';
};

export type FrameworkDetection = {
  version: typeof APPS_FRAMEWORK_DETECTOR_VERSION;
  framework: AppsFramework;
  /** The dependency range package.json declares, e.g. "^16.3.4". */
  frameworkVersion: string | null;
  target: AppsDeployTarget;
  /** One sentence: what was detected and why this target. */
  reason: string;
  reasons: FrameworkReason[];
  /** Set when target is edge. */
  adapter: EdgeAdapter | null;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  /** The folder of static files an edge build serves, relative to the root, when known up front. */
  outputDir: string | null;
  /** Unmatched navigations answer /index.html (single-page apps, static only). */
  spa: boolean;
  /** Next.js incremental static regeneration: the frontend gets its R2 cache and D1 tag cache. */
  isr: boolean;
  /** The customer's own choice in create.json ("edge" | "server"), if any. */
  requested: AppsDeployTarget | null;
};

export type FrameworkDetectorInput = {
  /** Every file path in the source, relative, with `/` separators. */
  paths: readonly string[];
  /** The content of a path `detectorWantsContent` asked for, or null when it was not captured. */
  read: (path: string) => string | null;
};

// ---------------------------------------------------------------------------------------------
// What to capture
// ---------------------------------------------------------------------------------------------

/** Directories whose files never count: dependencies, build output, VCS and caches. */
const IGNORED_DIR = /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.output|\.svelte-kit|\.vercel|\.netlify|\.wrangler|\.open-next|\.astro|\.turbo|\.cache|dist|build|out|coverage|vendor)(\/|$)/;

const CONFIG_FILES = /^(next|astro|svelte|react-router|remix|nuxt|vite|open-next)\.config\.(js|cjs|mjs|ts|cts|mts)$/;
const ROOT_FILES = new Set(['package.json', 'create.json', 'wrangler.json', 'wrangler.jsonc', 'wrangler.toml', 'server.js', 'server.mjs', 'server.cjs', 'server.ts', 'index.html', 'prisma/schema.prisma']);
const MIDDLEWARE = /^(src\/)?(middleware|proxy)\.(js|mjs|ts|mts)$/;
const SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro)$/;
/** Build-time-only code: config, scripts, tests. Its filesystem writes and child processes are fine. */
const BUILD_TIME = /(^|\/)(scripts|test|tests|__tests__|e2e|cypress|playwright|\.storybook|stories|migrations|seed)(\/|$)|\.(test|spec|stories|config)\.[a-z]+$|^(postcss|tailwind|eslint|prettier|vitest|jest|playwright|babel|webpack|rollup|tsup|drizzle)\.config\./;

/** Per-file and total capture budgets: the detector never needs more than this to decide. */
export const DETECTOR_CAPTURE_LIMITS = { maxFileBytes: 256 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxSourceFiles: 2000 } as const;

/**
 * Security review H1: the detector runs synchronously on the API's event loop for every upload, so
 * its cost must be bounded whatever an upload holds. Every pattern below is linear (no adjacent
 * overlapping quantifiers; unbounded runs only before a literal they cannot match), only the first
 * `maxScanChars` of any file are read, and the whole scan stops at `budgetMs` — a folder the detector
 * could not finish in time builds as a server (`detection_timed_out`).
 */
export const DETECTOR_SCAN_LIMITS = { maxScanChars: 64 * 1024, budgetMs: 250 } as const;

export type DetectorContentKind = 'manifest' | 'source';

/**
 * Which file contents the detector reads: manifests and framework config at the root (always), and
 * application source files (best effort, within `DETECTOR_CAPTURE_LIMITS`). Null: not needed.
 */
export function detectorWantsContent(path: string): DetectorContentKind | null {
  const p = path.replace(/^\.\//, '');
  if (IGNORED_DIR.test(p)) return null;
  if (ROOT_FILES.has(p) || CONFIG_FILES.test(p) || MIDDLEWARE.test(p)) return 'manifest';
  if (SOURCE.test(p) && !p.endsWith('.d.ts')) return 'source';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/**
 * §7.6 native Node addons. Each would fail to bundle for a Worker, or bundle and crash on first use.
 * `sharp` is special for Next.js: OpenNext does not use it (the edge serves images unoptimized), so
 * there it is a note unless the app imports it itself.
 */
const NATIVE_DEPENDENCIES: Readonly<Record<string, string>> = {
  sharp: 'sharp (a native image library)',
  bcrypt: 'bcrypt (a native addon; bcryptjs works at the edge)',
  argon2: 'argon2 (a native addon)',
  canvas: 'canvas (a native addon)',
  '@napi-rs/canvas': '@napi-rs/canvas (a native addon)',
  'better-sqlite3': 'better-sqlite3 (a native SQLite binding)',
  sqlite3: 'sqlite3 (a native SQLite binding)',
  'node-pty': 'node-pty (a native addon)',
  re2: 're2 (a native addon)',
  puppeteer: 'puppeteer (drives a local Chromium)',
  playwright: 'playwright (drives local browsers)',
  'playwright-core': 'playwright-core (drives local browsers)',
  'ffmpeg-static': 'ffmpeg-static (a native binary)',
};

/** §7.6 long-lived servers and background work: need a process that keeps running. */
const LONG_RUNNING_DEPENDENCIES: Readonly<Record<string, string>> = {
  'socket.io': 'socket.io (a WebSocket server)',
  bullmq: 'BullMQ (background job workers)',
  bull: 'Bull (background job workers)',
  agenda: 'Agenda (background job scheduler)',
  'node-cron': 'node-cron (an in-process scheduler)',
  'node-schedule': 'node-schedule (an in-process scheduler)',
};

type SourceRule = { code: string; pattern: RegExp; message: (path: string) => string };

/** §7.6 Node APIs outside Workers' compatibility, found in application source (not build scripts). */
export const DETECTOR_SOURCE_RULES: readonly SourceRule[] = [
  {
    code: 'child_process',
    pattern: /(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?child_process['"]/,
    message: (p) => `${p} starts processes (child_process), which a Worker cannot do`,
  },
  {
    code: 'filesystem_write',
    pattern: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|renameSync|unlinkSync|rmSync)\s*\(/,
    message: (p) => `${p} writes to the local filesystem, which a Worker does not have`,
  },
  {
    code: 'websocket_server',
    // The argument list is bounded ({0,200}) and cannot overlap the `\)` that ends it: linear.
    pattern: /new\s+(?:WebSocketServer|WebSocket\.Server)\s*\(|\bcreateServer\s*\([^)]{0,200}\)\s*\.listen\s*\(|\.listen\s*\(\s*(?:process\.env\.PORT|\d{2,5})\b/,
    message: (p) => `${p} runs its own long-lived server (listen / WebSocket server), which needs a container`,
  },
  {
    code: 'native_addon_import',
    pattern: /(?:from\s+|require\(\s*)['"](?:sharp|bcrypt|argon2|canvas|better-sqlite3|sqlite3)['"]/,
    message: (p) => `${p} imports a native addon`,
  },
];

type Pkg = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: unknown;
};

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Drops `/* … *\/` and `// …` comments (not after `:` or `\\`, so URLs survive) from the first
 * `maxScanChars` of a file. A single forward pass with indexOf — linear however many unterminated
 * `/*` an upload holds (the regex it replaces was quadratic on exactly that).
 */
export function stripComments(text: string): string {
  const src = text.length > DETECTOR_SCAN_LIMITS.maxScanChars ? text.slice(0, DETECTOR_SCAN_LIMITS.maxScanChars) : text;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const slash = src.indexOf('/', i);
    if (slash === -1) {
      out += src.slice(i);
      break;
    }
    const next = src[slash + 1];
    if (next === '*') {
      out += src.slice(i, slash);
      const end = src.indexOf('*/', slash + 2);
      if (end === -1) break;
      i = end + 2;
    } else if (next === '/' && src[slash - 1] !== ':' && src[slash - 1] !== '\\') {
      out += src.slice(i, slash);
      const nl = src.indexOf('\n', slash + 2);
      if (nl === -1) break;
      i = nl;
    } else {
      out += src.slice(i, slash + 1);
      i = slash + 1;
    }
  }
  return out;
}

/** A minimal semver-range check: can this range resolve to a version at or above `min`? */
export function rangeCanReach(range: string, min: [number, number, number]): boolean | null {
  const r = range.trim();
  if (/^(latest|canary|next|rc|beta|\*|x)$/i.test(r) || r === '') return true;
  const m = /^(\^|~|>=|>|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(r);
  if (!m) return null;
  const op = m[1] ?? '=';
  const major = Number(m[2]);
  const minor = m[3] === undefined || m[3] === 'x' || m[3] === '*' ? null : Number(m[3]);
  const patch = m[4] === undefined || m[4] === 'x' || m[4] === '*' ? null : Number(m[4]);
  const cmp = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  // The highest version the range admits (∞ where it is open).
  const INF = Number.MAX_SAFE_INTEGER;
  let max: [number, number, number];
  if (op === '>=' || op === '>') max = [INF, INF, INF];
  else if (op === '^') max = major > 0 ? [major, INF, INF] : [0, minor ?? INF, INF];
  else if (op === '~') max = [major, minor ?? INF, INF];
  else max = [major, minor ?? INF, patch ?? INF];
  return cmp(max, min) >= 0;
}

function majorOf(range: string | null): number | null {
  if (!range) return null;
  const m = /(\d+)/.exec(range);
  return m ? Number(m[1]) : null;
}

const NEXT_MIN_15: [number, number, number] = [15, 5, 24];
const NEXT_MIN_16: [number, number, number] = [16, 3, 3];

/** OpenNext 1.20.6's peer range, "next >=15.5.24 <16 || >=16.3.3", against the declared range. */
function nextSupported(range: string): boolean | null {
  const major = majorOf(range);
  if (major === null) return rangeCanReach(range, NEXT_MIN_16);
  if (/^(latest|canary|rc)$/i.test(range.trim())) return true;
  if (major <= 14) return false;
  if (major === 15) return rangeCanReach(range, NEXT_MIN_15);
  if (major === 16) return rangeCanReach(range, NEXT_MIN_16);
  return true;
}

function packageManagerOf(paths: Set<string>): FrameworkDetection['packageManager'] {
  if (paths.has('pnpm-lock.yaml')) return 'pnpm';
  if (paths.has('yarn.lock')) return 'yarn';
  if (paths.has('bun.lock') || paths.has('bun.lockb')) return 'bun';
  if (paths.has('package-lock.json') || paths.has('npm-shrinkwrap.json')) return 'npm';
  return paths.has('package.json') ? 'npm' : null;
}

function firstConfig(paths: Set<string>, base: string): string | null {
  for (const ext of ['ts', 'mts', 'js', 'mjs', 'cjs', 'cts']) if (paths.has(`${base}.config.${ext}`)) return `${base}.config.${ext}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------------------------

export function detectFramework(input: FrameworkDetectorInput, options: { budgetMs?: number; now?: () => number } = {}): FrameworkDetection {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? DETECTOR_SCAN_LIMITS.budgetMs);
  const all = input.paths.map((p) => p.replace(/^\.\//, '')).filter((p) => p !== '');
  const paths = new Set(all);
  const reasons: FrameworkReason[] = [];
  const block = (code: string, message: string, path?: string) => reasons.push({ code, message, blocking: true, ...(path ? { path } : {}) });
  const note = (code: string, message: string, path?: string) => reasons.push({ code, message, blocking: false, ...(path ? { path } : {}) });
  const read = (p: string) => (paths.has(p) ? input.read(p) : null);

  const pkgText = read('package.json');
  const pkg = parseJson<Pkg>(pkgText);
  if (pkgText !== null && pkg === null) block('package_json_invalid', 'package.json is not valid JSON', 'package.json');
  const deps: Record<string, string> = { ...(pkg?.optionalDependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  const packageManager = packageManagerOf(paths);

  // create.json: the customer's own choice (§8.3 "edge vs server").
  const createJson = parseJson<{ target?: string; edge?: boolean }>(read('create.json'));
  let requested: AppsDeployTarget | null = null;
  if (createJson?.target === 'server' || createJson?.target === 'container' || createJson?.edge === false) requested = 'container';
  else if (createJson?.target === 'edge' || createJson?.edge === true) requested = 'edge';

  // ── which framework ─────────────────────────────────────────────────────────────────────────
  const found: { framework: AppsFramework; version: string | null }[] = [];
  const nextConfig = firstConfig(paths, 'next');
  if (has('next') || nextConfig) found.push({ framework: 'nextjs', version: deps.next ?? null });
  const nuxtConfig = firstConfig(paths, 'nuxt');
  if (has('nuxt') || nuxtConfig) found.push({ framework: 'nuxt', version: deps.nuxt ?? null });
  const svelteConfig = firstConfig(paths, 'svelte');
  if (has('@sveltejs/kit')) found.push({ framework: 'sveltekit', version: deps['@sveltejs/kit'] ?? null });
  const astroConfig = firstConfig(paths, 'astro');
  if (has('astro') || astroConfig) found.push({ framework: 'astro', version: deps.astro ?? null });
  const rrConfig = firstConfig(paths, 'react-router');
  if (has('@react-router/dev') || rrConfig) found.push({ framework: 'react-router', version: deps['@react-router/dev'] ?? deps['react-router'] ?? null });
  const remixConfig = firstConfig(paths, 'remix');
  if (!found.some((f) => f.framework === 'react-router') && (Object.keys(deps).some((d) => d.startsWith('@remix-run/')) || remixConfig)) {
    found.push({ framework: 'remix', version: deps['@remix-run/react'] ?? deps['@remix-run/dev'] ?? null });
  }

  const base = (framework: AppsFramework, version: string | null): FrameworkDetection => ({
    version: APPS_FRAMEWORK_DETECTOR_VERSION,
    framework,
    frameworkVersion: version,
    target: 'container',
    reason: '',
    reasons,
    adapter: null,
    packageManager,
    outputDir: null,
    spa: false,
    isr: false,
    requested,
  });

  // A monorepo root or a folder with several frameworks is not one frontend: the container tier
  // (Railpack) plans those as a whole, the edge path would have to guess.
  if (found.length > 1) {
    block('mixed_frameworks', `The folder uses more than one framework (${found.map((f) => FRAMEWORK_LABELS[f.framework]).join(', ')}); deploy each app from its own folder to run it at the edge`);
  }
  if (pkg && pkg.workspaces !== undefined) block('monorepo_root', 'package.json declares workspaces: this is a monorepo root; deploy the app’s own folder to run it at the edge', 'package.json');
  if (paths.has('pnpm-workspace.yaml')) block('monorepo_root', 'pnpm-workspace.yaml marks a monorepo root; deploy the app’s own folder to run it at the edge', 'pnpm-workspace.yaml');

  let detection: FrameworkDetection;
  const primary = found[0];
  if (!primary) {
    detection = detectStatic(base, paths, pkg, deps, has, note, block);
  } else {
    detection = base(primary.framework, primary.version);
    switch (primary.framework) {
      case 'nextjs':
        applyNext(detection, { read, has, deps, paths, pkg, nextConfig, note, block });
        break;
      case 'astro':
        applyAstro(detection, { read, has, astroConfig, note, block });
        break;
      case 'sveltekit':
        applySvelteKit(detection, { read, has, svelteConfig, note, block });
        break;
      case 'react-router':
      case 'remix':
        applyReactRouter(detection, { read, has, rrConfig, note, block });
        break;
      case 'nuxt':
        applyNuxt(detection, { read, deps, nuxtConfig, note, block });
        break;
      default:
        break;
    }
  }

  // ── §7.6 rules common to every edge candidate ───────────────────────────────────────────────
  // Only a Worker runs the app's code at request time; static output ran its code at build time.
  if (detection.adapter?.mode === 'worker') {
    for (const [dep, label] of Object.entries(NATIVE_DEPENDENCIES)) {
      if (!has(dep)) continue;
      if (dep === 'sharp' && detection.framework === 'nextjs') {
        note('sharp_unused_at_edge', 'sharp is not used at the edge: next/image serves images unoptimized there', 'package.json');
        continue;
      }
      block('native_dependency', `package.json depends on ${label}, which cannot run in a Worker`, 'package.json');
    }
    if (has('@prisma/client') && !Object.keys(deps).some((d) => d.startsWith('@prisma/adapter-'))) {
      block('prisma_engine', 'Prisma without a driver adapter uses its native query engine, which cannot run in a Worker (add @prisma/adapter-d1 / -neon / -pg for the edge)', 'package.json');
    }
    for (const [dep, label] of Object.entries(LONG_RUNNING_DEPENDENCIES)) {
      if (has(dep)) block('long_running', `package.json depends on ${label}, which needs a process that keeps running`, 'package.json');
    }
    for (const p of all) {
      if (IGNORED_DIR.test(p)) continue;
      if (p.endsWith('.node')) {
        block('native_addon_file', `${p} is a compiled native Node addon`, p);
        break;
      }
    }
    let scanned = 0;
    const seen = new Set<string>();
    for (const p of all) {
      if (scanned >= DETECTOR_CAPTURE_LIMITS.maxSourceFiles) break;
      if (now() > deadline) {
        block('detection_timed_out', 'The source could not be inspected in time; it builds as a server (deploy with target "edge" to override)');
        break;
      }
      if (detectorWantsContent(p) !== 'source' || BUILD_TIME.test(p) || CONFIG_FILES.test(p)) continue;
      const text = input.read(p);
      if (text === null) continue;
      scanned += 1;
      const clean = stripComments(text);
      for (const rule of DETECTOR_SOURCE_RULES) {
        if (seen.has(rule.code) || !rule.pattern.test(clean)) continue;
        seen.add(rule.code);
        block(rule.code, rule.message(p), p);
      }
    }
  }

  if (requested === 'container') block('customer_chose_server', 'create.json chooses the server (container) tier', 'create.json');
  return finish(detection);
}

type Ctx = {
  read: (p: string) => string | null;
  note: (code: string, message: string, path?: string) => void;
  block: (code: string, message: string, path?: string) => void;
};

function applyNext(d: FrameworkDetection, c: Ctx & { has: (n: string) => boolean; deps: Record<string, string>; paths: Set<string>; pkg: Pkg | null; nextConfig: string | null }): void {
  const config = c.nextConfig ? c.read(c.nextConfig) : null;
  const clean = config ? stripComments(config) : '';
  if (d.frameworkVersion && nextSupported(d.frameworkVersion) === false) {
    c.block('framework_version', `Next.js ${d.frameworkVersion} is older than the edge adapter supports (OpenNext needs 15.5.24+ or 16.3.3+); upgrade Next.js to run at the edge`, 'package.json');
  }
  for (const f of ['server.js', 'server.mjs', 'server.cjs', 'server.ts']) {
    const text = c.read(f);
    if (text !== null && /(?:require\(\s*['"]next['"]\s*\)|from\s+['"]next['"]|\bnext\s*\(\s*\{)/.test(text)) {
      c.block('custom_server', `${f} is a custom Next.js server; a custom server needs a container`, f);
      break;
    }
  }
  const start = c.pkg?.scripts?.start ?? '';
  if (start && !/\bnext\s+start\b/.test(start) && /\bnode\b|\btsx\b|\bts-node\b/.test(start)) {
    c.block('custom_server', `The start script ("${start}") runs a custom server instead of next start`, 'package.json');
  }
  for (const f of ['middleware.ts', 'middleware.js', 'middleware.mjs', 'middleware.mts', 'src/middleware.ts', 'src/middleware.js', 'src/middleware.mjs', 'src/middleware.mts']) {
    const text = c.read(f);
    if (text !== null && /runtime\s*:\s*['"]nodejs['"]/.test(text)) {
      c.block('next_node_middleware', `${f} runs on the Node.js runtime; OpenNext does not support Node.js middleware yet`, f);
    }
  }
  for (const f of ['proxy.ts', 'proxy.js', 'proxy.mjs', 'proxy.mts', 'src/proxy.ts', 'src/proxy.js', 'src/proxy.mjs', 'src/proxy.mts']) {
    if (c.paths.has(f)) {
      c.block('next_node_middleware', `${f} is Next.js proxy, which runs on the Node.js runtime; OpenNext does not support Node.js middleware yet`, f);
      break;
    }
  }
  if (/output\s*:\s*['"]export['"]/.test(clean)) {
    d.adapter = { name: 'static', package: null, version: null, mode: 'static' };
    d.outputDir = 'out';
    c.note('static_export', 'next.config sets output: "export" — a static site, served from static files only', c.nextConfig ?? undefined);
    return;
  }
  if (/output\s*:\s*['"]standalone['"]/.test(clean)) c.note('standalone_output', 'next.config sets output: "standalone"; the edge build ignores it', c.nextConfig ?? undefined);
  d.adapter = { name: 'opennext', package: '@opennextjs/cloudflare', version: c.deps['@opennextjs/cloudflare'] ?? EDGE_ADAPTER_PINS.opennext, mode: 'worker' };
  d.isr = true;
}

function applyAstro(d: FrameworkDetection, c: Ctx & { has: (n: string) => boolean; astroConfig: string | null }): void {
  const config = c.astroConfig ? stripComments(c.read(c.astroConfig) ?? '') : '';
  if (c.has('@astrojs/cloudflare')) {
    d.adapter = { name: 'astro-cloudflare', package: '@astrojs/cloudflare', version: null, mode: 'worker' };
    return;
  }
  for (const other of ['@astrojs/node', '@astrojs/vercel', '@astrojs/netlify', '@deno/astro-adapter']) {
    if (c.has(other)) {
      c.block('node_adapter', `Astro is configured with ${other}, a server adapter for another platform; add @astrojs/cloudflare to run it at the edge`, 'package.json');
      return;
    }
  }
  if (/output\s*:\s*['"](server|hybrid)['"]/.test(config)) {
    c.block('server_output_without_adapter', `${c.astroConfig} renders on a server but names no adapter; add @astrojs/cloudflare to run it at the edge`, c.astroConfig ?? undefined);
    return;
  }
  d.adapter = { name: 'static', package: null, version: null, mode: 'static' };
  d.outputDir = 'dist';
}

function applySvelteKit(d: FrameworkDetection, c: Ctx & { has: (n: string) => boolean; svelteConfig: string | null }): void {
  const config = c.svelteConfig ? stripComments(c.read(c.svelteConfig) ?? '') : '';
  const uses = (pkg: string) => c.has(pkg) || config.includes(`'${pkg}'`) || config.includes(`"${pkg}"`);
  if (uses('@sveltejs/adapter-cloudflare')) {
    d.adapter = { name: 'sveltekit-cloudflare', package: '@sveltejs/adapter-cloudflare', version: null, mode: 'worker' };
    return;
  }
  if (uses('@sveltejs/adapter-static')) {
    d.adapter = { name: 'static', package: null, version: null, mode: 'static' };
    d.outputDir = 'build';
    return;
  }
  if (uses('@sveltejs/adapter-auto') || !c.svelteConfig) {
    // adapter-auto picks adapter-cloudflare on Cloudflare's build environment; the build pod sets it up.
    d.adapter = { name: 'sveltekit-cloudflare', package: '@sveltejs/adapter-cloudflare', version: EDGE_ADAPTER_PINS.sveltekitCloudflare, mode: 'worker' };
    c.note('adapter_auto', 'svelte.config uses adapter-auto; the edge build uses @sveltejs/adapter-cloudflare', c.svelteConfig ?? undefined);
    return;
  }
  const other = /@sveltejs\/adapter-[a-z-]+/.exec(config)?.[0] ?? 'another adapter';
  c.block('node_adapter', `svelte.config uses ${other}; switch to @sveltejs/adapter-cloudflare (or adapter-auto) to run it at the edge`, c.svelteConfig);
}

function applyReactRouter(d: FrameworkDetection, c: Ctx & { has: (n: string) => boolean; rrConfig: string | null }): void {
  const config = c.rrConfig ? stripComments(c.read(c.rrConfig) ?? '') : '';
  if (/ssr\s*:\s*false/.test(config)) {
    d.adapter = { name: 'static', package: null, version: null, mode: 'static' };
    d.outputDir = 'build/client';
    d.spa = true;
    c.note('spa_mode', `${c.rrConfig} sets ssr: false — a single-page app served from static files`, c.rrConfig ?? undefined);
    return;
  }
  if (c.has('@cloudflare/vite-plugin') || c.has('@react-router/cloudflare') || c.has('@remix-run/cloudflare') || c.has('@remix-run/cloudflare-workers')) {
    d.adapter = { name: 'cloudflare-vite', package: c.has('@cloudflare/vite-plugin') ? '@cloudflare/vite-plugin' : null, version: null, mode: 'worker' };
    return;
  }
  const server = ['@react-router/node', '@react-router/serve', '@react-router/express', '@remix-run/node', '@remix-run/serve', '@remix-run/express'].find((p) => c.has(p));
  c.block('node_adapter', `The app is set up for a Node.js server${server ? ` (${server})` : ''}; start from the Cloudflare template (@cloudflare/vite-plugin) to run it at the edge`, 'package.json');
}

function applyNuxt(d: FrameworkDetection, c: Ctx & { deps: Record<string, string>; nuxtConfig: string | null }): void {
  const major = majorOf(d.frameworkVersion);
  if (major !== null && major < 3) {
    c.block('framework_version', `Nuxt ${d.frameworkVersion} predates Nitro; Nuxt 3+ runs at the edge`, 'package.json');
    return;
  }
  const config = c.nuxtConfig ? stripComments(c.read(c.nuxtConfig) ?? '') : '';
  const preset = /preset\s*:\s*['"]([a-z0-9_-]+)['"]/.exec(config)?.[1];
  if (preset && !/^cloudflare/.test(preset)) {
    c.block('node_adapter', `${c.nuxtConfig} sets the Nitro preset "${preset}"; remove it (or use cloudflare_module) to run it at the edge`, c.nuxtConfig ?? undefined);
    return;
  }
  d.adapter = { name: 'nitro-cloudflare', package: null, version: null, mode: 'worker' };
}

function detectStatic(
  base: (framework: AppsFramework, version: string | null) => FrameworkDetection,
  paths: Set<string>,
  pkg: Pkg | null,
  deps: Record<string, string>,
  has: (n: string) => boolean,
  note: Ctx['note'],
  block: Ctx['block'],
): FrameworkDetection {
  const serverDeps = ['express', 'fastify', 'koa', 'hono', '@hapi/hapi', '@nestjs/core', 'restify', 'polka', 'socket.io', 'ws'];
  const server = serverDeps.find(has);
  const start = pkg?.scripts?.start ?? '';
  const build = pkg?.scripts?.build ?? '';
  if (server || (/\bnode\b|\btsx\b|\bts-node\b/.test(start) && !/\b(serve|http-server|vite preview)\b/.test(start))) {
    const d = base('unknown', null);
    block('server_app', server ? `package.json depends on ${server}: this is a server app` : `The start script ("${start}") runs a Node.js server`, 'package.json');
    return d;
  }
  const hasIndex = paths.has('index.html') || paths.has('public/index.html');
  const vite = has('vite');
  const cra = has('react-scripts');
  if (vite || cra || (build && hasIndex) || (!pkg && hasIndex)) {
    const d = base('static', vite ? (deps.vite ?? null) : cra ? (deps['react-scripts'] ?? null) : null);
    d.adapter = { name: 'static', package: null, version: null, mode: 'static' };
    d.outputDir = !pkg ? '.' : cra ? 'build' : vite ? 'dist' : null;
    d.spa = vite || cra;
    if (!pkg) note('plain_files', 'No package.json: the files are served as they are');
    return d;
  }
  if (pkg && Object.keys(deps).length === 0 && !build && hasIndex) {
    const d = base('static', null);
    d.adapter = { name: 'static', package: null, version: null, mode: 'static' };
    d.outputDir = '.';
    return d;
  }
  const d = base('unknown', null);
  block('no_frontend_framework', pkg ? 'No frontend framework or static site was found; it builds as a server' : 'No package.json or index.html was found; it builds as a server');
  return d;
}

function finish(d: FrameworkDetection): FrameworkDetection {
  const blocking = d.reasons.filter((r) => r.blocking);
  const label = FRAMEWORK_LABELS[d.framework];
  const version = d.frameworkVersion ? ` ${d.frameworkVersion}` : '';
  if (blocking.length > 0 || !d.adapter) {
    d.target = 'container';
    d.adapter = null;
    d.isr = false;
    const first = blocking[0]?.message ?? 'No edge adapter applies';
    d.reason = `${d.framework === 'unknown' ? 'Not an edge frontend' : `${label}${version}`} → server (container): ${first}${blocking.length > 1 ? ` (and ${blocking.length - 1} more reason${blocking.length > 2 ? 's' : ''})` : ''}.`;
    return d;
  }
  d.target = 'edge';
  const how =
    d.adapter.mode === 'static'
      ? 'static files on the edge network'
      : `a Worker on the edge network (${d.adapter.package ?? (d.adapter.name === 'nitro-cloudflare' ? 'Nitro cloudflare_module preset' : d.adapter.name)})`;
  d.reason = `${label}${version} → edge: builds to ${how}${d.isr ? ', with its incremental cache in the frontend’s own R2 bucket and D1 tag cache' : ''}.`;
  return d;
}

/**
 * The deploy decision for a request: the detector's target, or the caller's explicit override.
 * Forcing edge onto an app with no edge adapter at all is refused (there is nothing to build);
 * forcing it past a §7.6 finding is allowed — the finding may be a false positive — and the
 * findings travel with the deploy as warnings.
 */
export function decideTarget(detection: FrameworkDetection | null, choice: AppsTargetChoice): { target: AppsDeployTarget; overridden: boolean; refused: string | null } {
  if (choice === 'container') return { target: 'container', overridden: detection?.target === 'edge', refused: null };
  if (choice === 'edge') {
    if (!detection || detection.framework === 'unknown') return { target: 'container', overridden: false, refused: 'No frontend framework was detected, so there is nothing to build for the edge' };
    return { target: 'edge', overridden: detection.target !== 'edge', refused: null };
  }
  return { target: detection?.target ?? 'container', overridden: false, refused: null };
}

/**
 * The adapter a forced edge build uses when the detector had sent the app to a container: the one
 * its framework would have used, from the detector's own table.
 */
export function forcedEdgeAdapter(framework: AppsFramework): EdgeAdapter | null {
  switch (framework) {
    case 'nextjs':
      return { name: 'opennext', package: '@opennextjs/cloudflare', version: EDGE_ADAPTER_PINS.opennext, mode: 'worker' };
    case 'astro':
      return { name: 'astro-cloudflare', package: '@astrojs/cloudflare', version: null, mode: 'worker' };
    case 'sveltekit':
      return { name: 'sveltekit-cloudflare', package: '@sveltejs/adapter-cloudflare', version: EDGE_ADAPTER_PINS.sveltekitCloudflare, mode: 'worker' };
    case 'react-router':
    case 'remix':
      return { name: 'cloudflare-vite', package: '@cloudflare/vite-plugin', version: null, mode: 'worker' };
    case 'nuxt':
      return { name: 'nitro-cloudflare', package: null, version: null, mode: 'worker' };
    case 'static':
      return { name: 'static', package: null, version: null, mode: 'static' };
    default:
      return null;
  }
}
