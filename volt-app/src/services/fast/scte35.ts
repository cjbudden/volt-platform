// ============================================================================
//  SCTE-35 splice_info_section, built and read in TypeScript.
//
//  WHY BINARY AND NOT JUST CUE-OUT. Every FAST distributor (Samsung TV Plus,
//  Roku, Pluto, LG, Vizio, Xumo) and every commercial stitcher reads ad
//  breaks from SCTE-35. In HLS it rides in EXT-X-DATERANGE SCTE35-OUT /
//  SCTE35-IN (RFC 8216 4.3.2.7.1) beside the older EXT-X-CUE-OUT / CUE-IN
//  lines many of them still key on; in DASH it is an EventStream with
//  schemeIdUri urn:scte:scte35:2014:xml+bin carrying the same bytes in
//  base64. Emitting the real bytes means a channel we play out can be handed
//  to any of them and their ad insertion just works, and our own stitcher
//  reads the same signal, so there is one break signal, not two.
//
//  Only what a VOD-built channel needs: splice_insert, out (with break
//  duration and auto-return) and in, programme splice, a splice time in PTS.
//  `decode` reads back splice_insert and time_signal, enough to check what we
//  write and to read a live source's cues later.
//
//  Reference: ANSI/SCTE 35 2023r1, section 9.
// ============================================================================

const PTS_HZ = 90_000;
const PTS_WRAP = 2 ** 33;

/** MPEG-2 CRC-32 (poly 0x04C11DB7, no reflection, init 0xFFFFFFFF, no final xor). */
export function crc32mpeg(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

/** Big-endian bit writer, enough for the section's odd field widths (33-bit PTS included). */
class Bits {
  private out: number[] = [];
  private cur = 0;
  private n = 0;
  put(v: number | bigint, width: number) {
    let x = BigInt(v);
    for (let i = width - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | Number((x >> BigInt(i)) & 1n);
      if (++this.n === 8) { this.out.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  bytes(): number[] {
    if (this.n) throw new Error('scte35: section is not byte aligned');
    return this.out;
  }
}

export interface SpliceInsert {
  eventId: number;
  /** true = to the break (cue out), false = back to the programme (cue in). */
  out: boolean;
  /** Splice time as a 90 kHz PTS. Omit for splice_immediate. */
  pts?: number | null;
  /** Break length in seconds, on an out. */
  durationSec?: number | null;
  autoReturn?: boolean;
  uniqueProgramId?: number;
  availNum?: number;
  availsExpected?: number;
}

/** The splice_info_section bytes for a splice_insert. */
export function spliceInsert(s: SpliceInsert): Uint8Array {
  const cmd = new Bits();
  cmd.put(s.eventId >>> 0, 32);
  cmd.put(0, 1);            // splice_event_cancel_indicator
  cmd.put(0x7f, 7);         // reserved
  const hasDur = s.out && s.durationSec != null && s.durationSec > 0;
  const immediate = s.pts == null;
  cmd.put(s.out ? 1 : 0, 1); // out_of_network_indicator
  cmd.put(1, 1);            // program_splice_flag
  cmd.put(hasDur ? 1 : 0, 1);
  cmd.put(immediate ? 1 : 0, 1);
  cmd.put(1, 1);            // event_id_compliance_flag
  cmd.put(0x7, 3);          // reserved
  if (!immediate) {
    cmd.put(1, 1);          // time_specified_flag
    cmd.put(0x3f, 6);
    cmd.put(BigInt(Math.round(s.pts!)) % BigInt(PTS_WRAP), 33);
  }
  if (hasDur) {
    cmd.put(s.autoReturn === false ? 0 : 1, 1);
    cmd.put(0x3f, 6);
    cmd.put(BigInt(Math.round(s.durationSec! * PTS_HZ)) % BigInt(PTS_WRAP), 33);
  }
  cmd.put(s.uniqueProgramId ?? 0, 16);
  cmd.put(s.availNum ?? 0, 8);
  cmd.put(s.availsExpected ?? 0, 8);
  const command = cmd.bytes();

  // everything after section_length, up to (not including) the CRC
  const body = new Bits();
  body.put(0, 8);           // protocol_version
  body.put(0, 1);           // encrypted_packet
  body.put(0, 6);           // encryption_algorithm
  body.put(0, 33);          // pts_adjustment
  body.put(0, 8);           // cw_index
  body.put(0xfff, 12);      // tier
  body.put(command.length, 12);
  body.put(0x05, 8);        // splice_command_type = splice_insert
  const head = body.bytes();
  const rest = [...head, ...command, 0x00, 0x00]; // + descriptor_loop_length 0
  const sectionLength = rest.length + 4;           // + CRC
  const pre = new Bits();
  pre.put(0xfc, 8);         // table_id
  pre.put(0, 1);            // section_syntax_indicator
  pre.put(0, 1);            // private_indicator
  pre.put(0x3, 2);          // sap_type: not specified
  pre.put(sectionLength, 12);
  const all = [...pre.bytes(), ...rest];
  const crc = crc32mpeg(Uint8Array.from(all));
  all.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  return Uint8Array.from(all);
}

export const toHex = (b: Uint8Array) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** PTS for a wall-clock instant on a channel whose media clock is epoch-anchored. */
export function ptsAt(epochMs: number, atMs: number): number {
  return Math.round(((atMs - epochMs) / 1000) * PTS_HZ) % PTS_WRAP;
}

// ---------------------------------------------------------------- reading

class Reader {
  private bit = 0;
  constructor(private b: Uint8Array) {}
  get(width: number): bigint {
    let v = 0n;
    for (let i = 0; i < width; i++) {
      const byte = this.b[this.bit >> 3];
      if (byte === undefined) throw new Error('scte35: section is truncated');
      v = (v << 1n) | BigInt((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }
  num(width: number) { return Number(this.get(width)); }
  skip(width: number) { this.bit += width; }
  get pos() { return this.bit >> 3; }
}

export interface DecodedCue {
  command: 'splice_insert' | 'time_signal' | 'splice_null' | 'other';
  commandType: number;
  crcOk: boolean;
  eventId?: number;
  cancel?: boolean;
  out?: boolean;
  immediate?: boolean;
  pts?: number | null;
  durationSec?: number | null;
  autoReturn?: boolean;
  uniqueProgramId?: number;
}

/** Read a splice_info_section from bytes, hex ("0xFC...") or base64. */
export function decode(input: Uint8Array | string): DecodedCue {
  let b: Uint8Array;
  if (typeof input === 'string') {
    const s = input.trim();
    b = /^0x/i.test(s) ? Uint8Array.from(Buffer.from(s.slice(2), 'hex')) : Uint8Array.from(Buffer.from(s, 'base64'));
  } else b = input;
  const r = new Reader(b);
  if (r.num(8) !== 0xfc) throw new Error('scte35: not a splice_info_section (table_id is not 0xFC)');
  r.skip(4);
  const sectionLength = r.num(12);
  const total = 3 + sectionLength;
  const crcOk = b.length >= total && crc32mpeg(b.subarray(0, total)) === 0;
  r.skip(8 + 1 + 6);
  const ptsAdj = r.num(33);
  r.skip(8 + 12);
  r.skip(12); // splice_command_length
  const type = r.num(8);
  const readTime = () => {
    const specified = r.num(1);
    if (specified) { r.skip(6); return (r.num(33) + ptsAdj) % PTS_WRAP; }
    r.skip(7);
    return null;
  };
  if (type === 0x05) {
    const eventId = r.num(32);
    const cancel = r.num(1) === 1;
    r.skip(7);
    if (cancel) return { command: 'splice_insert', commandType: type, crcOk, eventId, cancel };
    const out = r.num(1) === 1;
    const programSplice = r.num(1) === 1;
    const hasDur = r.num(1) === 1;
    const immediate = r.num(1) === 1;
    r.skip(4);
    let pts: number | null = null;
    if (programSplice && !immediate) pts = readTime();
    if (!programSplice) { const n = r.num(8); for (let i = 0; i < n; i++) { r.skip(8); if (!immediate) readTime(); } }
    let durationSec: number | null = null, autoReturn: boolean | undefined;
    if (hasDur) { autoReturn = r.num(1) === 1; r.skip(6); durationSec = r.num(33) / PTS_HZ; }
    const uniqueProgramId = r.num(16);
    return { command: 'splice_insert', commandType: type, crcOk, eventId, cancel, out, immediate, pts, durationSec, autoReturn, uniqueProgramId };
  }
  if (type === 0x06) return { command: 'time_signal', commandType: type, crcOk, pts: readTime() };
  if (type === 0x00) return { command: 'splice_null', commandType: type, crcOk };
  return { command: 'other', commandType: type, crcOk };
}

/** Stable 32-bit splice_event_id for a break key. */
export function eventIdFor(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) & 0x7fffffff;
}
