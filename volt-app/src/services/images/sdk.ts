// ============================================================================
//  VOLT IMAGE URL SDK: build and sign image service URLs.
//
//  ONE SOURCE OF TRUTH. This file is copied verbatim into
//    packages/image-url/src/index.ts   (the publishable @volt/image-url package)
//    volt-web/src/lib/imageUrl.ts      (the console)
//  by `node packages/image-url/scripts/sync.js`. Edit it HERE; the images check
//  fails if a copy drifts. It has no imports and no Node or DOM dependency, so
//  the same code signs in Node, a browser, a worker or React Native.
//
//  URL SHAPE
//    {base}/img/{sig}/{spec}/{key}
//      sig   22 chars, base64url of the first 16 bytes of
//            HMAC-SHA256(accountKey, "{spec}/{key}")   (decoded text)
//      spec  "WxH,fit[,token...]"  e.g. 640x360,cover,focus=30-20,q=70
//      key   library/{accountId}/{path}  (or derived/{accountId}/{path})
//
//  The account key is per account (GET /api/images/signing-key, or the
//  `signingKey` field of POST /api/images/sign). It can only sign URLs for that
//  account's own images: the server derives the key from the account id in the
//  path, so a key for account A never verifies a URL for account B.
// ============================================================================

export type ImageFit = 'cover' | 'inside' | 'contain' | 'fill';
export type ImageFormat = 'webp' | 'avif' | 'jpeg' | 'png';
export type ImageGravity =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'smart' | 'entropy';

export interface ImageOptions {
  /** Output width in px. 0 or omitted = auto from the height and source aspect. */
  width?: number;
  /** Output height in px. 0 or omitted = auto from the width and source aspect. */
  height?: number;
  /** cover (default) crop to fill the box, inside fit within, contain letterbox, fill stretch. */
  fit?: ImageFit;
  /** Hard crop applied first, percent of the source (0..100). */
  crop?: { x: number; y: number; w: number; h: number };
  /** Area of focus for cover crops: a point in source percent, or a gravity. */
  focus?: { x: number; y: number } | ImageGravity;
  grayscale?: boolean;
  /** Gaussian blur sigma, 0.3..50. */
  blur?: number;
  /** Brightness percent, 10..300 (100 = unchanged). */
  brightness?: number;
  /** Saturation percent, 0..300 (100 = unchanged). */
  saturation?: number;
  /** true = light sharpen; a number = sharpen sigma 0.3..10. */
  sharpen?: boolean | number;
  /** Letterbox / transparency fill colour, RRGGBB. */
  background?: string;
  /** Encoder quality 1..100 (default 80). Ignored for png. */
  quality?: number;
  /** Output format (default webp). */
  format?: ImageFormat;
  /** Allow upscaling past the source size (default false). */
  enlarge?: boolean;
  /** Cache-busting version, [A-Za-z0-9]{1,32}. Use when an image is replaced at the same path. */
  version?: string;
}

export const IMAGE_SIG_LENGTH = 22;

const round1 = (n: number) => String(Math.round(n * 10) / 10);
const int = (n: number) => String(Math.round(n));

/** The canonical compact spec for a set of options. Token order is fixed, so the
 *  same options always produce the same string, signature and cache entry. */
export function imageSpec(o: ImageOptions): string {
  const w = Math.max(0, Math.round(o.width ?? 0));
  const h = Math.max(0, Math.round(o.height ?? 0));
  if (!w && !h) throw new Error('imageSpec: width or height is required');
  const t: string[] = [`${w}x${h}`, o.fit ?? 'cover'];
  if (o.crop) t.push(`crop=${int(o.crop.x)}-${int(o.crop.y)}-${int(o.crop.w)}-${int(o.crop.h)}`);
  if (o.focus) t.push(typeof o.focus === 'string' ? `focus=${o.focus}` : `focus=${int(o.focus.x)}-${int(o.focus.y)}`);
  if (o.grayscale) t.push('gray');
  if (o.blur) t.push(`blur=${round1(o.blur)}`);
  if (o.brightness != null && o.brightness !== 100) t.push(`bright=${int(o.brightness)}`);
  if (o.saturation != null && o.saturation !== 100) t.push(`sat=${int(o.saturation)}`);
  if (o.sharpen === true) t.push('sharp');
  else if (typeof o.sharpen === 'number' && o.sharpen > 0) t.push(`sharp=${round1(o.sharpen)}`);
  if (o.background) t.push(`bg=${o.background.replace(/^#/, '').toLowerCase()}`);
  if (o.enlarge) t.push('up');
  if (o.quality != null && o.quality !== 80) t.push(`q=${int(o.quality)}`);
  if (o.format && o.format !== 'webp') t.push(`fmt=${o.format}`);
  if (o.version) t.push(`v=${o.version}`);
  return t.join(',');
}

/** The account id inside a store key (library/{acct}/... or derived/{acct}/...). */
export function accountOfKey(key: string): string | null {
  const m = /^(?:library|derived)\/([A-Za-z0-9_-]{1,64})\/./.exec(key.replace(/^\/+/, ''));
  return m ? m[1] : null;
}

/** Percent-encode each path segment, keeping the slashes and the RFC 3986
 *  sub-delimiters a spec uses (, = : ( ) @ ! * ') readable. '+' stays encoded,
 *  because S3 would otherwise read it as a space. */
export function encodeImagePath(path: string): string {
  return path.split('/').map((s) => encodeURIComponent(s)
    .replace(/%(2C|3D|3A|28|29|40|21|2A|27)/gi, (m) => decodeURIComponent(m))).join('/');
}

/** Signature for the decoded text after the signature segment ("{spec}/{key}"). */
export function signImagePath(accountKey: string, path: string): string {
  const mac = hmacSha256(fromBase64Url(accountKey), utf8(path));
  return toBase64Url(mac.subarray(0, 16));
}

export interface SignedImageInput extends ImageOptions {
  /** Store key, e.g. library/{acct}/slates/a.png. A leading slash is tolerated. */
  key: string;
  /** The account's image signing key (base64url). */
  accountKey: string;
  /** Image host, e.g. https://img.example.com. Omit for a root-relative URL. */
  baseUrl?: string;
}

/** A complete signed URL for an image and a set of options. */
export function imageUrl(input: SignedImageInput): string {
  const key = input.key.replace(/^\/+/, '');
  const spec = imageSpec(input);
  const sig = signImagePath(input.accountKey, `${spec}/${key}`);
  const base = (input.baseUrl ?? '').replace(/\/+$/, '');
  return `${base}/img/${sig}/${encodeImagePath(spec)}/${encodeImagePath(key)}`;
}

/** Sign an already-built spec string (e.g. one composed in a URL builder). */
export function signedImageUrlForSpec(accountKey: string, spec: string, key: string, baseUrl = ''): string {
  const k = key.replace(/^\/+/, '');
  const sig = signImagePath(accountKey, `${spec}/${k}`);
  return `${baseUrl.replace(/\/+$/, '')}/img/${sig}/${encodeImagePath(spec)}/${encodeImagePath(k)}`;
}

// ---------------------------------------------------------------------------
//  SHA-256 + HMAC, synchronous and dependency-free (FIPS 180-4, RFC 2104).
//  Small inputs only (URLs), so clarity beats speed here.
// ---------------------------------------------------------------------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key.length > 64 ? sha256(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  k = block;
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) s += B64[n & 63];
  }
  return s;
}

export function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('fromBase64Url: invalid character');
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
