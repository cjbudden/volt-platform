/**
 * Content-negotiated JSON-LD + Hydra post-processor.
 *
 * Wraps res.json for GET requests under /api. The request path is resolved
 * against the running app's routes and the list registry (services/hypermedia.ts
 * resolve()), so EVERY list endpoint is covered, not only the hand-described
 * REGISTRY:
 *   - a collection (bare array, or an object holding one array such as
 *     { jobs: [...] }) becomes a hydra:Collection with paging controls
 *     (first / next / previous / last from the list standard's headers),
 *     a hydra:search template, and member siblings;
 *   - an item becomes a JSON-LD entity with typed links, a breadcrumb and a
 *     siblings link;
 *   - anything under an item (/api/channels/:id/history) links up to that item.
 *
 * Plain JSON is UNCHANGED (same body, same status). It only gains Link headers
 * that point at the richer view, so a plain client is told it exists:
 *   Link: <same url?format=jsonld>; rel="alternate"; type="application/ld+json"
 */
import type { Request, Response, NextFunction } from 'express';
import { absBase, wantsJsonLd, decorateEntity, decorateCollection, LD_MIME, resolve, pagingView, searchTemplate, breadcrumb, answers, itemSubLinks, collectionSubLinks } from '../services/hypermedia';

/** The one array an object body carries ({ jobs: [...] } -> 'jobs'), if exactly one. */
function wrappedArrayKey(body: any): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.id !== undefined) return null;
  const keys = Object.keys(body).filter((k) => Array.isArray(body[k]));
  return keys.length === 1 ? keys[0] : null;
}

export function hypermediaNegotiation(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'GET' || !req.path.startsWith('/api/')) return next();
  const path = new URL(req.originalUrl, 'http://x').pathname;
  let r: ReturnType<typeof resolve> = null;
  try { r = resolve(req.app, path); } catch { r = null; }
  if (!r) return next();

  const orig = res.json.bind(res);

  if (!wantsJsonLd(req)) {
    // Plain JSON: body untouched; advertise the hypermedia view in a header.
    res.json = (body: any) => {
      try {
        if (res.statusCode < 400 && !res.headersSent) {
          const u = new URL(req.originalUrl, 'http://x');
          u.searchParams.set('format', 'jsonld');
          res.append('Link', `<${u.pathname}${u.search}>; rel="alternate"; type="${LD_MIME}"`);
        }
      } catch { /* headers are best effort */ }
      return orig(body);
    };
    return next();
  }

  // ?format=jsonld chose this view; it is not a filter, so the handler (and the
  // list standard, which refuses unknown parameters) never sees it.
  if (req.query.format === 'jsonld') { try { delete (req.query as any).format; } catch { /* ignore */ } }

  // Hydra totals: ask the list standard to count, so totalItems means "all
  // matching", not "on this page". Only for list-standard collections.
  if (r.kind === 'collection' && r.spec && req.query.count === undefined) {
    try { (req.query as any).count = 'true'; } catch { /* read-only query object: totals fall back to page size */ }
  }

  const res0 = r;
  res.json = (body: any) => {
    if (res.statusCode >= 400) return orig(body);
    const b = absBase(req);
    const ctxUrl = `${b}/api/context.jsonld`;
    const ok = (p: string) => answers(req.app, p);
    try {
      const desc = res0.desc;
      const key = Array.isArray(body) ? null : wrappedArrayKey(body);
      const items: any[] | null = Array.isArray(body) ? body : key ? body[key] : null;
      if (items && res0.kind !== 'entity') {
        const total = res.getHeader('X-Total-Count') != null ? Number(res.getHeader('X-Total-Count')) : undefined;
        const view = pagingView(req, res, b, items.length, !!res0.spec?.allowOffset);
        const opts = {
          total, view,
          search: res0.spec && res0.kind === 'collection' ? searchTemplate(b, res0.concrete, res0.spec) : undefined,
          up: res0.kind === 'sub' ? `${b}${res0.parent}` : undefined,
        };
        const coll: any = res0.kind === 'sub'
          ? { ...decorateCollection({ type: 'volt:Item', links: (o: any) => ({}) }, items, req, b, ctxUrl, opts) }
          : decorateCollection(desc, items, req, b, ctxUrl, opts);
        if (res0.kind === 'sub') coll['hydra:member'] = items; // sub-resource rows stay as served
        coll.breadcrumb = breadcrumb(b, path, `${b}${req.originalUrl}`, null, undefined, ok);
        if (res0.kind === 'collection') for (const [k, v] of Object.entries(collectionSubLinks(req.app, res0, b))) if (coll[k] === undefined) coll[k] = v;
        if (key) { const { [key]: _drop, ...rest } = body; Object.assign(coll, rest, { 'volt:memberKey': key }); }
        res.type(LD_MIME);
        return orig(coll);
      }
      if (body && typeof body === 'object' && !Array.isArray(body) && (body.id !== undefined || res0.kind === 'sub')) {
        let out: any;
        if (res0.kind === 'entity') {
          out = decorateEntity(desc, body, b, ctxUrl);
          if (!out['@id']) out['@id'] = `${b}${path}`;
          out.siblings = out.collection ?? `${b}${res0.concrete}`;
          out.breadcrumb = breadcrumb(b, path, out['@id'], body, out.up, ok);
          // Drill down: every sub-resource route of this item, as a typed link.
          for (const [k, v] of Object.entries(itemSubLinks(req.app, res0, b, res0.id!))) if (out[k] === undefined) out[k] = v;
        } else {
          out = { '@context': ctxUrl, '@id': `${b}${req.originalUrl}`, ...body, up: `${b}${res0.parent ?? res0.concrete}`, breadcrumb: breadcrumb(b, path, undefined, null, undefined, ok) };
        }
        res.type(LD_MIME);
        return orig(out);
      }
    } catch {
      /* fall through to plain JSON on any decoration error */
    }
    return orig(body);
  };
  next();
}
