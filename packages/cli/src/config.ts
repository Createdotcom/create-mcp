import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI keeps things.
 *
 * - CREDENTIALS: one file per user, `$CREATE_CONFIG_DIR` or the platform config dir
 *   (`%APPDATA%\create` on Windows, `$XDG_CONFIG_HOME/create` or `~/.config/create` elsewhere),
 *   written with mode 0600 in a 0700 directory. Keyed by API URL so staging and production sign-ins
 *   never mix. The tokens are the only secrets the CLI holds, and they are never printed or logged.
 * - PROJECT LINK: `.create/project.json` in the deployed folder — which project and service this
 *   folder deploys to. No secrets; `.create/` is never uploaded.
 */

export type StoredCredentials = { accessToken: string; refreshToken: string; expiresAt: number; clientId: string };

export const DEFAULT_API_URL = 'https://api.create.com';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CREATE_CONFIG_DIR) return env.CREATE_CONFIG_DIR;
  if (platform() === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'create');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'create');
}

const credentialsFile = (env?: NodeJS.ProcessEnv) => join(configDir(env), 'credentials.json');

function readAll(env?: NodeJS.ProcessEnv): Record<string, StoredCredentials> {
  const file = credentialsFile(env);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredCredentials>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, StoredCredentials>, env?: NodeJS.ProcessEnv): void {
  const file = credentialsFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX modes; the file lives in the user's own profile directory.
  }
}

export function loadCredentials(apiUrl: string, env?: NodeJS.ProcessEnv): StoredCredentials | null {
  return readAll(env)[apiUrl] ?? null;
}

export function saveCredentials(apiUrl: string, creds: StoredCredentials, env?: NodeJS.ProcessEnv): void {
  writeAll({ ...readAll(env), [apiUrl]: creds }, env);
}

export function clearCredentials(apiUrl: string, env?: NodeJS.ProcessEnv): void {
  const all = readAll(env);
  delete all[apiUrl];
  writeAll(all, env);
}

/**
 * An exclusive lock across CLI processes (two terminals, or `create mcp` next to `create deploy`)
 * around token refresh. Refresh tokens rotate and a replayed one revokes the whole sign-in, so two
 * processes must never refresh with the same token: the second waits, then re-reads what the first
 * stored. `open(…, 'wx')` is atomic on every platform Node supports; a lock older than 30 s is from a
 * crashed process and is broken.
 */
export async function withCredentialsLock<T>(env: NodeJS.ProcessEnv | undefined, sleep: (ms: number) => Promise<void>, fn: () => Promise<T>): Promise<T> {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'credentials.lock');
  let fd: number | null = null;
  for (let attempt = 0; fd === null; attempt += 1) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
      } catch {
        // Released between our checks: try again.
      }
      if (attempt > 300) throw new Error('Another create command is refreshing the sign-in; try again in a moment.');
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // Already gone.
    }
  }
}

export type ProjectLink = { projectId: string; projectName: string; service: string };

/**
 * The link file is in a folder a model may write to (`create mcp`), so neither `.create/` nor the files
 * in it may be symbolic links: following one would read, or overwrite, a file anywhere on the machine.
 */
function refuseSymlink(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) throw new LinkError(`${path} is a symbolic link; the CLI never follows one there`);
  // A hard link is the same file as another one elsewhere: writing it would change that file.
  if (st?.isFile() && st.nlink > 1) throw new LinkError(`${path} is hard-linked to another file; the CLI never writes through one`);
}

export class LinkError extends Error {
  readonly code = 'unsafe_link';
  readonly fix = 'Remove the .create folder (or the symbolic link in it) and deploy again.';
}

export function readLink(dir: string): ProjectLink | null {
  const folder = join(dir, '.create');
  const file = join(folder, 'project.json');
  const fileStat = lstatSync(file, { throwIfNoEntry: false });
  if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink() || fileStat?.isSymbolicLink() || (fileStat && fileStat.nlink > 1)) return null;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ProjectLink;
  } catch {
    return null;
  }
}

/** Writes without following a symbolic link at the last step (O_NOFOLLOW), after refusing linked parents. */
function writeNoFollow(path: string, content: string, flags: number): void {
  refuseSymlink(path);
  const fd = openSync(path, flags | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

export function writeLink(dir: string, link: ProjectLink): void {
  const folder = join(dir, '.create');
  refuseSymlink(folder);
  mkdirSync(folder, { recursive: true });
  refuseSymlink(folder);
  writeNoFollow(join(folder, 'project.json'), `${JSON.stringify(link, null, 2)}\n`, fsConstants.O_CREAT | fsConstants.O_TRUNC);
  const readme = join(folder, 'README.txt');
  if (!existsSync(readme) && !lstatSync(readme, { throwIfNoEntry: false })) {
    writeNoFollow(readme, 'This folder is linked to a Create project. project.json holds no secrets. This folder is never uploaded.\n', fsConstants.O_CREAT | fsConstants.O_EXCL);
  }
}
