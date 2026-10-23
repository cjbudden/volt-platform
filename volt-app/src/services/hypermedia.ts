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
import type { Request, Response } from 'express';
import { listSpecsForDocs } from '../util/listQuery';
import { routeInventory, type RouteRow } from '../util/routeInventory';

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
      // The status collection filtered to this stream: 200 with 0 or 1 member,
      // where /api/status/channel/:id is a 404 until the channel has run.
      status: `${b}/api/status?${q({ channelId: o.id })}`,
      epg: `${b}/api/epg?${q({ channelId: o.id })}`,
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
      status: `${b}/api/status?${q({ eventId: o.id })}`,
      epg: `${b}/api/epg?${q({ eventId: o.id })}`,
    }),
  },
  // One list over channels, stations, events and FAST channels (build queue
  // 1.12). An item's own page is its aggregate; `resource` is the row in its
  // own collection (channel, radio station, event or FAST channel).
  '/api/live-streams': {
    type: 'volt:LiveStream',
    links: (o, b) => {
      const ev = o.kind === 'event';
      const fast = o.kind === 'fast_channel';
      return {
        self: `${b}/api/live-streams/${ev ? 'event' : 'channel'}/${o.id}`,
        collection: `${b}/api/live-streams`,
        up: `${b}/api`,
        resource: ev ? `${b}/api/events/${o.id}` : fast ? `${b}/api/fast/channels/${o.id}` : o.medium === 'radio' ? `${b}/api/radio/${o.id}` : `${b}/api/channels/${o.id}`,
        status: `${b}/api/status?${q(ev ? { eventId: o.id } : { channelId: o.id })}`,
        epg: `${b}/api/epg?${q(ev ? { eventId: o.id } : { channelId: o.id })}`,
      };
    },
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
      // Publications are listed per asset (the bare collection is a 400).
      collection: o.vod_asset_id ? `${b}/api/publications?${q({ assetId: o.vod_asset_id })}` : `${b}/api/vod`,
      up: o.vod_asset_id ? `${b}/api/vod/${o.vod_asset_id}` : `${b}/api`,
      ...(o.vod_asset_id ? { vod: `${b}/api/vod/${o.vod_asset_id}` } : {}),
    }),
  },
};

function op(method: string, target: string, title: string) {
  return { '@type': 'hydra:Operation', 'hydra:method': method, 'hydra:title': title, target };
}

// ---- Decorators -------------------------------------------------------------
export interface CollectionOpts {
  /** Matching items across every page (X-Total-Count), when known. */
  total?: number;
  /** The hydra:view (paging controls) for this page. */
  view?: any;
  /** A hydra:search IriTemplate describing the collection's filters. */
  search?: any;
  /** Typed link up to the parent of the collection. */
  up?: string;
}

export function decorateEntity(desc: ResourceDesc, o: any, b: string, ctxUrl?: string) {
  const links = desc.links(o, b);
  const out: any = {
    ...(ctxUrl ? { '@context': ctxUrl } : {}),
    ...(links.self ? { '@id': links.self } : {}),
    '@type': o.clip_spec && desc.type === 'schema:VideoObject' ? 'schema:Clip' : desc.type,
    ...o,
    ...links,
  };
  if (desc.operations) out.operation = desc.operations(o, b);
  return out;
}

export function decorateCollection(desc: ResourceDesc, items: any[], req: Request, b: string, ctxUrl: string, opts: CollectionOpts = {}) {
  const selfUrl = `${b}${req.originalUrl}`;
  const members = items.map((o) => decorateEntity(desc, o, b));
  // Siblings: left/right inside the ORIGINATING view, so a client moving
  // across items stays inside the same filtered, sorted page.
  members.forEach((m, i) => {
    if (i > 0 && members[i - 1]['@id']) m.previousSibling = members[i - 1]['@id'];
    if (i < members.length - 1 && members[i + 1]['@id']) m.nextSibling = members[i + 1]['@id'];
  });
  return {
    '@context': ctxUrl,
    '@id': selfUrl,
    '@type': 'hydra:Collection',
    'hydra:totalItems': typeof opts.total === 'number' ? opts.total : items.length,
    'hydra:member': members,
    'hydra:view': opts.view ?? { '@id': selfUrl, '@type': 'hydra:PartialCollectionView' },
    ...(opts.search ? { 'hydra:search': opts.search } : {}),
    ...(opts.up ? { up: opts.up } : {}),
  };
}

// ---- Resolution: which resource does a URL name? ---------------------------
// Built from the running app's routes + the list registry, so every list
// endpoint is a Hydra collection (not only the REGISTRY above) and a link is
// emitted only when a route answers it.
type Kind = 'collection' | 'entity' | 'sub';
export interface Resolved {
  kind: Kind;
  /** Route pattern of the collection, e.g. /api/watchfolders/:id/items */
  pattern: string;
  /** Concrete collection path for this request, e.g. /api/watchfolders/42/items */
  concrete: string;
  /** For an entity: its id segment. For a sub-resource: the parent entity path. */
  id?: string;
  parent?: string;
  desc: ResourceDesc;
  spec?: ReturnType<typeof listSpecsForDocs>[number];
}

interface Model {
  collections: { pattern: string; rx: RegExp; hasItem: boolean; itemRx: RegExp; literals: Set<string>; itemSubs: string[]; collSubs: string[] }[];
  /** Every GET route pattern, compiled, to test whether a URL is answerable. */
  getRx: RegExp[];
  routes: RouteRow[];
  specs: Map<string, ReturnType<typeof listSpecsForDocs>[number]>;
}
const toRx = (pattern: string, tail = '') =>
  new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]\w*/g, '[^/]+') + tail + '$');
const models = new WeakMap<object, Model>();
const NOT_COLLECTIONS = new Set(['/api', '/api/doc', '/api/context.jsonld']);

export function buildModel(routes: RouteRow[]): Model {
  const specs = new Map(listSpecsForDocs().map((s) => [s.path, s]));
  const get = new Set(routes.filter((r) => r.method === 'GET').map((r) => r.path));
  const pats = new Set<string>([...Object.keys(REGISTRY), ...specs.keys()]);
  // Any GET p that also serves GET p/:param is a collection of items.
  for (const p of get) {
    const m = p.match(/^(.*)\/:[A-Za-z_]\w*$/);
    if (m && get.has(m[1]) && !m[1].endsWith('/:id')) pats.add(m[1]);
  }
  const collections = [...pats].filter((p) => !NOT_COLLECTIONS.has(p) && p.startsWith('/api/')).map((pattern) => {
    const itemRoute = [...get].find((g) => g.startsWith(pattern + '/:') && !g.slice(pattern.length + 2).includes('/'));
    const literals = new Set([...get, ...routes.map((r) => r.path)]
      .filter((g) => g.startsWith(pattern + '/') && !g.slice(pattern.length + 1).includes('/') && !g.slice(pattern.length + 1).startsWith(':'))
      .map((g) => g.slice(pattern.length + 1)));
    // Drill-down targets: GET pattern/:id/<word> (an item's sub-resources) and
    // GET pattern/<word> (views of the collection, e.g. /api/epg/owners).
    const itemSubs = itemRoute ? [...get].filter((g) => g.startsWith(itemRoute + '/') && /^[\w-]+$/.test(g.slice(itemRoute.length + 1))).map((g) => g.slice(itemRoute.length + 1)) : [];
    const collSubs = [...get].filter((g) => g.startsWith(pattern + '/') && /^[\w-]+$/.test(g.slice(pattern.length + 1))).map((g) => g.slice(pattern.length + 1));
    return { pattern, rx: toRx(pattern), hasItem: !!itemRoute, itemRx: toRx(pattern, '/[^/]+'), literals, itemSubs, collSubs };
  }).sort((x, y) => y.pattern.length - x.pattern.length); // most specific first
  return { collections, routes, specs, getRx: [...get].map((g) => toRx(g)) };
}
export function modelFor(app: any): Model {
  let m = models.get(app);
  if (!m) { m = buildModel(routeInventory(app)); models.set(app, m); }
  return m;
}

const pascal = (s: string) => s.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
const singular = (s: string) => s.replace(/ies$/, 'y').replace(/(ss|x|ch|sh)es$/, '$1').replace(/([^su])s$/, '$1');
/** Generic description for a collection the REGISTRY does not describe by hand. */
export function genericDesc(pattern: string, concrete: string, hasItem: boolean): ResourceDesc {
  // Every static segment after /api names the type, so /api/fast/channels is a
  // FastChannel and never collides with /api/channels (Channel).
  const segs = pattern.split('/').filter((x) => x && x !== 'api' && !x.startsWith(':'));
  const name = segs.map((x, i) => pascal(i === segs.length - 1 ? x : singular(x))).join('');
  // A nested collection (/api/watchfolders/:id/items) walks up to its parent item.
  const parentIsItem = pattern.split('/').slice(-2, -1)[0]?.startsWith(':');
  const up = parentIsItem ? concrete.split('/').slice(0, -1).join('/') : '/api';
  return {
    type: `volt:${singular(name) || 'Resource'}`,
    links: (o, b) => {
      const id = o.id ?? o.key ?? o.slug;
      const self = id != null ? (hasItem ? `${b}${concrete}/${encodeURIComponent(String(id))}` : `${b}${concrete}#${encodeURIComponent(String(id))}`) : undefined;
      return { ...(self ? { self } : {}), collection: `${b}${concrete}`, up: `${b}${up}` };
    },
  };
}

/** Does a GET route answer this path? (So a link is emitted only when it works.) */
export function answers(app: any, path: string): boolean {
  if (SCOPED[path]) return false; // answers only with its scope parameters
  return modelFor(app).getRx.some((rx) => rx.test(path));
}

/**
 * Sub-resources that need query parameters to answer (a time window, an owner).
 * They are offered as IriTemplates naming those parameters, never as bare links
 * that would 400 when followed. Key: "<collection pattern>|<word>".
 */
export const PARAMETERISED: Record<string, string[]> = {
  '/api/channels|access-check': ['country', 'viewer'],
  '/api/events|access-check': ['country', 'viewer'],
  '/api/channels|coverage': ['from', 'to'],
  '/api/channels|timeline': ['from', 'to'],
  '/api/channels|waveform': ['from', 'to', 'buckets'],
  '/api/channels|thumbs': ['from', 'to', 'count'],
  '/api/epg|vod-status': ['channelId', 'eventId', 'from', 'to'],
  '/api/epg|now-next': ['channelId', 'eventId'],
  '/api/epg|owner-defaults': ['channelId', 'eventId'],
  '/api/epg|conflicts': ['channelId', 'eventId'],
};
const template = (url: string, vars: string[]) => ({
  '@type': 'hydra:IriTemplate',
  'hydra:template': `${url}{?${vars.join(',')}}`,
  'hydra:variableRepresentation': 'hydra:BasicRepresentation',
  'hydra:mapping': vars.map((v) => ({ '@type': 'hydra:IriTemplateMapping', 'hydra:variable': v, 'hydra:required': true })),
});

/** Links to an item's sub-resources (rel = camelCase of the route word). */
export function itemSubLinks(app: any, r: Resolved, b: string, id: string): Record<string, any> {
  const c = modelFor(app).collections.find((x) => x.pattern === r.pattern);
  const out: Record<string, any> = {};
  for (const w of c?.itemSubs ?? []) {
    const url = `${b}${r.concrete}/${encodeURIComponent(id)}/${w}`;
    const vars = PARAMETERISED[`${r.pattern}|${w}`];
    out[camelWord(w)] = vars ? template(url, vars) : url;
  }
  return out;
}
/** Links to a collection's own views (/api/epg/owners from /api/epg). */
export function collectionSubLinks(app: any, r: Resolved, b: string): Record<string, any> {
  const c = modelFor(app).collections.find((x) => x.pattern === r.pattern);
  const out: Record<string, any> = {};
  for (const w of c?.collSubs ?? []) {
    if (c?.hasItem && !c.literals.has(w)) continue;
    const vars = PARAMETERISED[`${r.pattern}|${w}`];
    out[camelWord(w)] = vars ? template(`${b}${r.concrete}/${w}`, vars) : `${b}${r.concrete}/${w}`;
  }
  return out;
}
const camelWord = (w: string) => w.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());

export function resolve(app: any, path: string): Resolved | null {
  const clean = path.replace(/\/+$/, '') || '/';
  if (!clean.startsWith('/api/')) return null;
  const m = modelFor(app);
  const descOf = (c: Model['collections'][number], concrete: string) => REGISTRY[c.pattern] ?? genericDesc(c.pattern, concrete, c.hasItem);
  for (const c of m.collections) {
    if (c.rx.test(clean)) return { kind: 'collection', pattern: c.pattern, concrete: clean, desc: descOf(c, clean), spec: m.specs.get(c.pattern) };
  }
  for (const c of m.collections) {
    if (!c.hasItem || !c.itemRx.test(clean)) continue;
    const seg = clean.slice(clean.lastIndexOf('/') + 1);
    if (c.literals.has(seg)) continue; // /api/x/catalogue is a sub-route, not an item
    const concrete = clean.slice(0, clean.lastIndexOf('/'));
    return { kind: 'entity', pattern: c.pattern, concrete, id: decodeURIComponent(seg), desc: descOf(c, concrete), spec: m.specs.get(c.pattern) };
  }
  // Something under an item (e.g. /api/channels/:id/history): link it up to that item.
  for (const c of m.collections) {
    if (!c.hasItem) continue;
    const rx = toRx(c.pattern, '/[^/]+/.+');
    if (!rx.test(clean)) continue;
    const depth = c.pattern.split('/').length + 1;
    const parent = clean.split('/').slice(0, depth).join('/');
    const seg = parent.slice(parent.lastIndexOf('/') + 1);
    if (c.literals.has(seg)) continue;
    return { kind: 'sub', pattern: c.pattern, concrete: clean, parent, desc: genericDesc(clean, clean, false) };
  }
  // Anything else a GET route answers (a collection's view such as
  // /api/epg/owners, /api/fleet/hosts): it still gets an @id, an up link to
  // the nearest ancestor that answers, and a breadcrumb.
  if (clean.startsWith('/api/public/') || !m.getRx.some((rx) => rx.test(clean))) return null;
  let parent = clean.slice(0, clean.lastIndexOf('/'));
  while (parent.length > 4 && (SCOPED[parent] || !m.getRx.some((rx) => rx.test(parent)))) parent = parent.slice(0, parent.lastIndexOf('/'));
  return { kind: 'sub', pattern: clean, concrete: clean, parent: parent.length > 4 ? parent : '/api', desc: genericDesc(clean, clean, false) };
}

// ---- Paging controls (hydra:view) -------------------------------------------
/** Parse RFC 8288 Link header value(s) into rel -> URL. */
export function parseLinks(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const vals = Array.isArray(h) ? h : h == null ? [] : [String(h)];
  for (const v of vals) for (const m of String(v).matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)) out[m[2]] ??= m[1];
  return out;
}

/**
 * Hydra paging from the list standard's own headers (util/listQuery.ts): its
 * Link rel next / prev / first / last (keyset cursors that stay inside the
 * caller's filters and sort), X-Page-Limit and X-Total-Count. A list that
 * offers offset paging and sends no cursor links gets offset first / previous
 * / next / last instead. `first` is always present.
 */
export function pagingView(req: Request, res: Response, b: string, count: number, allowOffset: boolean) {
  const u = new URL(req.originalUrl, 'http://x');
  const at = (mut: (s: URLSearchParams) => void) => {
    const v = new URL(u.toString()); mut(v.searchParams);
    return `${b}${v.pathname}${v.search}`;
  };
  const view: any = { '@id': `${b}${req.originalUrl}`, '@type': 'hydra:PartialCollectionView' };
  const limit = Number(res.getHeader('X-Page-Limit')) || 0;
  const total = res.getHeader('X-Total-Count') != null ? Number(res.getHeader('X-Total-Count')) : undefined;
  const rels = parseLinks(res.getHeader('Link'));
  const abs = (x: string) => (x.startsWith('http') ? x : `${b}${x}`);
  view.first = rels.first ? abs(rels.first) : at((s) => { s.delete('cursor'); s.delete('offset'); });
  if (rels.prev) view.previous = abs(rels.prev);
  if (rels.next) view.next = abs(rels.next);
  if (rels.last) view.last = abs(rels.last);
  if (!rels.next && !rels.prev && allowOffset && limit) {
    const off = Math.max(0, Number(u.searchParams.get('offset') ?? 0) || 0);
    if (off > 0) view.previous = at((s) => { s.delete('cursor'); s.set('offset', String(Math.max(0, off - limit))); });
    if (typeof total === 'number' && off + count < total) view.next = at((s) => { s.delete('cursor'); s.set('offset', String(off + limit)); });
    if (typeof total === 'number' && total > limit) view.last = at((s) => { s.delete('cursor'); s.set('offset', String(Math.floor((total - 1) / limit) * limit)); });
  }
  if (limit) view['volt:pageSize'] = limit;
  return view;
}

/** hydra:search: the collection's filters as an IriTemplate (from its ListSpec). */
export function searchTemplate(b: string, concrete: string, spec: NonNullable<Resolved['spec']>) {
  const filters = Object.entries(spec.fields).filter(([, f]) => f.filter).map(([k]) => k);
  const vars = [...(spec.search.length ? ['q'] : []), ...filters, 'sort', 'limit', 'cursor', ...(spec.allowOffset ? ['offset'] : []), 'count'];
  return {
    '@type': 'hydra:IriTemplate',
    'hydra:template': `${b}${concrete}{?${vars.join(',')}}`,
    'hydra:variableRepresentation': 'hydra:BasicRepresentation',
    'hydra:mapping': vars.map((v) => ({
      '@type': 'hydra:IriTemplateMapping', 'hydra:variable': v,
      'hydra:property': spec.fields[v] ? `volt:${v}` : v === 'q' ? 'hydra:freetextQuery' : `volt:${v}`,
      'hydra:required': false,
    })),
  };
}

// ---- Breadcrumb -------------------------------------------------------------
const titleOf = (o: any) => o?.name ?? o?.title ?? o?.label ?? o?.email ?? (o?.id != null ? String(o.id) : undefined);
const humanize = (seg: string) => seg.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
/**
 * The trail from the entry point to this resource. When the resource's typed
 * `up` is another entity (a recording's channel), the trail runs through that
 * entity; otherwise it follows the URL hierarchy.
 */
export function breadcrumb(b: string, path: string, self: string | undefined, o: any, up?: string, ok: (p: string) => boolean = () => true) {
  const crumbs: { '@id': string; title: string }[] = [{ '@id': `${b}/api`, title: 'API' }];
  if (up && up !== `${b}/api` && up.startsWith(b) && self && !self.startsWith(up + '/')) {
    const upPath = up.slice(b.length).split('?')[0];
    const upColl = upPath.split('/').slice(0, -1).join('/');
    if (upColl.length > 4) crumbs.push({ '@id': `${b}${upColl}`, title: humanize(upColl.split('/').pop()!) });
    crumbs.push({ '@id': up, title: upPath.split('/').pop()! });
    crumbs.push({ '@id': self, title: titleOf(o) ?? 'item' });
    return crumbs;
  }
  const segs = path.split('/').filter(Boolean); // ['api', ...]
  for (let i = 2; i <= segs.length; i++) {
    const p = '/' + segs.slice(0, i).join('/');
    const last = i === segs.length;
    if (!last && !ok(p)) continue; // /api/fast is not a resource, only a prefix
    crumbs.push({ '@id': last && self ? self : `${b}${p}`, title: last ? (titleOf(o) ?? humanize(segs[i - 1])) : humanize(segs[i - 1]) });
  }
  return crumbs;
}

// ---- @context, entrypoint, ApiDocumentation ---------------------------------
// The volt: vocabulary lives in the ApiDocumentation (/api/doc#Term), so every
// volt: term dereferences to the class or property that defines it.
export function contextDoc(b: string) {
  const idRel = (iri: string) => ({ '@id': iri, '@type': '@id' });
  return {
    '@context': {
      hydra: 'http://www.w3.org/ns/hydra/core#',
      schema: 'https://schema.org/',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      volt: `${b}/api/doc#`,
      id: '@id',
      type: '@type',
      member: 'hydra:member',
      totalItems: 'hydra:totalItems',
      view: 'hydra:view',
      search: 'hydra:search',
      operation: 'hydra:operation',
      target: idRel('hydra:target'),
      first: idRel('hydra:first'),
      next: idRel('hydra:next'),
      previous: idRel('hydra:previous'),
      last: idRel('hydra:last'),
      self: idRel('volt:self'),
      up: idRel('volt:up'),
      collection: idRel('hydra:collection'),
      siblings: idRel('volt:siblings'),
      previousSibling: idRel('volt:previousSibling'),
      nextSibling: idRel('volt:nextSibling'),
      breadcrumb: { '@id': 'volt:breadcrumb', '@container': '@list' },
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
      resource: idRel('volt:resource'),
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

const camel = (path: string) => path.replace(/^\/api\//, '').replace(/[-/](\w)/g, (_, c) => c.toUpperCase());

/** Every top-level collection the app serves (no path parameters), rel -> path. */
export function collectionIndex(app?: any): [string, string][] {
  const out = new Map<string, string>(ENTRY.map(([r, p]) => [r, p]));
  if (app) {
    for (const c of modelFor(app).collections) {
      if (c.pattern.includes(':') || c.pattern.startsWith('/api/public/') || c.pattern.startsWith('/api/platform')) continue;
      const rel = camel(c.pattern);
      if (![...out.values()].includes(c.pattern)) out.set(rel, c.pattern);
    }
  }
  return [...out.entries()].sort((x, y) => x[0].localeCompare(y[0]));
}

/**
 * Collections that only answer inside a scope (the programmes OF a channel, the
 * publications OF an asset). The entry point offers them as IriTemplates, not
 * as links that would 400 when followed bare; items link to them filled in.
 */
export const SCOPED: Record<string, string[]> = {
  '/api/epg': ['channelId', 'eventId', 'from', 'to'],
  '/api/publications': ['assetId'],
};

export function entrypoint(b: string, app?: any) {
  const out: any = {
    '@context': `${b}/api/context.jsonld`,
    '@id': `${b}/api`,
    '@type': ['hydra:EntryPoint', 'volt:EntryPoint'],
    apiDocumentation: `${b}/api/doc`,
    // The first call any client makes, declared with its method (it is POST
    // only, so it is an operation, not a link to GET).
    operation: [op('POST', `${b}/api/auth/login`, 'Sign in (email + password) and receive a bearer token')],
  };
  for (const [rel, path] of collectionIndex(app)) {
    const scope = SCOPED[path];
    out[rel] = scope
      ? { '@type': 'hydra:IriTemplate', 'hydra:template': `${b}${path}{?${scope.join(',')}}`, 'hydra:variableRepresentation': 'hydra:BasicRepresentation', 'hydra:mapping': scope.map((v) => ({ '@type': 'hydra:IriTemplateMapping', 'hydra:variable': v, 'hydra:required': false })) }
      : `${b}${path}`;
  }
  return out;
}

const XSD: Record<string, string> = { string: 'xsd:string', number: 'xsd:decimal', boolean: 'xsd:boolean', timestamp: 'xsd:dateTime', uuid: 'xsd:string', enum: 'xsd:string' };

/**
 * Hydra ApiDocumentation: every class with the operations its routes actually
 * serve (method, expects, returns) and the properties its list filters and
 * sorts on. This is the WSDL-equivalent half: a client can see that
 * POST /api/channels/{id}/start exists and is a POST, without a manual.
 */
export function apiDocumentation(b: string, app?: any) {
  const model = app ? modelFor(app) : null;
  const classes = new Map<string, any>();
  const pats = model ? model.collections.map((c) => c.pattern) : Object.keys(REGISTRY);
  for (const pattern of pats) {
    const c = model?.collections.find((x) => x.pattern === pattern);
    const desc = REGISTRY[pattern] ?? genericDesc(pattern, pattern, !!c?.hasItem);
    const cls = desc.type;
    if (classes.has(cls)) continue;
    const routes = model?.routes ?? [];
    const tmpl = (p: string) => `${b}${p.replace(/:([A-Za-z_]\w*)/g, '{$1}')}`;
    const ops: any[] = [];
    for (const r of routes) {
      const rest = r.path.startsWith(pattern + '/') ? r.path.slice(pattern.length + 1) : r.path === pattern ? '' : null;
      if (rest === null) continue;
      const parts = rest ? rest.split('/') : [];
      // collection, item, or an action on an item (/:id/start)
      const ok = parts.length === 0 || (parts.length === 1 && parts[0].startsWith(':')) || (parts.length === 2 && parts[0].startsWith(':') && !parts[1].startsWith(':'));
      if (!ok) continue;
      const onItem = parts.length >= 1;
      const action = parts.length === 2 ? parts[1] : null;
      ops.push(Object.fromEntries(Object.entries({
        '@type': 'hydra:Operation',
        'hydra:method': r.method,
        'hydra:title': action ? `${humanize(action)} ${cls.replace(/^.*:/, '')}` : `${r.method} ${onItem ? 'one' : 'collection'}`,
        target: tmpl(r.path),
        'hydra:expects': ['POST', 'PUT', 'PATCH'].includes(r.method) && !action ? cls : null,
        'hydra:returns': r.method === 'DELETE' ? null : r.method === 'GET' && !onItem ? 'hydra:Collection' : action ? null : cls,
      }).filter(([, v]) => v !== null)));
    }
    const spec = model?.specs.get(pattern);
    const props = spec ? Object.entries(spec.fields).map(([k, f]) => ({
      '@type': 'hydra:SupportedProperty',
      'hydra:property': { '@id': `volt:${k}`, '@type': 'rdf:Property', 'rdfs:range': XSD[f.type] ?? 'xsd:string' },
      'hydra:title': k,
      ...(f.doc ? { 'hydra:description': f.doc } : {}),
      'hydra:readable': true,
      'hydra:writeable': false,
      'volt:filter': f.filter ? f.ops : [],
      'volt:sortable': f.sort,
      ...(f.values ? { 'volt:values': f.values } : {}),
    })) : [];
    classes.set(cls, {
      '@id': cls,
      '@type': 'hydra:Class',
      'hydra:title': cls.replace(/^.*:/, ''),
      'hydra:description': `Resource at ${pattern}`,
      'volt:collection': tmpl(pattern),
      'hydra:supportedOperation': ops,
      'hydra:supportedProperty': props,
    });
  }
  return {
    '@context': [`${b}/api/context.jsonld`, { rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' }],
    '@id': `${b}/api/doc`,
    '@type': 'hydra:ApiDocumentation',
    'hydra:title': 'Volt Streaming API',
    'hydra:description':
      'Control-plane API. Send `Accept: application/ld+json` (or `?format=jsonld`) for the JSON-LD + Hydra hypermedia representation: typed links, paged collections, breadcrumbs and siblings, and this documentation. Plain JSON responses point at it with a `Link: <...>; rel="alternate"; type="application/ld+json"` header. Bearer-auth (JWT); the encoder ingest route uses X-Volt-Ingest-Token.',
    'hydra:entrypoint': `${b}/api`,
    'hydra:supportedClass': [...classes.values()],
  };
}
