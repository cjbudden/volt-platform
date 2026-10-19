// ============================================================================
//  IMAGE SERVICE (HTTP): on-the-fly resize, crop and filters, signed + cached.
//  Full guide: docs/IMAGES.md.
//
//  PUBLIC   GET|HEAD /img/{sig}/{spec}/{key}       render (or serve cached)
//  ADMIN    POST /api/images/sign                  options -> signed URL(s)
//           GET  /api/images/signing-key           this account's signing key
//           GET  /api/images/config                limits, formats, base URL
//           GET  /api/images/stats                 hit/miss/render counters (this task)
//
//  The public route is the only one a browser, player or partner hits. It
//  needs no session: the signature is the authorisation, and it is minted per
//  account (services/images/signing.ts). Responses are immutable for a year,
//  so CloudFront (deploy/terraform/images.tf) answers repeats at the edge.
// ============================================================================
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, forbidden } from '../util/http';
import { one } from '../db';
import { imageStore } from '../services/imageStore';
import { ImageService, makeCache } from '../services/images/service';
import { ImageError, parseImageRequest, type ImageLimits } from '../services/images/grammar';
import { accountSigningKey, assertSigningConfigured, signWithAccountKey } from '../services/images/signing';
import { accountOfKey, encodeImagePath, imageSpec, type ImageOptions } from '../services/images/sdk';

// ---------------------------------------------------------------- the service
let service: ImageService | null = null;

/** The process-wide image service. Built on first use, from config. */
export function imageService(): ImageService {
  if (!service) {
    const cfg = config.images;
    assertSigningConfigured(cfg.signingSecret, process.env.NODE_ENV === 'production');
    service = new ImageService(cfg, imageStore(), makeCache(cfg, config.aws.region));
  }
  return service;
}

/** Tests swap in their own service (temp store, fake S3). */
export function setImageService(s: ImageService | null) { service = s; }

// ------------------------------------------------------------ server helpers

/** A signed absolute URL for a store key, for server-side use (feeds, emails, webhooks). */
export function signedImageUrl(key: string, opts: ImageOptions | string, baseUrl?: string): string {
  const svc = imageService();
  const k = key.replace(/^\/+/, '');
  const acct = accountOfKey(k);
  if (!acct) throw new Error(`not an image library key: ${key}`);
  const spec = typeof opts === 'string' ? opts : imageSpec(opts);
  const sig = signWithAccountKey(accountSigningKey(svc.cfg.signingSecret, acct), `${spec}/${k}`);
  const base = (baseUrl ?? svc.cfg.publicBaseUrl).replace(/\/+$/, '');
  return `${base}/img/${sig}/${encodeImagePath(spec)}/${encodeImagePath(k)}`;
}

// ------------------------------------------------------------ public render
const ERROR_TTL: Record<number, string> = {
  400: 'public, max-age=300', 403: 'public, max-age=60', 404: 'public, max-age=60',
  413: 'public, max-age=300', 415: 'public, max-age=300', 422: 'public, max-age=300',
};

function sendError(res: Response, status: number, message: string) {
  res.status(status);
  res.setHeader('Cache-Control', ERROR_TTL[status] ?? 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (status === 503) res.setHeader('Retry-After', '2');
  res.json({ error: message });
}

/** Split "/{sig}/{rest...}" into the signature and the DECODED rest. */
export function splitImagePath(rawPath: string): { sig: string; rest: string } {
  const parts = rawPath.replace(/^\/+/, '').split('/');
  const sig = parts.shift() ?? '';
  const decoded = parts.map((p) => {
    let d: string;
    try { d = decodeURIComponent(p); } catch { throw new ImageError(400, 'malformed URL encoding'); }
    if (d.includes('/')) throw new ImageError(400, 'encoded slashes are not allowed');
    return d;
  });
  return { sig, rest: decoded.join('/') };
}

export function imagesPublicRouter(): Router {
  const r = Router();
  const serve = async (req: Request, res: Response) => {
    try {
      const { sig, rest } = splitImagePath(req.path);
      const out = await imageService().handle(sig, rest);
      const etag = `"${sig}"`;
      res.setHeader('Content-Type', out.contentType);
      res.setHeader('Cache-Control', imageService().cfg.cacheControl);
      res.setHeader('ETag', etag);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Timing-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('X-Image-Cache', out.cache);
      if (out.renderMs != null) res.setHeader('Server-Timing', `render;dur=${out.renderMs}`);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('Content-Length', String(out.body.length));
      if (req.method === 'HEAD') return res.end();
      res.end(out.body);
    } catch (e: any) {
      if (e instanceof ImageError) return sendError(res, e.status, e.message);
      console.error('[images] render failed', e);
      sendError(res, 500, 'image service error');
    }
  };
  r.get('/*', serve);
  r.head('/*', serve);
  return r;
}

// ------------------------------------------------------------- signing API
const FIT_ALIASES: Record<string, ImageOptions['fit']> = {
  cover: 'cover', inside: 'inside', contain: 'contain', fill: 'cover', 'fit-in': 'inside', stretch: 'fill',
};

const optionsSchema = z.object({
  key: z.string().optional(),
  path: z.string().optional(),
  spec: z.string().optional(),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  fit: z.string().optional(),
  crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  focus: z.union([z.object({ x: z.number(), y: z.number() }), z.string()]).optional(),
  grayscale: z.boolean().optional(),
  blur: z.number().optional(),
  brightness: z.number().optional(),
  saturation: z.number().optional(),
  sharpen: z.union([z.boolean(), z.number()]).optional(),
  background: z.string().optional(),
  quality: z.number().int().optional(),
  format: z.string().optional(),
  enlarge: z.boolean().optional(),
  version: z.string().optional(),
  // The first published contract nested filters; still accepted.
  filters: z.object({
    format: z.string().optional(), quality: z.number().optional(), sharpen: z.number().optional(),
    blur: z.number().optional(), grayscale: z.boolean().optional(), background: z.string().optional(),
    focus: z.string().optional(),
  }).optional(),
  expiresIn: z.number().optional(),   // accepted, ignored: URLs do not expire (see docs/IMAGES.md)
});
type SignInput = z.infer<typeof optionsSchema>;

export interface SignedImage { url: string; path: string; key: string; spec: string; signature: string; expires: null }

/** Lookup of a cache-busting version for a key (media_files.created_at). */
export type VersionLookup = (accountId: string, key: string) => Promise<string | null>;

const dbVersion: VersionLookup = async (acct, key) => {
  const row = await one<{ v: string }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') AS v FROM media_files WHERE account_id=$1 AND store_key=$2`,
    [acct, key]).catch(() => null);
  return row?.v ?? null;
};

/** Options -> one signed URL for an account. Exported for the tests. */
export async function signForAccount(acct: string, b: SignInput, limits: ImageLimits, secret: string, baseUrl: string,
  lookup: VersionLookup = dbVersion): Promise<SignedImage> {
  const raw = (b.key ?? b.path ?? '').replace(/^\/+/, '');
  if (!raw) throw badRequest('key or path is required');
  const key = /^(library|derived)\//.test(raw) ? raw : `library/${acct}/${raw}`;
  if (accountOfKey(key) !== acct) throw forbidden('that image belongs to another account');

  let spec: string;
  if (b.spec) spec = b.spec;
  else {
    const f = b.filters ?? {};
    const fit = b.fit ? FIT_ALIASES[b.fit] : undefined;
    if (b.fit && !fit) throw badRequest(`fit must be one of ${Object.keys(FIT_ALIASES).join(', ')}`);
    const focus = b.focus ?? f.focus;
    const opts: ImageOptions = {
      width: b.width, height: b.height, fit: fit ?? 'cover',
      crop: b.crop,
      focus: typeof focus === 'string' && /^0?\.\d+x0?\.\d+$/.test(focus)
        ? { x: Number(focus.split('x')[0]) * 100, y: Number(focus.split('x')[1]) * 100 }
        : (focus as ImageOptions['focus']),
      grayscale: b.grayscale ?? f.grayscale,
      blur: b.blur ?? f.blur,
      brightness: b.brightness, saturation: b.saturation,
      sharpen: b.sharpen ?? (f.sharpen != null ? 0.5 + f.sharpen / 100 : undefined),
      background: b.background ?? f.background,
      quality: b.quality ?? f.quality,
      format: ((b.format ?? f.format) === 'jpg' ? 'jpeg' : (b.format ?? f.format)) as ImageOptions['format'],
      enlarge: b.enlarge,
      version: b.version ?? (await lookup(acct, key)) ?? undefined,
    };
    if (opts.fit === 'contain' && !opts.background && b.fit === 'fit-in') opts.fit = 'inside';
    try { spec = imageSpec(opts); } catch (e: any) { throw badRequest(e.message); }
  }
  // Same parser and guards as the render path: a URL we sign is a URL we serve.
  try { parseImageRequest(`${spec}/${key}`, limits); } catch (e: any) {
    if (e instanceof ImageError) throw badRequest(e.message);
    throw e;
  }
  const signature = signWithAccountKey(accountSigningKey(secret, acct), `${spec}/${key}`);
  const path = `/img/${signature}/${encodeImagePath(spec)}/${encodeImagePath(key)}`;
  return { url: `${baseUrl.replace(/\/+$/, '')}${path}`, path, key, spec, signature, expires: null };
}

export const imagesApiRouter = Router();
imagesApiRouter.use(requireAuth);

imagesApiRouter.get('/config', (_req, res) => {
  const c = imageService().cfg;
  res.json({
    baseUrl: c.publicBaseUrl,
    maxDimension: c.maxDimension, maxOutputPixels: c.maxOutputPixels, maxSourceBytes: c.maxSourceBytes,
    formats: c.formats, fits: ['cover', 'inside', 'contain', 'fill'],
    urlGrammar: '/img/{sig}/{W}x{H},{fit}[,token...]/{key}',
  });
});

imagesApiRouter.get('/signing-key', (req, res) => {
  const acct = accountId(req);
  const c = imageService().cfg;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    accountId: acct,
    key: accountSigningKey(c.signingSecret, acct),
    algorithm: 'HMAC-SHA256, first 16 bytes, base64url, over "{spec}/{key}"',
    baseUrl: c.publicBaseUrl,
    consoleBaseUrl: c.consoleBaseUrl,
    keyPrefixes: [`library/${acct}/`, `derived/${acct}/`],
  });
});

imagesApiRouter.post('/sign', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const svc = imageService();
  const c = svc.cfg;
  const body = req.body ?? {};
  if (Array.isArray(body.items)) {
    if (body.items.length > 100) throw badRequest('at most 100 items per request');
    const items = [];
    for (const it of body.items) items.push(await signForAccount(acct, optionsSchema.parse(it), svc.limits, c.signingSecret, c.publicBaseUrl));
    return res.json({ items });
  }
  res.json(await signForAccount(acct, optionsSchema.parse(body), svc.limits, c.signingSecret, c.publicBaseUrl));
}));

imagesApiRouter.get('/stats', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(imageService().snapshot());
});
