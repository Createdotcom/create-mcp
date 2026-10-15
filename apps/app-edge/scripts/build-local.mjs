#!/usr/bin/env node
// Build a framework app (Next.js via OpenNext, Astro, SvelteKit, …) into a Create edge bundle ON THIS
// MACHINE (or a GitHub Actions runner), for `create deploy` to upload as a PRE-BUILT bundle — the edge
// path that needs no app cluster. Staging has no build pods yet (edge builds from source run in the
// cluster's build pods, runbook apps-edge.md §6), so this is how a framework site ships there.
//
// It runs the SAME build the build pod runs — infra/app-cluster/builds/image/edge/edge-build.mjs, the
// same pins (EDGE_ADAPTER_PINS) and the plan the control plane would derive from the same detector
// (packages/shared/src/apps-frameworks.ts) — over a COPY of the project (the build adds the pinned
// adapter to package.json and may write open-next.config.ts / wrangler.jsonc; your folder is never
// touched). The bundle is then unpacked into --out, a folder with create-edge.json at its root, which
// `create deploy --dir <out>` uploads as is. The control plane re-validates every bundle (parseEdgeBundle,
// size limits, quotas), so a locally built bundle gets no more trust than one from a build pod.
//
// Nothing here talks to Create or Cloudflare or needs a credential. Build-time variables (e.g.
// NEXT_PUBLIC_*) come from YOUR environment, exactly as `next build` would read them — and are baked into
// the bundle, so never export a secret you would not ship to browsers before running it.
//
// Usage (Node 22.18+; from the Create repository):
//   node apps/app-edge/scripts/build-local.mjs --dir ~/code/my-site --out ~/create-bundles/my-site
//   create deploy --dir ~/create-bundles/my-site --project my-site
// Re-running with the same --out rebuilds in place and keeps the folder's link to the project (.create/).
// Flags: --edge (build for the edge even when the detector would choose a container), --keep (keep the
// work copy for debugging), --env NAME (pass one more variable from this shell to the build; repeatable).
//
// THE INSTALL RUNS THIRD-PARTY CODE ON THIS MACHINE (package lifecycle scripts, the app's build config).
// The build sees only an allowlisted environment (`buildEnv`) and a copy without secret files
// (`isSecretFile`), but it runs as you, with your files: prefer a throwaway VM/container or a GitHub
// Actions runner for anything but your own trusted project.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// Plain TypeScript with no imports of its own: Node 22.18+ strips its types natively.
import { DETECTOR_SCAN_LIMITS, EDGE_ADAPTER_PINS, detectFramework, detectorWantsContent, forcedEdgeAdapter } from '../../../packages/shared/src/apps-frameworks.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// Bundled into the published CLI (@create.com/cli dist/build-local.mjs), the build pod's scripts are
// copied next to it (dist/edge/); in the Create repository they are the infra/ originals.
const PACKAGED_EDGE_BUILD_SCRIPT = resolve(HERE, 'edge/edge-build.mjs');
export const EDGE_BUILD_SCRIPT = existsSync(PACKAGED_EDGE_BUILD_SCRIPT) ? PACKAGED_EDGE_BUILD_SCRIPT : resolve(HERE, '../../../infra/app-cluster/builds/image/edge/edge-build.mjs');
/** EDGE_DEFAULT_LIMITS.maxScriptBytes (packages/shared/src/apps-edge.ts): 64 MiB uncompressed. */
export const MAX_SCRIPT_BYTES = 64 * 1024 * 1024;

/** Never scanned and never copied into the work folder: dependencies, build output, VCS, caches. */
const SKIP = new Set(['node_modules', '.git', '.next', '.open-next', '.wrangler', '.create-edge', '.vercel', '.netlify', '.turbo', '.cache', '.svelte-kit', '.nuxt', '.output', '.astro']);
/**
 * Never copied into the work folder: local secret files — `.env*` (Next.js would bake them into the
 * bundle), wrangler's `.dev.vars*`, and private keys/certificates (`*.pem`, `*.key`, `*.p12`, `*.pfx`).
 */
export function isSecretFile(name) {
  if (name === '.env.example') return false;
  return /^\.env(\..*)?$/.test(name) || /^\.dev\.vars(\..*)?$/.test(name) || /\.(pem|key|p12|pfx)$/i.test(name);
}

/**
 * The environment the install and the build see — an ALLOWLIST, not this shell's environment. The
 * install runs third-party lifecycle scripts (`postinstall` …) and the build runs the app's own config
 * code, so neither may read the cloud keys, tokens or SSH agent of the shell that started it.
 *   - PATH, HOME, USER, LOGNAME, SHELL, TMPDIR/TMP/TEMP, LANG/LC_*, TZ, TERM — a working process;
 *   - NODE_* (NODE_OPTIONS, NODE_EXTRA_CA_CERTS …), COREPACK_*, npm_config_* / NPM_CONFIG_*,
 *     YARN_*, PNPM_* — the package managers (a private registry token, if the app needs one, travels
 *     as npm_config_//registry…:_authToken, which is the one credential this lets through on purpose);
 *   - CI — some builds change behaviour on it;
 *   - NEXT_PUBLIC_*, PUBLIC_*, VITE_* — build-time values that end up in browsers anyway;
 *   - HTTP_PROXY/HTTPS_PROXY/NO_PROXY (either case) — corporate networks.
 * Anything else a build genuinely needs is passed with --env NAME (repeatable), by name, deliberately.
 */
export function buildEnv(source, extra = []) {
  const exact = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'TERM', 'CI', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SystemRoot', 'ComSpec', 'APPDATA', 'LOCALAPPDATA', ...extra]);
  const prefixes = ['LC_', 'NODE_', 'COREPACK_', 'npm_config_', 'NPM_CONFIG_', 'YARN_', 'PNPM_', 'NEXT_PUBLIC_', 'PUBLIC_', 'VITE_'];
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (exact.has(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
const MAX_FILES = 20_000;

/** Every file path under `root` (relative, `/` separators), skipping SKIP directories. */
export function listFiles(root) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      // lstat: a symbolic link is never followed (it could point anywhere on the machine) and never copied.
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP.has(name)) walk(full);
      } else if (st.isFile()) {
        out.push(relative(root, full).split(sep).join('/'));
        if (out.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files under ${root}; is this the project folder?`);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** The detector's verdict over a folder on disk — the same function the control plane runs over an upload. */
export function detectLocal(root, include = null) {
  const paths = include ? [...include].sort() : listFiles(root);
  const read = (p) => {
    if (!detectorWantsContent(p)) return null;
    try {
      return readFileSync(join(root, p), 'utf8').slice(0, DETECTOR_SCAN_LIMITS.maxScanChars);
    } catch {
      return null;
    }
  };
  // A generous budget: this runs on the developer's machine, not the API's event loop.
  return detectFramework({ paths, read }, { budgetMs: 10_000 });
}

/**
 * The CREATE_EDGE_PLAN edge-build.mjs reads — what apps/api/src/apps-hosting/edge/builds.ts `edgePlanFor`
 * derives for a build pod. `forceEdge` mirrors `create deploy --edge` (decideTarget's override).
 */
export function localEdgePlan(detection, { forceEdge = false } = {}) {
  if (detection.target !== 'edge' && !forceEdge) {
    const why = detection.reasons.map((r) => `  - ${r.code}: ${r.message}`).join('\n');
    throw Object.assign(new Error(`Create would run this app as a server, not at the edge: ${detection.reason}\n${why}\nFix what is listed, or pass --edge to build for the edge anyway.`), { code: 'not_edge' });
  }
  const adapter = detection.adapter ?? forcedEdgeAdapter(detection.framework);
  if (!adapter) throw Object.assign(new Error(`There is no edge adapter for ${detection.framework}`), { code: 'edge_not_supported' });
  return {
    framework: detection.framework,
    adapter,
    packageManager: detection.packageManager ?? 'npm',
    outputDir: detection.outputDir ?? null,
    spa: detection.spa ?? false,
    maxScriptBytes: MAX_SCRIPT_BYTES,
    pins: EDGE_ADAPTER_PINS,
  };
}

function parseArgs(argv) {
  const args = { dir: process.cwd(), out: null, edge: false, keep: false, env: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--edge') args.edge = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--env') {
      const name = argv[++i] ?? '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('--env takes a variable NAME (its value comes from this shell)');
      args.env.push(name);
    }
    else throw new Error(`unknown argument ${a} (usage: build-local.mjs --dir <project> --out <folder> [--edge] [--keep] [--env NAME …])`);
  }
  if (!args.out) throw new Error('--out <folder> is required: the unpacked bundle goes there');
  return { ...args, dir: resolve(args.dir), out: resolve(args.out) };
}

/**
 * --out is either new/empty, or a folder this script filled before (create-edge.json at its root): the
 * old bundle is removed and `.create/` — the CLI's link to the Create project, written by the first
 * `create deploy` there and never uploaded — is KEPT, so every rebuild deploys to the same project.
 * Anything else is refused rather than emptied.
 */
export function prepareOut(out) {
  if (!existsSync(out)) return false;
  const entries = readdirSync(out);
  if (entries.length === 0 || (entries.length === 1 && entries[0] === '.create')) return false;
  if (!entries.includes('create-edge.json')) throw new Error(`${out} is not empty and is not an earlier edge bundle; pass a new folder`);
  for (const name of entries) if (name !== '.create') rmSync(join(out, name), { recursive: true, force: true });
  return true;
}

/**
 * The local edge build as a function — `create deploy` / `create mcp` (packages/cli/src/edge-build.ts)
 * call it with a temp `out`, the script's `main` with --out. Asynchronous (the build runs in a child
 * process) so a stdio MCP server keeps reading its input while a build runs. Every line the build prints
 * goes to `onOutput` (never this process's stdout: under `create mcp` that is the protocol channel);
 * the last lines are kept for the error message, which quotes the `::create-edge-error::` line.
 *
 *
 * `include` (the CLI passes the files `create deploy` would upload: .gitignore/.createignore honoured,
 * credential files and symbolic links left out) limits the copy to those files; without it the folder
 * is copied minus SKIP, secret files and symbolic links. The build runs with HOME pointed at an empty
 * folder inside the work copy (`isolateHome`, default true) so `~/.ssh`, `~/.config/create`, `~/.npmrc`
 * are not where a build script looks first — a mitigation, not a sandbox: the build still runs as you.
 * npm's cache goes to `npmCache` (default ~/.cache/create-edge-build/npm, kept between builds).
 * `signal` aborts the build: the whole process group is killed.
 *
 * @param {{ dir: string, out: string, forceEdge?: boolean, env?: string[], keep?: boolean,
 *   sourceEnv?: Record<string, string | undefined>, log?: (line: string) => void,
 *   onOutput?: (chunk: string) => void, include?: string[] | null, isolateHome?: boolean,
 *   npmCache?: string, signal?: AbortSignal }} options
 */
/** Build process groups still running: killed if this process exits first (the MCP client went away). */
const LIVE_BUILDS = new Set();
let exitHook = false;
function killLiveBuilds() {
  for (const pid of LIVE_BUILDS) {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
      else process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  LIVE_BUILDS.clear();
}

export async function buildEdgeBundle(options) {
  const dir = resolve(options.dir);
  const out = resolve(options.out);
  const log = options.log ?? ((line) => console.log(line));
  const onOutput = options.onOutput ?? ((chunk) => process.stdout.write(chunk));
  if (!existsSync(join(dir, 'package.json'))) throw Object.assign(new Error(`${dir} has no package.json`), { code: 'not_a_project' });
  if (out === dir || out.startsWith(`${dir}${sep}`)) throw new Error('--out must be outside the project folder');
  const previous = prepareOut(out);

  const detection = detectLocal(dir, options.include ?? null);
  log(`detector: ${detection.reason}`);
  const plan = localEdgePlan(detection, { forceEdge: options.forceEdge === true });
  log(`plan: ${plan.framework} via ${plan.adapter.name} (${plan.adapter.package ?? 'no package'}), ${plan.packageManager}`);

  const work = mkdtempSync(join(tmpdir(), 'create-edge-local-'));
  const src = join(work, 'app');
  const bundleOut = join(work, 'out');
  try {
    if (options.include) {
      for (const rel of options.include) {
        const parts = rel.split('/');
        if (parts.some((p) => p === '..' || p === '' || SKIP.has(p)) || isSecretFile(parts[parts.length - 1])) continue;
        const from = join(dir, ...parts);
        const st = lstatSync(from, { throwIfNoEntry: false });
        if (!st || !st.isFile()) continue; // symbolic links and special files are never copied
        mkdirSync(dirname(join(src, ...parts)), { recursive: true });
        copyFileSync(from, join(src, ...parts));
      }
    } else {
      cpSync(dir, src, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (from) => {
          const name = from.split(sep).pop() ?? '';
          if (from === dir) return true;
          if (lstatSync(from, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
          if (SKIP.has(name)) return false;
          if (isSecretFile(name)) return false;
          return true;
        },
      });
    }
    mkdirSync(bundleOut, { recursive: true });
    const isolate = options.isolateHome !== false;
    const home = join(work, 'home');
    if (isolate) mkdirSync(home, { recursive: true });
    const env = buildEnv(options.sourceEnv ?? process.env, options.env ?? []);
    if (isolate) {
      env.HOME = home;
      env.USERPROFILE = home;
      if (!env.npm_config_cache && !env.NPM_CONFIG_CACHE) env.npm_config_cache = options.npmCache ?? join(homedir(), '.cache', 'create-edge-build', 'npm');
    }
    if (options.signal?.aborted) throw Object.assign(new Error('the build was cancelled'), { code: 'cancelled' });
    const tail = [];
    const status = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [EDGE_BUILD_SCRIPT], {
        cwd: src,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a cancel kills npm, next and wrangler too, not only this child.
        detached: process.platform !== 'win32',
        env: { ...env, CREATE_EDGE_PLAN: JSON.stringify(plan), CREATE_EDGE_OUT: bundleOut, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' },
      });
      const kill = () => {
        const signal = (sig) => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
            else child.kill(sig);
          } catch {
            // already gone
          }
        };
        signal('SIGTERM');
        setTimeout(() => signal('SIGKILL'), 5000).unref();
      };
      options.signal?.addEventListener('abort', kill, { once: true });
      if (child.pid) LIVE_BUILDS.add(child.pid);
      if (!exitHook) {
        exitHook = true;
        process.once('exit', killLiveBuilds);
      }
      const take = (chunk) => {
        const text = String(chunk);
        onOutput(text);
        for (const line of text.split('\n')) if (line.trim()) tail.push(line.trimEnd());
        if (tail.length > 40) tail.splice(0, tail.length - 40);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', reject);
      child.on('close', (code) => {
        if (child.pid) LIVE_BUILDS.delete(child.pid);
        options.signal?.removeEventListener('abort', kill);
        resolveExit(code);
      });
    });
    if (options.signal?.aborted) throw Object.assign(new Error('the build was cancelled'), { code: 'cancelled' });
    if (status !== 0) {
      const marker = [...tail].reverse().find((l) => l.includes('::create-edge-error::'));
      const before = tail.filter((l) => !l.includes('::create-edge-error::') && !/^\s+at /.test(l)).slice(-12);
      throw Object.assign(new Error(`the edge build failed (exit ${status})${marker ? `: ${marker.replace(/^.*::create-edge-error::\s*/, '')}` : ''}; its last lines:\n${before.join('\n')}`), { code: 'edge_build_failed', tail });
    }
    mkdirSync(out, { recursive: true });
    const x = spawnSync('tar', ['-xzf', join(bundleOut, 'bundle.tar.gz'), '-C', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (x.status !== 0) throw new Error('could not unpack bundle.tar.gz');
    if (!existsSync(join(out, 'create-edge.json'))) throw new Error('the unpacked bundle has no create-edge.json');
  } finally {
    if (options.keep) log(`work copy kept at ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  return { out, previous, plan, detection };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { previous } = await buildEdgeBundle({ dir: args.dir, out: args.out, forceEdge: args.edge, env: args.env, keep: args.keep });
  console.log(`\nEdge bundle ${previous ? 'rebuilt' : 'ready'} in ${args.out}. Deploy it with:\n  create deploy --dir ${args.out}${existsSync(join(args.out, '.create', 'project.json')) ? '' : ' --project <project>'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
