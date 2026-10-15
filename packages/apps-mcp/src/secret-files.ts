/**
 * Files that hold credentials and are never packaged for a deploy unless a person names each one
 * explicitly (security review of #215, finding 7). Shared by the CLI's folder packager and the MCP
 * `deploy_files` tool, so both refuse the same things for the same stated reason.
 *
 * Paths are POSIX and relative to the deployed folder.
 */

const ENV_EXAMPLE = /\.env\.(example|sample|template|dist|defaults)$/;

const FILE_RULES: { test: (name: string, path: string) => boolean; reason: string }[] = [
  { test: (name, path) => /^\.env(\..+)?$/.test(name) && !ENV_EXAMPLE.test(path), reason: 'environment file with secrets' },
  { test: (name) => name === '.envrc', reason: 'direnv file (usually exports secrets)' },
  { test: (name) => /\.(pem|key|p12|pfx)$/i.test(name), reason: 'private key or certificate bundle' },
  { test: (name) => /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(name) && !name.endsWith('.pub'), reason: 'SSH private key' },
  { test: (name) => name === '.npmrc' || name === '.pypirc' || name === '.netrc' || name === '_netrc', reason: 'package-registry or login credentials' },
  { test: (name) => name === 'credentials.json', reason: 'credentials file' },
];

/** Directories whose whole content is credentials. */
const SECRET_DIRS: Record<string, string> = { '.aws': 'AWS credentials folder', '.ssh': 'SSH keys folder', '.gnupg': 'GnuPG keys folder' };

export const SECRET_FILE_FIX = 'Set secret values with `create env set KEY --secret` (or set_variables with secret: true) instead of deploying the file. To deploy this exact file anyway, pass --allow-secret-file <path>.';

/** Why `path` is refused, or null when it is an ordinary file. */
export function secretFileReason(path: string, isDir = false): string | null {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  for (const dir of isDir ? parts : parts.slice(0, -1)) if (SECRET_DIRS[dir]) return SECRET_DIRS[dir]!;
  if (isDir) return null;
  for (const rule of FILE_RULES) if (rule.test(name, path)) return rule.reason;
  return null;
}
