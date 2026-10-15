import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * A minimal, dependency-free tar.gz writer (POSIX ustar + PAX long names) and reader, used to package
 * a folder (`create deploy`) or an inline file map (`deploy_files`) as the tarball the upload path
 * takes (spec §8.3). Regular files only: no symlinks, devices or hard links are ever written, and
 * every path is checked by `safeArchivePath` first — relative, forward slashes, no `..`, no absolute
 * or drive-letter paths, no NUL — so an archive we produce can never write outside its root when
 * unpacked ("zip slip"). The reader applies the same check and refuses what fails it.
 */

export type TarEntry = { path: string; data: Uint8Array; mode?: number };

/** Normalize an archive path, or null when it could escape the root or is otherwise unsafe. */
export function safeArchivePath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024) return null;
  if (input.includes('\0')) return null;
  const forward = input.replace(/\\/g, '/');
  if (forward.startsWith('/') || /^[A-Za-z]:/.test(forward) || forward.startsWith('//')) return null;
  const parts: string[] = [];
  for (const part of forward.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    // Control characters in names are refused outright: they make log lines and consoles lie.
    if (/[\u0000-\u001f\u007f]/.test(part)) return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}

const enc = new TextEncoder();

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeString(buf: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = enc.encode(value);
  buf.set(bytes.subarray(0, length), offset);
}

function header(name: string, size: number, mode: number, type: '0' | 'x', prefix = ''): Uint8Array {
  const h = new Uint8Array(512);
  writeString(h, 0, 100, name);
  writeString(h, 100, 8, octal(mode, 8));
  writeString(h, 108, 8, octal(0, 8));
  writeString(h, 116, 8, octal(0, 8));
  writeString(h, 124, 12, octal(size, 12));
  // A fixed mtime keeps archives of the same files byte-identical, so their sha256 is stable.
  writeString(h, 136, 12, octal(0, 12));
  writeString(h, 148, 8, '        ');
  writeString(h, 156, 1, type);
  writeString(h, 257, 6, 'ustar\0');
  writeString(h, 263, 2, '00');
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

function pad(size: number): Uint8Array {
  const rem = size % 512;
  return new Uint8Array(rem === 0 ? 0 : 512 - rem);
}

function splitUstar(path: string): { name: string; prefix: string } | null {
  if (enc.encode(path).length <= 100) return { name: path, prefix: '' };
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(name).length <= 100 && enc.encode(prefix).length <= 155) return { name, prefix };
  }
  return null;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = enc.encode(body).length;
  let total = len + String(len).length;
  if (String(total).length !== String(len).length) total = len + String(total).length;
  return `${total}${body}`;
}

/** Entries → gzipped tar bytes. Throws on an unsafe or duplicate path. */
export function createTarGz(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const path = safeArchivePath(entry.path);
    if (!path) throw new Error(`unsafe archive path: ${JSON.stringify(entry.path)}`);
    if (seen.has(path)) throw new Error(`duplicate archive path: ${path}`);
    seen.add(path);
    const mode = entry.mode ?? 0o644;
    const split = splitUstar(path);
    if (split) {
      chunks.push(header(split.name, entry.data.length, mode, '0', split.prefix));
    } else {
      const pax = enc.encode(paxRecord('path', path));
      chunks.push(header('PaxHeader', pax.length, 0o644, 'x'), pax, pad(pax.length));
      chunks.push(header(path.slice(-100).replace(/^\/+/, ''), entry.data.length, mode, '0'));
    }
    chunks.push(entry.data, pad(entry.data.length));
  }
  chunks.push(new Uint8Array(1024));
  let total = 0;
  for (const c of chunks) total += c.length;
  const tar = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    tar.set(c, off);
    off += c.length;
  }
  return new Uint8Array(gzipSync(tar, { level: 9 }));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const dec = new TextDecoder();
function readString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return dec.decode(end === -1 ? slice : slice.subarray(0, end));
}

/**
 * Read a tar.gz back into entries — for tests and for verifying what a package holds. Refuses any
 * entry type but regular files and PAX headers, and any path `safeArchivePath` rejects.
 */
export function readTarGz(gz: Uint8Array, maxBytes = 512 * 1024 * 1024): TarEntry[] {
  const tar = gunzipSync(gz, { maxOutputLength: maxBytes });
  const out: TarEntry[] = [];
  let off = 0;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(readString(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    const name = readString(h, 0, 100);
    const prefix = readString(h, 345, 155);
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + size + (size % 512 === 0 ? 0 : 512 - (size % 512));
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(data));
      paxPath = m ? m[1]! : null;
      continue;
    }
    if (type !== '0' && type !== '\0') throw new Error(`unsupported tar entry type ${JSON.stringify(type)}`);
    const raw = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    const path = safeArchivePath(raw);
    if (!path || path !== raw.replace(/\\/g, '/').replace(/^\.\//, '')) throw new Error(`unsafe path in archive: ${JSON.stringify(raw)}`);
    out.push({ path, data: new Uint8Array(data), mode: parseInt(readString(h, 100, 8).trim() || '644', 8) });
  }
  return out;
}
