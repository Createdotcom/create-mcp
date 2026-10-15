#!/usr/bin/env node
// The Create edge build (app hosting spec §7.4, slice E2): one framework app → one Create edge bundle.
//
// Runs as the only RUN step of a generated Dockerfile stage (see ../create-build.sh, "edge"), inside
// the build pod's rootless BuildKit, in the Node image pinned by EDGE_BUILD_NODE_IMAGE
// (packages/shared/src/apps-frameworks.ts). Nothing here talks to Cloudflare or holds a Cloudflare
// credential: the bundle it writes to /out is uploaded by the pod to the CONTROL PLANE, which alone
// provisions resources and uploads Workers (spec §7.4 "only the control plane holds the Cloudflare API
// token and performs uploads").
//
// Input:  CREATE_EDGE_PLAN (JSON): { framework, adapter: { name, package, version, mode },
//         packageManager, outputDir, spa, maxScriptBytes, pins: { opennext, wrangler, sveltekitCloudflare } }
//         The project is in the working directory (/app); build-time variables are in the environment.
// Output: /out/bundle.tar.gz and /out/result.json; on failure a line
//         `::create-edge-error:: code=<code> <message>` (the control plane's build summary reads it).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EdgeBuildError, NEXT_OPEN_NEXT_CONFIG, assertNoNodeMiddleware, bundleCommand, collectModules, nextImagesConfig, packBundle, resolveOutput, writeBundle } from './pack.mjs';

const root = process.cwd();
const outDir = process.env.CREATE_EDGE_OUT ?? '/out';

function say(line) {
  process.stdout.write(`${line}\n`);
}

function run(command, args, env = {}) {
  say(`$ ${[command, ...args].join(' ')}`);
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new EdgeBuildError('edge_build_command_failed', `${command} ${args.join(' ')} exited with code ${r.status ?? 'unknown'}`);
}

function pkgJson() {
  const p = join(root, 'package.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function hasDep(pkg, name) {
  return Boolean(pkg && (pkg.dependencies?.[name] || pkg.devDependencies?.[name]));
}

function isYarnClassic() {
  const lock = join(root, 'yarn.lock');
  return existsSync(lock) && readFileSync(lock, 'utf8').includes('# yarn lockfile v1');
}

function install(pm) {
  if (!existsSync(join(root, 'package.json'))) return;
  switch (pm) {
    case 'pnpm':
      run('corepack', ['enable']);
      run('pnpm', ['install', '--frozen-lockfile']);
      return;
    case 'yarn':
      run('corepack', ['enable']);
      run('yarn', isYarnClassic() ? ['install', '--frozen-lockfile'] : ['install', '--immutable']);
      return;
    default:
      if (pm === 'bun') say('bun is not in the edge build image; installing with npm');
      run('npm', existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'npm-shrinkwrap.json')) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund']);
  }
}

/**
 * Adds a pinned dev dependency when the project does not already have the package. Saved into the
 * build's own copy of package.json for every package manager: npm's `--no-save` (used before
 * 2026-10-03) pruned the previously added pin on the next install — OpenNext, then wrangler — so a
 * Next.js app on npm that declared neither failed with "could not determine executable to run"
 * (found by the Next.js compatibility run, docs/apps/nextjs-compatibility.md).
 */
function ensure(pm, name, version) {
  if (hasDep(pkgJson(), name)) return;
  const spec = `${name}@${version}`;
  if (pm === 'pnpm') run('pnpm', ['add', '-D', spec]);
  else if (pm === 'yarn') run('yarn', ['add', '-D', spec]);
  else run('npm', ['install', '--save-dev', '--save-exact', '--no-audit', '--no-fund', spec]);
}

function script(pm, name, env = {}) {
  const pkg = pkgJson();
  if (!pkg?.scripts?.[name]) return false;
  run(pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : 'npm', ['run', name], env);
  return true;
}

function buildNext(plan, pm) {
  ensure(pm, '@opennextjs/cloudflare', plan.pins.opennext);
  ensure(pm, 'wrangler', plan.pins.wrangler);
  const configs = ['open-next.config.ts', 'open-next.config.mjs', 'open-next.config.js'];
  if (!configs.some((c) => existsSync(join(root, c)))) {
    writeFileSync(join(root, 'open-next.config.ts'), NEXT_OPEN_NEXT_CONFIG);
    say('wrote open-next.config.ts (R2 incremental cache, D1 tag cache, memory queue)');
  }
  if (!['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((c) => existsSync(join(root, c)))) {
    // OpenNext reads a wrangler config during its build; the bindings here are placeholders for its
    // checks only — the deployed Worker is bound by the control plane to the frontend's own resources.
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify(
        {
          name: 'create-edge-build',
          main: '.open-next/worker.js',
          compatibility_date: '2026-09-01',
          compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
          r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET', bucket_name: 'create-build-placeholder' }],
          d1_databases: [{ binding: 'NEXT_TAG_CACHE_D1', database_name: 'create-build-placeholder', database_id: '00000000-0000-0000-0000-000000000000' }],
        },
        null,
        2,
      ),
    );
  }
  run('npx', ['--no-install', 'opennextjs-cloudflare', 'build'], { NEXT_TELEMETRY_DISABLED: '1' });
  assertNoNodeMiddleware(root);
}

function frameworkBuild(plan, pm) {
  const env = { NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' };
  switch (plan.adapter.name) {
    case 'opennext':
      return buildNext(plan, pm);
    case 'sveltekit-cloudflare':
      ensure(pm, '@sveltejs/adapter-cloudflare', plan.pins.sveltekitCloudflare);
      ensure(pm, 'wrangler', plan.pins.wrangler);
      // adapter-auto picks adapter-cloudflare in Cloudflare's build environment.
      script(pm, 'build', { ...env, CF_PAGES: '1' });
      return;
    case 'nitro-cloudflare':
      ensure(pm, 'wrangler', plan.pins.wrangler);
      if (!script(pm, 'build', { ...env, NITRO_PRESET: 'cloudflare_module' })) run('npx', ['--no-install', 'nuxi', 'build'], { ...env, NITRO_PRESET: 'cloudflare_module' });
      return;
    case 'static':
      script(pm, 'build', env);
      return;
    default:
      ensure(pm, 'wrangler', plan.pins.wrangler);
      if (!script(pm, 'build', env)) throw new EdgeBuildError('edge_build_command_failed', 'package.json has no build script');
  }
}

function main() {
  const plan = JSON.parse(process.env.CREATE_EDGE_PLAN ?? '{}');
  if (!plan.adapter) throw new EdgeBuildError('edge_plan_missing', 'The build has no edge plan');
  const pm = plan.packageManager ?? 'npm';
  say(`::create-edge:: framework=${plan.framework} adapter=${plan.adapter.name} mode=${plan.adapter.mode}`);
  install(pm);
  frameworkBuild(plan, pm);
  const output = resolveOutput(root, plan);
  let modules = [];
  if (output.main) {
    const bundled = join(root, '.create-edge', 'worker');
    mkdirSync(bundled, { recursive: true });
    const cmd = bundleCommand(output, bundled, join(root, '.create-edge', 'wrangler.json'));
    ensure(pm, 'wrangler', plan.pins.wrangler);
    run(cmd.command, cmd.args, cmd.env);
    modules = collectModules(bundled, output.main);
  }
  // E5: Next.js's image sources; the dispatch Worker serves /_next/image as /_create/image.
  const images = plan.adapter.name === 'opennext' ? nextImagesConfig(root) : null;
  const packed = packBundle({ output, modules, plan, images });
  writeBundle(outDir, packed);
  say(`::create-edge:: bundle sha256=${packed.sha256} bytes=${packed.tarball.length} worker=${packed.stats.scriptBytes} assets=${packed.stats.assetCount} cache=${packed.stats.cacheCount}`);
}

try {
  main();
} catch (error) {
  const code = error instanceof EdgeBuildError ? error.code : 'edge_build_failed';
  say(`::create-edge-error:: code=${code} ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof EdgeBuildError && error.fix) say(`fix: ${error.fix}`);
  process.exit(1);
}
