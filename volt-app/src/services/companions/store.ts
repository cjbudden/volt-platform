// ============================================================================
//  COMPANION FILES: storing, assigning and applying (docs/COMPANION_FILES.md).
//  Pure reading and checking is in formats.ts; manifests in delivery.ts and
//  serve.ts.
// ============================================================================
import { createHash } from 'node:crypto';
import { one, query } from '../../db';
import { imageStore } from '../imageStore';
import {
  detectFormat, kindOf, nameHints, languageName, parseCaptions, checkCaptions, toVtt, parseSidecar, matchFields,
  type CaptionFormat, type SidecarFormat, type CompanionKind, type FileFormat,
} from './formats';

export const MAX_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function ownedAsset(id: string, acct: string) {
  if (!UUID.test(id)) return null;
  return one<any>(`
    SELECT v.id, v.title, v.metadata, v.metadata_provenance, v.schema_id, v.duration_ms, v.master_key, COALESCE(g.account_id, v.account_id) AS acct
      FROM vod_assets v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN events e ON e.id = v.event_id
      LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
     WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [id, acct]);
}

/** Text, as the file meant it: UTF-8, else Windows-1252 (old SRTs from subtitling tools). */
export function decodeText(buf: Buffer): { text: string; encoding: string } {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' }; }
}

const safeName = (n: string) => (n.split(/[\\/]/).pop() ?? 'file').replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 160) || 'file';
const invalidate = async (assetId: string) => { try { (await import('../../scale/cache')).invalidateTag(`asset:${assetId}`); } catch { /* no cache */ } };

export interface AddInput {
  name: string; buf: Buffer; contentType?: string | null; kind?: CompanionKind | null; language?: string | null; label?: string | null;
  isDefault?: boolean; forced?: boolean; sdh?: boolean; offsetMs?: number; by: string; source?: 'upload' | 'api' | 'watchfolder';
}

/** Store a file for an asset and read what it is. Captions get their clean WebVTT and a check. */
export async function addFile(assetId: string, acct: string, inp: AddInput): Promise<{ file: any; duplicate: boolean }> {
  const a = await ownedAsset(assetId, acct);
  if (!a) throw err(404, 'VOD asset not found');
  if (!inp.buf.length) throw err(400, 'the file is empty');
  if (inp.buf.length > MAX_BYTES) throw err(413, `companion files are limited to ${MAX_BYTES / 1024 / 1024} MB`);
  const name = safeName(inp.name);
  const sha256 = createHash('sha256').update(inp.buf).digest('hex');
  const dup = await one<any>(`SELECT * FROM vod_asset_files WHERE asset_id = $1 AND sha256 = $2`, [a.id, sha256]);
  if (dup) return { file: view(dup), duplicate: true };

  const binary = inp.buf.subarray(0, 4096).includes(0);
  const { text, encoding } = binary ? { text: '', encoding: 'binary' } : decodeText(inp.buf);
  const format: FileFormat = binary ? 'unknown' : detectFormat(name, text);
  let kind: CompanionKind = inp.kind ?? kindOf(format);
  if (kind === 'captions' && !['srt', 'vtt', 'ttml'].includes(format)) throw err(400, `"${name}" is not a caption file Volt reads (SRT, WebVTT or TTML).`);
  if (kind === 'metadata' && !['json', 'xml', 'csv', 'tsv'].includes(format)) kind = 'other';

  const id = (await one<any>(`SELECT gen_random_uuid() AS id`))!.id as string;
  const storeKey = `companions/${acct}/${a.id}/${id}/${name}`;
  await imageStore().put(storeKey, inp.buf, inp.contentType || 'application/octet-stream');

  const hints = nameHints(name);
  let report: any = null, vttKey: string | null = null;
  const language = (inp.language ?? hints.language) || null;
  const forced = inp.forced ?? hints.forced, sdh = inp.sdh ?? hints.sdh;
  if (kind === 'captions') {
    const cues = parseCaptions(format as CaptionFormat, text);
    report = checkCaptions(format as CaptionFormat, cues, a.duration_ms ? Number(a.duration_ms) : null);
    if (report.ok) {
      vttKey = `companions/${acct}/${a.id}/${id}/track.vtt`;
      await imageStore().put(vttKey, Buffer.from(toVtt(cues, { offsetMs: inp.offsetMs ?? 0 }), 'utf8'), 'text/vtt; charset=utf-8');
    }
  } else if (kind === 'metadata') {
    try {
      const flat = parseSidecar(format as SidecarFormat, text);
      report = { ok: true, values: Object.keys(flat).length, paths: Object.keys(flat).slice(0, 200) };
    } catch (e: any) { report = { ok: false, issues: [{ level: 'error', code: 'parse', message: `Could not read it as ${format.toUpperCase()}: ${String(e?.message ?? e).slice(0, 200)}` }] }; }
  }
  const hasDefault = kind === 'captions' && !!(await one(`SELECT 1 FROM vod_asset_files WHERE asset_id = $1 AND kind = 'captions' AND is_default`, [a.id]));
  const isDefault = kind === 'captions' && report?.ok && !forced && (inp.isDefault ?? !hasDefault);
  if (isDefault && hasDefault) await query(`UPDATE vod_asset_files SET is_default = false WHERE asset_id = $1 AND kind = 'captions'`, [a.id]);
  const label = (inp.label?.trim() || (kind === 'captions' ? `${languageName(language)}${sdh ? ' (SDH)' : ''}${forced ? ' (forced)' : ''}` : name)).slice(0, 80);
  const row = await one<any>(`
    INSERT INTO vod_asset_files (id, asset_id, account_id, kind, format, name, store_key, vtt_key, content_type, bytes, sha256, encoding,
                                 language, label, is_default, forced, sdh, enabled, offset_ms, report, source, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [id, a.id, acct, kind, format, name, storeKey, vttKey, inp.contentType ?? null, inp.buf.length, sha256, encoding,
     language, label, !!isDefault, forced, sdh, kind === 'captions' ? !!report?.ok : true, inp.offsetMs ?? 0, report ? JSON.stringify(report) : null, inp.source ?? 'upload', inp.by]);
  await invalidate(a.id);
  return { file: view(row), duplicate: false };
}

export function view(r: any) {
  return {
    id: r.id, assetId: r.asset_id, kind: r.kind, format: r.format, name: r.name, bytes: Number(r.bytes) || 0, sha256: r.sha256, encoding: r.encoding,
    language: r.language, label: r.label, isDefault: !!r.is_default, forced: !!r.forced, sdh: !!r.sdh, enabled: !!r.enabled, offsetMs: Number(r.offset_ms) || 0,
    report: r.report ?? null, applied: r.applied ?? null, source: r.source, uploadedBy: r.uploaded_by, createdAt: r.created_at, updatedAt: r.updated_at,
    download: `/api/vod/${r.asset_id}/files/${r.id}/content`, ...(r.vtt_key ? { webvtt: `/api/vod/${r.asset_id}/files/${r.id}/content?as=vtt` } : {}),
  };
}

export async function listFiles(assetId: string, acct: string) {
  const a = await ownedAsset(assetId, acct);
  if (!a) throw err(404, 'VOD asset not found');
  const rows = await query<any>(`SELECT * FROM vod_asset_files WHERE asset_id = $1 ORDER BY kind, is_default DESC, language NULLS LAST, created_at`, [a.id]);
  return { assetId: a.id, durationMs: a.duration_ms != null ? Number(a.duration_ms) : null, files: rows.map(view) };
}

async function fileRow(assetId: string, acct: string, fileId: string) {
  if (!UUID.test(fileId)) throw err(404, 'no such file');
  const r = await one<any>(`SELECT * FROM vod_asset_files WHERE id = $1 AND asset_id = $2 AND account_id = $3`, [fileId, assetId, acct]);
  if (!r) throw err(404, 'no such file');
  return r;
}

export async function fileContent(assetId: string, acct: string, fileId: string, asVtt = false): Promise<{ buf: Buffer; name: string; type: string }> {
  const r = await fileRow(assetId, acct, fileId);
  const key = asVtt ? r.vtt_key : r.store_key;
  if (!key) throw err(404, 'this file has no WebVTT');
  const buf = await imageStore().get(key);
  if (!buf) throw err(410, 'the stored file is missing');
  return { buf, name: asVtt ? r.name.replace(/\.[a-z0-9]+$/i, '') + '.vtt' : r.name, type: asVtt ? 'text/vtt; charset=utf-8' : r.content_type || 'application/octet-stream' };
}

export interface Patch { language?: string | null; label?: string; isDefault?: boolean; forced?: boolean; sdh?: boolean; enabled?: boolean; offsetMs?: number; kind?: CompanionKind }

/** Change how a file is used. A new offset rebuilds the WebVTT from the original. */
export async function updateFile(assetId: string, acct: string, fileId: string, p: Patch) {
  const r = await fileRow(assetId, acct, fileId);
  if (p.isDefault === true && r.kind === 'captions') await query(`UPDATE vod_asset_files SET is_default = false WHERE asset_id = $1 AND kind = 'captions' AND id <> $2`, [r.asset_id, r.id]);
  let vttKey = r.vtt_key, report = r.report;
  if (r.kind === 'captions' && p.offsetMs !== undefined && p.offsetMs !== Number(r.offset_ms)) {
    const buf = await imageStore().get(r.store_key);
    if (!buf) throw err(410, 'the stored file is missing');
    const cues = parseCaptions(r.format as CaptionFormat, decodeText(buf).text);
    const a = await ownedAsset(r.asset_id, acct);
    report = checkCaptions(r.format as CaptionFormat, cues.map((c) => ({ ...c, startMs: c.startMs + p.offsetMs!, endMs: c.endMs + p.offsetMs! })), a?.duration_ms ? Number(a.duration_ms) : null);
    vttKey = vttKey ?? `companions/${acct}/${r.asset_id}/${r.id}/track.vtt`;
    await imageStore().put(vttKey!, Buffer.from(toVtt(cues, { offsetMs: p.offsetMs }), 'utf8'), 'text/vtt; charset=utf-8');
  }
  const row = await one<any>(`
    UPDATE vod_asset_files SET
      language = CASE WHEN $3::boolean THEN $4 ELSE language END, label = COALESCE($5, label), is_default = COALESCE($6, is_default),
      forced = COALESCE($7, forced), sdh = COALESCE($8, sdh), enabled = COALESCE($9, enabled), offset_ms = COALESCE($10, offset_ms),
      vtt_key = $11, report = $12, updated_at = now()
    WHERE id = $1 AND asset_id = $2 RETURNING *`,
    [r.id, r.asset_id, p.language !== undefined, p.language ?? null, p.label?.trim() || null, p.isDefault ?? null, p.forced ?? null, p.sdh ?? null,
     p.enabled ?? null, p.offsetMs ?? null, vttKey, report ? JSON.stringify(report) : null]);
  await invalidate(r.asset_id);
  return view(row);
}

export async function deleteFile(assetId: string, acct: string, fileId: string) {
  const r = await fileRow(assetId, acct, fileId);
  await query(`DELETE FROM vod_asset_files WHERE id = $1`, [r.id]);
  for (const k of [r.store_key, r.vtt_key]) if (k) await imageStore().delete(k).catch(() => {});
  await invalidate(r.asset_id);
  return { deleted: true, name: r.name };
}

// ---------------------------------------------------------------- metadata sidecars

async function schemaFields(schemaId: string | null): Promise<any[]> {
  if (!schemaId) return [];
  return (await one<any>(`SELECT fields FROM metadata_schemas WHERE id = $1`, [schemaId]))?.fields ?? [];
}

/** What the sidecar would change: each matched field with its value now. Nothing is written. */
export async function proposeMetadata(assetId: string, acct: string, fileId: string) {
  const r = await fileRow(assetId, acct, fileId);
  if (r.kind !== 'metadata') throw err(400, 'only metadata sidecars can be applied');
  const a = (await ownedAsset(r.asset_id, acct))!;
  const buf = await imageStore().get(r.store_key);
  if (!buf) throw err(410, 'the stored file is missing');
  let flat;
  try { flat = parseSidecar(r.format as SidecarFormat, decodeText(buf).text); } catch (e: any) { throw err(400, `Could not read it: ${String(e?.message ?? e).slice(0, 200)}`); }
  const fields = await schemaFields(a.schema_id);
  const fdefs = fields.map((f: any) => ({ key: f.key, label: f.label, type: f.type, options: f.options, multiple: f.multiple }));
  const m = matchFields(flat, fdefs, a.metadata ?? {});
  const prov = a.metadata_provenance ?? {};
  return {
    file: view(r), hasType: !!a.schema_id,
    proposals: m.proposals.map((p) => ({ ...p, byPerson: !!a.metadata?.[p.field] && !prov[p.field] })),
    unmatched: m.unmatched.slice(0, 200).map((k) => ({ path: k, value: flat[k] })),
  };
}

/**
 * Write the fields a person approved, with `values` as they may have edited
 * them. Provenance says which file, who approved it and what was there before.
 */
export async function applyMetadata(assetId: string, acct: string, fileId: string, approved: string[], values: Record<string, any>, by: string) {
  const plan = await proposeMetadata(assetId, acct, fileId);
  const pick = new Set(approved);
  const fill: Record<string, any> = {};
  for (const p of plan.proposals) if (pick.has(p.field)) fill[p.field] = p.field in values ? values[p.field] : p.value;
  if (!Object.keys(fill).length) throw err(400, 'tick at least one field to apply');
  const a = (await ownedAsset(assetId, acct))!;
  const fields = await schemaFields(a.schema_id);
  const { validateMetadata } = await import('../metadataValidator');
  // Check only what is being written: values already on the asset are not this file's business.
  const touched = fields.filter((f: any) => f.key in fill).map((f: any) => ({ ...f, required: false }));
  try { validateMetadata(touched, fill); } catch (e: any) { throw err(400, String(e?.message ?? e)); }
  const at = new Date().toISOString();
  const pv = Object.fromEntries(Object.keys(fill).map((k) => [k, { source: 'sidecar', file: plan.file.name, fileId, approvedBy: by, at, was: a.metadata?.[k] ?? null }]));
  await query(`UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1`,
    [a.id, JSON.stringify(fill), JSON.stringify(pv)]);
  await query(`UPDATE vod_asset_files SET applied = $2, updated_at = now() WHERE id = $1`, [fileId, JSON.stringify({ fields: Object.keys(fill), by, at })]);
  await invalidate(a.id);
  return { applied: Object.keys(fill), was: Object.fromEntries(Object.keys(fill).map((k) => [k, a.metadata?.[k] ?? null])) };
}
