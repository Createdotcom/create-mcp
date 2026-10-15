// The Create edge packager (app hosting spec §7.4, slice E2). Runs INSIDE an edge build — in the pinned
// Node stage of the build pod's rootless BuildKit — after a framework's Cloudflare adapter has built
// the app. It turns the adapter's output into the Create edge bundle the control plane deploys
// (`create-edge.json` + `worker/*` + `public/*` [+ `cache/*`], see apps/api/src/apps-hosting/edge/bundle.ts):
//
//   1. locate the output — the Worker entry and the static-assets folder — for the adapter that ran
//      (`resolveOutput`), preferring the wrangler config the Cloudflare Vite plugin / Nitro redirect to
//      (`.wrangler/deploy/config.json`), else each adapter's documented output paths;
//   2. bundle the Worker into ES modules with `wrangler deploy --dry-run --outdir` (`bundleCommand`);
//   3. pack the bundle (`packBundle`): the modules, the static files, and for Next.js the prerendered
//      incremental-cache entries keyed exactly as OpenNext's R2 cache reads them, plus the small entry
//      wrapper Create needs for OpenNext on Workers for Platforms (`nextEntryWrapper`).
//
// Dependency-free on purpose (node: builtins only): it is copied into the build as it is, and the
// tests in apps/app-edge/tests import this same file.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const EDGE_MANIFEST_FILE = 'create-edge.json';
export const DEFAULT_COMPAT_DATE = '2026-09-01';
/** OpenNext's binding names (@opennextjs/cloudflare 1.20.6) and the cache key shape its R2 cache reads. */
export const NEXT_BINDINGS = { incrementalCache: 'NEXT_INC_CACHE_R2_BUCKET', tagCache: 'NEXT_TAG_CACHE_D1' };
export const NEXT_CACHE_KEY = /^incremental-cache\/[A-Za-z0-9_.-]{1,128}\/[0-9a-f]{64}\.(cache|fetch)$/;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** A failure an agent can act on: `code` is stable (the control plane's build summary keys on it). */
export class EdgeBuildError extends Error {
  constructor(code, message, fix) {
    super(message);
    this.code = code;
    this.fix = fix ?? null;
  }
}

const SERVER_FIX = 'Deploy it as a server instead (target "container"): every framework here also runs in a container.';

// ---------------------------------------------------------------------------------------------
// Reading configs
// ---------------------------------------------------------------------------------------------

/** JSON with comments and trailing commas (wrangler.jsonc). */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[++i] ?? '';
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJsonc(path) {
  return parseJsonc(readFileSync(path, 'utf8'));
}

/**
 * The wrangler config an adapter left behind, if any: the redirect file the Cloudflare Vite plugin and
 * Nitro write (`.wrangler/deploy/config.json` → `{ "configPath": "…" }`, relative to its folder), else
 * a `wrangler.json`/`wrangler.jsonc` at the root. Paths inside it are relative to its own folder.
 */
export function findWranglerConfig(root) {
  const redirect = join(root, '.wrangler', 'deploy', 'config.json');
  if (existsSync(redirect)) {
    const { configPath } = readJsonc(redirect);
    if (typeof configPath === 'string') {
      const path = resolve(dirname(redirect), configPath);
      if (!inside(root, path)) throw new EdgeBuildError('edge_output_invalid', 'The redirected wrangler config points outside the project');
      if (existsSync(path)) return { path, config: readJsonc(path), redirected: true };
    }
  }
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const path = join(root, name);
    if (existsSync(path)) return { path, config: readJsonc(path), redirected: false };
  }
  return null;
}

function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/**
 * Bindings the project's own wrangler config declares, mapped onto what a frontend can get: at most
 * one KV namespace, one R2 bucket and one D1 database of its OWN (their ids/names in the config are
 * ignored — the control plane provisions the frontend's), and Durable Objects of classes this Worker
 * exports. Anything that would reach another Worker or an account-wide resource is refused.
 */
export function bindingsFromConfig(config) {
  const resources = {};
  const one = (list, kind, label) => {
    if (!Array.isArray(list) || list.length === 0) return;
    if (list.length > 1) throw new EdgeBuildError('edge_bindings_unsupported', `The wrangler config declares ${list.length} ${label} bindings; a frontend gets exactly one ${label} of its own`, `Use one ${label} binding (the frontend’s own), or deploy as a server.`);
    const name = list[0]?.binding;
    if (typeof name !== 'string' || !BINDING_NAME.test(name)) throw new EdgeBuildError('edge_bindings_unsupported', `A ${label} binding has an invalid name`);
    resources[kind] = name;
  };
  one(config.kv_namespaces, 'kv', 'KV namespace');
  one(config.r2_buckets, 'r2', 'R2 bucket');
  one(config.d1_databases, 'd1', 'D1 database');
  const durableObjects = [];
  for (const b of config.durable_objects?.bindings ?? []) {
    if (b.script_name) throw new EdgeBuildError('edge_bindings_unsupported', `Durable Object binding ${b.name} points at another Worker (${b.script_name}); only classes this Worker exports can be bound`);
    if (!BINDING_NAME.test(b.name ?? '') || !CLASS_NAME.test(b.class_name ?? '')) throw new EdgeBuildError('edge_bindings_unsupported', 'A Durable Object binding has an invalid name or class name');
    durableObjects.push({ name: b.name, className: b.class_name });
  }
  for (const key of ['services', 'queues', 'hyperdrive', 'vectorize', 'analytics_engine_datasets', 'dispatch_namespaces', 'mtls_certificates', 'workflows']) {
    const v = config[key];
    const present = Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' && Object.keys(v).length > 0;
    if (present) throw new EdgeBuildError('edge_bindings_unsupported', `The wrangler config declares ${key} bindings, which edge frontends on Create do not offer yet`, SERVER_FIX);
  }
  return { resources, durableObjects };
}

// ---------------------------------------------------------------------------------------------
// Locating the adapter's output
// ---------------------------------------------------------------------------------------------

const firstExisting = (root, candidates) => candidates.map((c) => join(root, c)).find((p) => existsSync(p)) ?? null;

/**
 * Where the Worker entry and the static files are, per adapter (§7.4 table). `plan` is the build plan
 * the control plane derived from the detector: `{ framework, adapter: { name, mode }, outputDir, spa }`.
 */
export function resolveOutput(root, plan) {
  const adapter = plan.adapter?.name;
  const mode = plan.adapter?.mode;
  if (mode === 'static') {
    const dir = plan.outputDir && plan.outputDir !== '.' ? join(root, plan.outputDir) : plan.outputDir === '.' ? root : firstExisting(root, ['dist', 'build', 'out', 'public']);
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new EdgeBuildError('edge_output_missing', `The build produced no static output folder${plan.outputDir ? ` (${plan.outputDir})` : ''}`, 'Check that the build script writes the site to that folder.');
    return { main: null, assetsDir: dir, exclude: dir === root ? ['node_modules', '.git', EDGE_MANIFEST_FILE, 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'create.json'] : [], compatibilityDate: DEFAULT_COMPAT_DATE, compatibilityFlags: [], resources: {}, durableObjects: [], cacheDir: null, wrapper: null };
  }
  if (adapter === 'opennext') {
    const main = join(root, '.open-next', 'worker.js');
    if (!existsSync(main)) throw new EdgeBuildError('edge_output_missing', 'OpenNext did not produce .open-next/worker.js', 'Look at the build log above for the Next.js or OpenNext error.');
    const own = findWranglerConfig(root);
    const fromConfig = own ? bindingsFromConfig(own.config) : { resources: {}, durableObjects: [] };
    return {
      main,
      assetsDir: join(root, '.open-next', 'assets'),
      exclude: [],
      compatibilityDate: own?.config.compatibility_date ?? DEFAULT_COMPAT_DATE,
      compatibilityFlags: unique(['nodejs_compat', 'global_fetch_strictly_public', ...(own?.config.compatibility_flags ?? [])]),
      // The ISR bindings are the frontend's own R2 bucket and D1 database, whatever the config names.
      resources: { ...fromConfig.resources, r2: NEXT_BINDINGS.incrementalCache, d1: NEXT_BINDINGS.tagCache },
      durableObjects: fromConfig.durableObjects.filter((d) => !['DOQueueHandler', 'DOShardedTagCache', 'BucketCachePurge'].includes(d.className)),
      cacheDir: join(root, '.open-next', 'cache'),
      wrapper: 'next',
    };
  }
  // Every other Worker adapter: the wrangler config it generated is the source of truth when it
  // exists (Cloudflare Vite plugin: React Router, Astro 6+; Nitro); otherwise its documented paths.
  const cfg = findWranglerConfig(root);
  if (cfg && typeof cfg.config.main === 'string') {
    const base = dirname(cfg.path);
    const main = resolve(base, cfg.config.main);
    const assetsDir = cfg.config.assets?.directory ? resolve(base, cfg.config.assets.directory) : null;
    if (!inside(root, main) || (assetsDir && !inside(root, assetsDir))) throw new EdgeBuildError('edge_output_invalid', 'The wrangler config points outside the project');
    if (existsSync(main)) {
      const b = bindingsFromConfig(cfg.config);
      return { main, assetsDir: assetsDir && existsSync(assetsDir) ? assetsDir : null, exclude: pagesExcludes(main, assetsDir), compatibilityDate: cfg.config.compatibility_date ?? DEFAULT_COMPAT_DATE, compatibilityFlags: cfg.config.compatibility_flags ?? [], resources: b.resources, durableObjects: b.durableObjects, cacheDir: null, wrapper: null };
    }
  }
  const known = {
    'astro-cloudflare': { main: ['dist/_worker.js/index.js', 'dist/_worker.js', 'dist/server/entry.mjs'], assets: ['dist/client', 'dist'] },
    'sveltekit-cloudflare': { main: ['.svelte-kit/cloudflare/_worker.js'], assets: ['.svelte-kit/cloudflare'] },
    'nitro-cloudflare': { main: ['.output/server/index.mjs'], assets: ['.output/public'] },
    'cloudflare-vite': { main: ['build/server/index.js', 'dist/server/index.js'], assets: ['build/client', 'dist/client'] },
  }[adapter];
  if (!known) throw new EdgeBuildError('edge_adapter_unknown', `No edge adapter is known for ${adapter ?? 'this project'}`, SERVER_FIX);
  const mainFile = firstExisting(root, known.main);
  if (!mainFile) throw new EdgeBuildError('edge_output_missing', `The ${adapter} build produced no Worker entry (looked for ${known.main.join(', ')})`, 'Check that the Cloudflare adapter is configured for the app, or deploy as a server.');
  const main = statSync(mainFile).isDirectory() ? join(mainFile, 'index.js') : mainFile;
  const assetsDir = firstExisting(root, known.assets);
  const own = cfg ? bindingsFromConfig(cfg.config) : { resources: {}, durableObjects: [] };
  return { main, assetsDir, exclude: pagesExcludes(main, assetsDir), compatibilityDate: cfg?.config.compatibility_date ?? DEFAULT_COMPAT_DATE, compatibilityFlags: unique(['nodejs_compat', ...(cfg?.config.compatibility_flags ?? [])]), resources: own.resources, durableObjects: own.durableObjects, cacheDir: null, wrapper: null };
}

/** Pages-style outputs keep the Worker and routing files inside the assets folder: never serve them. */
function pagesExcludes(main, assetsDir) {
  const out = ['_worker.js', '_routes.json', '.assetsignore'];
  if (assetsDir && inside(assetsDir, main)) out.push(relative(assetsDir, main).split(sep)[0]);
  return unique(out);
}

const unique = (xs) => [...new Set(xs)];

// ---------------------------------------------------------------------------------------------
// Bundling the Worker
// ---------------------------------------------------------------------------------------------

/**
 * The wrangler invocation that bundles `main` into ES modules in `outDir` (no upload: --dry-run). A
 * generated config, so a project's own config cannot add routes, bindings or an account id.
 */
export function bundleCommand(output, outDir, configPath) {
  const config = { name: 'create-edge-build', main: output.main, compatibility_date: output.compatibilityDate, compatibility_flags: output.compatibilityFlags, no_bundle: false, workers_dev: false };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { command: 'npx', args: ['--no-install', 'wrangler', 'deploy', '--dry-run', '--outdir', outDir, '--config', configPath], env: { WRANGLER_SEND_METRICS: 'false', CI: '1' } };
}

function walk(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, r));
    else if (st.isFile()) out.push({ abs, rel: r, size: st.size });
  }
  return out;
}

/** The bundled modules wrangler wrote: the entry (named after `main`) first, then the rest. */
export function collectModules(outDir, main) {
  const files = walk(outDir).filter((f) => /\.(js|mjs|cjs|wasm)$/i.test(f.rel) && !f.rel.endsWith('.map'));
  if (files.length === 0) throw new EdgeBuildError('edge_output_missing', 'Bundling produced no Worker module');
  const stem = basename(main).replace(/\.[^.]+$/, '');
  const entry = files.find((f) => !f.rel.includes('/') && f.rel.replace(/\.[^.]+$/, '') === stem) ?? (files.length === 1 ? files[0] : files.find((f) => !f.rel.includes('/') && /\.m?js$/.test(f.rel)));
  if (!entry) throw new EdgeBuildError('edge_output_missing', `Bundling produced no entry module for ${basename(main)}`);
  return [entry, ...files.filter((f) => f !== entry)];
}

// ---------------------------------------------------------------------------------------------
// OpenNext specifics
// ---------------------------------------------------------------------------------------------

/**
 * OpenNext's `computeCacheKey` (1.20.6, overrides/internal.js): `<prefix>/<buildId>/<sha256(key)>.<type>`.
 */
export function nextCacheKey(key, buildId, cacheType, prefix = 'incremental-cache') {
  const hash = createHash('sha256').update(key).digest('hex');
  return `${prefix}/${buildId}/${hash}.${cacheType}`.replace(/\/+/g, '/');
}

/**
 * The prerendered cache entries of an OpenNext build (`.open-next/cache`), as OpenNext's own
 * `populateCache` reads them: `<buildId>/<route>.cache` → type `cache`, `__fetch/<buildId>/<key>` →
 * type `fetch`. Returned with the R2 key each is stored under in the frontend's own bucket.
 */
export function nextCacheEntries(cacheDir) {
  if (!cacheDir || !existsSync(cacheDir)) return [];
  const out = [];
  for (const f of walk(cacheDir)) {
    let key;
    if (f.rel.startsWith('__fetch/')) {
      const [, buildId, ...parts] = f.rel.split('/');
      if (!buildId || parts.length === 0) throw new EdgeBuildError('edge_output_invalid', `Unexpected OpenNext cache file ${f.rel}`);
      key = nextCacheKey(`/${parts.join('/')}`, buildId, 'fetch');
    } else {
      if (!f.rel.endsWith('.cache')) continue;
      const [buildId, ...parts] = f.rel.slice(0, -'.cache'.length).split('/');
      if (!buildId || parts.length === 0) throw new EdgeBuildError('edge_output_invalid', `Unexpected OpenNext cache file ${f.rel}`);
      key = nextCacheKey(`/${parts.join('/')}`, buildId, 'cache');
    }
    if (!NEXT_CACHE_KEY.test(key)) throw new EdgeBuildError('edge_output_invalid', `OpenNext cache key ${key} has an unexpected shape`);
    out.push({ key, abs: f.abs, size: f.size });
  }
  return out;
}

/**
 * The entry module Create puts in front of an OpenNext Worker on Workers for Platforms:
 *
 * - `WORKER_SELF_REFERENCE`: OpenNext revalidates ISR pages by requesting them from itself through a
 *   service binding of that name; a user Worker in a dispatch namespace has none, so the wrapper hands
 *   it an in-process one (the same handler, a fresh invocation). Paired with OpenNext's memory queue.
 * - `/_next/image`: local images are optimized through an `ASSETS` binding the dispatch model does not
 *   give a user Worker (Create serves static files from the dispatch Worker); the wrapper answers with
 *   a SAME-ORIGIN redirect to the original file, served unoptimized, and 400 for anything that would
 *   resolve to another origin (security review L1: no open redirect).
 * - every named export (Durable Object classes) is re-exported unchanged.
 */
export function nextEntryWrapper(innerModule) {
  const spec = `./${innerModule}`;
  return `// Generated by Create's edge build (slice E2). See infra/app-cluster/builds/image/edge/pack.mjs.
import * as inner from ${JSON.stringify(spec)};
export * from ${JSON.stringify(spec)};
const worker = inner.default;
function envWithSelf(env, ctx) {
  const scoped = Object.assign({}, env);
  scoped.WORKER_SELF_REFERENCE = { fetch: (input, init) => worker.fetch(new Request(input, init), scoped, ctx) };
  return scoped;
}
export default {
  ...worker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/_next/image') {
      // Only ever a same-origin redirect: the source is resolved the way the browser will resolve it
      // (\\ is /, tabs and newlines are dropped), and anything that lands elsewhere is refused.
      const src = url.searchParams.get('url');
      let target = null;
      try {
        target = src && src.startsWith('/') ? new URL(src, url) : null;
      } catch {
        target = null;
      }
      if (!target || target.origin !== url.origin) return new Response('Bad image URL', { status: 400 });
      return Response.redirect(target.toString(), 307);
    }
    return worker.fetch(request, envWithSelf(env, ctx), ctx);
  },
};
`;
}

/** The open-next.config.ts Create writes when a project has none: R2 cache, D1 tag cache, memory queue. */
export const NEXT_OPEN_NEXT_CONFIG = `// Written by Create's edge build (slice E2): the frontend's own R2 bucket holds the incremental cache,
// its own D1 database the tag cache; revalidation runs in-process (see pack.mjs, nextEntryWrapper).
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue";

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  tagCache: d1NextTagCache,
  queue: memoryQueue,
});
`;

/**
 * After an OpenNext build: Node.js middleware (Next 15.2+, and Next 16's proxy) is only experimental in
 * OpenNext, so Create refuses it at the edge (§7.6) — decided from Next's own manifests, as OpenNext does.
 */
export function assertNoNodeMiddleware(root) {
  const dotNext = join(root, '.next', 'server');
  const read = (name) => {
    const p = join(dotNext, name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  };
  const edge = read('middleware-manifest.json')?.middleware?.['/'];
  const node = read('functions-config-manifest.json')?.functions?.['/_middleware'];
  if (!edge && node) throw new EdgeBuildError('edge_node_middleware', 'The app uses Next.js Node.js middleware (or proxy), which OpenNext supports only experimentally', SERVER_FIX);
}

// ---------------------------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const padTo512 = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);

/** A deterministic ustar archive of regular files (PAX `path` records for long names), gzipped. */
export function tarGz(entries) {
  const parts = [];
  for (const { path, data } of entries) {
    const body = Buffer.from(data);
    if (Buffer.byteLength(path) > 100) {
      const rec = (len) => `${len} path=${path}\n`;
      let len = Buffer.byteLength(rec(0));
      while (Buffer.byteLength(rec(len)) !== len) len = Buffer.byteLength(rec(len));
      const pax = Buffer.from(rec(len), 'utf8');
      parts.push(tarHeader('PaxHeader', pax.length, 'x'), pax, padTo512(pax.length));
      parts.push(tarHeader(path.slice(-100).replace(/^\/+/, ''), body.length), body, padTo512(body.length));
    } else {
      parts.push(tarHeader(path, body.length), body, padTo512(body.length));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/**
 * Build the Create edge bundle from a located output and bundled modules.
 *
 * @param {object} input
 * @param {object} input.output     resolveOutput(...)
 * @param {Array}  input.modules    collectModules(...) (empty for static)
 * @param {object} input.plan       { framework, spa, notFound?, maxScriptBytes }
 * @returns {{ tarball: Buffer, sha256: string, manifest: object, stats: object }}
 */
/**
 * E5: the image sources a Next.js app declared (`images.remotePatterns` / `images.domains` in
 * next.config), as `next build` recorded them in `.next/required-server-files.json`. Copied raw and
 * capped; the CONTROL PLANE validates them (https only, no ports/IPs/internal names) — a build is
 * never trusted to widen anything.
 */
export function nextImagesConfig(root) {
  const file = join(root, '.next', 'required-server-files.json');
  if (!existsSync(file)) return null;
  let images;
  try {
    images = JSON.parse(readFileSync(file, 'utf8'))?.config?.images;
  } catch {
    return null;
  }
  if (!images || typeof images !== 'object') return null;
  const remotePatterns = (Array.isArray(images.remotePatterns) ? images.remotePatterns : [])
    .filter((p) => typeof p === 'string' || (p && typeof p === 'object' && typeof p.hostname === 'string'))
    .slice(0, 100)
    .map((p) => (typeof p === 'string' ? p.slice(0, 300) : { protocol: typeof p.protocol === 'string' ? p.protocol.slice(0, 10) : undefined, hostname: p.hostname.slice(0, 300), port: typeof p.port === 'string' ? p.port.slice(0, 10) : undefined, pathname: typeof p.pathname === 'string' ? p.pathname.slice(0, 300) : undefined }));
  const domains = (Array.isArray(images.domains) ? images.domains : []).filter((d) => typeof d === 'string').slice(0, 100).map((d) => d.slice(0, 300));
  const qualities = Array.isArray(images.qualities) ? images.qualities.filter((q) => typeof q === 'number').slice(0, 20) : null;
  if (!remotePatterns.length && !domains.length && !qualities) return null;
  return { remotePatterns, domains, ...(qualities ? { qualities } : {}) };
}

export function packBundle({ output, modules, plan, images = null }) {
  const entries = [];
  const manifest = { version: 1, assets: 'public', compatibilityDate: output.compatibilityDate, compatibilityFlags: output.compatibilityFlags, spa: false, notFound: null };
  if (plan.framework) manifest.framework = plan.framework;
  if (images) manifest.images = images;
  let scriptBytes = 0;
  if (output.main) {
    if (modules.length === 0) throw new EdgeBuildError('edge_output_missing', 'The Worker was not bundled');
    const names = [];
    for (const m of modules) {
      const data = readFileSync(m.abs);
      scriptBytes += data.length;
      entries.push({ path: `worker/${m.rel}`, data });
      names.push(`worker/${m.rel}`);
    }
    if (output.wrapper === 'next') {
      const wrapper = enc.encode(nextEntryWrapper(modules[0].rel));
      scriptBytes += wrapper.length;
      entries.push({ path: 'worker/create-entry.mjs', data: wrapper });
      manifest.main = 'worker/create-entry.mjs';
      manifest.modules = names;
    } else {
      manifest.main = names[0];
      manifest.modules = names.slice(1);
    }
    const r = Object.fromEntries(Object.entries(output.resources ?? {}).filter(([, v]) => v));
    if (Object.keys(r).length > 0) manifest.resources = r;
    if ((output.durableObjects ?? []).length > 0) manifest.durableObjects = output.durableObjects;
  } else {
    manifest.spa = Boolean(plan.spa);
    if (plan.notFound) manifest.notFound = plan.notFound;
  }
  if (plan.maxScriptBytes && scriptBytes > plan.maxScriptBytes) {
    throw new EdgeBuildError('edge_bundle_too_large', `The Worker is ${(scriptBytes / 1024 / 1024).toFixed(1)} MiB, over the edge limit of ${(plan.maxScriptBytes / 1024 / 1024).toFixed(1)} MiB`, SERVER_FIX);
  }
  let assetCount = 0;
  let assetBytes = 0;
  if (output.assetsDir && existsSync(output.assetsDir)) {
    const excluded = new Set(output.exclude ?? []);
    for (const f of walk(output.assetsDir)) {
      const top = f.rel.split('/')[0];
      if (excluded.has(top) || excluded.has(f.rel)) continue;
      entries.push({ path: `public/${f.rel}`, data: readFileSync(f.abs) });
      assetCount += 1;
      assetBytes += f.size;
    }
  }
  if (!manifest.spa && !output.main && entries.some((e) => e.path === 'public/404.html')) manifest.notFound = manifest.notFound ?? '404.html';
  let cacheCount = 0;
  if (output.cacheDir) {
    for (const c of nextCacheEntries(output.cacheDir)) {
      entries.push({ path: `cache/${c.key}`, data: readFileSync(c.abs) });
      cacheCount += 1;
    }
    if (cacheCount > 0) manifest.cache = { r2: 'cache' };
  }
  if (!output.main && assetCount === 0) throw new EdgeBuildError('edge_output_missing', 'The build produced no files to serve');
  entries.unshift({ path: EDGE_MANIFEST_FILE, data: enc.encode(JSON.stringify(manifest, null, 2)) });
  const tarball = tarGz(entries);
  return { tarball, sha256: createHash('sha256').update(tarball).digest('hex'), manifest, stats: { scriptBytes, assetCount, assetBytes, cacheCount, modules: modules.length } };
}

/** Writes the bundle and a small result file the build pod's shell reads. */
export function writeBundle(outDir, packed) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'bundle.tar.gz'), packed.tarball);
  writeFileSync(join(outDir, 'result.json'), JSON.stringify({ sha256: packed.sha256, sizeBytes: packed.tarball.length, stats: packed.stats }));
}

export const _internal = { walk, inside, extname };
