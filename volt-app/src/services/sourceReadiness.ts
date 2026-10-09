// ============================================================================
//  CAN THIS STREAM ACTUALLY BE STARTED?
//
//  A channel with NO SOURCE URL used to start. It launched an encoder, showed
//  STARTING, showed the source card as RECEIVING, opened a recording, and
//  started the billable clock, all with nothing on the other end. Nobody had to
//  do anything wrong to get there: create a channel, do not fill the source in
//  yet, press Start.
//
//  IT DID NOT FAIL, BECAUSE A DEFAULT TURNED THE MISSING VALUE INTO A PLAUSIBLE
//  ONE. buildEncoderJobConfig read the source as:
//
//      i.ingest_url ?? `srt://0.0.0.0:9000?streamid=${i.stream_key ?? ''}`
//
//  which for an empty row is `srt://0.0.0.0:9000?streamid=` -- a syntactically
//  valid SRT listener, bound to every interface, with an EMPTY streamid. ffmpeg
//  binds it happily and waits. Forever. There is no error to report because
//  nothing has gone wrong yet: a listener with no caller is exactly what a
//  correctly configured push channel looks like in the seconds before its
//  encoder dials in.
//
//  That fallback is not wrong in itself. For a PUSH protocol the platform is
//  supposed to issue the endpoint and the STREAM KEY is what selects the
//  channel. It is only wrong when there is no stream key either, because then
//  nothing in the URL identifies the feed and it cannot ever match anything.
//
//  So the rule is per protocol, and the descriptor registry already knows which
//  is which:
//
//    PULL  (icecast, hls, dash)     we fetch it. A URL is the whole address.
//                                   No URL, nothing to fetch, no start.
//    PUSH  (srt, rtmp, rtmps)       they send to us. Either an explicit URL, or
//                                   a stream key we can issue an endpoint for.
//                                   Neither, and nothing identifies the feed.
//    NDI / ST 2110                  a source name or a multicast address is
//                                   required; both live in ingest_url.
//
//  WHY THIS IS A SERVICE AND NOT A FORM CHECK. The console is not the only
//  thing that starts a stream: the event scheduler starts them on a window,
//  auto-connect restarts them after a fault, and the API is public. A guard in
//  the form protects one of those four. This is checked where the start
//  actually happens, so every path gets the same answer.
// ============================================================================
import { getProtocol } from './ingestProtocols';

export interface SourceRow {
  role?: string | null;
  protocol?: string | null;
  ingest_url?: string | null;
  stream_key?: string | null;
  rendition_label?: string | null;
}

/** An error the HTTP layer turns into a 400 rather than a 500 (see util/http). */
export class NotStartable extends Error {
  status = 400;
  /** Retrying cannot fix this: the configuration has to change first. */
  readonly configuration = true;
  constructor(message: string) {
    super(message);
    this.name = 'NotStartable';
  }
}

const has = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/**
 * Why this stream cannot start, in words an operator can act on, or null when
 * it can. Pure: no database, no clock, no process table.
 *
 * The message names the FIELD to go and fill, not the internal condition that
 * failed. "This channel has no source" is a fact about the world; "inputs[0]
 * .ingest_url is null" is a fact about us.
 */
export function sourceProblem(inputs: SourceRow[], label = 'This channel'): string | null {
  const rows = (inputs || []).filter(Boolean);
  if (rows.length === 0) return `${label} has no source. Add a primary source in Settings, then start it.`;

  // A channel can carry several primary rows: a package_only workflow has one
  // per rendition. Any usable one is enough to go on air, because the encoder
  // pulls what it is given; a channel is only unstartable when NONE of them
  // carries an address.
  const primaries = rows.filter((r) => (r.role ?? 'primary') === 'primary');
  if (primaries.length === 0) return `${label} has no primary source. Add one in Settings, then start it.`;

  const reasons: string[] = [];
  for (const r of primaries) {
    const id = String(r.protocol ?? '').toLowerCase();
    const desc = getProtocol(id);
    const name = desc?.label ?? (id ? id.toUpperCase() : 'source');

    if (has(r.ingest_url)) return null;                  // usable: nothing more to check

    // No URL. For a push protocol a stream key is still enough, because the
    // endpoint is ours to issue and the key is what selects the channel.
    if (desc?.ingest === 'push') {
      if (has(r.stream_key)) return null;
      reasons.push(
        `${label} has a ${name} source with neither a URL nor a stream key, so nothing identifies the incoming feed.`
      );
      continue;
    }

    // Pull, or a protocol we do not recognise. Either way the address is the
    // only thing that could tell the encoder where to look.
    const field = desc?.urlLabel ?? 'source URL';
    reasons.push(`${label} has a ${name} source but no ${field.toLowerCase()}.`);
  }

  const why = reasons[0] ?? `${label} has no usable source.`;
  return `${why} Open Settings, fill the primary source in, and start it again.`;
}

/** Throw NotStartable when the sources cannot support a start. */
export function assertStartable(inputs: SourceRow[], label = 'This channel'): void {
  const problem = sourceProblem(inputs, label);
  if (problem) throw new NotStartable(problem);
}
