/**
 * JSON-LD + Hydra hypermedia layer.
 *
 * Recovers the "SOAP/WSDL navigability" goal (api_design.md, 1 Aug): every
 * resource carries typed links; navigation is DATA in the response, not client
 * knowledge. Content-negotiated — plain JSON stays the default; a client that
 * sends `Accept: application/ld+json` (or `?format=jsonld`) gets the hypermedia
 * representation with @context/@id/@type, typed rels (self/up/collection/related),
 * Hydra collections (member/totalItems/view), an entrypoint, and ApiDocumentation.
 *
 * Non-invasive: a response post-processor (see middleware/hypermedia.ts) decorates
 * GET responses using the REGISTRY below, so the 34 existing handlers are untouched.
 */
import type { Request } from 'express';

export const LD_MIME = 'application/ld+json';

export function absBase(req: Request): string {
  // trust proxy is set in server.ts so protocol/host are correct behind the ALB.
  return `${req.protocol}://${req.get('host')}`;
}

export function wantsJsonLd(req: Request): boolean {
  if (req.method !== 'GET') return false; // navigation is a read concern
  if (typeof req.query.format === 'string' && req.query.format === 'jsonld') return true;
  const accept = req.headers.accept || '';
  return accept.includes(LD_MIME) || accept.includes('application/hydra+json');
}

// ---- Resource registry ------------------------------------------------------
// Keyed by the router mount path (req.baseUrl). Each entry knows its @type and
// how to build typed links for one item of that resource.
type LinkFn = (o: any, b: string) => Record<string, string>;
interface ResourceDesc {
  type: string;                 // @type for an item
  links: LinkFn;                // typed rels for an item (absolute IRIs)
  operations?: (o: any, b: string) => any[]; // inline hydra:Operation affordances
}

const q = (obj: Record<string, string | undefined>) =>
  Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export const REGISTRY: Record<string, ResourceDesc> = {
  '/api/channels': {
    type: 'volt:Channel',
    links: (o, b) => ({
      self: `${b}/api/channels/${o.id}`,
      collection: `${b}/api/channels`,
      up: `${b}/api`,
      recordings: `${b}/api/recordings?${q({ channelId: o.id })}`,
      scheduledClips: `${b}/api/scheduled-clips?${q({ channelId: o.id })}`,
      status: `${b}/api/status/channel/${o.id}`,
    }),
    operations: (o, b) => [
      op('PUT', `${b}/api/channels/${o.id}`, 'Update channel'),
      op('DELETE', `${b}/api/channels/${o.id}`, 'Delete channel'),
      op('POST', `${b}/api/channels/${o.id}/start`, 'Start channel'),
      op('POST', `${b}/api/channels/${o.id}/stop`, 'Stop channel'),
    ],
  },
  '/api/events': {
    type: 'volt:Event',
    links: (o, b) => ({
      self: `${b}/api/events/${o.id}`,
      collection: `${b}/api/events`,
      up: `${b}/api`,
      recordings: `${b}/api/recordings?${q({ kind: 'event' })}`,
      scheduledClips: `${b}/api/scheduled-clips?${q({ eventId: o.id })}`,
      status: `${b}/api/status/event/${o.id}`,
    }),
  },
  '/api/recordings': {
    type: 'volt:Recording',
    links: (o, b) => ({
      self: `${b}/api/recordings/${o.id}`,
      collection: `${b}/api/recordings`,
      up: o.channel_id ? `${b}/api/channels/${o.channel_id}` : o.event_id ? `${b}/api/events/${o.event_id}` : `${b}/api`,
      vod: `${b}/api/vod?${q({ recordingId: o.id })}`,
      download: `${b}/api/recordings/${o.id}/download`,
      ...(o.channel_id ? { channel: `${b}/api/channels/${o.channel_id}` } : {}),
      ...(o.event_id ? { event: `${b}/api/events/${o.event_id}` } : {}),
    }),
    operations: (o, b) => [op('POST', `${b}/api/recordings/${o.id}/clip`, 'Clip to VOD')],
  },
  '/api/vod': {
    type: 'schema:VideoObject',
    links: (o, b) => ({
      self: `${b}/api/vod/${o.id}`,
      collection: `${b}/api/vod`,
      up: o.recording_id ? `${b}/api/recordings/${o.recording_id}` : `${b}/api`,
      schemaOrg: `${b}/api/vod/${o.id}/schema.org`,
      publications: `${b}/api/publications?${q({ assetId: o.id })}`,
      ...(o.recording_id ? { recording: `${b}/api/recordings/${o.recording_id}` } : {}),
    }),
    operations: (o, b) => [
      op('PUT', `${b}/api/vod/${o.id}`, 'Update metadata'),
      op('POST', `${b}/api/publications/vod/${o.id}/publish`, 'Publish'),
    ],
  },
  '/api/metadata-schemas': {
    type: 'volt:MetadataSchema',
    links: (o, b) => ({ self: `${b}/api/metadata-schemas/${o.id}`, collection: `${b}/api/metadata-schemas`, up: `${b}/api` }),
  },
  '/api/filler-assets': {
    type: 'volt:FillerAsset',
    links: (o, b) => ({ self: `${b}/api/filler-assets/${o.id}`, collection: `${b}/api/filler-assets`, up: `${b}/api` }),
  },
  '/api/scheduled-clips': {
    type: 'volt:ScheduledClip',
    links: (o, b) => ({
      self: `${b}/api/scheduled-clips/${o.id}`,
      collection: `${b}/api/scheduled-clips`,
      up: o.channel_id ? `${b}/api/channels/${o.channel_id}` : o.event_id ? `${b}/api/events/${o.event_id}` : `${b}/api`,
      ...(o.vod_asset_id ? { vod: `${b}/api/vod/${o.vod_asset_id}` } : {}),
    }),
  },
  '/api/publish-targets': {
    type: 'volt:PublishTarget',
    links: (o, b) => ({ self: `${b}/api/publish-targets/${o.id}`, collection: `${b}/api/publish-targets`, up: `${b}/api` }),
  },
  '/api/publications': {
    type: 'volt:Publication',
    links: (o, b) => ({
      self: `${b}/api/publications/${o.id}`,
      collection: `${b}/api/publications`,
      up: o.vod_asset_id ? `${b}/api/vod/${o.vod_asset_id}` : `${b}/api`,
      ...(o.vod_asset_id ? { vod: `${b}/api/vod/${o.vod_asset_id}` } : {}),
    }),
  },
};

function op(method: string, target: string, title: string) {
  return { '@type': 'hydra:Operation', 'hydra:method': method, 'hydra:title': title, target };
}

// ---- Decorators -------------------------------------------------------------
export function decorateEntity(desc: ResourceDesc, o: any, b: string, ctxUrl?: string) {
  const links = desc.links(o, b);
  const out: any = {
    ...(ctxUrl ? { '@context': ctxUrl } : {}),
    '@id': links.self,
    '@type': o.clip_spec && desc.type === 'schema:VideoObject' ? 'schema:Clip' : desc.type,
    ...o,
    ...links,
  };
  if (desc.operations) out.operation = desc.operations(o, b);
  return out;
}

export function decorateCollection(desc: ResourceDesc, items: any[], req: Request, b: string, ctxUrl: string) {
  const selfUrl = `${b}${req.originalUrl}`;
  return {
    '@context': ctxUrl,
    '@id': selfUrl,
    '@type': 'hydra:Collection',
    'hydra:totalItems': items.length,
    'hydra:member': items.map((o) => decorateEntity(desc, o, b)),
    'hydra:view': { '@id': selfUrl, '@type': 'hydra:PartialCollectionView' },
  };
}

// ---- @context, entrypoint, ApiDocumentation ---------------------------------
export function contextDoc(b: string) {
  const idRel = (iri: string) => ({ '@id': iri, '@type': '@id' });
  return {
    '@context': {
      hydra: 'http://www.w3.org/ns/hydra/core#',
      schema: 'https://schema.org/',
      volt: `${b}/api/vocab#`,
      id: '@id',
      type: '@type',
      member: 'hydra:member',
      totalItems: 'hydra:totalItems',
      view: 'hydra:view',
      first: idRel('hydra:first'),
      next: idRel('hydra:next'),
      previous: idRel('hydra:previous'),
      last: idRel('hydra:last'),
      self: idRel('volt:self'),
      up: idRel('volt:up'),
      collection: idRel('hydra:collection'),
      recordings: idRel('volt:recordings'),
      vod: idRel('volt:vod'),
      status: idRel('volt:status'),
      publications: idRel('volt:publications'),
      schemaOrg: idRel('volt:schemaOrg'),
      channel: idRel('volt:channel'),
      event: idRel('volt:event'),
      download: idRel('volt:download'),
      scheduledClips: idRel('volt:scheduledClips'),
      recording: idRel('volt:recording'),
      apiDocumentation: idRel('hydra:apiDocumentation'),
    },
  };
}

const ENTRY = [
  ['channels', '/api/channels'],
  ['events', '/api/events'],
  ['recordings', '/api/recordings'],
  ['vod', '/api/vod'],
  ['metadataSchemas', '/api/metadata-schemas'],
  ['fillerAssets', '/api/filler-assets'],
  ['scheduledClips', '/api/scheduled-clips'],
  ['publishTargets', '/api/publish-targets'],
  ['publications', '/api/publications'],
  ['status', '/api/status'],
] as const;

export function entrypoint(b: string) {
  const out: any = {
    '@context': `${b}/api/context.jsonld`,
    '@id': `${b}/api`,
    '@type': ['hydra:EntryPoint', 'volt:EntryPoint'],
    apiDocumentation: `${b}/api/doc`,
  };
  for (const [rel, path] of ENTRY) out[rel] = `${b}${path}`;
  return out;
}

export function apiDocumentation(b: string) {
  return {
    '@context': `${b}/api/context.jsonld`,
    '@id': `${b}/api/doc`,
    '@type': 'hydra:ApiDocumentation',
    'hydra:title': 'Volt Streaming API',
    'hydra:description':
      'Control-plane API. Send `Accept: application/ld+json` for the JSON-LD + Hydra hypermedia representation (typed links, collections, entrypoint). Bearer-auth (JWT); the encoder ingest route uses X-Volt-Ingest-Token.',
    'hydra:entrypoint': `${b}/api`,
    'hydra:supportedClass': Object.entries(REGISTRY).map(([path, d]) => ({
      '@id': d.type,
      '@type': 'hydra:Class',
      'hydra:title': d.type.replace(/^.*:/, ''),
      'hydra:description': `Resource at ${path}`,
    })),
  };
}
