import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, EDGE_MANIFEST_FILE } from '@create/apps-mcp';
import { configDir } from './config.js';
import { packDirectory } from './pack.js';

/**
 * Local edge builds for `create deploy` and `create mcp`: a framework SOURCE folder (Next.js, Astro,
 * SvelteKit, …) becomes a pre-built edge bundle on THIS machine, for a project with no build cluster
 * (edge-only, e.g. staging today) or on request (`--build local`, MCP `build: "local"`).
 *
 * It is the same code as `node apps/app-edge/scripts/build-local.mjs` (runbook
 * apps-edge.md §6), imported rather than shelled out: the build pod's script
 * (infra/app-cluster/builds/image/edge/edge-build.mjs), its pins and the plan from the same detector,
 * over a COPY of the folder without secret files (`.env*`, `.dev.vars*`, keys), with an ALLOWLISTED
 * environment (plus the variable names a person passed with `--build-env NAME`; a model cannot add
 * any). The unpacked bundle is then packaged like any folder (`packDirectory`: credential files are
 * never uploaded) and deployed with deployEdgeBundle. The build's own output goes to stderr only —
 * under `create mcp` stdout is the protocol channel.
 */

export type LocalBuildResult = { bundleDir: string; framework: string; adapter: string; cleanup: () => void };
export type LocalEdgeBuilder = (
  dir: string,
  options: { forceEdge: boolean; envNames: readonly string[]; env: NodeJS.ProcessEnv; log: (line: string) => void; output: (chunk: string) => void; include: readonly string[]; signal?: AbortSignal },
) => Promise<LocalBuildResult>;

/** What every local build tells the person: it is code execution on their machine. */
export const LOCAL_BUILD_WARNING = 'this runs the folder’s npm install and build scripts on this machine, as you';
const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'PUBLIC_', 'VITE_'];

/**
 * build-local.mjs: in the published package (`@create.com/cli`) it sits next to the bundled CLI
 * (`dist/build-local.mjs`, with the build pod's scripts in `dist/edge/`, copied there by
 * scripts/build.mjs); run from a checkout of the Create repository (tsx packages/cli/src/bin.ts), it is
 * apps/app-edge/scripts/build-local.mjs. Resolved from this module's own location, never the cwd.
 */
export function resolveBuildLocalScript(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl);
  const packaged = resolve(here, '../build-local.mjs');
  return existsSync(packaged) ? packaged : resolve(here, '../../../../apps/app-edge/scripts/build-local.mjs');
}
export const BUILD_LOCAL_SCRIPT = resolveBuildLocalScript();

type BuildLocalModule = typeof import('../../../apps/app-edge/scripts/build-local.mjs');

/** True when `name` is an executable file on PATH. */
export function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const st = statSync(join(dir, `${name}${ext}`), { throwIfNoEntry: false });
      if (st?.isFile()) return true;
    }
  }
  return false;
}

/**
 * What a local build needs before it starts, as AgentErrors with a fix line: Node 22.18+, npm and npx
 * on PATH (the build installs the app's dependencies and runs the pinned OpenNext/wrangler through
 * npx), a package.json, and the Create repository's build scripts.
 */
export function checkLocalBuildPrerequisites(dir: string, env: NodeJS.ProcessEnv, script = BUILD_LOCAL_SCRIPT, nodeVersion = process.versions.node): void {
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new AgentError('build_tool_missing', `Building on this machine needs Node.js 22.18 or newer (this is ${nodeVersion})`, 'Install Node.js 22 (https://nodejs.org) and start create mcp / create deploy with it.');
  for (const tool of ['npm', 'npx']) {
    if (!onPath(tool, env)) throw new AgentError('build_tool_missing', `Building on this machine needs ${tool}, and it is not on PATH`, `Install Node.js 22 with npm (https://nodejs.org), and make sure its bin folder is on PATH for the process running create (for an MCP client, set PATH in the server's env).`);
  }
  if (!existsSync(join(dir, 'package.json'))) throw new AgentError('not_a_project', `${dir} has no package.json, so there is no framework app to build`, 'Deploy the folder that holds the app’s package.json, or a pre-built bundle (a folder with create-edge.json).');
  if (!existsSync(script)) {
    throw new AgentError('local_build_unavailable', 'This create CLI cannot build sites on this machine (the Create edge build scripts are not next to it)', 'Reinstall the create CLI (npx -y @create.com/cli) or run it from a checkout of the Create repository, or build the bundle elsewhere and deploy the folder with create-edge.json.');
  }
}

/** The real builder: build-local.mjs `buildEdgeBundle` into a fresh temp folder, HOME isolated. */
export const realLocalEdgeBuilder: LocalEdgeBuilder = async (dir, options) => {
  const mod = (await import(pathToFileURL(BUILD_LOCAL_SCRIPT).href)) as BuildLocalModule;
  const work = mkdtempSync(join(tmpdir(), 'create-edge-bundle-'));
  const out = join(work, 'bundle');
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  try {
    const { plan } = await mod.buildEdgeBundle({ dir, out, forceEdge: options.forceEdge, env: [...options.envNames], sourceEnv: options.env, log: options.log, onOutput: options.output, include: options.include, isolateHome: true, ...(options.signal ? { signal: options.signal } : {}) });
    return { bundleDir: out, framework: plan.framework, adapter: plan.adapter.package ?? plan.adapter.name, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
};

// ------------------------------------------------------------------ per-folder approvals (create mcp)

const approvalsFile = (env: NodeJS.ProcessEnv) => join(configDir(env), 'local-build-approvals.json');

/**
 * The source folder's real path + sha256 over EVERY file of the COPY the build will run from (paths and
 * contents, lockfiles included): any change at all — a new script, a new dependency, an edited config
 * file the build executes — asks the person again. Hashing the copy (not the folder) means what was
 * approved is exactly what builds: the folder can change after the question without effect. (.npmrc is
 * never copied — a credential file — and the build's HOME is empty, so no .npmrc is read at all.)
 */
export function approvalKey(root: string, copied: readonly string[], copyRoot: string): string {
  const real = realpathSync(root);
  const h = createHash('sha256');
  for (const rel of [...new Set(copied)].sort()) {
    const abs = join(copyRoot, ...rel.split('/'));
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    h.update(rel).update('\0').update(createHash('sha256').update(readFileSync(abs)).digest('hex')).update('\n');
  }
  return `${real}#${h.digest('hex')}`;
}

function readApprovals(env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(approvalsFile(env), 'utf8')) as { approvals?: Record<string, string> };
    return parsed.approvals && typeof parsed.approvals === 'object' ? parsed.approvals : {};
  } catch {
    return {};
  }
}

/** Kept in the user's config folder (never the project, which the model can write). */
function saveApproval(env: NodeJS.ProcessEnv, key: string, at: string): void {
  const file = approvalsFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ approvals: { ...readApprovals(env), [key]: at } }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: no POSIX modes.
  }
}

export type Elicit = NonNullable<import('@create/apps-mcp').ToolContext['elicit']>;

/**
 * `ctx.buildEdgeLocally` for the CLI: null for a folder that already is a pre-built bundle; else
 * check the rules, build, package the bundle, and always remove the temp folder.
 *
 * - `mode: 'terminal'` (`create deploy`, a person ran it): builds, after saying it runs the folder's
 *   npm scripts on this machine.
 * - `mode: 'mcp'` (`create mcp`, a model asks): OFF unless the person started the server with
 *   `--local-builds`; then, when the client can ask (elicitation), the person confirms each folder once
 *   (remembered per real path + package.json hash in the user's config folder). Browser-public
 *   variables (NEXT_PUBLIC_*, PUBLIC_*, VITE_*) from the server's environment are passed only when
 *   named with --build-env.
 */
export function localEdgeBuild(opts: {
  builder: LocalEdgeBuilder;
  envNames: readonly string[];
  env: NodeJS.ProcessEnv;
  say: (line: string) => void;
  buildOutput: (chunk: string) => void;
  script?: string;
  mode: 'terminal' | 'mcp';
  /** mcp: the person passed --local-builds. */
  localBuildsAllowed?: boolean;
  now?: () => number;
}) {
  return async (dir: string, options: { forceEdge: boolean; elicit?: Elicit; signal?: AbortSignal }) => {
    const root = resolve(dir);
    if (existsSync(join(root, EDGE_MANIFEST_FILE))) return null;
    if (opts.mode === 'mcp' && !opts.localBuildsAllowed) {
      throw new AgentError(
        'local_builds_off',
        `Building ${root} on this machine is turned off: it would run the folder’s npm install and build scripts as you, outside your agent’s sandbox`,
        'A person can turn it on by adding --local-builds to the create mcp server’s args (e.g. args = ["…/bin.ts", "mcp", "--local-builds"]) and restarting it — or build in a terminal with `create deploy --build local`, or deploy a folder that already holds create-edge.json.',
      );
    }
    // The tool and script checks apply to the real build; an injected builder (tests) brings its own.
    if (opts.builder === realLocalEdgeBuilder) checkLocalBuildPrerequisites(root, opts.env, opts.script);
    else if (!existsSync(join(root, 'package.json'))) throw new AgentError('not_a_project', `${root} has no package.json, so there is no framework app to build`, 'Deploy the folder that holds the app’s package.json, or a pre-built bundle (a folder with create-edge.json).');

    // Exactly the files `create deploy` would upload (.gitignore/.createignore honoured, credential
    // files and symbolic links left out), COPIED FIRST into a private folder: the approval hashes that
    // copy and the build runs from it, so nothing the person did not approve can slip in afterwards.
    const listed = packDirectory(root, { allowSecretFiles: [], gitignore: true, listOnly: true }).files;
    const staging = mkdtempSync(join(tmpdir(), 'create-edge-source-'));
    try {
      const src = join(staging, 'src');
      const include = copyNoFollow(root, src, listed);
      return await buildFromCopy(root, src, include, options);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };

  async function buildFromCopy(root: string, src: string, include: readonly string[], options: { forceEdge: boolean; elicit?: Elicit; signal?: AbortSignal }) {
    if (opts.mode === 'mcp' && options.elicit) {
      const key = approvalKey(root, include, src);
      if (!readApprovals(opts.env)[key]) {
        let answer: Awaited<ReturnType<Elicit>>;
        try {
          answer = await options.elicit({
            message: `Build ${root} on this machine? It runs this folder’s npm install and build scripts as you (outside the agent’s sandbox). Asked again whenever any file in the folder changes.`,
            requestedSchema: { type: 'object', properties: { build: { type: 'boolean', title: 'Build on this machine', default: false } }, required: ['build'] },
          });
        } catch {
          answer = { action: 'cancel' };
        }
        if (answer.action !== 'accept' || answer.content?.build !== true) {
          throw new AgentError('local_build_declined', `The person did not approve building ${root} on this machine`, 'Nothing was built or deployed. Ask the person whether to build it here; or deploy a folder that already holds create-edge.json.');
        }
        saveApproval(opts.env, key, new Date((opts.now ?? Date.now)()).toISOString());
      }
    }
    opts.say(`Building ${root} on this machine: ${LOCAL_BUILD_WARNING}.`);

    const env: NodeJS.ProcessEnv = { ...opts.env };
    if (opts.mode === 'mcp') for (const k of Object.keys(env)) if (PUBLIC_PREFIXES.some((p) => k.startsWith(p)) && !opts.envNames.includes(k)) delete env[k];

    const started = Date.now();
    let built: LocalBuildResult;
    try {
      built = await opts.builder(src, { forceEdge: options.forceEdge, envNames: opts.envNames, env, log: (line) => opts.say(`  ${line}`), output: opts.buildOutput, include, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      if (error instanceof AgentError) throw error;
      const e = error as Error & { code?: string };
      if (e.code === 'cancelled' || options.signal?.aborted) throw new AgentError('cancelled', 'The build was cancelled', 'Nothing was deployed. Deploy again when ready.');
      if (e.code === 'not_edge') throw new AgentError('not_edge', e.message, 'Fix what the detector lists (docs/apps/nextjs-compatibility.md), or deploy again with target "edge" (create deploy --edge) to build for the edge anyway.');
      if (e.code === 'edge_not_supported') throw new AgentError('edge_not_supported', e.message, 'Deploy it to a project with compute (a container), or use a framework Create runs at the edge.');
      if (e.code === 'not_a_project') throw new AgentError('not_a_project', e.message, 'Deploy the folder that holds the app’s package.json.');
      const tail = `${e.message}\n${((e as { tail?: string[] }).tail ?? []).join('\n')}`;
      if (/\bE401\b|ENEEDAUTH|401 Unauthorized|code E403\b/.test(tail)) {
        throw new AgentError(
          'npm_auth_failed',
          'The install could not sign in to the package registry. The build runs with HOME set to an empty folder, so your ~/.npmrc (and its registry token) is not read',
          'Set npm_config_userconfig=/path/to/your/.npmrc (or the registry’s npm_config_… settings) in the environment of create — for an MCP client, in the server’s env; npm_config_* variables reach the build. A token you reference as ${NPM_TOKEN} in that file is passed with --build-env NPM_TOKEN.',
        );
      }
      throw new AgentError('edge_build_failed', `Building on this machine failed: ${e.message}`, 'Fix the error the build reports (run the app’s own build, e.g. `npm run build`, in the folder to see it), then deploy again.');
    }
    try {
      if (options.signal?.aborted) throw new AgentError('cancelled', 'The build was cancelled', 'Nothing was deployed. Deploy again when ready.');
      const pack = packDirectory(built.bundleDir, { allowSecretFiles: [], gitignore: false });
      opts.say(`Built ${built.framework} for the edge in ${Math.round((Date.now() - started) / 1000)}s (${pack.fileCount} files).`);
      return { tarball: pack.tarball, sha256: pack.sha256, fileCount: pack.fileCount, skipped: pack.skipped, edge: true as const, framework: built.framework, adapter: built.adapter };
    } finally {
      built.cleanup();
    }
  }
}

/**
 * Copy `include` from `root` into `dest`, opening every file with O_NOFOLLOW and checking it is a
 * regular file on the open descriptor (a file swapped for a symbolic link after listing is skipped, never
 * followed). Returns the paths actually copied.
 */
export function copyNoFollow(root: string, dest: string, include: readonly string[]): string[] {
  const copied: string[] = [];
  for (const rel of include) {
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) continue;
    let fd: number;
    try {
      fd = openSync(join(root, ...parts), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch {
      continue; // gone, or a symbolic link now
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) continue;
      const target = join(dest, ...parts);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(fd), { mode: st.mode & 0o111 ? 0o755 : 0o644 });
      copied.push(rel);
    } finally {
      closeSync(fd);
    }
  }
  return copied;
}
