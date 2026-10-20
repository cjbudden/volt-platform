// ============================================================================
//  RADIO JOB CONFIG — what a station container is told.
//
//  The counterpart of buildEncoderJobConfig, and deliberately the same shape of
//  thing: everything the task needs, handed over as JSON at launch, so the
//  container needs no database, no credentials of its own and no discovery. It
//  is given a source to read, somewhere to put the output, a relay to push MP3
//  to, and an address to report status back to. Nothing else.
//
//  The keys are snake_case because this crosses into Python. That is the only
//  reason, and it is worth the small ugliness: the boundary is a wire format,
//  and pretending otherwise is how a rename in TypeScript silently stops a
//  station in production.
// ============================================================================
import { config } from '../../config';
import { resolveRelayFor } from '../fleet/relays';
import { clampBitrate, resolveOutputs, type RadioOutputs } from './args';

export interface RadioJobCtx {
  channelId: string;
  channelName?: string | null;
  protocol: string;
  url: string;
  radioConfig: {
    outputs?: RadioOutputs;
    bitrateKbps?: number;
    transcode?: boolean;
  } | null | undefined;
}

/**
 * The mount a station publishes on.
 *
 * Derived from the channel id rather than its name on purpose: a name can be
 * edited, and a listener URL that changes when somebody fixes a typo is a
 * broken URL. Hardware receivers in particular are configured once and never
 * again.
 */
export function mountFor(channelId: string): string {
  return `${channelId}.mp3`;
}

/**
 * The URL a LISTENER is given. This is the relay's public face, which is
 * normally a CDN or load balancer, and is never the in-VPC host:port the
 * station uses to reach Icecast. Falling back to host:port is a development
 * convenience and would be wrong to serve in production, which is why
 * ICECAST_PUBLIC_BASE exists and why this is the only place that decides it.
 */
export function publicMp3Url(channelId: string): string {
  const ice = config.icecast;
  const base = ice.publicBase
    || `${ice.tls ? 'https' : 'http'}://${ice.host}:${ice.port}`;
  return `${base.replace(/\/+$/, '')}/${mountFor(channelId)}`;
}

/**
 * Build the job config, with the relay resolved from the station's assignment.
 *
 * ASYNC BECAUSE THE RELAY IS NOW A FACT ABOUT THIS STATION rather than a global
 * constant. It used to read config.icecast, which is one host from the
 * environment and therefore the same answer for every station on the platform.
 * With a relay tier that has to be assignable and countable, the address is a
 * row, and reading a row means a round trip.
 *
 * A deployment with no relays registered gets the environment exactly as
 * before, so nothing about a development machine or a single-Icecast install
 * changes. See services/fleet/relays.ts.
 */
export async function buildRadioJobConfig(ctx: RadioJobCtx): Promise<Record<string, any>> {
  const rc = ctx.radioConfig ?? {};
  const outs = resolveOutputs(rc.outputs);
  // Only resolve when MP3 is actually wanted: a station with mp3 off has no
  // business being assigned a relay, and assigning one would make the fleet's
  // station counts include stations that never push a byte to it.
  const ice = outs.mp3 ? await resolveRelayFor(ctx.channelId) : null;

  return {
    channel_id: ctx.channelId,
    protocol: ctx.protocol,
    url: ctx.url,
    outputs: outs,
    bitrate_kbps: clampBitrate(rc.bitrateKbps),
    transcode: !!rc.transcode,
    segment_seconds: 4,

    // The source codec is deliberately NOT probed here. The container is the
    // party that can actually reach the source; on ECS the control plane
    // usually cannot, and a probe that fails from here would silently force a
    // re-encode on a station that could have been copied.
    // radio.py probes when this key is absent.

    icecast: ice ? {
      host: ice.host,
      port: ice.port,
      mount: mountFor(ctx.channelId),
      username: ice.username,
      password: ice.password,
      station_name: ctx.channelName ?? null,
      tls: ice.tls,
    } : null,

    s3: {
      bucket: config.aws.s3Bucket,
      prefix: `channel/${ctx.channelId}`,
    },
    status_report: {
      url: `${config.internalApiBaseUrl}/api/streams/${ctx.channelId}/report`,
      token: config.ingestToken,
    },
    // In-stream graphic triggers (Up next), the same standard as television
    // (services/graphicTriggers.ts). radio.py keeps delivered copies of its
    // playlists with the triggers written in and points master.m3u8 at them.
    // A station is a channel row, so kind=channel finds its guide and settings.
    timed_events: {
      url: `${config.internalApiBaseUrl}/api/streams/${ctx.channelId}/timed-events?kind=channel`,
      token: config.ingestToken,
      poll_sec: 5,
    },
  };
}
