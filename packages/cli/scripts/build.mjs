#!/usr/bin/env node
// Builds the publishable @create.com/cli into packages/cli/dist/, self-contained:
//
//   dist/bin.js           the CLI (src/bin.ts) with @create/apps-mcp, @create/shared and their
//                         third-party dependencies (zod, …) inlined; only Node built-ins stay external.
//   dist/build-local.mjs  apps/app-edge/scripts/build-local.mjs (local edge builds, `--build local` /
//                         `create mcp --local-builds`), with the framework detector inlined. The CLI
//                         finds it next to itself (src/edge-build.ts resolveBuildLocalScript).
//   dist/edge/*.mjs       the build pod's edge-build.mjs + pack.mjs, copied verbatim: build-local.mjs
//                         runs edge-build.mjs as a child process and finds it in edge/ next to itself.
//
// Usage: node packages/cli/scripts/build.mjs   (or `pnpm --filter @create.com/cli build`)
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '../..');
const DIST = join(PKG, 'dist');
const EDGE_SRC = join(REPO, 'infra/app-cluster/builds/image/edge');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'edge'), { recursive: true });

const external = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

// @create/shared is a barrel of zod schemas for the whole platform; module-level `z.object(…)` calls
// look like side effects to esbuild, so without this every schema (commerce, billing, …) would be
// bundled. Its modules only declare values, so for this bundle treat them as side-effect free and let
// tree shaking keep just what the CLI uses. (Scoped to this build: other apps are unaffected.)
const SHARED_SRC = join(REPO, 'packages/shared/src') + '/';
const sharedTreeShaking = {
  name: 'shared-side-effect-free',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.shared) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { shared: true } });
      if (r.errors.length || !r.path.startsWith(SHARED_SRC)) return r.errors.length ? { errors: r.errors } : undefined;
      return { ...r, sideEffects: false };
    });
  },
};

const common = {
  plugins: [sharedTreeShaking],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  legalComments: 'none',
  // Whitespace and syntax only: identifiers keep their names, so a stack trace stays readable.
  minifyWhitespace: true,
  minifySyntax: true,
  logLevel: 'warning',
  // A few bundled CommonJS dependencies may call require() for built-ins; give ESM output a real one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
};

const bundles = [];
bundles.push(await build({
  ...common,
  metafile: true,
  entryPoints: [join(PKG, 'src/bin.ts')],
  outfile: join(DIST, 'bin.js'),
  // src/bin.ts starts with `#!/usr/bin/env node`; esbuild keeps an entry point's hashbang on line 1.
}));

bundles.push(await build({
  ...common,
  metafile: true,
  entryPoints: [join(REPO, 'apps/app-edge/scripts/build-local.mjs')],
  outfile: join(DIST, 'build-local.mjs'),
}));

// The third-party packages inlined above (zod, parse5, …) ship under their own licenses: their notices
// go into dist/THIRD_PARTY_LICENSES.txt, which is published with the bundle.
const thirdParty = new Map();
// Only packages with code in the output: a package esbuild merely read (then tree-shook away) ships nothing.
for (const { metafile } of bundles) {
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
      if (m && bytesInOutput > 0 && !thirdParty.has(m[2])) thirdParty.set(m[2], resolve(PKG, m[1]));
    }
  }
}
const notices = [];
for (const [name, dir] of [...thirdParty].sort(([a], [b]) => a.localeCompare(b))) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = licenseFile && existsSync(join(dir, licenseFile)) ? readFileSync(join(dir, licenseFile), 'utf8').trim() : `License: ${pkg.license ?? 'see the package'}`;
  notices.push(`${name}@${pkg.version} (${pkg.license ?? 'unknown'})\n\n${text}`);
}
writeFileSync(join(DIST, 'THIRD_PARTY_LICENSES.txt'), `Third-party software bundled into @create.com/cli\n\n${notices.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`);

// scripts/export-public.mjs asks which first-party sources the bundle is built from, to mirror exactly
// those into the public repository that publishes the package: `resolved` is every file esbuild had to
// read, `bundled` the ones with code in the output, in output order.
if (process.env.CLI_BUILD_INPUTS) {
  const resolved = new Set();
  const bundled = new Set();
  const rel = (input) => relative(REPO, resolve(input));
  for (const { metafile } of bundles) {
    for (const input of Object.keys(metafile.inputs)) if (!input.includes('node_modules/')) resolved.add(rel(input));
    for (const output of Object.values(metafile.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        if (bytesInOutput > 0 && !input.includes('node_modules/')) bundled.add(rel(input));
      }
    }
  }
  writeFileSync(process.env.CLI_BUILD_INPUTS, `${JSON.stringify({ resolved: [...resolved].sort(), bundled: [...bundled] }, null, 2)}\n`);
}

for (const file of ['edge-build.mjs', 'pack.mjs']) copyFileSync(join(EDGE_SRC, file), join(DIST, 'edge', file));
chmodSync(join(DIST, 'bin.js'), 0o755);

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`;
console.log(`dist/bin.js ${kb(join(DIST, 'bin.js'))}, dist/build-local.mjs ${kb(join(DIST, 'build-local.mjs'))}, dist/edge/ edge-build.mjs + pack.mjs`);
