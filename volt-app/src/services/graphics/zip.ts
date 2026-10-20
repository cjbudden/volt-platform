// ============================================================================
//  A SMALL ZIP READER for graphics template packages (no dependency).
//
//  Reads the central directory, so entries are found by the archive's own
//  index rather than by scanning for local headers (which a data descriptor or
//  a stored nested zip would confuse). Stored (0) and deflate (8) only, which
//  is every zip a desktop or a build tool makes. Zip64 and encryption are
//  refused with a clear message rather than misread.
//
//  Bounded on purpose: a package is a handful of fonts and images, so the
//  caller's limits (entry count, inflated size) stop a zip bomb before it
//  inflates.
// ============================================================================
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry { path: string; data: Buffer }
export interface ZipLimits { maxEntries: number; maxTotalBytes: number }

export class ZipError extends Error {}

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

export function readZip(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  // End of central directory: last 22 bytes plus up to 64 KB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('This is not a readable .zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new ZipError('Zip64 archives are not supported. Re-zip the package normally.');
  if (count > limits.maxEntries) throw new ZipError(`The package has ${count} files, more than the ${limits.maxEntries} allowed.`);
  if (cdOff + cdSize > buf.length) throw new ZipError('The .zip file is truncated.');

  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The .zip file is damaged (central directory).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                        // a directory
    if (name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;  // Finder litter
    if (flags & 0x1) throw new ZipError('Encrypted .zip files are not supported.');
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipError(`The package unpacks to more than ${Math.round(limits.maxTotalBytes / 1e6)} MB.`);

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new ZipError('The .zip file is damaged (local header).');
    const lName = buf.readUInt16LE(localOff + 26);
    const lExtra = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lName + lExtra;
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    else throw new ZipError(`${name}: compression method ${method} is not supported. Re-zip with standard compression.`);
    if (data.length !== usize) throw new ZipError(`${name}: unpacked size does not match the archive.`);
    out.push({ path: name, data });
  }
  return out;
}

/** Build a stored (uncompressed) zip. Used by tests and by "Download files". */
export function writeZip(entries: ZipEntry[]): Buffer {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8'); const crc = crc32(e.data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, e.data); centrals.push(ch, name);
    off += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
