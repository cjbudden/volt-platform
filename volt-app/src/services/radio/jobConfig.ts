// ============================================================================
//  RADIO JOB CONFIG — what a station container is told.
//
//  The counterpart of buildEncoderJobConfig, and deliberately the same shape of
//  thing: everything the task needs, handed over as JSON at launch, so the
//  container needs no database, no credentials of its own and no discovery. It
//  is given a source to read, somewhere to put the output, and an address to
//  report status back to. Nothing else: it pushes nothing to a relay (there is
//  none since build queue 2.1c-2) and writes HLS and DASH only.
//
//  The keys are snake_case because this crosses into Python. That is the only
//  reason, and it is worth the small ugliness: the boundary is a wire format,
//  and pretending otherwise is how a rename in TypeScript silently stops a
//  station in production.
// ============================================================================
import { config } from '../../config';
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
 * Build the job config. The station's outputs are HLS and DASH; `mp3` is
 * always sent as false (the container would ignore it anyway): MP3 for
 * listeners is the control plane's on-demand gateway (mp3Gateway.ts).
 */
export async function buildRadioJobConfig(ctx: RadioJobCtx): Promise<Record<string, any>> {
  const rc = ctx.radioConfig ?? {};
  const outs = { ...resolveOutputs(rc.outputs), mp3: false };

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
