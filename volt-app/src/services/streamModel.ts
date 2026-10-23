// ============================================================================
//  THE STREAM AGGREGATE: one channel or event as its two planes
//  (domain_model.md), its preset (origin x lifecycle, product_positioning.md)
//  and its source-provider contract (metadata_source_provider.md).
//
//  The pieces already exist in their own tables and services; this names the
//  composition and serves it read-only, so a client (or a person) sees the
//  stream the way the design describes it:
//
//    PRODUCTION PLANE   what the encoder job is built from (jobConfig.ts):
//                       origin (live inputs, or a FAST playlist), processing
//                       profile (ladder, packaging, DRM, captions, watermark),
//                       placement (the running task, if any)
//    DISTRIBUTION PLANE what outlives the pipeline: the VideoObject +
//                       BroadcastEvent (schema.org), the metadata (schema +
//                       values), and how it is made available (on air, share
//                       links, geo)
//
//  Presets are derived, never stored: a preset is a name for an origin and a
//  lifecycle, so a new one is a new row in PRESETS, not a new code path.
//
//  The provider contract lists, per tier, what a downstream party (a portal,
//  an OTT app, a partner) consumes and in which standard:
//    delivery    HLS / DASH CMAF, DRM, DVR window, the stable public URL
//    descriptive schema.org JSON-LD (VideoObject, BroadcastEvent, SportsEvent)
//    guide       XMLTV and the JSON guide
//    timed       EXT-X-DATERANGE / DASH EventStream in the manifests (SCTE-35
//                for breaks, Volt graphic triggers)
//    rights      the play gate (availability) and the edge rules
//    control     the admin API for the stream
// ============================================================================
import { one, query } from '../db';
import { config } from '../config';
import { sportsEventJsonLd } from './eventPromo';

// No 'loop' origin (removed 23 Oct 2026, build queue 1.12): a loop is a filler
// video asset in Loops & Fillers, played to cover a dropped source or a rights
// window, not a kind of stream (Christian, 22 Oct). No channel could ever have
// it (channels.origin is 'live' or 'playlist'), so the preset only misled.
export type Origin = 'live_ingest' | 'scheduled_playout';
export type Lifecycle = 'continuous' | 'bounded';
export interface Preset { key: string; label: string; origin: Origin; lifecycle: Lifecycle }

export const PRESETS: Preset[] = [
  { key: 'live_channel', label: 'Live channel', origin: 'live_ingest', lifecycle: 'continuous' },
  { key: 'live_event', label: 'Live event', origin: 'live_ingest', lifecycle: 'bounded' },
  { key: 'fast_channel', label: 'FAST channel', origin: 'scheduled_playout', lifecycle: 'continuous' },
  { key: 'vod_premiere', label: 'Premiere', origin: 'scheduled_playout', lifecycle: 'bounded' },
];

/** The preset of a channel or event row (pure). */
export function presetOf(kind: 'channel' | 'event', row: { origin?: string | null }): Preset {
  const origin: Origin = row.origin === 'playlist' ? 'scheduled_playout' : 'live_ingest';
  const lifecycle: Lifecycle = kind === 'event' ? 'bounded' : 'continuous';
  return PRESETS.find((p) => p.origin === origin && p.lifecycle === lifecycle)
    ?? { key: `${origin}_${lifecycle}`, label: `${origin} ${lifecycle}`, origin, lifecycle };
}

const api = () => config.publicBaseUrl.replace(/\/$/, '');
const cdn = () => config.aws.cdnBaseUrl.replace(/\/$/, '');

/** schema.org for a live stream: a VideoObject published by a BroadcastEvent (pure). */
export function broadcastJsonLd(kind: 'channel' | 'event', row: any, metadata: Record<string, any> | null, schemaType?: string | null): Record<string, any> {
  const base = api();
  const self = `${base}/api/${kind}s/${row.id}`;
  const publicUrl = `${base}/live/${row.id}/master.m3u8`;
  const start = kind === 'event' ? (row.actual_start ?? row.scheduled_start) : null;
  const end = kind === 'event' ? (row.actual_end ?? row.scheduled_end) : null;
  const iso = (d: any) => (d ? new Date(d).toISOString() : undefined);
  const event: Record<string, any> = {
    '@type': 'BroadcastEvent',
    '@id': `${self}#broadcast`,
    isLiveBroadcast: true,
    name: row.name,
    startDate: iso(start),
    endDate: iso(end),
    eventStatus: row.status === 'live' ? 'https://schema.org/EventScheduled' : undefined,
    videoFormat: 'HD',
  };
  if (kind === 'channel') {
    event.publishedOn = { '@type': 'BroadcastService', '@id': `${self}#service`, name: row.name, broadcastDisplayName: row.name };
  } else if (metadata && (metadata.homeTeam || metadata.awayTeam || metadata.competitor || /Sports/i.test(schemaType ?? ''))) {
    // The event IS a sports fixture: the broadcast is OF it (eventPromo.ts builds it).
    const sports = sportsEventJsonLd({ id: row.id, name: row.name, scheduled_start: row.scheduled_start, scheduled_end: row.scheduled_end }, metadata, { type: schemaType, baseUrl: base });
    delete sports['@context'];
    event.broadcastOfEvent = sports;
  }
  return JSON.parse(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    '@id': self,
    name: row.name,
    description: metadata?.description ?? undefined,
    thumbnailUrl: metadata?.image ?? undefined,
    isLiveBroadcast: true,
    contentUrl: publicUrl,
    embedUrl: `${base}/live/${row.id}/master.m3u8`,
    publication: event,
  }));
}

/** The source-provider tiers for a stream (pure). */
export function providerContract(kind: 'channel' | 'event', row: any, profile: any | null): Record<string, any> {
  const base = api();
  const self = `${base}/api/${kind}s/${row.id}`;
  return {
    delivery: {
      standard: 'HLS + DASH, CMAF',
      public: { hls: `${base}/live/${row.id}/master.m3u8`, dash: `${base}/live/${row.id}/manifest.mpd`, stable: true },
      cdn: { hls: `${cdn()}/${kind}/${row.id}/master_cc.m3u8`, dash: `${cdn()}/${kind}/${row.id}/manifest_cc.mpd` },
      drm: profile?.drm_enabled ? { scheme: 'cbcs', systems: ['Widevine', 'PlayReady', 'FairPlay'], keys: 'SPEKE v2 / CPIX' } : null,
      dvr_window_sec: row.dvr_window_sec ?? profile?.dvr_window_sec ?? null,
      captions: profile?.captions_enabled ? { format: 'WebVTT', languages: [profile.caption_source_lang, ...(profile.caption_targets ?? [])].filter(Boolean) } : null,
    },
    descriptive: { standard: 'schema.org JSON-LD (VideoObject, BroadcastEvent, SportsEvent)', url: `${base}/api/live-streams/${kind}/${row.id}/schema.org` },
    guide: kind === 'channel'
      ? { standard: 'XMLTV', xmltv: `${base}/api/epg/xmltv?channelId=${row.id}`, json: `${base}/api/epg?channelId=${row.id}`, as_run: `${base}/api/epg/as-run?channelId=${row.id}` }
      : { standard: 'schema.org Event dates', json: `${base}/api/epg?eventId=${row.id}` },
    timed: {
      standard: 'HLS EXT-X-DATERANGE, DASH EventStream (in the delivered manifests)',
      carriers: ['SCTE-35 (ad breaks, splice_insert)', 'com.boomlabs.volt.graphic (Up next, graphics)', 'programme boundaries'],
      feed: `${base}/api/streams/${row.id}/timed-events?kind=${kind}`,
    },
    rights: {
      standard: 'play gate + edge rules (geo, programme blackout, replacement)',
      play_gate: `${base}/api/public/availability`,
      geo: row.geo_mode && row.geo_mode !== 'worldwide' ? { mode: row.geo_mode, countries: row.geo_countries ?? [] } : null,
    },
    control: { standard: 'Volt REST API (JSON, JSON-LD + Hydra on request)', self, status: `${base}/api/status/${kind}/${row.id}` },
  };
}

/** The whole aggregate for one stream, tenant-scoped. Null when not the account's. */
export async function composeStream(kind: 'channel' | 'event', id: string, accountId: string): Promise<Record<string, any> | null> {
  const row = kind === 'channel'
    ? await one<any>(`SELECT c.*, g.output_profile_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`, [id, accountId])
    : await one<any>(`SELECT e.*, g.output_profile_id FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1 AND g.account_id = $2`, [id, accountId]);
  if (!row) return null;
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const [profile, inputs, instance, schema, shares] = await Promise.all([
    row.output_profile_id ? one<any>(`SELECT * FROM output_profiles WHERE id = $1`, [row.output_profile_id]) : Promise.resolve(null),
    query<any>(`SELECT id, role, rendition_label, rendition_bitrate_kbps, protocol, status FROM stream_inputs WHERE ${col} = $1 ORDER BY role, rendition_label`, [id]),
    one<any>(`SELECT id, state, lifecycle, is_gpu, instance_type, launched_at FROM instances WHERE ${col} = $1 AND terminated_at IS NULL ORDER BY launched_at DESC NULLS LAST LIMIT 1`, [id]),
    row.schema_id ? one<any>(`SELECT id, name, schema_org_type FROM metadata_schemas WHERE id = $1`, [row.schema_id]).catch(() => one<any>(`SELECT id, name FROM metadata_schemas WHERE id = $1`, [row.schema_id])) : Promise.resolve(null),
    query<any>(`SELECT count(*)::int AS n FROM share_links WHERE resource_id = $1 AND NOT revoked`, [id]).catch(() => [{ n: null }]),
  ]);
  const preset = presetOf(kind, row);
  const metadata = (row.metadata && typeof row.metadata === 'object') ? row.metadata : null;
  const base = api();
  const workflow = profile?.workflow_type ?? null;
  return {
    '@id': `${base}/api/live-streams/${kind}/${id}`,
    kind, id, name: row.name, status: row.status ?? null,
    preset,
    production: {
      origin: preset.origin === 'scheduled_playout'
        ? { type: 'playlist', lineup: `${base}/api/fast/channels/${id}` }
        : {
            type: 'live_inputs',
            inputs: inputs.map((i: any) => ({ id: i.id, role: i.role, rendition: i.rendition_label, kbps: i.rendition_bitrate_kbps, protocol: i.protocol, status: i.status })),
            failover: !!row.input_failover_enabled, auto_failback: row.auto_failback ?? null, on_total_loss: row.input_loss_behavior ?? null,
          },
      processing: profile ? {
        profile: { id: profile.id, name: profile.name, '@id': `${base}/api/output-profiles/${profile.id}` },
        workflow, codec_backend: profile.codec_backend, packaging: profile.packaging,
        ladder: profile.rungs, segment_sec: profile.segment_dur,
        drm: !!profile.drm_enabled,
        captions: profile.captions_enabled ? { engine: profile.caption_engine, source: profile.caption_source_lang, targets: profile.caption_targets } : null,
        // burn-in exists only on the transcode path (package-only copies the source)
        watermark: row.watermark_enabled ? { burned_in: workflow === 'transcode', position: row.watermark_position ?? null } : null,
      } : null,
      placement: instance ? { instance: instance.id, state: instance.state, lifecycle: instance.lifecycle, gpu: instance.is_gpu, instance_type: instance.instance_type, since: instance.launched_at } : null,
    },
    distribution: {
      video_object: broadcastJsonLd(kind, row, metadata, schema?.schema_org_type ?? null),
      metadata: { schema: schema ? { id: schema.id, name: schema.name } : null, values: metadata },
      availability: {
        on_air: kind === 'channel' ? !!row.on_air : row.status === 'live',
        public_url: `${base}/live/${id}/master.m3u8`,
        share_links: shares?.[0]?.n ?? null,
        geo: row.geo_mode && row.geo_mode !== 'worldwide' ? { mode: row.geo_mode, countries: row.geo_countries ?? [] } : null,
      },
    },
    provider: providerContract(kind, row, profile),
  };
}
