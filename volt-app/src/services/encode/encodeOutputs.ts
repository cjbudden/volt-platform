// ============================================================================
//  WHAT A VOD ENCODE PRODUCED, OUTPUT BY OUTPUT (the Encoding queue's job view).
//
//  Read from three places, because each knows a different part:
//   - the asset row: the ladder the job decided (encode_result), the manifests
//     it published (master_key, formats), the thumbnail candidates
//     (poster_candidates), the chosen image (poster_key) and the sprite layout
//   - the disk: every rendition folder the encoder is writing, with its init
//     segment, segment count and size, so a RUNNING encode shows its renditions
//     filling up before the asset row knows about them
//   - the jobs table: the follow-on jobs the encode queued for the asset
//     (asset image, skip markers, social formats tracking, QC), with their state
//  And from the job's own result: how the thumbnail and sprite steps went
//  (outputs.thumbnails / sprites / image), including a failure that did not
//  fail the encode.
// ============================================================================
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config';
import { one, query } from '../../db';

type State = 'ok' | 'running' | 'pending' | 'failed' | 'skipped' | 'missing';

export interface RenditionOut { name: string; planned: boolean; state: State; width?: number | null; height?: number | null; bitrateKbps?: number | null; codec?: string | null; init: boolean; segments: number; bytes: number }
export interface EncodeOutputs {
  asset: { id: string; title: string | null; exists: boolean; dir: string; store: 'local' | 's3' }
  renditions: RenditionOut[]
  manifests: { name: string; state: State; path: string | null }[]
  thumbnails: { state: State; count: number; chosen: string | null; source: string | null; error?: string; detail?: string }
  sprites: { state: State; sheets: number; previews: number; intervalMs: number | null; error?: string; detail?: string }
  followOn: { id: string; type: string; label: string; state: string; progressPct: number; note: string | null; error: string | null; finishedAt: string | null }[]
}

const FOLLOW_ON: Record<string, string> = {
  'vod.image': 'Asset image', 'vod.markers': 'Skip markers', 'reframe.analyse': 'Social formats tracking', 'qc.run': 'Quality check',
};

function dirStats(dir: string): { init: boolean; segments: number; bytes: number } {
  let segments = 0, bytes = 0, init = false;
  try {
    for (const f of readdirSync(dir)) {
      if (f === 'init.mp4') init = true;
      else if (!/\.(m4s|ts|mp4|aac|m4a)$/.test(f)) continue;
      else segments++;
      try { bytes += statSync(join(dir, f)).size; } catch { /* written as we look */ }
    }
  } catch { /* not there (yet) */ }
  return { init, segments, bytes };
}

export async function encodeOutputs(job: { id: string; state: string; payload: any; result: any; created_at: string }): Promise<EncodeOutputs | null> {
  const assetId = job.payload?.vodAssetId as string | undefined;
  if (!assetId) return null;
  const a = await one<any>(
    `SELECT id, title, master_key, formats, encode_result, media_facts, poster_candidates, poster_key, poster_source, sprite
       FROM vod_assets WHERE id = $1`, [assetId]);
  const { vodStore } = await import('../fast/vodStore');
  const store = vodStore() === 's3' ? 's3' : 'local';
  const dir = join(config.clips.dir, 'vod', assetId);
  const running = job.state === 'running', queued = job.state === 'queued';
  const finished = job.state === 'succeeded';
  const outs = job.result?.outputs ?? {};

  // RENDITIONS: the ladder the job decided, plus any folder on disk it did not list.
  const kept: any[] = a?.encode_result?.kept ?? [];
  const facts: any[] = a?.media_facts?.video ?? [];
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+p$/.test(f) || f === 'audio') : [];
  const names = [...new Set([...kept.map((r) => `${r.height}p`), ...onDisk.filter((n) => n !== 'audio'),
    ...(a?.encode_result?.probe?.hasAudio === false ? [] : onDisk.includes('audio') || kept.length ? ['audio'] : [])])];
  names.sort((x, y) => (y === 'audio' ? -1 : x === 'audio' ? 1 : parseInt(y) - parseInt(x)));
  const renditions: RenditionOut[] = names.map((name) => {
    const r = kept.find((k) => `${k.height}p` === name);
    const f = facts.find((v) => v.label === name);
    const s = dirStats(join(dir, name));
    const state: State = s.init && s.segments ? (running ? 'running' : 'ok')
      : running || queued ? (s.segments || s.init ? 'running' : 'pending')
      : finished && store === 's3' && a?.master_key ? 'ok'
      : 'missing';
    const af = name === 'audio' ? (a?.media_facts?.audio ?? [])[0] : null;
    return { name, planned: !!r, state, width: f?.width ?? null, height: f?.height ?? r?.height ?? null,
      bitrateKbps: r?.bitrate_kbps ?? af?.bitrateKbps ?? (name === 'audio' ? 128 : null),
      codec: name === 'audio' ? (af?.codec ?? 'aac') : [f?.codec, f?.profile, f?.level].filter(Boolean).join(' ') || null, ...s };
  });

  const file = (n: string) => existsSync(join(dir, n));
  const manifests = [
    { name: 'HLS (master.m3u8)', state: (file('master.m3u8') || (store === 's3' && a?.master_key) ? 'ok' : running || queued ? 'pending' : 'missing') as State, path: a?.master_key ?? null },
    { name: 'DASH (manifest.mpd)', state: (file('manifest.mpd') || (store === 's3' && a?.formats?.dash) ? 'ok' : running || queued ? 'pending' : 'missing') as State, path: file('manifest.mpd') ? `/clips/vod/${assetId}/manifest.mpd` : null },
  ];

  const cands = Array.isArray(a?.poster_candidates) ? a.poster_candidates.length : 0;
  const t = outs.thumbnails ?? null;
  const thumbnails = {
    state: (t?.state ?? (cands ? 'ok' : running || queued ? 'pending' : finished ? 'missing' : 'pending')) as State,
    count: t?.count ?? cands, chosen: a?.poster_key ?? null, source: a?.poster_source ?? null, error: t?.error, detail: t?.detail,
  };
  const sp = a?.sprite ?? null;
  const so = outs.sprites ?? null;
  const sprites = {
    state: (so?.state ?? (sp?.sheets?.length ? 'ok' : running || queued ? 'pending' : finished ? 'missing' : 'pending')) as State,
    sheets: sp?.sheets?.length ?? so?.count ?? 0,
    previews: (sp?.sheets ?? []).reduce((n: number, s: any) => n + (s.tiles ?? 0), 0),
    intervalMs: sp?.intervalMs ?? null, error: so?.error, detail: so?.detail,
  };

  const follow = await query<any>(
    `SELECT id, type, state, progress_pct, progress_note, last_error, finished_at FROM jobs
      WHERE type = ANY($2::text[]) AND payload->>'vodAssetId' = $1 AND created_at >= $3::timestamptz - interval '5 seconds'
      ORDER BY created_at`, [assetId, Object.keys(FOLLOW_ON), job.created_at]).catch(() => []);
  const followOn = follow.map((f) => ({ id: f.id, type: f.type, label: FOLLOW_ON[f.type] ?? f.type, state: f.state,
    progressPct: f.progress_pct ?? 0, note: f.progress_note ?? null, error: f.last_error ?? null, finishedAt: f.finished_at ?? null }));

  return { asset: { id: assetId, title: a?.title ?? null, exists: !!a, dir, store }, renditions, manifests, thumbnails, sprites, followOn };
}
