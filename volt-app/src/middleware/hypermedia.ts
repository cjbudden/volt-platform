/**
 * Content-negotiated JSON-LD + Hydra post-processor.
 *
 * Wraps res.json for GET requests that ask for `application/ld+json`. If the
 * request's router mount path is in the REGISTRY, an array payload becomes a
 * Hydra Collection and an object-with-id becomes a JSON-LD entity with typed
 * links. Everything else (and every non-negotiated request) passes through
 * unchanged — so the default JSON contract is untouched.
 */
import type { Request, Response, NextFunction } from 'express';
import { REGISTRY, absBase, wantsJsonLd, decorateEntity, decorateCollection, LD_MIME } from '../services/hypermedia';

export function hypermediaNegotiation(req: Request, res: Response, next: NextFunction) {
  if (!wantsJsonLd(req)) return next();

  const orig = res.json.bind(res);
  res.json = (body: any) => {
    const desc = REGISTRY[req.baseUrl];
    if (!desc) return orig(body);
    const b = absBase(req);
    const ctxUrl = `${b}/api/context.jsonld`;
    try {
      if (Array.isArray(body)) {
        res.type(LD_MIME);
        return orig(decorateCollection(desc, body, req, b, ctxUrl));
      }
      if (body && typeof body === 'object' && body.id) {
        res.type(LD_MIME);
        return orig(decorateEntity(desc, body, b, ctxUrl));
      }
    } catch {
      /* fall through to plain JSON on any decoration error */
    }
    return orig(body);
  };
  next();
}
