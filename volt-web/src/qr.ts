/**
 * Minimal QR encoder — byte mode, ECC level L or M, versions 1..10 (up to ~270
 * characters), no dependencies. Enough for a share URL, and small enough to read.
 *
 * Returns a square boolean matrix (true = dark module). Render it however you like;
 * `qrSvg()` gives a crisp, printable SVG.
 */

type Ecc = 'L' | 'M'

// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks?, group2DataCodewords?]
const BLOCKS: Record<Ecc, number[][]> = {
  L: [
    [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108],
    [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43],
    [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
}
// alignment pattern centres per version (index = version - 1)
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

/* ------------------------------------------------------------- GF(256) ---- */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** Reed-Solomon generator polynomial of the given degree, ascending by degree. */
function rsPoly(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i])
      next[j + 1] ^= poly[j]
    }
    poly = next
  }
  return poly
}

function rsRemainder(data: number[], ecLen: number): number[] {
  // rsPoly is ascending by degree and monic; the division below wants the
  // coefficients descending, without the leading 1
  const gen = rsPoly(ecLen).slice(0, ecLen).reverse()
  const rem = new Array(ecLen).fill(0)
  for (const b of data) {
    const factor = b ^ rem[0]
    rem.shift()
    rem.push(0)
    for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i], factor)
  }
  return rem
}

/* --------------------------------------------------------------- BCH ------ */
/** Remainder of data*x^bits divided by `poly` in GF(2) — the format/version check bits. */
function bch(data: number, poly: number, bits: number): number {
  let d = data << bits
  for (let i = polyDeg(d); i >= bits; i--) {
    if ((d >> i) & 1) d ^= poly << (i - bits)
  }
  return d
}
const polyDeg = (n: number) => { let d = -1; while (n) { d++; n >>>= 1 } return d }

/* ------------------------------------------------------------ encoding ---- */
function capacityBits(version: number, ecc: Ecc): number {
  const b = BLOCKS[ecc][version - 1]
  const data = b[1] * b[2] + (b[3] ? b[3] * b[4] : 0)
  return data * 8
}

function encodeData(bytes: number[], version: number, ecc: Ecc): number[] {
  const bits: number[] = []
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }
  push(0b0100, 4)                               // byte mode
  push(bytes.length, version < 10 ? 8 : 16)     // character count
  for (const b of bytes) push(b, 8)

  const cap = capacityBits(version, ecc)
  if (bits.length > cap) throw new Error('data too long for this QR version')
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0)   // terminator
  while (bits.length % 8) bits.push(0)                            // byte align
  const pad = [0xec, 0x11]
  for (let i = 0; bits.length < cap; i++) push(pad[i % 2], 8)

  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    codewords.push(v)
  }

  // split into blocks, compute EC per block, then interleave
  const [ecLen, g1, d1, g2 = 0, d2 = 0] = BLOCKS[ecc][version - 1]
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let at = 0
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? d1 : d2
    const blk = codewords.slice(at, at + len)
    at += len
    dataBlocks.push(blk)
    ecBlocks.push(rsRemainder(blk, ecLen))
  }
  const out: number[] = []
  const maxData = Math.max(d1, d2)
  for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i])
  for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) out.push(blk[i])
  return out
}

/* ------------------------------------------------------------- matrix ----- */
function buildMatrix(version: number, ecc: Ecc, codewords: number[]): boolean[][] {
  const size = version * 4 + 17
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null))

  const setFn = (r: number, c: number, v: boolean) => { m[r][c] = v }
  // finders + separators
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
      setFn(rr, cc, inRing || inCore)
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0)

  // timing
  for (let i = 8; i < size - 8; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0) }

  // alignment
  const centres = ALIGN[version - 1]
  for (const r0 of centres) for (const c0 of centres) {
    if ((r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8)) continue
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      setFn(r0 + r, c0 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1)
    }
  }

  // dark module + reserve format areas
  setFn(size - 8, 8, true)
  for (let i = 0; i < 9; i++) { if (m[8][i] === null) setFn(8, i, false); if (m[i][8] === null) setFn(i, 8, false) }
  for (let i = 0; i < 8; i++) { if (m[8][size - 1 - i] === null) setFn(8, size - 1 - i, false); if (m[size - 1 - i][8] === null) setFn(size - 1 - i, 8, false) }

  // version info (v7+)
  if (version >= 7) {
    const bits = (version << 12) | bch(version, 0x1f25, 12)
    for (let i = 0; i < 18; i++) {
      const b = ((bits >> i) & 1) === 1
      setFn(Math.floor(i / 3), size - 11 + (i % 3), b)
      setFn(size - 11 + (i % 3), Math.floor(i / 3), b)
    }
  }

  // data, zigzag from bottom-right
  let bitIdx = 0
  const nextBit = () => {
    const byte = codewords[bitIdx >> 3]
    const b = byte === undefined ? 0 : (byte >> (7 - (bitIdx & 7))) & 1
    bitIdx++
    return b === 1
  }
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--                       // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (m[row][c] === null) m[row][c] = nextBit()
      }
    }
    upward = !upward
  }

  // pick the mask with the lowest penalty
  let best: boolean[][] | null = null
  let bestPenalty = Infinity
  let bestMask = 0
  for (let mask = 0; mask < 8; mask++) {
    const cand = applyMask(m as boolean[][], mask, size, version)
    const p = penalty(cand, size)
    if (p < bestPenalty) { bestPenalty = p; best = cand; bestMask = mask }
  }
  const out = best!
  writeFormat(out, size, ecc, bestMask)
  return out
}

function isFunction(size: number, version: number, r: number, c: number): boolean {
  if (r === 6 || c === 6) return true                                   // timing
  if (r < 9 && c < 9) return true                                       // TL finder + format
  if (r < 9 && c >= size - 8) return true                               // TR finder + format
  if (r >= size - 8 && c < 9) return true                               // BL finder + format
  if (version >= 7 && ((r < 6 && c >= size - 11) || (c < 6 && r >= size - 11))) return true
  for (const r0 of ALIGN[version - 1]) for (const c0 of ALIGN[version - 1]) {
    if ((r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8)) continue
    if (Math.abs(r - r0) <= 2 && Math.abs(c - c0) <= 2) return true
  }
  return false
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function applyMask(m: boolean[][], mask: number, size: number, version: number): boolean[][] {
  const out = m.map(row => row.slice())
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (isFunction(size, version, r, c)) continue
    if (MASKS[mask](r, c)) out[r][c] = !out[r][c]
  }
  return out
}

function writeFormat(m: boolean[][], size: number, ecc: Ecc, mask: number) {
  const eccBits = ecc === 'L' ? 0b01 : 0b00
  const data = (eccBits << 3) | mask
  const bits = (((data << 10) | bch(data, 0x537, 10)) ^ 0x5412) & 0x7fff
  const bit = (i: number) => ((bits >> i) & 1) === 1
  // copy 1: down the left of the top-right finder, then along the top of the
  // bottom-left one (bit 0 at the top)
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i)
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8)
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i)
  // copy 2: along row 8 from the right edge, then down column 8 to the bottom
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i)
  m[size - 8][8] = true   // always dark
}

function penalty(m: boolean[][], size: number): number {
  let p = 0
  // rule 1: runs of 5+
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map(r => r[i])]) {
      let run = 1
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++ }
        else run = 1
      }
    }
  }
  // rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c]
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3
  }
  // rule 3: finder-like patterns
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false]
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true]
  const matches = (line: boolean[], at: number, pat: boolean[]) => pat.every((v, k) => line[at + k] === v)
  for (let i = 0; i < size; i++) {
    const row = m[i], col = m.map(r => r[i])
    for (let j = 0; j + 11 <= size; j++) {
      for (const line of [row, col]) { if (matches(line, j, pat1) || matches(line, j, pat2)) p += 40 }
    }
  }
  // rule 4: dark/light balance
  let dark = 0
  for (const row of m) for (const v of row) if (v) dark++
  const pct = (dark * 100) / (size * size)
  p += Math.floor(Math.abs(pct - 50) / 5) * 10
  return p
}

/* ---------------------------------------------------------------- api ----- */
/** Encode a string as a QR matrix (true = dark). Throws if it will not fit v1..10. */
export function qrMatrix(text: string, ecc: Ecc = 'M'): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text))
  for (let version = 1; version <= 10; version++) {
    const headerBits = 4 + (version < 10 ? 8 : 16)
    if (headerBits + bytes.length * 8 <= capacityBits(version, ecc)) {
      return buildMatrix(version, ecc, encodeData(bytes, version, ecc))
    }
  }
  throw new Error('text too long to encode as a QR code')
}

/** A self-contained SVG for the text. `size` is the pixel width of the square. */
export function qrSvg(text: string, size = 180, opts: { ecc?: Ecc; dark?: string; light?: string } = {}): string {
  const m = qrMatrix(text, opts.ecc ?? 'M')
  const n = m.length
  const quiet = 4
  const total = n + quiet * 2
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" fill="${opts.light ?? '#ffffff'}"/>` +
    `<path d="${d}" fill="${opts.dark ?? '#000000'}"/></svg>`
}
