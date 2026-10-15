import { lstatSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createTarGz, safeArchivePath, secretFileReason, sha256Hex, type TarEntry } from '@create/apps-mcp';
import { compileRule, matchIgnore, parseIgnoreFile, type IgnoreRule } from './ignore.js';

/**
 * Package a folder for `create deploy` (spec §8.3): every regular file under the folder, minus what
 * `.gitignore` files (at every level) and `.createignore` (root, applied last so it can re-include)
 * exclude, minus the built-in exclusions below. Never followed: symbolic links (a link can point
 * anywhere on the machine) and special files. Never included unless a person names the exact file
 * with `--allow-secret-file <path>`: credential files — `.env*`, `.envrc`, private keys (`*.pem`,
 * `*.key`, `id_rsa*`, `id_ed25519*`), `.npmrc`, `.pypirc`, `.netrc`, `credentials.json`, and the
 * `.aws/`, `.ssh/`, `.gnupg/` folders (`secretFileReason` in @create/apps-mcp). Secret VALUES belong
 * in `create env set KEY --secret`.
 *
 * Every archived path goes through `safeArchivePath`, so the tarball can never write outside its root.
 */

export type Skipped = { path: string; reason: string };
export type PackResult = { tarball: Uint8Array; sha256: string; fileCount: number; totalBytes: number; files: string[]; skipped: Skipped[] };
export type PackOptions = {
  /** Relative POSIX paths of credential files a person explicitly chose to deploy anyway (one flag per file). */
  allowSecretFiles?: readonly string[];
  maxBytes?: number;
  maxFiles?: number;
  /**
   * E1: false for an edge bundle folder (`create-edge.json` at its root). Such a folder IS build
   * output, which `.gitignore` files usually exclude (`dist/`, `.open-next/`, `public/build/`), so only
   * `.createignore` and the built-in and credential exclusions apply. Default true.
   */
  gitignore?: boolean;
  /** Only decide which files would go (no bytes read, no tarball): the local edge build copies exactly these. */
  listOnly?: boolean;
};

export const PACK_MAX_BYTES = 500 * 1024 * 1024;
export const PACK_MAX_FILES = 50_000;

/** Always left out, whatever the ignore files say: VCS data, dependency trees, our own link file, OS litter. */
const BUILT_IN = ['.git/', '.hg/', '.svn/', 'node_modules/', '.create/', '.DS_Store', 'Thumbs.db', '.vercel/', '.netlify/'];

/** True for an `.env` file that holds values (examples and templates are fine). */
export function isEnvFile(path: string): boolean {
  return secretFileReason(path) === 'environment file with secrets';
}

export class PackError extends Error {
  constructor(
    readonly code: 'not_a_directory' | 'too_large' | 'too_many_files' | 'empty',
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

const toPosix = (p: string) => p.split(sep).join('/');

export function packDirectory(dir: string, options: PackOptions = {}): PackResult {
  const root = resolve(dir);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new PackError('not_a_directory', `${dir} is not a folder`, 'Run create deploy inside your project folder, or pass --dir <folder>.');
  const maxBytes = options.maxBytes ?? PACK_MAX_BYTES;
  const maxFiles = options.maxFiles ?? PACK_MAX_FILES;
  const builtIn: IgnoreRule[] = BUILT_IN.map((p) => compileRule(p, '', 'built-in')!);
  const createIgnore = existsSync(join(root, '.createignore')) ? parseIgnoreFile(readFileSync(join(root, '.createignore'), 'utf8'), '', '.createignore') : [];

  const entries: TarEntry[] = [];
  const skipped: Skipped[] = [];
  let totalBytes = 0;

  const allowed = new Set((options.allowSecretFiles ?? []).map((p) => safeArchivePath(p) ?? p));
  const walk = (abs: string, rel: string, inherited: IgnoreRule[]) => {
    const gitignore = join(abs, '.gitignore');
    const local = options.gitignore !== false && existsSync(gitignore) ? parseIgnoreFile(readFileSync(gitignore, 'utf8'), rel, `${rel ? `${rel}/` : ''}.gitignore`) : [];
    const rules = [...inherited, ...local];
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) {
        skipped.push({ path: childRel, reason: 'symbolic link (never followed)' });
        continue;
      }
      const isDir = stat.isDirectory();
      if (matchIgnore(builtIn, childRel, isDir)) continue;
      // .createignore last: it may re-include what a .gitignore excluded.
      const decided = matchIgnore([...rules, ...createIgnore], childRel, isDir);
      if (decided && !decided.negate) continue;
      if (isDir) {
        const dirSecret = secretFileReason(childRel, true);
        // A credentials folder is entered only to pick out files a person named explicitly.
        if (dirSecret && ![...allowed].some((p) => p.startsWith(`${childRel}/`))) {
          skipped.push({ path: `${childRel}/`, reason: `${dirSecret}: never uploaded` });
          continue;
        }
        walk(childAbs, childRel, rules);
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ path: childRel, reason: 'not a regular file' });
        continue;
      }
      const secret = secretFileReason(childRel);
      if (secret && !allowed.has(childRel)) {
        skipped.push({ path: childRel, reason: `${secret}: never uploaded; set its values with \`create env set KEY --secret\`, or pass --allow-secret-file ${childRel}` });
        continue;
      }
      const safe = safeArchivePath(toPosix(relative(root, childAbs)));
      if (!safe) {
        skipped.push({ path: childRel, reason: 'unsafe file name' });
        continue;
      }
      totalBytes += stat.size;
      if (totalBytes > maxBytes) throw new PackError('too_large', `The folder is over ${Math.round(maxBytes / 1024 / 1024)} MB`, 'Add build outputs, media and caches to .createignore, or deploy a container image with --image.');
      if (entries.length + 1 > maxFiles) throw new PackError('too_many_files', `The folder has more than ${maxFiles} files`, 'Add generated folders to .createignore.');
      entries.push({ path: safe, data: options.listOnly ? new Uint8Array() : new Uint8Array(readFileSync(childAbs)), mode: stat.mode & 0o111 ? 0o755 : 0o644 });
    }
  };
  walk(root, '', []);
  if (entries.length === 0) throw new PackError('empty', 'There is nothing to deploy in this folder', 'Check your .gitignore and .createignore, or run create deploy in your project folder.');
  if (options.listOnly) return { tarball: new Uint8Array(), sha256: '', fileCount: entries.length, totalBytes, files: entries.map((e) => e.path).sort(), skipped };
  const tarball = createTarGz(entries);
  return { tarball, sha256: sha256Hex(tarball), fileCount: entries.length, totalBytes, files: entries.map((e) => e.path).sort(), skipped };
}
