// ============================================================================
//  IMAGE SERVICE: verify, look up, render, cache. HTTP-free, so the tests and
//  any other surface can drive it; src/modules/images.ts is the HTTP shell.
//
//  Request path: /img/{sig}/{rest}   rest = "{spec}/{key}" (decoded)
//    1. parse + guards (grammar.ts)          400 / 404 / 415, nothing fetched
//    2. signature for the key's account      403
//    3. memory LRU -> derivative cache       HIT
//    4. single-flight per URL, then the render limiter (503 when saturated)
//    5. fetch source (size guard, source LRU) -> render -> cache in background
// ============================================================================
import type { ImageServiceConfig } from '../../config';
import { contentTypeOf, ImageError, parseImageRequest, type Format, type ImageLimits } from './grammar';
import { accountOfKey } from './sdk';
import { renderImage } from './render';
import { verifyImageSignature, SIG_RX } from './signing';
import {
  BusyError, Limiter, LocalDerivativeCache, MemoryLru, NoDerivativeCache, S3DerivativeCache, SingleFlight,
  type DerivativeCache,
} from './cache';

export interface SourceStore {
  get(key: string): Promise<Buffer | null>;
  stat(key: string): Promise<{ size: number } | null>;
}

export interface ImageResult {
  body: Buffer;
  contentType: string;
  cache: 'MEMORY' | 'HIT' | 'MISS';
  renderMs?: number;
}

export interface ImageStats {
  requests: number; memoryHits: number; cacheHits: number; renders: number;
  rejected: Record<string, number>; renderMsTotal: number; busy: number;
}

const FORMAT_BY_EXT: Record<string, Format> = { webp: 'webp', avif: 'avif', jpeg: 'jpeg', png: 'png' };

export class ImageService {
  readonly limits: ImageLimits;
  private memory: MemoryLru<{ body: Buffer; contentType: string }>;
  private sources: MemoryLru<{ body: Buffer }>;
  private flights = new SingleFlight<ImageResult>();
  private limiter: Limiter;
  readonly stats: ImageStats = { requests: 0, memoryHits: 0, cacheHits: 0, renders: 0, rejected: {}, renderMsTotal: 0, busy: 0 };

  constructor(readonly cfg: ImageServiceConfig, private store: SourceStore, readonly cache: DerivativeCache) {
    this.limits = { maxDimension: cfg.maxDimension, maxOutputPixels: cfg.maxOutputPixels, formats: cfg.formats };
    this.memory = new MemoryLru(cfg.memoryCacheBytes);
    this.sources = new MemoryLru(cfg.sourceCacheBytes);
    this.limiter = new Limiter(cfg.maxConcurrent, cfg.maxQueue);
  }

  /** Serve one request. Throws ImageError with the HTTP status to answer. */
  async handle(sig: string, rest: string): Promise<ImageResult> {
    this.stats.requests++;
    try {
      return await this.handleInner(sig, rest);
    } catch (e) {
      const status = e instanceof ImageError ? e.status : e instanceof BusyError ? 503 : 500;
      this.stats.rejected[status] = (this.stats.rejected[status] ?? 0) + 1;
      if (e instanceof BusyError) { this.stats.busy++; throw new ImageError(503, e.message); }
      throw e;
    }
  }

  private async handleInner(sig: string, rest: string): Promise<ImageResult> {
    if (!SIG_RX.test(sig)) throw new ImageError(403, 'image URLs must be signed');
    const { spec, key } = parseImageRequest(rest, this.limits);
    const acct = accountOfKey(key)!;
    const secrets = [this.cfg.signingSecret, this.cfg.previousSigningSecret];
    if (!verifyImageSignature(sig, rest, acct, secrets)) throw new ImageError(403, 'signature does not match');

    const cacheKey = `img/${sig}/${rest}`;
    const mem = this.memory.get(cacheKey);
    if (mem) { this.stats.memoryHits++; return { ...mem, cache: 'MEMORY' }; }

    return this.flights.run(cacheKey, async () => {
      const stored = await this.cache.get(cacheKey);
      if (stored) {
        this.stats.cacheHits++;
        this.memory.set(cacheKey, stored);
        return { body: stored.body, contentType: stored.contentType, cache: 'HIT' };
      }
      return this.limiter.run(async () => {
        const source = await this.loadSource(key);
        const t0 = performance.now();
        const out = await renderImage(source, spec, {
          maxInputPixels: this.cfg.maxInputPixels, timeoutSeconds: this.cfg.renderTimeoutSeconds,
        });
        const renderMs = Math.round(performance.now() - t0);
        this.stats.renders++;
        this.stats.renderMsTotal += renderMs;
        const entry = { body: out.buffer, contentType: out.contentType };
        this.memory.set(cacheKey, entry);
        this.cache.put(cacheKey, out.buffer, out.contentType, this.cfg.cacheControl)
          .catch((e) => console.warn(`[images] cache write failed for ${cacheKey}: ${e?.message ?? e}`));
        return { ...entry, cache: 'MISS', renderMs };
      });
    });
  }

  private async loadSource(key: string): Promise<Buffer> {
    const hit = this.sources.get(key);
    if (hit) return hit.body;
    const st = await this.store.stat(key);
    if (!st) throw new ImageError(404, 'image not found');
    if (st.size > this.cfg.maxSourceBytes) throw new ImageError(413, 'source image is too large');
    const body = await this.store.get(key);
    if (!body) throw new ImageError(404, 'image not found');
    if (body.length > this.cfg.maxSourceBytes) throw new ImageError(413, 'source image is too large');
    this.sources.set(key, { body });
    return body;
  }

  /** Drop a source from the in-process cache (call after replacing or deleting it). */
  forgetSource(key: string) { this.sources.delete(key); }

  snapshot() {
    return {
      ...this.stats,
      cacheDriver: this.cache.driver,
      rendering: this.limiter.running, queued: this.limiter.waiting, inflight: this.flights.pending,
      memoryEntries: this.memory.size, memoryBytes: this.memory.usedBytes,
    };
  }
}

/** Content type of a cached file from its request path (local files carry no metadata). */
export function typeFromCacheKey(key: string): string {
  try {
    const rest = key.split('/').slice(2).join('/');
    const { spec } = parseImageRequest(rest, { maxDimension: 1e9, maxOutputPixels: Infinity, formats: Object.keys(FORMAT_BY_EXT) });
    return contentTypeOf(spec.fmt);
  } catch { return 'application/octet-stream'; }
}

export function makeCache(cfg: ImageServiceConfig, region: string): DerivativeCache {
  if (cfg.cacheDriver === 's3') return new S3DerivativeCache(cfg.cacheBucket, cfg.cachePrefix, region);
  if (cfg.cacheDriver === 'none') return new NoDerivativeCache();
  return new LocalDerivativeCache(cfg.cacheDir, typeFromCacheKey);
}
