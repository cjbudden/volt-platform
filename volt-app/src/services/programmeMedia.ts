// ============================================================================
//  WHERE CAN I WATCH OR HEAR THIS AGAIN? (24 Oct 2026)
//
//  A guide entry and a now-playing log entry are the same row (programmes),
//  and once it has aired the operator's next question is "where is it": the
//  VOD asset made from it, or failing that the recording that still holds it.
//  Every surface outside the EPG editor (the station's metadata log, the
//  channel's guide strip, the Live Streams timeline, the EPG drawer's open
//  buttons) asks that through this one function, so they cannot disagree.
//
//    asset      programmes.clip_asset_id, when that asset still exists. A song
//               or show turned into VOD, by auto VOD or by hand.
//    recording  the capture that holds the slot: same owner, its window
//               overlaps the slot, not errored, not past its expiry. The
//               link carries the slot's own from/to, so the workbench opens
//               with exactly that range marked.
//
//  DECLARED WINDOWS, ON PURPOSE. The recording row says what was captured;
//  the disk says what is still there. Measuring the disk per row (as
//  epgVod.ts does for convertibility) is the right answer to "can this become
//  VOD", and too slow for a 50-row log page. A link only has to open the right
//  capture; the workbench itself then shows the real media and any gap.
//
//  One query for the assets and one for the recordings, whatever the number
//  of rows, so a page of the metadata log stays two round trips.
// ============================================================================
import { query } from '../db';

/** Where a VOD asset stands with viewers (vod_assets.availability_state). */
export type VodPublish = 'draft' | 'scheduled' | 'published' | 'expired' | 'withdrawn';
export interface FlagAsset { id: string; title: string | null; publish?: VodPublish | null; from?: string | null; until?: string | null }

export interface ProgrammeMedia {
  asset: FlagAsset | null;
  recording: { id: string; from: number; to: number; partial: boolean; expiresAt: string | null } | null;
  /** The ONE flag to show for this entry (flagFor below). Null = show nothing. */
  flag: ProgrammeFlag | null;
  /** Set when a recording covered it and was removed. */
  expired?: { removedAt: string | null } | null;
}

// ----------------------------------------------------------------------------
//  THE FLAG (24 Oct 2026). One per guide entry or logged song, the most useful
//  thing about it right now, in a fixed precedence, so every surface (EPG grid
//  and day view, the guide strip, the Live Streams timeline, the metadata log)
//  says the same thing:
//
//    before air   autovod      set to become VOD once it has aired
//                 (nothing)    it will be recorded; everything is, so no flag
//    on air       autovod      (the ON AIR pill is the surface's own)
//    aired        vod          an asset exists                 -> the asset
//                              coloured by where it stands with viewers:
//                                blue   created, not published (draft, or
//                                       scheduled to publish later)
//                                green  published, viewers can watch it
//                                grey   expired or withdrawn (restricted)
//                 converting   auto VOD is (or is about to be) building it
//                 failed       auto VOD failed, recording kept -> the recording
//                 rec          recording kept, no asset        -> the recording
//                              `warn` when it is removed within WARN_DAYS
//                 expired      it WAS recorded; the keep period removed it, no asset
//                 notrecorded  no recording ever covered it (recording off, or
//                              the stream was down), no asset
//                 unavailable  cannot tell: the records say it is there and the
//                              disk says it is not, or the records were lost
//
//  Removed recordings keep their row as a tombstone (storage_state 'deleted',
//  services/media/retention.ts), which is what makes expired and not recorded
//  two different, honest answers.
//
//  The tooltip carries the rest of the story (what, when, until when).
// ----------------------------------------------------------------------------
export type FlagKind = 'autovod' | 'vod' | 'converting' | 'failed' | 'rec' | 'expired' | 'notrecorded' | 'unavailable';
export interface ProgrammeFlag {
  kind: FlagKind;
  /** REC about to be removed (or FAILED whose recording is). */
  warn: boolean;
  /** Days until the recording is removed; null = kept indefinitely or n/a. */
  daysLeft: number | null;
  partial: boolean;
  /** VOD only: draft | scheduled | published | expired | withdrawn. */
  publish: VodPublish | null;
  /** What a click opens. */
  assetId: string | null;
  recording: { id: string; from: number; to: number } | null;
  /** One line for the tooltip. */
  note: string;
}

/** A recording removed within this many days is flagged in amber. */
export const WARN_DAYS = 2;
const DAY = 86_400_000;

export interface FlagInput {
  startMs: number; endMs: number; nowMs: number;
  autoVod: boolean;
  clipStatus: string | null;        // none | firing | created | error
  clipError?: string | null;
  asset: FlagAsset | null;
  recording: ProgrammeMedia['recording'];
  /** Disk says nothing covers it any more (epgVod measured), whatever the rows say. */
  measuredGone?: boolean;
  /** A recording covered it once and has since been removed (tombstone or expiry). */
  expiredRecording?: { removedAt: string | null } | null;
}

const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });

/** Pure: the flag for one entry. */
export function flagFor(i: FlagInput): ProgrammeFlag | null {
  const base = { warn: false, daysLeft: null as number | null, partial: false, publish: null as VodPublish | null, assetId: null as string | null, recording: null as ProgrammeFlag['recording'] };
  const rec = i.measuredGone ? null : i.recording;
  const recLink = rec ? { id: rec.id, from: rec.from, to: rec.to } : null;
  const expMs = rec?.expiresAt ? Date.parse(rec.expiresAt) : NaN;
  const daysLeft = Number.isFinite(expMs) ? Math.max(0, Math.ceil((expMs - i.nowMs) / DAY)) : null;
  const keptNote = rec ? (daysLeft == null ? 'Recording kept indefinitely.' : `Recording removed ${fmtDay(expMs)} (in ${daysLeft} day${daysLeft === 1 ? '' : 's'}).`) : '';

  if (i.asset && i.clipStatus !== 'firing') {
    const pub = i.asset.publish ?? 'draft';
    const fromMs = i.asset.from ? Date.parse(i.asset.from) : NaN;
    const untilMs = i.asset.until ? Date.parse(i.asset.until) : NaN;
    const pubNote = pub === 'published' ? `Published${Number.isFinite(untilMs) ? ` until ${fmtDay(untilMs)}` : ''}: viewers can watch it.`
      : pub === 'scheduled' ? `Not published yet: goes out${Number.isFinite(fromMs) ? ` ${fmtDay(fromMs)}` : ' on its schedule'}.`
      : pub === 'expired' ? 'Expired: its availability window has ended, viewers can no longer watch it.'
      : pub === 'withdrawn' ? 'Withdrawn: taken off for viewers.'
      : 'Created, not published: viewers cannot see it yet.';
    return { ...base, kind: 'vod', publish: pub, assetId: i.asset.id, recording: recLink,
      note: `VOD asset${i.asset.title ? ` "${i.asset.title}"` : ''}. ${pubNote} ${keptNote}`.trim() };
  }
  if (i.clipStatus === 'firing') {
    return { ...base, kind: 'converting', recording: recLink, note: 'Auto VOD is building the asset now.' };
  }
  if (i.endMs > i.nowMs) {
    return i.autoVod ? { ...base, kind: 'autovod', note: 'Set to become a VOD asset once it has aired.' } : null;
  }
  const warn = daysLeft != null && daysLeft <= WARN_DAYS;
  if (i.clipStatus === 'error') {
    return { ...base, kind: 'failed', warn, daysLeft, partial: !!rec?.partial, recording: recLink,
      note: `Auto VOD failed${i.clipError ? `: ${i.clipError}` : ''}. ${rec ? keptNote : 'The recording is gone.'}`.trim() };
  }
  if (rec && i.autoVod) {
    return { ...base, kind: 'converting', recording: recLink, note: 'Aired; auto VOD will build the asset shortly.' };
  }
  if (rec) {
    return { ...base, kind: 'rec', warn, daysLeft, partial: rec.partial, recording: recLink,
      note: `Recorded, no VOD asset. ${keptNote}${rec.partial ? ' The recording covers only part of it.' : ''}` };
  }
  if (i.expiredRecording) {
    const at = i.expiredRecording.removedAt ? Date.parse(i.expiredRecording.removedAt) : NaN;
    return { ...base, kind: 'expired', note: `Expired: it was recorded, and the recording was removed${Number.isFinite(at) ? ` on ${fmtDay(at)}` : ''} by the keep period. No VOD was made.` };
  }
  if (i.measuredGone && i.recording) {
    return { ...base, kind: 'unavailable', note: 'Unavailable: a recording is listed for it, but its media cannot be found. No VOD was made.' };
  }
  return { ...base, kind: 'notrecorded', note: 'Not recorded: no recording covered it (recording was off, or the stream was down). No VOD was made.' };
}

export interface ProgrammeLike {
  id: string;
  channel_id?: string | null;
  event_id?: string | null;
  starts_at: string | Date;
  ends_at: string | Date;
  actual_start?: string | Date | null;
  actual_end?: string | Date | null;
  clip_asset_id?: string | null;
  auto_vod?: boolean | null;
  clip_status?: string | null;
  clip_error?: string | null;
}

const ms = (v: string | Date | null | undefined) => (v == null ? NaN : new Date(v).getTime());

/** The media and flag behind each programme. Future slots get only an Auto VOD flag. */
export async function programmeMedia(rows: ProgrammeLike[], nowMs = Date.now()): Promise<Map<string, ProgrammeMedia>> {
  const out = new Map<string, ProgrammeMedia>();
  // Not yet started: only Auto VOD can be flagged, and that needs no query.
  for (const r of rows) {
    if (ms(r.actual_start ?? r.starts_at) < nowMs) continue;
    out.set(r.id, { asset: null, recording: null, flag: flagFor({ startMs: ms(r.starts_at), endMs: ms(r.ends_at), nowMs,
      autoVod: !!r.auto_vod, clipStatus: r.clip_status ?? null, asset: null, recording: null }) });
  }
  const aired = rows.filter((r) => ms(r.actual_start ?? r.starts_at) < nowMs);
  if (!aired.length) return out;

  const assetIds = [...new Set(aired.map((r) => r.clip_asset_id).filter(Boolean) as string[])];
  const assets = assetIds.length === 0 ? [] : await query<any>(
    `SELECT id, title, availability_state, published, available_from, available_until FROM vod_assets WHERE id = ANY($1::uuid[])`, [assetIds]);
  const assetBy = new Map(assets.map((a: any) => [String(a.id), a]));

  const owners = [...new Set(aired.map((r) => r.channel_id ?? r.event_id).filter(Boolean) as string[])];
  const lo = Math.min(...aired.map((r) => ms(r.actual_start ?? r.starts_at)));
  const hi = Math.max(...aired.map((r) => Math.min(ms(r.actual_end ?? r.ends_at), nowMs)));
  const recs = owners.length === 0 ? [] : await query<any>(
    `SELECT id, channel_id, event_id, start_epoch_ms, end_epoch_ms, expires_at,
            (COALESCE(storage_state::text, '') IN ('deleting','deleted')
              OR (expires_at IS NOT NULL AND expires_at <= now())) AS removed
       FROM recordings
      WHERE (channel_id = ANY($1::uuid[]) OR event_id = ANY($1::uuid[]))
        AND status <> 'error'
        AND start_epoch_ms < $3 AND COALESCE(end_epoch_ms, $4) > $2
      ORDER BY start_epoch_ms`,
    [owners, lo, hi, nowMs]);

  for (const r of aired) {
    const owner = r.channel_id ?? r.event_id;
    const from = ms(r.actual_start ?? r.starts_at);
    const to = Math.min(ms(r.actual_end ?? r.ends_at), nowMs);
    let best: any = null; let bestOverlap = 0; let gone: any = null;
    for (const x of recs) {
      if ((x.channel_id ?? x.event_id) !== owner) continue;
      const rs = Number(x.start_epoch_ms); const re = x.end_epoch_ms == null ? nowMs : Number(x.end_epoch_ms);
      const ov = Math.min(re, to) - Math.max(rs, from);
      if (ov <= 0) continue;
      if (x.removed) { if (!gone) gone = x; continue; }
      if (ov > bestOverlap) { best = { ...x, rs, re }; bestOverlap = ov; }
    }
    const a = r.clip_asset_id ? assetBy.get(String(r.clip_asset_id)) : null;
    const asset: FlagAsset | null = a ? { id: String(a.id), title: a.title ?? null, publish: publishOf(a.availability_state, a.published),
      from: a.available_from ? new Date(a.available_from).toISOString() : null,
      until: a.available_until ? new Date(a.available_until).toISOString() : null } : null;
    const recording = best ? { id: String(best.id), from, to, partial: best.rs > from + 1000 || best.re < to - 1000,
      expiresAt: best.expires_at ? new Date(best.expires_at).toISOString() : null } : null;
    const expired = gone ? { removedAt: gone.expires_at ? new Date(gone.expires_at).toISOString() : null } : null;
    out.set(r.id, { asset, recording, expired, flag: flagFor({
      startMs: from, endMs: ms(r.actual_end ?? r.ends_at), nowMs, autoVod: !!r.auto_vod,
      clipStatus: r.clip_status ?? null, clipError: r.clip_error ?? null, asset, recording,
      expiredRecording: expired,
    }) });
  }
  return out;
}

/** availability_state -> the flag's publish state ('available' reads as published). */
export function publishOf(state: string | null | undefined, published?: boolean | null): VodPublish {
  // An asset from before availability existed is 'draft' with the old
  // `published` flag deciding, exactly as onDemandAccess() plays it.
  if ((state ?? 'draft') === 'draft' && published) return 'published';
  return state === 'available' ? 'published' : state === 'scheduled' ? 'scheduled'
    : state === 'expired' ? 'expired' : state === 'withdrawn' ? 'withdrawn' : 'draft';
}
