// ============================================================================
//  ID3v2 TEXT FRAMES, enough for a music library.
//
//  Title, artist, album, album artist, track, year, genre, composer, comment
//  and whether cover art is present. v2.3 and v2.4 frames, v2.2 three-letter
//  frames mapped. Unsynchronisation and compressed frames are skipped rather
//  than mis-read. Everything else in the tag is ignored on purpose: the goal
//  is the fields a content type can use, not a tag editor.
// ============================================================================
export interface Id3Tags {
  title?: string; artist?: string; album?: string; albumArtist?: string;
  track?: string; year?: string; genre?: string; composer?: string; comment?: string;
  hasCover?: boolean;
  version?: string;
}

const MAP: Record<string, keyof Id3Tags> = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album', TAL: 'album',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TRCK: 'track', TRK: 'track',
  TYER: 'year', TDRC: 'year', TYE: 'year',
  TCON: 'genre', TCO: 'genre',
  TCOM: 'composer', TCM: 'composer',
};

function syncsafe(b: Buffer, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function text(frame: Buffer): string {
  if (frame.length < 1) return '';
  const enc = frame[0]; const body = frame.subarray(1);
  let s: string;
  if (enc === 0) s = body.toString('latin1');
  else if (enc === 3) s = body.toString('utf8');
  else if (enc === 1) {
    // UTF-16 with BOM
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) s = swap16(body.subarray(2)).toString('utf16le');
    else s = body.subarray(body.length >= 2 && body[0] === 0xff ? 2 : 0).toString('utf16le');
  } else s = swap16(body).toString('utf16le'); // UTF-16BE without BOM
  return s.replace(/\0+$/g, '').split('\0')[0].trim();
}
function swap16(b: Buffer): Buffer { const o = Buffer.from(b); o.swap16(); return o; }

/** Genre "(17)Rock" and "17" forms map to the ID3v1 table for the common ones. */
const GENRES = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','AlternRock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychadelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock'];
function genre(s: string): string {
  const m = /^\((\d+)\)(.*)$/.exec(s) ?? /^(\d+)$/.exec(s);
  if (m) { const n = Number(m[1]); const rest = (m[2] ?? '').trim(); return rest || GENRES[n] || s; }
  return s;
}

/** Parse an ID3v2 tag at the start of `buf`. Returns null when there is none. */
export function readId3v2(buf: Buffer): Id3Tags | null {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const major = buf[3]; const flags = buf[5];
  const size = syncsafe(buf, 6);
  const end = Math.min(buf.length, 10 + size);
  const out: Id3Tags = { version: `2.${major}` };
  if (flags & 0x80) return out;               // unsynchronised tag: skip rather than mis-read
  let o = 10;
  if (flags & 0x40) {                         // extended header
    const ehs = major === 4 ? syncsafe(buf, o) : buf.readUInt32BE(o);
    o += major === 4 ? ehs : ehs + 4;
  }
  while (o + (major === 2 ? 6 : 10) <= end) {
    let id: string, len: number, hdr: number, fflags = 0;
    if (major === 2) { id = buf.toString('latin1', o, o + 3); len = (buf[o + 3] << 16) | (buf[o + 4] << 8) | buf[o + 5]; hdr = 6; }
    else { id = buf.toString('latin1', o, o + 4); len = major === 4 ? syncsafe(buf, o + 4) : buf.readUInt32BE(o + 4); fflags = buf.readUInt16BE(o + 8); hdr = 10; }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || len <= 0) break;    // padding
    const start = o + hdr; const stop = Math.min(end, start + len);
    if (stop <= start) break;
    const compressedOrEncrypted = major === 4 ? (fflags & 0x0c) : (fflags & 0xc0);
    if (!compressedOrEncrypted) {
      const body = buf.subarray(start, stop);
      const key = MAP[id];
      if (key) { const v = text(body); if (v) (out as any)[key] = key === 'genre' ? genre(v) : v; }
      else if (id === 'COMM' || id === 'COM') {
        // enc(1) lang(3) short-desc\0 text
        if (body.length > 4) { const rest = Buffer.concat([body.subarray(0, 1), body.subarray(4)]); const t = text(rest); const parts = t.split('\0'); const v = (parts[1] ?? parts[0] ?? '').trim(); if (v && !out.comment) out.comment = v; }
      }
      else if (id === 'APIC' || id === 'PIC') out.hasCover = true;
    }
    o = stop;
  }
  return out;
}
