/**
 * Hypermedia discovery endpoints — the "service document" that recovers the
 * WSDL-like feel: start at /api, follow links to every collection.
 *   GET /api                  → Hydra EntryPoint (links to all collections)
 *   GET /api/context.jsonld   → the JSON-LD @context
 *   GET /api/doc              → Hydra ApiDocumentation (supported classes, their
 *                               operations and properties); also the volt: vocabulary
 * All are public (no side-channel knowledge needed to discover the graph).
 */
import { Router } from 'express';
import { absBase, entrypoint, contextDoc, apiDocumentation, LD_MIME } from '../services/hypermedia';

export const hypermediaRouter = Router();

hypermediaRouter.get('/', (req, res) => {
  res.type(LD_MIME).json(entrypoint(absBase(req), req.app));
});

hypermediaRouter.get('/context.jsonld', (req, res) => {
  res.type(LD_MIME).json(contextDoc(absBase(req)));
});

hypermediaRouter.get('/doc', (req, res) => {
  res.type(LD_MIME).json(apiDocumentation(absBase(req), req.app));
});
