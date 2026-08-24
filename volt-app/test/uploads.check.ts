// ============================================================================
//  RESUMABLE UPLOADS — the protocol, against a real file over real HTTP.
//
//  The claim the whole design rests on:
//
//      AN INTERRUPTED UPLOAD COSTS ONE CHUNK, NOT THE FILE.
//
//  So the suite does not upload a file cleanly and call it proven. It sends the
//  chunks OUT OF ORDER, leaves a hole, tries to finish anyway, sends a
//  wrong-sized chunk, sends a duplicate, uses the wrong token, and only then
//  fills the hole — and the assembled file has to be byte-identical to what went
//  in. Anything less tests the happy path, which is not the path that matters.
//
//  Everything goes over HTTP against the running API, because the interesting
//  behaviour is in the endpoints: the raw-body handling, the capability token,
//  the status codes a client branches on.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/uploads.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query, one } from '../src/db';
import { config } from '../src/config';

const API = process.env.API ?? 'http://localhost:8080';
let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const contains = (m: string, hay: string, needle: string) =>
  (hay ?? '').toLowerCase().includes(needle.toLowerCase())
    ? ok(m) : bad(m, `expected to mention "${needle}", got "${String(hay).slice(0, 160)}"`);

const WORK = '/tmp/volt-upload-scratch';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // A REAL FILE, and deliberately not a round number of chunks: the last chunk
  // is short, and a short last chunk is where a length check gets written wrong.
  const path = join(WORK, 'loop.mp4');
  const enc = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8000k',
    '-y', path,
  ], { encoding: 'utf8' });
  if (enc.status !== 0) { console.log('SKIP: ffmpeg could not build the test file'); process.exit(0); }

  const bytes = readFileSync(path);
  const size = bytes.length;
  const want = sha(bytes);
  truthy(`the test file is worth chunking (${(size / 1e6).toFixed(1)} MB)`, size > 9_000_000);

  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'root@adminco.example', password: 'volt1234' }),
  });
  const TOK = (await login.json() as any).access;
  if (!TOK) { console.log('FATAL: no token (is the API up?)'); process.exit(1); }

  // ---- open ---------------------------------------------------------------
  const openRes = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fillerKind: 'loop', name: 'upload suite', filename: 'loop.mp4',
      contentType: 'video/mp4', totalBytes: size,
    }),
  });
  check('a session opens', openRes.status, 201);
  const s = await openRes.json() as any;
  const CS = s.chunkSize;
  check('the chunk count matches the file', s.chunkCount, Math.ceil(size / CS));
  truthy('the last chunk is a short one', size % CS !== 0);
  truthy('a capability token comes back', String(s.token ?? '').startsWith('upl_'));
  truthy('and an asset row exists from the start', !!s.assetId);

  const asset0 = await one<any>(`SELECT status FROM filler_assets WHERE id = $1`, [s.assetId]);
  check('shown as uploading while bytes are in flight', asset0?.status, 'uploading');

  const put = (i: number, body: Buffer, token = s.token) =>
    fetch(`${API}/api/uploads/${s.id}/chunks/${i}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(body),
    });
  const chunk = (i: number) => bytes.subarray(i * CS, Math.min((i + 1) * CS, size));

  // ---- out of order, with a hole -----------------------------------------
  const last = s.chunkCount - 1;
  check('the last chunk lands first', (await put(last, chunk(last))).status, 200);
  check('then the first', (await put(0, chunk(0))).status, 200);

  const midway = await fetch(`${API}/api/uploads/${s.id}/state`, {
    headers: { authorization: `Bearer ${s.token}` },
  }).then(r => r.json()) as any;
  check('the server knows exactly which chunks it has',
    JSON.stringify(midway.received), JSON.stringify([0, last].sort((a, b) => a - b)));
  truthy('and which are missing', midway.missing.length === s.chunkCount - 2);

  // ---- finishing early is refused, with the list ---------------------------
  const early = await fetch(`${API}/api/uploads/${s.id}/finish`, {
    method: 'POST', headers: { authorization: `Bearer ${s.token}` },
  });
  check('finishing with a hole is refused', early.status, 409);
  const earlyBody = await early.json() as any;
  truthy('and it names the chunks to send', Array.isArray(earlyBody.missing) && earlyBody.missing.length > 0);

  // ---- the guards ---------------------------------------------------------
  const short = await put(1, Buffer.alloc(1000));
  check('a wrong-sized chunk is refused', short.status, 400);
  contains('saying what it should have been', (await short.json() as any).error, 'should be');
  const stillMissing = await fetch(`${API}/api/uploads/${s.id}/state`, {
    headers: { authorization: `Bearer ${s.token}` },
  }).then(r => r.json()) as any;
  // The important half: a rejected chunk must not be RECORDED as received, or
  // assembly later produces a file with a hole that looks complete.
  truthy('and is not recorded as received', !stillMissing.received.includes(1));

  check('a chunk index outside the upload is refused',
    (await put(9999, chunk(0))).status, 400);
  check('the wrong token is refused', (await put(1, chunk(1), 'upl_nope')).status, 401);
  check('and an unsigned request is refused',
    (await fetch(`${API}/api/uploads/${s.id}/chunks/1`, {
      method: 'PUT', body: new Uint8Array(chunk(1)),
    })).status, 401);

  // A token is scoped to ITS session. Another session's token must not write here.
  const other = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fillerKind: 'slate', name: 'other', filename: 'x.png', totalBytes: 100 }),
  }).then(r => r.json()) as any;
  check("another session's token cannot write here",
    (await put(1, chunk(1), other.token)).status, 403);

  // ---- fill the hole ------------------------------------------------------
  for (let i = 1; i < last; i++) {
    const r = await put(i, chunk(i));
    if (r.status !== 200) { bad(`chunk ${i} accepted`, `status ${r.status}`); break; }
  }
  const full = await fetch(`${API}/api/uploads/${s.id}/state`, {
    headers: { authorization: `Bearer ${s.token}` },
  }).then(r => r.json()) as any;
  check('every chunk has now landed', full.received.length, s.chunkCount);
  check('and the byte count agrees with the file', full.receivedBytes, size);

  // ---- a duplicate is accepted and does not double-count -------------------
  const dup = await put(0, chunk(0));
  check('a duplicate chunk is accepted', dup.status, 200);
  const dupBody = await dup.json() as any;
  check('and says so', dupBody.duplicate, true);
  check('without double-counting the bytes', dupBody.receivedBytes, size);

  // ---- assemble -----------------------------------------------------------
  const fin = await fetch(`${API}/api/uploads/${s.id}/finish`, {
    method: 'POST', headers: { authorization: `Bearer ${s.token}` },
  });
  check('assembly succeeds', fin.status, 200);
  const finBody = await fin.json() as any;
  check('the assembled length matches the file', finBody.bytes, size);

  // THE CLAIM: after out-of-order delivery, a rejected chunk, a duplicate and a
  // resume, the file on disk is the file that went in.
  check('the assembled file is byte-identical', finBody.sha256, want);

  const stored = join(config.uploads.fillerDir, s.assetId ? '' : '', '');
  void stored;
  const assetRow = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [s.assetId]);
  check('the asset is ready', assetRow?.status, 'ready');
  check('with its real size', Number(assetRow?.bytes), size);
  truthy('and a source key that keeps the extension',
    String(assetRow?.source_key ?? '').endsWith('.mp4'));

  const onDisk = join(config.uploads.fillerDir, '..', assetRow.source_key);
  const diskPath = join(config.uploads.fillerDir, assetRow.source_key.replace(/^filler\//, ''));
  truthy('the bytes are where the key says', existsSync(diskPath));
  check('and are the right length', statSync(diskPath).size, size);
  check('and hash the same', sha(readFileSync(diskPath)), want);
  void onDisk;

  // ---- staging is cleaned up ----------------------------------------------
  check('the staged chunks are gone', existsSync(join(config.uploads.dir, s.id)), false);

  // ---- finishing again is idempotent --------------------------------------
  const again = await fetch(`${API}/api/uploads/${s.id}/finish`, {
    method: 'POST', headers: { authorization: `Bearer ${s.token}` },
  });
  check('finishing twice is not an error', again.status, 200);
  const stillOne = await query(
    `SELECT id FROM filler_assets WHERE id = $1 AND status = 'ready'`, [s.assetId]);
  check('and does not make a second asset', stillOne.length, 1);
  check('the file is untouched', sha(readFileSync(diskPath)), want);

  // ---- a chunk after completion is refused --------------------------------
  const late = await put(0, chunk(0));
  check('a chunk arriving after completion is refused', late.status, 409);

  // ---- abandoning ---------------------------------------------------------
  // `other` was opened above and never used: exactly what an abandoned upload is.
  const del = await fetch(`${API}/api/uploads/${other.id}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${TOK}` },
  });
  check('an abandoned session can be dropped', del.status, 204);
  const orphan = await one<any>(`SELECT id FROM filler_assets WHERE id = $1`, [other.assetId]);
  // The asset row was created optimistically at the start. An abandoned upload
  // must not leave a permanently 'uploading' row in the list.
  check('and takes its placeholder asset with it', orphan, null);
  check('and its staged chunks', existsSync(join(config.uploads.dir, other.id)), false);

  // ---- limits -------------------------------------------------------------
  const huge = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fillerKind: 'loop', name: 'too big', filename: 'big.mp4',
      totalBytes: 999_999_999_999,
    }),
  });
  check('an absurd size is refused at the door', huge.status, 400);
  contains('with the limit named', (await huge.json() as any).error, 'GB');

  const zero = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fillerKind: 'loop', name: 'empty', filename: 'e.mp4', totalBytes: 0 }),
  });
  truthy('a zero-byte upload is refused', zero.status >= 400);

  // ---- resumable listing --------------------------------------------------
  const openAgain = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fillerKind: 'loop', name: 'half done', filename: 'half.mp4', totalBytes: size,
    }),
  }).then(r => r.json()) as any;
  await fetch(`${API}/api/uploads/${openAgain.id}/chunks/0`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${openAgain.token}`, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(chunk(0)),
  });
  const list = await fetch(`${API}/api/uploads`, {
    headers: { authorization: `Bearer ${TOK}` },
  }).then(r => r.json()) as any;
  const found = list.sessions.find((x: any) => x.id === openAgain.id);
  truthy('a part-finished upload is offered back', !!found);
  check('with how far it got', found?.receivedBytes, CS);
  truthy('and what is left to send', (found?.missing?.length ?? 0) === openAgain.chunkCount - 1);
  check('a completed one is not offered back',
    list.sessions.some((x: any) => x.id === s.id), false);

  // clean up everything this suite created
  await fetch(`${API}/api/uploads/${openAgain.id}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${TOK}` },
  });
  await query(`DELETE FROM filler_assets WHERE name IN ('upload suite', 'half done', 'other', 'too big', 'empty')`);
  try { rmSync(diskPath, { force: true }); } catch { /* */ }
  rmSync(WORK, { recursive: true, force: true });

  console.log(`\nuploads: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
