// ============================================================================
//  REAL TYPE FROM THE FIRST BYTES, not from the extension.
//
//  A .mp4 that is a QuickTime file, a .mp3 that is AAC, a .png that is a JPEG:
//  every one of these arrives weekly from somebody's export preset. Recording
//  the declared type makes the library lie; the encoder finds out later and
//  the error message names the wrong thing. Sixteen signatures cover what a
//  media platform actually receives. Anything else is 'application/octet-
//  stream' with the extension kept as a hint, never as a fact.
//
//  No dependency: the signatures are short and stable, and pulling a package
//  in for them would be the only runtime dependency of ingest-core.
// ============================================================================
export interface Sniffed {
  mime: string;
  /** Short container label for humans: 'mp4', 'quicktime', 'mxf', 'mp3' ... */
  container: string;
  /** True when the bytes did not match anything and the mime is a fallback. */
  unknown: boolean;
  /** ID3v2 tag length at the head of an MP3/AAC, 0 if none. */
  id3Bytes: number;
}

const ascii = (b: Buffer, off: number, len: number) => b.subarray(off, off + len).toString('latin1');

export function sniff(head: Buffer, name = ''): Sniffed {
  const b = head;
  const r = (mime: string, container: string, id3 = 0): Sniffed => ({ mime, container, unknown: false, id3Bytes: id3 });
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand.startsWith('qt')) return r('video/quicktime', 'quicktime');
    if (['M4A ', 'M4B ', 'M4P '].includes(brand)) return r('audio/mp4', 'm4a');
    if (['heic', 'heix', 'mif1', 'msf1', 'heif'].includes(brand)) return r('image/heic', 'heic');
    if (brand === 'avif') return r('image/avif', 'avif');
    return r('video/mp4', 'mp4');
  }
  if (b.length >= 4 && b[0] === 0x06 && b[1] === 0x0e && b[2] === 0x2b && b[3] === 0x34) return r('application/mxf', 'mxf');
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML: matroska or webm, decided by the DocType a few bytes in.
    const s = ascii(b, 0, Math.min(b.length, 64));
    return s.includes('webm') ? r('video/webm', 'webm') : r('video/x-matroska', 'matroska');
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF') {
    const t = ascii(b, 8, 4);
    if (t === 'WAVE') return r('audio/wav', 'wav');
    if (t === 'AVI ') return r('video/x-msvideo', 'avi');
    if (t === 'WEBP') return r('image/webp', 'webp');
  }
  if (b.length >= 4 && ascii(b, 0, 4) === 'FORM' && b.length >= 12 && ascii(b, 8, 4).startsWith('AIF')) return r('audio/aiff', 'aiff');
  if (b.length >= 4 && ascii(b, 0, 4) === 'fLaC') return r('audio/flac', 'flac');
  if (b.length >= 4 && ascii(b, 0, 4) === 'OggS') {
    const s = ascii(b, 0, Math.min(b.length, 64));
    return s.includes('OpusHead') ? r('audio/opus', 'opus') : r('audio/ogg', 'ogg');
  }
  if (b.length >= 3 && ascii(b, 0, 3) === 'ID3') {
    // ID3v2 header: size is 4 syncsafe bytes at 6..9, tag = 10 + size.
    const size = b.length >= 10 ? ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f) : 0;
    const after = 10 + size;
    // What follows the tag decides mp3 vs aac; if we cannot see it, assume mp3.
    if (b.length > after + 1 && b[after] === 0xff && (b[after + 1] & 0xf6) === 0xf0) return r('audio/aac', 'aac', after);
    return r('audio/mpeg', 'mp3', after);
  }
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    return (b[1] & 0xf6) === 0xf0 ? r('audio/aac', 'aac') : r('audio/mpeg', 'mp3');
  }
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return r('image/png', 'png');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return r('image/jpeg', 'jpeg');
  if (b.length >= 6 && ascii(b, 0, 4) === 'GIF8') return r('image/gif', 'gif');
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return r('image/tiff', 'tiff');
  if (b.length >= 2 && ascii(b, 0, 2) === 'BM') return r('image/bmp', 'bmp');
  if (b.length >= 5 && /^\s*<(\?xml|svg)/.test(ascii(b, 0, Math.min(b.length, 256)))) return r('image/svg+xml', 'svg');
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return r('video/mpeg', 'mpeg-ps');
  if (b.length >= 189 && b[0] === 0x47 && b[188] === 0x47) return r('video/mp2t', 'mpeg-ts');
  if (b.length >= 4 && b[0] === 0x47 && (b.length < 189)) return r('video/mp2t', 'mpeg-ts');
  return { mime: 'application/octet-stream', container: name ? (/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? 'unknown') : 'unknown', unknown: true, id3Bytes: 0 };
}

/** How many bytes sniff() wants. 256 covers every signature above. */
export const SNIFF_BYTES = 256;
