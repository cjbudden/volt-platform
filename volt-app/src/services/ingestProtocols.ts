// ============================================================================
//  Ingest-protocol descriptor registry — the single source of truth for how a
//  source is entered in the UI *and* validated on the server. Keyed to the DB
//  `ingest_protocol` enum (srt|rtmp|rtmps|hls|dash|ndi|st2110). The app fetches
//  this via GET /api/ingest-protocols so the source form's example/placeholder/
//  fields change to suit the selected protocol without hard-coding them twice.
//
//  This is data-driven-by-descriptor (versioned in code, type-checked), NOT a
//  runtime DB form builder: the protocol set is bounded by what the encoder can
//  actually ingest, so a tenant can't invent one. Custom, tenant-defined fields
//  are handled separately by metadata_schemas; label translation by the i18n
//  catalog. See docs/DESIGN_forms_and_fields.md.
// ============================================================================

export type FieldType = 'url' | 'string' | 'number' | 'password';

export interface ProtocolField {
  key: string;                 // maps to a stream_inputs column / URL param
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  default?: string | number;
}

export interface IngestProtocol {
  id: string;
  label: string;
  ingest: 'push' | 'pull';     // push = we provision an endpoint the source pushes to; pull = we fetch it
  urlLabel: string;
  urlPlaceholder: string;
  urlExample: string;
  urlPattern?: string;         // lenient client+server hint (RegExp source)
  streamKey: { show: boolean; label?: string; placeholder?: string };
  extraFields?: ProtocolField[]; // optional protocol-specific params (advanced)
  hint: string;
  packageFriendly: boolean;    // typically used as a package_only per-rendition input
}

export const INGEST_PROTOCOLS: IngestProtocol[] = [
  {
    id: 'srt', label: 'SRT', ingest: 'push',
    urlLabel: 'SRT URL',
    urlPlaceholder: 'srt://host:9000?streamid=…',
    urlExample: 'srt://ingest.volt.example:9000?streamid=live&latency=200',
    urlPattern: '^srt://',
    streamKey: { show: false },
    extraFields: [
      { key: 'latency', label: 'Latency (ms)', type: 'number', default: 200, hint: 'Buffer for jitter; 200 is typical.' },
      { key: 'passphrase', label: 'Passphrase', type: 'password', hint: 'Optional AES encryption passphrase.' },
    ],
    hint: 'Caller or listener SRT. streamid selects the channel; add latency/passphrase as query params.',
    packageFriendly: false,
  },
  {
    id: 'rtmp', label: 'RTMP', ingest: 'push',
    urlLabel: 'RTMP URL',
    urlPlaceholder: 'rtmp://host/app',
    urlExample: 'rtmp://ingest.volt.example/live',
    urlPattern: '^rtmp://',
    streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123' },
    hint: 'URL + stream key, exactly like OBS (Server + Stream Key).',
    packageFriendly: false,
  },
  {
    id: 'rtmps', label: 'RTMPS', ingest: 'push',
    urlLabel: 'RTMPS URL',
    urlPlaceholder: 'rtmps://host:443/app',
    urlExample: 'rtmps://ingest.volt.example:443/live',
    urlPattern: '^rtmps://',
    streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123' },
    hint: 'TLS RTMP. URL + stream key; typically port 443.',
    packageFriendly: false,
  },
  {
    id: 'hls', label: 'HLS', ingest: 'pull',
    urlLabel: 'HLS manifest URL',
    urlPlaceholder: 'https://…/master.m3u8',
    urlExample: 'https://cdn.example.com/live/master.m3u8',
    urlPattern: '^https?://.+\\.m3u8',
    streamKey: { show: false },
    hint: 'We pull this playlist. For a package channel add one manifest per rendition.',
    packageFriendly: true,
  },
  {
    id: 'dash', label: 'DASH', ingest: 'pull',
    urlLabel: 'DASH manifest URL',
    urlPlaceholder: 'https://…/manifest.mpd',
    urlExample: 'https://cdn.example.com/live/manifest.mpd',
    urlPattern: '^https?://.+\\.mpd',
    streamKey: { show: false },
    hint: 'We pull this MPD. For a package channel add one manifest per rendition.',
    packageFriendly: true,
  },
  {
    id: 'ndi', label: 'NDI', ingest: 'pull',
    urlLabel: 'NDI source name',
    urlPlaceholder: 'STUDIO-PC (Camera 1)',
    urlExample: 'STUDIO-PC (Camera 1)',
    streamKey: { show: false },
    hint: 'NDI source name on the local network. Requires an NDI-enabled ingest node.',
    packageFriendly: false,
  },
  {
    id: 'st2110', label: 'ST 2110', ingest: 'pull',
    urlLabel: 'ST 2110 stream',
    urlPlaceholder: '239.0.0.1:5000',
    urlExample: '239.0.0.1:5000',
    urlPattern: '^\\d{1,3}(\\.\\d{1,3}){3}:\\d+',
    streamKey: { show: false },
    extraFields: [
      { key: 'sdp', label: 'SDP', type: 'string', hint: 'Session Description (SDP) URL or inline for the essence flows.' },
    ],
    hint: 'SMPTE ST 2110 multicast. Requires an ST 2110-capable ingest node + SDP.',
    packageFriendly: false,
  },
];

const byId = new Map(INGEST_PROTOCOLS.map((p) => [p.id, p]));
export function getProtocol(id: string): IngestProtocol | undefined { return byId.get(id); }

/** Lenient validation: true if the URL plausibly matches the protocol (empty passes — the
 *  form may leave it blank while wiring). Used server-side as a guard, not a hard gate. */
export function urlMatchesProtocol(protocolId: string, url?: string | null): boolean {
  if (!url) return true;
  const p = byId.get(protocolId);
  if (!p?.urlPattern) return true;
  try { return new RegExp(p.urlPattern, 'i').test(url); } catch { return true; }
}
