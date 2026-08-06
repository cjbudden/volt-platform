// Tiny dependency-free image dimension + content-type probe for the common web
// formats (PNG, JPEG, GIF, WebP). Avoids pulling sharp into the control plane just
// to read width/height on upload. Returns null dims if it can't parse the header.
export interface ImageInfo { width: number | null; height: number | null; contentType: string | null }

export function probeImage(buf: Buffer): ImageInfo {
  if (buf.length < 24) return { width: null, height: null, contentType: null };

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR at offset 16 (width, height as uint32 BE)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), contentType: 'image/png' };
  }
  // GIF: 'GIF87a'/'GIF89a', width/height uint16 LE at 6/8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), contentType: 'image/gif' };
  }
  // JPEG: scan SOFn markers for dimensions
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        const height = buf.readUInt16BE(o + 5);
        const width = buf.readUInt16BE(o + 7);
        return { width, height, contentType: 'image/jpeg' };
      }
      const len = buf.readUInt16BE(o + 2);
      o += 2 + len;
    }
    return { width: null, height: null, contentType: 'image/jpeg' };
  }
  // WebP: 'RIFF'....'WEBP'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    try {
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, contentType: 'image/webp' };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, contentType: 'image/webp' };
      }
      if (fmt === 'VP8X') return { width: ((buf.readUIntLE(24, 3)) & 0xffffff) + 1, height: ((buf.readUIntLE(27, 3)) & 0xffffff) + 1, contentType: 'image/webp' };
    } catch { /* fall through */ }
    return { width: null, height: null, contentType: 'image/webp' };
  }
  // SVG (text)
  if (buf.toString('ascii', 0, 5).trim().startsWith('<?xml') || buf.toString('ascii', 0, 4) === '<svg') {
    return { width: null, height: null, contentType: 'image/svg+xml' };
  }
  return { width: null, height: null, contentType: null };
}
