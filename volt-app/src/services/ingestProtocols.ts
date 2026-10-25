// ============================================================================
//  Ingest-protocol descriptor registry — the single source of truth for how a
//  source is entered in the UI *and* validated on the server. Keyed to the DB
//  `ingest_protocol` enum. The app fetches this via GET /api/ingest-protocols
//  so the source form's fields, examples and checks change with the protocol
//  without being written twice. See docs/SOURCES.md.
//
//  WHO MAY USE WHAT.
//    Channels and events (video): HLS, DASH, SRT, RTMP, RTMPS, NDI, ST 2110,
//    for transcoding AND packaging.
//    Radio stations: Icecast / HTTP audio (plus HLS and DASH audio).
//  Icecast is a radio protocol: a TV channel or an event never offers it.
//
//  PACKAGING: compressed sources (HLS, DASH, SRT, RTMP) are re-packaged as
//  they arrive, without re-encoding. NDI and ST 2110 carry uncompressed (or
//  lightly compressed) video, so a packaging rendition from them is encoded
//  once, at that rendition's own size and bitrate (`packaging: 'encode'`).
//
//  Per-protocol settings live in stream_inputs.params (migration 0057) and go
//  to the encoder with the input; validateSource() is what create, edit and
//  the start path all use, so a source that cannot work is refused with the
//  reason before anything runs.
// ============================================================================

export type FieldType = 'url' | 'string' | 'number' | 'password' | 'select' | 'text';

export interface ProtocolField {
  key: string;                 // stream_inputs.params key
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  default?: string | number;
  options?: Array<{ value: string; label: string }>;
  /** Show only when another field has one of these values (e.g. SRT listener port). */
  when?: { key: string; in: string[] };
  min?: number; max?: number;
  /** Shown under "More settings" rather than always. */
  advanced?: boolean;
}

export type ProtocolScope = 'video' | 'radio';

export interface IngestProtocol {
  id: string;
  label: string;
  ingest: 'push' | 'pull';     // push = the source sends to an address we give; pull = we fetch it
  urlLabel: string;
  urlPlaceholder: string;
  urlExample: string;
  urlPattern?: string;         // RegExp source, checked client and server side
  streamKey: { show: boolean; label?: string; placeholder?: string; required?: boolean };
  fields?: ProtocolField[];
  hint: string;
  /** Where it may be used. */
  scopes: ProtocolScope[];
  /** Usable as a packaging rendition input. */
  packageFriendly: boolean;
  /** How packaging treats it: re-packaged as is, or encoded once to the rendition. */
  packaging: 'remux' | 'encode';
  /** Can it be checked from the control plane before starting (Check source)? */
  checkable: boolean;
}

export const INGEST_PROTOCOLS: IngestProtocol[] = [
  {
    id: 'hls', label: 'HLS', ingest: 'pull',
    urlLabel: 'HLS playlist URL',
    urlPlaceholder: 'https://…/master.m3u8',
    urlExample: 'https://cdn.example.com/live/master.m3u8',
    urlPattern: '^https?://.+\\.m3u8',
    streamKey: { show: false },
    hint: 'We pull this playlist. A master playlist asks which variant to take.',
    scopes: ['video', 'radio'], packageFriendly: true, packaging: 'remux', checkable: true,
  },
  {
    id: 'dash', label: 'DASH', ingest: 'pull',
    urlLabel: 'DASH manifest URL',
    urlPlaceholder: 'https://…/manifest.mpd',
    urlExample: 'https://cdn.example.com/live/manifest.mpd',
    urlPattern: '^https?://.+\\.mpd',
    streamKey: { show: false },
    hint: 'We pull this MPD (live or static).',
    scopes: ['video', 'radio'], packageFriendly: true, packaging: 'remux', checkable: true,
  },
  {
    id: 'srt', label: 'SRT', ingest: 'push',
    urlLabel: 'SRT address',
    urlPlaceholder: 'srt://host:9000',
    urlExample: 'srt://contribution.example.com:9000',
    urlPattern: '^srt://[^\\s/:]+:\\d{2,5}',
    streamKey: { show: false },
    fields: [
      { key: 'mode', label: 'Connection', type: 'select', default: 'caller', options: [
        { value: 'caller', label: 'Caller (we connect)' },
        { value: 'listener', label: 'Listener (it connects)' },
      ], hint: 'Caller: the address is the sender\'s. Listener: the address is the port we open (srt://0.0.0.0:PORT); give the sender our ingest host and that port.' },
      { key: 'streamid', label: 'Stream ID', type: 'string', placeholder: '#!::r=live/match1,m=publish',
        hint: 'Only when the other side needs one (many SRT gateways do).' },
      { key: 'latency', label: 'Latency (ms)', type: 'number', default: 200, min: 20, max: 8000,
        hint: 'Receive buffer. About 4× the round trip; 200 ms is typical, 1000+ over the open internet.' },
      { key: 'passphrase', label: 'Passphrase', type: 'password', placeholder: '10 to 79 characters',
        hint: 'Must match the sender exactly. Leave empty for an unencrypted link.' },
      { key: 'pbkeylen', label: 'Key length', type: 'select', default: '16', advanced: true, options: [
        { value: '16', label: 'AES-128' }, { value: '24', label: 'AES-192' }, { value: '32', label: 'AES-256' },
      ], when: { key: 'passphrase', in: ['*'] }, hint: 'Must match the sender.' },
    ],
    hint: 'Secure Reliable Transport, MPEG-TS inside. Choose who connects to whom.',
    scopes: ['video'], packageFriendly: true, packaging: 'remux', checkable: true,
  },
  {
    id: 'rtmp', label: 'RTMP', ingest: 'push',
    urlLabel: 'RTMP server URL',
    urlPlaceholder: 'rtmp://host/app',
    urlExample: 'rtmp://ingest.volt.example/live',
    urlPattern: '^rtmp://[^\\s/]+/',
    streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123', required: true },
    hint: 'Server URL + stream key, exactly like OBS or a hardware encoder (Server + Stream key). H.264 / AAC.',
    scopes: ['video'], packageFriendly: true, packaging: 'remux', checkable: true,
  },
  {
    id: 'rtmps', label: 'RTMPS', ingest: 'push',
    urlLabel: 'RTMPS server URL',
    urlPlaceholder: 'rtmps://host:443/app',
    urlExample: 'rtmps://ingest.volt.example:443/live',
    urlPattern: '^rtmps://[^\\s/]+/',
    streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123', required: true },
    hint: 'RTMP over TLS: server URL + stream key, usually port 443.',
    scopes: ['video'], packageFriendly: true, packaging: 'remux', checkable: true,
  },
  {
    id: 'ndi', label: 'NDI', ingest: 'pull',
    urlLabel: 'NDI source name',
    urlPlaceholder: 'STUDIO-PC (Camera 1)',
    urlExample: 'STUDIO-PC (Camera 1)',
    urlPattern: '^.+ \\(.+\\)$',
    streamKey: { show: false },
    fields: [
      { key: 'groups', label: 'NDI groups', type: 'string', placeholder: 'public', advanced: true,
        hint: 'Comma-separated groups the source is in. Empty = public.' },
      { key: 'discoveryServer', label: 'Discovery server', type: 'string', placeholder: '10.0.0.5:5959',
        hint: 'When sources are found through an NDI Discovery Server rather than mDNS (usual across subnets and in the cloud).' },
      { key: 'extraIps', label: 'Extra IPs', type: 'string', placeholder: '10.0.1.20, 10.0.1.21', advanced: true,
        hint: 'Machines to ask directly when discovery cannot reach them.' },
      { key: 'bandwidth', label: 'Receive', type: 'select', default: 'highest', options: [
        { value: 'highest', label: 'Full quality' }, { value: 'lowest', label: 'Proxy (low bandwidth)' },
      ], advanced: true },
    ],
    hint: 'The source name exactly as NDI shows it: MACHINE (Source). Needs an NDI-enabled ingest node on the same network (or a Discovery Server).',
    scopes: ['video'], packageFriendly: true, packaging: 'encode', checkable: false,
  },
  {
    id: 'st2110', label: 'ST 2110', ingest: 'pull',
    urlLabel: 'Video flow (multicast:port)',
    urlPlaceholder: '239.10.10.1:5000',
    urlExample: '239.10.10.1:5000',
    urlPattern: '^\\d{1,3}(\\.\\d{1,3}){3}:\\d{2,5}$',
    streamKey: { show: false },
    fields: [
      { key: 'sdp', label: 'SDP', type: 'text', required: true, placeholder: 'https://…/flows.sdp, or paste the SDP (v=0 …)',
        hint: 'The session description: its URL, or the SDP itself. List the video (2110-20) and audio (2110-30) flows in it; it carries their format.' },
      { key: 'interfaceIp', label: 'Receive interface (IP)', type: 'string', placeholder: '192.168.50.10',
        hint: 'The ingest node\'s address on the media network: which NIC joins the multicast.' },
      { key: 'sourceIp', label: 'Source IP (SSM)', type: 'string', placeholder: '192.168.50.2', advanced: true,
        hint: 'For source-specific multicast.' },
      { key: 'ptpDomain', label: 'PTP domain', type: 'number', default: 127, min: 0, max: 127, advanced: true,
        hint: 'SMPTE 2059-2 default is 127.' },
    ],
    hint: 'SMPTE ST 2110 multicast on the media network. Needs an ingest node with a 2110 NIC, PTP-locked.',
    scopes: ['video'], packageFriendly: true, packaging: 'encode', checkable: false,
  },
  {
    id: 'icecast', label: 'Icecast / HTTP audio', ingest: 'pull',
    urlLabel: 'Stream URL (mount)',
    urlPlaceholder: 'https://ice.example.com/station-128-mp3',
    // A neutral example: the form shows it to customers (it named a real station).
    urlExample: 'https://radio.example.com/live-128-mp3',
    urlPattern: '^https?://',
    streamKey: { show: false },
    hint: 'Icecast / SHOUTcast mount or any HTTP MP3/AAC stream. We negotiate ICY metadata, so now-playing titles are captured into the timed metadata log.',
    scopes: ['radio'], packageFriendly: true, packaging: 'remux', checkable: true,
  },
];

const byId = new Map(INGEST_PROTOCOLS.map((p) => [p.id, p]));
export function getProtocol(id: string): IngestProtocol | undefined { return byId.get(id); }

/** The protocols a channel/event (video) or a radio station may use. */
export function protocolsFor(scope: ProtocolScope): IngestProtocol[] {
  return INGEST_PROTOCOLS.filter((p) => p.scopes.includes(scope));
}

/** Lenient URL check (empty passes; the required check is validateSource's). */
export function urlMatchesProtocol(protocolId: string, url?: string | null): boolean {
  if (!url) return true;
  const p = byId.get(protocolId);
  if (!p?.urlPattern) return true;
  try { return new RegExp(p.urlPattern, 'i').test(url.trim()); } catch { return true; }
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTPORT = /^[^\s:]+:\d{2,5}$/;
const isIp = (v: string) => IPV4.test(v) && v.split('.').every((n) => Number(n) <= 255);
const isMulticast = (v: string) => { const ip = v.split(':')[0]; return isIp(ip) && Number(ip.split('.')[0]) >= 224 && Number(ip.split('.')[0]) <= 239; };

export interface SourceToCheck {
  protocol: string;
  ingestUrl?: string | null;
  streamKey?: string | null;
  params?: Record<string, unknown> | null;
}

/**
 * Is this source complete and plausible for its protocol? Returns the reason
 * it is not, in words an operator can act on, or null. Used on create, edit
 * and start, and mirrored in the console (protocols.tsx sourceProblem).
 */
export function validateSource(s: SourceToCheck, scope: ProtocolScope = 'video'): string | null {
  const p = byId.get(String(s.protocol).toLowerCase());
  if (!p) return `"${s.protocol}" is not a source type Volt can ingest`;
  if (!p.scopes.includes(scope)) {
    return scope === 'video'
      ? `${p.label} is for radio stations; a channel or event takes HLS, DASH, SRT, RTMP, NDI or ST 2110`
      : `${p.label} is not available for radio stations`;
  }
  const url = (s.ingestUrl ?? '').trim();
  const params = (s.params ?? {}) as Record<string, any>;
  const str = (k: string) => (params[k] == null ? '' : String(params[k]).trim());
  if (!url) return `${p.urlLabel} is required`;
  if (p.urlPattern && !new RegExp(p.urlPattern, 'i').test(url)) return `${p.urlLabel} should look like ${p.urlExample}`;
  if (p.streamKey.required && !(s.streamKey ?? '').trim()) {
    // A pull from another RTMP server may carry the key in the path: rtmp://host/app/key.
    const path = url.replace(/^rtmps?:\/\/[^/]+/i, '').split('/').filter(Boolean);
    if (path.length < 2) return `${p.label} needs the stream key`;
  }
  for (const f of p.fields ?? []) {
    const v = str(f.key);
    if (f.required && !v) return `${f.label} is required for ${p.label}`;
    if (v && f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) return `${f.label} must be a number from ${f.min} to ${f.max}`;
    }
    if (v && f.type === 'select' && f.options && !f.options.some((o) => o.value === v)) return `${f.label}: choose one of ${f.options.map((o) => o.label).join(', ')}`;
  }
  switch (p.id) {
    case 'srt': {
      const pass = str('passphrase');
      if (pass && (pass.length < 10 || pass.length > 79)) return 'The SRT passphrase must be 10 to 79 characters';
      if (str('mode') === 'listener' && !/^srt:\/\/(0\.0\.0\.0|\[::\]|[^\s/:]+):\d{2,5}/i.test(url)) return 'A listener address is the port we open, e.g. srt://0.0.0.0:9000';
      const port = Number((url.match(/:(\d{2,5})/) ?? [])[1]);
      if (!(port >= 1 && port <= 65535)) return 'The SRT address needs a port, e.g. srt://host:9000';
      break;
    }
    case 'ndi': {
      const ds = str('discoveryServer');
      if (ds && !HOSTPORT.test(ds) && !isIp(ds) && !/^[\w.-]+$/.test(ds)) return 'The NDI discovery server is a host or IP, optionally with :port';
      const ips = str('extraIps');
      if (ips && !ips.split(/[\s,]+/).filter(Boolean).every(isIp)) return 'NDI extra IPs must be IPv4 addresses, comma separated';
      break;
    }
    case 'st2110': {
      if (!isMulticast(url)) return 'The ST 2110 video flow is a multicast address (224.0.0.0 to 239.255.255.255) with a port';
      const sdp = str('sdp');
      if (sdp && !/^https?:\/\//i.test(sdp) && !/^v=0/m.test(sdp)) return 'The SDP is a URL or the SDP text itself (starting v=0)';
      for (const k of ['interfaceIp', 'sourceIp']) if (str(k) && !isIp(str(k))) return `${k === 'interfaceIp' ? 'The receive interface' : 'The source IP'} must be an IPv4 address`;
      break;
    }
  }
  return null;
}

/** Only the settings the protocol defines, trimmed; unknown keys are dropped. */
export function cleanParams(protocol: string, params: Record<string, unknown> | null | undefined): Record<string, string | number> {
  const p = byId.get(String(protocol).toLowerCase());
  const out: Record<string, string | number> = {};
  if (!p || !params) return out;
  for (const f of p.fields ?? []) {
    const v = params[f.key];
    if (v == null || String(v).trim() === '') continue;
    out[f.key] = f.type === 'number' ? Number(v) : String(v).trim();
  }
  return out;
}
