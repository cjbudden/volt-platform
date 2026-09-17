// ============================================================================
//  TUS 1.0.0 — the open resumable upload protocol, as an Express router.
//
//  Extensions: creation, creation-with-upload, expiration, termination,
//  checksum (sha1, sha256, md5). Not concatenation: parallel parts are what
//  the chunk protocol and Background Fetch are for, and a client that wants
//  them uses that door.
//
//  WHY A SECOND PROTOCOL BESIDE THE CHUNK ONE. tus is what the official iOS,
//  Android, Python, Go and .NET clients speak, and what Uppy speaks. Offering
//  it means a developer's existing client uploads into Volt's rules, naming
//  and metadata without our UI. The chunk protocol stays for Background Fetch,
//  which needs order-independent requests that tus (sequential PATCH at
//  Upload-Offset) cannot give it. Both land in completeLanded().
//
//  THE STORE IS AN INTERFACE so the protocol is tested over real HTTP with a
//  memory store and no database. The data file is always on disk, appended in
//  offset order, which is the one thing tus guarantees a server may rely on.
// ============================================================================
import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statSync, rmSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const TUS_VERSION = '1.0.0';
export const TUS_EXTENSIONS = 'creation,creation-with-upload,expiration,termination,checksum';
export const TUS_CHECKSUMS = 'sha1,sha256,md5';

export interface TusInfo {
  id: string;
  length: number;
  offset: number;
  /** Decoded Upload-Metadata. Keys the ingest uses: filename, filetype, relativePath, schemaId, source, metadata (JSON). */
  metadata: Record<string, string>;
  expiresAt: string | null;
  /** Anything the store needs to carry (an upload session token, an account). */
  extra?: Record<string, any>;
}

export interface TusStore {
  /** Create the record and return it. `who` is whatever `authorise` returned. */
  create(who: any, length: number, metadata: Record<string, string>): Promise<TusInfo>;
  get(who: any, id: string): Promise<TusInfo | null>;
  setOffset(id: string, offset: number): Promise<void>;
  remove(id: string): Promise<void>;
  /** Filesystem path the bytes are appended to. */
  dataPath(info: TusInfo): string;
}

export interface TusOptions {
  store: TusStore;
  /** Returns an identity for the request, or throws an ApiError-like {status, message}. */
  authorise: (req: Request) => Promise<any>;
  /** Called once when offset reaches length. */
  onComplete: (info: TusInfo, who: any, sha256: string) => Promise<void>;
  maxBytes?: number;
  /** Public path this router is mounted at, for the Location header. */
  basePath: string;
}

/** Upload-Metadata: comma-separated "key base64value" pairs, value optional. */
export function parseMetadata(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (h ?? '').split(',')) {
    const [k, v] = pair.trim().split(/\s+/, 2);
    if (!k) continue;
    out[k] = v ? Buffer.from(v, 'base64').toString('utf8') : '';
  }
  return out;
}
export function encodeMetadata(m: Record<string, string>): string {
  return Object.entries(m).map(([k, v]) => `${k} ${Buffer.from(String(v), 'utf8').toString('base64')}`).join(',');
}

function bad(res: Response, status: number, msg: string) {
  res.status(status).set('Tus-Resumable', TUS_VERSION).type('text/plain').send(msg);
}

export function createTusRouter(o: TusOptions): Router {
  const r = Router();
  const max = o.maxBytes ?? 16 * 1024 * 1024 * 1024;

  r.use((req, res, next) => {
    res.set('Tus-Resumable', TUS_VERSION);
    if (req.method === 'OPTIONS') return next();
    // Every request but OPTIONS must name the version (tus core).
    if (req.get('Tus-Resumable') !== TUS_VERSION) return bad(res, 412, `Tus-Resumable must be ${TUS_VERSION}`);
    next();
  });

  r.options('/', (_req, res) => {
    res.set({ 'Tus-Version': TUS_VERSION, 'Tus-Extension': TUS_EXTENSIONS, 'Tus-Max-Size': String(max), 'Tus-Checksum-Algorithm': TUS_CHECKSUMS }).status(204).end();
  });
  r.options('/:id', (_req, res) => {
    res.set({ 'Tus-Version': TUS_VERSION, 'Tus-Extension': TUS_EXTENSIONS, 'Tus-Max-Size': String(max), 'Tus-Checksum-Algorithm': TUS_CHECKSUMS }).status(204).end();
  });

  // creation (+ creation-with-upload)
  r.post('/', async (req, res) => {
    let who: any;
    try { who = await o.authorise(req); } catch (e: any) { return bad(res, e?.status ?? 401, e?.message ?? 'unauthorised'); }
    const len = Number(req.get('Upload-Length'));
    if (req.get('Upload-Defer-Length') === '1') return bad(res, 400, 'Upload-Defer-Length is not supported; send Upload-Length');
    if (!Number.isFinite(len) || len < 0) return bad(res, 400, 'Upload-Length is required');
    if (len > max) return bad(res, 413, `Upload-Length exceeds Tus-Max-Size ${max}`);
    const md = parseMetadata(req.get('Upload-Metadata'));
    let info: TusInfo;
    try { info = await o.store.create(who, len, md); } catch (e: any) { return bad(res, e?.status ?? 500, e?.message ?? 'could not create'); }
    const path = o.store.dataPath(info);
    mkdirSync(require('node:path').dirname(path), { recursive: true });
    createWriteStream(path, { flags: 'a' }).end();
    res.set('Location', `${o.basePath.replace(/\/$/, '')}/${info.id}`);
    if (info.expiresAt) res.set('Upload-Expires', new Date(info.expiresAt).toUTCString());
    // creation-with-upload: a body on POST is the first PATCH.
    if (req.get('Content-Type') === 'application/offset+octet-stream' && Number(req.get('Content-Length') ?? 0) > 0) {
      const out = await receive(req, res, info, who, 0);
      if (out === null) return;
      res.set('Upload-Offset', String(out));
    } else {
      res.set('Upload-Offset', '0');
    }
    res.status(201).end();
  });

  // core: HEAD reports the offset
  r.head('/:id', async (req, res) => {
    let who: any;
    try { who = await o.authorise(req); } catch (e: any) { return bad(res, e?.status ?? 401, e?.message ?? 'unauthorised'); }
    const info = await o.store.get(who, req.params.id);
    if (!info) return bad(res, 404, 'not found');
    if (expired(info)) return bad(res, 410, 'expired');
    res.set({ 'Upload-Offset': String(info.offset), 'Upload-Length': String(info.length), 'Cache-Control': 'no-store' });
    if (Object.keys(info.metadata).length) res.set('Upload-Metadata', encodeMetadata(info.metadata));
    if (info.expiresAt) res.set('Upload-Expires', new Date(info.expiresAt).toUTCString());
    res.status(200).end();
  });

  // core: PATCH appends at Upload-Offset
  r.patch('/:id', async (req, res) => {
    let who: any;
    try { who = await o.authorise(req); } catch (e: any) { return bad(res, e?.status ?? 401, e?.message ?? 'unauthorised'); }
    if (req.get('Content-Type') !== 'application/offset+octet-stream') return bad(res, 415, 'Content-Type must be application/offset+octet-stream');
    const info = await o.store.get(who, req.params.id);
    if (!info) return bad(res, 404, 'not found');
    if (expired(info)) return bad(res, 410, 'expired');
    const off = Number(req.get('Upload-Offset'));
    if (!Number.isFinite(off)) return bad(res, 400, 'Upload-Offset is required');
    // The file on disk is the truth for the offset; the store follows it.
    const path = o.store.dataPath(info);
    const onDisk = existsSync(path) ? statSync(path).size : 0;
    if (off !== onDisk) { res.set('Upload-Offset', String(onDisk)); return bad(res, 409, `Upload-Offset ${off} does not match ${onDisk}`); }
    const out = await receive(req, res, info, who, off);
    if (out === null) return;
    res.set('Upload-Offset', String(out));
    if (info.expiresAt) res.set('Upload-Expires', new Date(info.expiresAt).toUTCString());
    res.status(204).end();
  });

  // termination
  r.delete('/:id', async (req, res) => {
    let who: any;
    try { who = await o.authorise(req); } catch (e: any) { return bad(res, e?.status ?? 401, e?.message ?? 'unauthorised'); }
    const info = await o.store.get(who, req.params.id);
    if (!info) return bad(res, 404, 'not found');
    try { rmSync(o.store.dataPath(info), { force: true }); } catch { /* */ }
    await o.store.remove(info.id);
    res.status(204).end();
  });

  /** Append the body. Returns the new offset, or null after having answered with an error. */
  async function receive(req: Request, res: Response, info: TusInfo, who: any, off: number): Promise<number | null> {
    const path = o.store.dataPath(info);
    const declared = Number(req.get('Content-Length'));
    if (Number.isFinite(declared) && off + declared > info.length) { bad(res, 413, 'body would exceed Upload-Length'); return null; }
    // checksum extension: "algo base64digest" over THIS request body.
    const ck = req.get('Upload-Checksum');
    let algo: string | null = null, want: string | null = null;
    if (ck) {
      const [a, d] = ck.trim().split(/\s+/, 2);
      if (!TUS_CHECKSUMS.split(',').includes(a)) { bad(res, 400, `unsupported checksum algorithm ${a}`); return null; }
      algo = a; want = d ?? '';
    }
    const h = algo ? createHash(algo) : null;
    let n = 0;
    const counter = new Transform({ transform(chunk, _e, cb) { n += chunk.length; h?.update(chunk); cb(null, chunk); } });
    const ws = createWriteStream(path, { flags: 'a' });
    try {
      await pipeline(req, counter, ws);
    } catch (e: any) {
      // A broken connection mid-body leaves what did arrive on disk, and the
      // next HEAD reports it. That is resumability.
      await o.store.setOffset(info.id, statSync(path).size).catch(() => {});
      if (!res.headersSent) bad(res, 400, 'body ended early');
      return null;
    }
    if (h && want !== null && h.digest('base64') !== want) {
      // Roll back this request's bytes so the client resends them.
      const fd = require('node:fs').openSync(path, 'r+'); require('node:fs').ftruncateSync(fd, off); require('node:fs').closeSync(fd);
      await o.store.setOffset(info.id, off);
      bad(res, 460, 'Checksum Mismatch'); return null;
    }
    const newOff = off + n;
    if (newOff > info.length) { bad(res, 413, 'body exceeded Upload-Length'); return null; }
    await o.store.setOffset(info.id, newOff);
    if (newOff === info.length) {
      const sha = await sha256Of(path);
      await o.onComplete({ ...info, offset: newOff }, who, sha);
    }
    return newOff;
  }

  return r;
}

function expired(i: TusInfo): boolean { return !!i.expiresAt && new Date(i.expiresAt).getTime() < Date.now(); }

export async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
  return h.digest('hex');
}

/** A store for tests and for embedding without a database. */
export class MemoryTusStore implements TusStore {
  private m = new Map<string, TusInfo>();
  constructor(private dir: string, private ttlMs = 24 * 3600 * 1000) {}
  async create(who: any, length: number, metadata: Record<string, string>): Promise<TusInfo> {
    const id = require('node:crypto').randomBytes(12).toString('hex');
    const info: TusInfo = { id, length, offset: 0, metadata, expiresAt: new Date(Date.now() + this.ttlMs).toISOString(), extra: { who } };
    this.m.set(id, info); return info;
  }
  async get(_who: any, id: string) { return this.m.get(id) ?? null; }
  async setOffset(id: string, offset: number) { const i = this.m.get(id); if (i) i.offset = offset; }
  async remove(id: string) { this.m.delete(id); }
  dataPath(info: TusInfo) { return require('node:path').join(this.dir, info.id + '.tus'); }
}
