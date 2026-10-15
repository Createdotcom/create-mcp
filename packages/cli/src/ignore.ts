/**
 * A small `.gitignore` matcher (the subset of gitignore(5) that real projects use): comments, blank
 * lines, `!` negation, trailing-`/` directory-only rules, anchored rules (a leading or inner `/`),
 * `*`, `?`, `[…]` and `**`. Rules from a nested `.gitignore` apply only below its directory, and the
 * last matching rule wins. As in git, a directory that is ignored is not descended into, so nothing
 * inside it can be re-included — the walker in `pack.ts` prunes on `isIgnored(dir, true)`.
 *
 * Paths are always POSIX, relative to the folder being deployed, with no leading `./`.
 */

export type IgnoreRule = { base: string; regex: RegExp; negate: boolean; dirOnly: boolean; source: string };

function globToRegex(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/';
        const after = glob[i + 2] === '/' || i + 2 === glob.length;
        if (before && after) {
          if (glob[i + 2] === '/') {
            out += '(?:.*/)?';
            i += 3;
          } else {
            out += '.*';
            i += 2;
          }
          continue;
        }
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i + 1) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end + 1;
        continue;
      }
    }
    if (c === '\\' && i + 1 < glob.length) {
      out += glob[i + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 2;
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    i += 1;
  }
  return out;
}

/** One line of an ignore file → a rule, or null for a blank line or a comment. `base` is the file's directory ('' for the root). */
export function compileRule(line: string, base: string, source = '.gitignore'): IgnoreRule | null {
  let pattern = line.replace(/\r$/, '');
  if (pattern.startsWith('#') || pattern.trim() === '') return null;
  // Trailing spaces are ignored unless escaped.
  pattern = pattern.replace(/(?<!\\)\s+$/, '').replace(/\\(\s)$/, '$1');
  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) {
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === '') return null;
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const body = globToRegex(pattern);
  const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  return { base, regex, negate, dirOnly, source };
}

export function parseIgnoreFile(text: string, base: string, source?: string): IgnoreRule[] {
  return text
    .split('\n')
    .map((l) => compileRule(l, base, source))
    .filter((r): r is IgnoreRule => r !== null);
}

/** The rule that decided, or null when nothing matched. */
export function matchIgnore(rules: readonly IgnoreRule[], path: string, isDir: boolean): IgnoreRule | null {
  let decided: IgnoreRule | null = null;
  for (const rule of rules) {
    let rel = path;
    if (rule.base) {
      if (!path.startsWith(`${rule.base}/`)) continue;
      rel = path.slice(rule.base.length + 1);
    }
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(rel)) decided = rule;
  }
  return decided;
}

export function isIgnored(rules: readonly IgnoreRule[], path: string, isDir: boolean): boolean {
  const rule = matchIgnore(rules, path, isDir);
  return rule !== null && !rule.negate;
}
