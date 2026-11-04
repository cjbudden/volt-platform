// ============================================================================
//  HYBRID SITES 1: sites, hosts and enrolment (build queue H1, HYBRID_SITES.md).
//
//  Through the real API on a real database:
//    - licence off: the routes refuse with licence_required and /auth/me
//      lists no licence; nothing else changes;
//    - sites: create, name clash, list with health, edit with audit;
//      operators and other accounts refused;
//    - enrolment: a token shown once and stored as a hash; spent once;
//      expired and withdrawn tokens refused; the host registered as pending
//      with its facts and a credential of its own;
//    - credential scope: the host credential opens only the agent routes
//      (admin API, another account's site, any console route refused);
//    - approve and reject: a pending host takes no work, an approved one is
//      told it may; a rejected host's credential stops working;
//    - heartbeat and health: stale and offline hosts, site health from the
//      approved hosts only, config pulled only when it changed;
//    - rotation: handed over on the next heartbeat, the old credential works
//      until the new one is first used, then never again;
//    - a disabled site and a withdrawn licence refuse the agent;
//    - audit rows for enrolment, decisions and rotation;
//    - the real volt-agent: enrol and heartbeat from its own module, then
//      `volt-agent site run` as a second process against this control plane.
//
//  Usage: DATABASE_URL=... npx tsx test/sites.check.ts
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const S = await import('../src/services/sites/sites');
  const agent = await import('../../volt-agent/src/site');

  console.log('== health (pure) ==');
  const now = Date.now();
  ok(S.hostHealth(null, now) === 'never', 'a host never heard from');
  ok(S.hostHealth(new Date(now - 10_000), now) === 'online', 'heard from 10 s ago: online');
  ok(S.hostHealth(new Date(now - (S.STALE_AFTER_S + 5) * 1000), now) === 'stale', 'three heartbeats missed: stale');
  ok(S.hostHealth(new Date(now - (S.OFFLINE_AFTER_S + 5) * 1000), now) === 'offline', 'ten minutes: offline');
  ok(S.siteHealth('active', []) === 'no_hosts' && S.siteHealth('disabled', ['online']) === 'disabled', 'no approved hosts; a disabled site');
  ok(S.siteHealth('active', ['online', 'online']) === 'healthy' && S.siteHealth('active', ['online', 'stale']) === 'degraded' && S.siteHealth('active', ['stale', 'offline']) === 'offline', 'healthy, degraded, offline');
  let threw = false; try { S.cleanFacts({}); } catch { threw = true; }
  ok(threw, 'facts without a hostname are refused');
  const cf = S.cleanFacts({ hostname: 'h', cpuCores: -1, memoryBytes: 'x', gpus: Array.from({ length: 30 }, () => ({ name: 'g', encodeSessions: 3 })), os: 'x'.repeat(500) });
  ok(cf.cpuCores === null && cf.memoryBytes === null && cf.gpus!.length === 16 && cf.os!.length === 80, 'facts from outside are bounded and typed', cf);

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sites-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`sites-b-${tag}`]))!.id;
  const mkUser = async (a: string, role: string, n: string) => (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`, [a, `${n}-${tag}@example.com`, role]))!.id;
  const owner = await mkUser(acct, 'owner', 'own');
  const operator = await mkUser(acct, 'operator', 'op');
  const ownerB = await mkUser(other, 'owner', 'ownb');
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const tokOp = signAccess({ sub: operator, account_id: acct, role: 'operator' } as any);
  const tokB = signAccess({ sub: ownerB, account_id: other, role: 'owner' } as any);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const facts = (hostname: string, extra: any = {}) => ({ hostname, cpuCores: 32, memoryBytes: 128 * 2 ** 30, gpus: [{ name: 'NVIDIA L4', vendor: 'nvidia', memoryBytes: 24 * 2 ** 30, encodeSessions: 8 }], diskFreeBytes: 2e12, diskTotalBytes: 4e12, os: 'Linux 6.8', arch: 'x64', agentVersion: '0.2.0', encoderVersion: '1.4.0', ...extra });

  console.log('== licence off ==');
  let r = await api('GET', '/api/sites');
  ok(r.status === 403 && r.body?.code === 'licence_required', 'GET /api/sites refused without the licence', r);
  r = await api('POST', '/api/sites', { name: 'Main' });
  ok(r.status === 403 && r.body?.code === 'licence_required', 'creating a site refused without the licence', r);
  r = await api('GET', '/api/auth/me');
  ok(r.status === 200 && Array.isArray(r.body?.account?.licences) && r.body.account.licences.length === 0, '/auth/me lists no licence', r.body?.account);
  r = await api('POST', '/api/site-agent/enrol', { token: 'vsenrol_nothing', host: facts('x') }, null);
  ok(r.status === 401, 'an unknown enrolment token is refused', r);
  ok((await one<any>(`SELECT licences FROM accounts WHERE id = $1`, [acct]))!.licences.length === 0, 'a new account has no licences (off by default)');

  console.log('== the system admin sets the licence ==');
  const { AUD_PLATFORM } = await import('../src/auth/jwt');
  const sys = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status, platform_role) VALUES ($1,$2,'x','owner','active','saas_admin') RETURNING id`, [other, `sys-${tag}@example.com`]))!.id;
  const tokSys = signAccess({ sub: sys, account_id: other, role: 'owner' } as any, { aud: AUD_PLATFORM } as any);
  r = await api('PATCH', `/api/platform/accounts/${acct}`, { licences: ['hybrid_sites'] });
  ok(r.status === 403, 'an account owner cannot license their own account', r.status);
  r = await api('PATCH', `/api/platform/accounts/${acct}`, { licences: ['made_up'] }, tokSys);
  ok(r.status === 422, 'an unknown licence is refused', r.status);
  r = await api('PATCH', `/api/platform/accounts/${acct}`, { licences: ['hybrid_sites', 'hybrid_sites'] }, tokSys);
  ok(r.status === 200 && JSON.stringify(r.body.licences) === '["hybrid_sites"]', 'the system admin sets it (duplicates folded)', r.body);
  r = await api('GET', '/api/platform/accounts', undefined, tokSys);
  const plist: any[] = Array.isArray(r.body) ? r.body : (r.body?.items ?? r.body?.accounts ?? []);
  ok(plist.find((x: any) => x.id === acct)?.licences?.includes('hybrid_sites'), 'the platform account list shows it', r.status);
  await query(`UPDATE accounts SET licences = '{hybrid_sites}' WHERE id = ANY($1::uuid[])`, [[acct, other]]);
  r = await api('GET', '/api/auth/me');
  ok(r.body?.account?.licences?.includes('hybrid_sites'), '/auth/me lists the licence once set');

  console.log('== sites ==');
  r = await api('POST', '/api/sites', { name: 'Main broadcast centre', description: 'Ground floor' });
  ok(r.status === 201 && r.body?.health === 'no_hosts' && r.body?.status === 'active', 'site created, no hosts yet', r);
  const site = r.body.id;
  r = await api('POST', '/api/sites', { name: 'main BROADCAST centre' });
  ok(r.status === 409, 'name clash refused, ignoring case', r);
  r = await api('POST', '/api/sites', { name: 'Edit suite' }, tokOp);
  ok(r.status === 403, 'an operator cannot create sites', r);
  r = await api('GET', '/api/sites', undefined, tokOp);
  ok(r.status === 403, 'an operator cannot list sites', r);
  r = await api('GET', `/api/sites/${site}`, undefined, tokB);
  ok(r.status === 404, "another account cannot read this account's site", r);
  r = await api('GET', '/api/sites', undefined, tokB);
  ok(r.status === 200 && r.body.items.length === 0, "another account's list does not show it", r.body);
  r = await api('GET', '/api/sites');
  ok(r.status === 200 && r.body.items.length === 1 && r.body.items[0].name === 'Main broadcast centre' && r.body.items[0].hosts.total === 0, 'list with health and host counts', r.body);
  r = await api('PATCH', `/api/sites/${site}`, { description: 'Ground floor, rack 4', version: 1 });
  ok(r.status === 200 && r.body.version === 2 && r.body.changed.includes('description') && r.body.configVersion === 2, 'edit bumps the record and config versions', r.body);
  r = await api('PATCH', `/api/sites/${site}`, { description: 'stale', version: 1 });
  ok(r.status === 409, 'an edit from an old version is refused', r);

  console.log('== enrolment ==');
  r = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  ok(r.status === 201 && /^vsenrol_/.test(r.body.token) && r.body.prefix && r.body.token.startsWith(r.body.prefix), 'token created and shown once', r.body);
  const token1 = r.body.token;
  const stored = await one<any>(`SELECT token_hash FROM site_enrolment_tokens WHERE id = $1`, [r.body.id]);
  ok(stored.token_hash === S.sha256(token1) && !JSON.stringify(stored).includes(token1), 'only its hash is stored');
  r = await api('GET', `/api/sites/${site}`);
  ok(r.body.enrolmentTokens.length === 1 && !JSON.stringify(r.body).includes(token1), 'the site page lists the token by prefix, never in clear', r.body.enrolmentTokens);
  r = await api('POST', `/api/sites/${site}/enrolment-tokens`, {}, tokB);
  ok(r.status === 404, "another account cannot make tokens for this site", r);

  r = await api('POST', '/api/site-agent/enrol', { token: token1, host: {} }, null);
  ok(r.status === 400, 'enrolment without a hostname refused (token not spent)', r);
  r = await api('POST', '/api/site-agent/enrol', { token: token1, host: facts('enc-01') }, null);
  ok(r.status === 201 && r.body.status === 'pending' && /^vsite_/.test(r.body.credential) && r.body.siteId === site, 'enrolled: host pending, credential given', r.body);
  const host1 = r.body.hostId; const cred1 = r.body.credential;
  r = await api('POST', '/api/site-agent/enrol', { token: token1, host: facts('enc-01b') }, null);
  ok(r.status === 401, 'a token works once', r);
  const h1 = await one<any>(`SELECT * FROM site_hosts WHERE id = $1`, [host1]);
  ok(h1.cpu_cores === 32 && Number(h1.memory_bytes) === 128 * 2 ** 30 && h1.gpus[0].encodeSessions === 8 && Number(h1.disk_free_bytes) === 2e12, 'host facts stored: cores, memory, GPU sessions, disk', h1);
  ok((await one<any>(`SELECT count(*)::int AS n FROM site_credentials WHERE host_id = $1 AND secret_hash = $2`, [host1, S.sha256(cred1)]))!.n === 1, 'the credential is stored as a hash');

  r = await api('POST', `/api/sites/${site}/enrolment-tokens`, { expiresInHours: 1 });
  const expired = r.body;
  await query(`UPDATE site_enrolment_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
  r = await api('POST', '/api/site-agent/enrol', { token: expired.token, host: facts('late') }, null);
  ok(r.status === 401, 'an expired token is refused', r);
  r = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const withdrawn = r.body;
  r = await api('DELETE', `/api/sites/${site}/enrolment-tokens/${withdrawn.id}`);
  ok(r.status === 204, 'an unused token withdrawn');
  r = await api('POST', '/api/site-agent/enrol', { token: withdrawn.token, host: facts('w') }, null);
  ok(r.status === 401, 'a withdrawn token is refused', r);

  console.log('== credential scope ==');
  for (const path of ['/api/sites', `/api/sites/${site}`, '/api/vod', '/api/channels', '/api/auth/me', '/api/platform/overview']) {
    r = await api('GET', path, undefined, cred1);
    ok(r.status === 401, `host credential refused on ${path}`, r.status);
  }
  r = await api('POST', `/api/sites/${site}/hosts/${host1}/approve`, {}, cred1);
  ok(r.status === 401, 'a host cannot approve itself', r.status);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, tok);
  ok(r.status === 401, 'a console session is not a host credential', r.status);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, 'vsite_forged');
  ok(r.status === 401, 'a made-up credential is refused', r.status);

  console.log('== pending, then approved ==');
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01', { diskFreeBytes: 1.5e12 }), configVersion: null }, cred1);
  ok(r.status === 200 && r.body.approved === false && r.body.status === 'pending' && r.body.pullConfig === true && r.body.rotate === null, 'a pending host heartbeats, is told it is not approved', r.body);
  const cv = r.body.configVersion;
  ok(Number((await one<any>(`SELECT disk_free_bytes FROM site_hosts WHERE id = $1`, [host1]))!.disk_free_bytes) === 1.5e12, 'each heartbeat updates the facts (free disk)');
  r = await api('GET', '/api/site-agent/config', undefined, cred1);
  ok(r.status === 200 && r.body.work === 'waiting_for_approval' && r.body.host.approved === false && r.body.site.id === site && r.body.configVersion === cv, 'a pending host gets config with no work', r.body);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01'), configVersion: cv }, cred1);
  ok(r.body.pullConfig === false, 'no config pull while nothing changed');
  r = await api('GET', `/api/sites/${site}`);
  ok(r.body.health === 'no_hosts' && r.body.hosts.pending === 1 && r.body.hostList[0].health === 'online' && r.body.hostList[0].gpus[0].encodeSessions === 8, 'a pending host does not make the site healthy; its facts shown', r.body);
  r = await api('POST', `/api/sites/${site}/hosts/${host1}/approve`, {}, tokOp);
  ok(r.status === 403, 'an operator cannot approve hosts', r.status);
  r = await api('POST', `/api/sites/${site}/hosts/${host1}/approve`, {}, tokB);
  ok(r.status === 404, 'another account cannot approve this host', r.status);
  r = await api('POST', `/api/sites/${site}/hosts/${host1}/approve`, {});
  ok(r.status === 200 && r.body.status === 'approved', 'host approved', r.body);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01'), configVersion: cv }, cred1);
  ok(r.body.approved === true && r.body.pullConfig === true, 'the approval reaches the agent and it is told to pull config', r.body);
  r = await api('GET', '/api/site-agent/config', undefined, cred1);
  ok(r.body.work === 'ready' && r.body.host.approved === true, 'an approved host is told it may take work', r.body);
  r = await api('GET', `/api/sites/${site}`);
  ok(r.body.health === 'healthy' && r.body.hosts.online === 1 && r.body.agentVersions[0] === '0.2.0' && r.body.encoderVersions[0] === '1.4.0' && r.body.lastContactAt, 'site healthy with versions and last contact', r.body);

  console.log('== stale heartbeat ==');
  await query(`UPDATE site_hosts SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`, [host1, S.STALE_AFTER_S + 30]);
  r = await api('GET', `/api/sites/${site}`);
  ok(r.body.hostList[0].health === 'stale' && r.body.health === 'offline', 'stale host: the site shows offline (no host online)', r.body.health);
  await query(`UPDATE site_hosts SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1`, [host1, S.OFFLINE_AFTER_S + 30]);
  r = await api('GET', '/api/sites');
  ok(r.body.items[0].health === 'offline', 'offline in the list too');

  console.log('== second host: rejected ==');
  r = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  r = await api('POST', '/api/site-agent/enrol', { token: r.body.token, host: facts('enc-02') }, null);
  const host2 = r.body.hostId; const cred2 = r.body.credential;
  await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred1);
  r = await api('POST', `/api/sites/${site}/hosts/${host2}/reject`, {});
  ok(r.status === 200 && r.body.status === 'rejected', 'second host rejected', r.body);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-02') }, cred2);
  ok(r.status === 401 || r.status === 403, "a rejected host's credential stops working", r);
  r = await api('GET', `/api/sites/${site}`);
  ok(r.body.health === 'healthy' && r.body.hosts.total === 2 && r.body.hosts.approved === 1, 'the rejected host does not affect site health', r.body.hosts);

  console.log('== rotation ==');
  r = await api('POST', `/api/sites/${site}/hosts/${host1}/rotate-credential`, {});
  ok(r.status === 201 && r.body.pending === true && !('credential' in r.body), 'rotation made; the console never sees the new secret', r.body);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred1);
  ok(r.status === 200 && /^vsite_/.test(r.body.rotate?.credential), 'the next heartbeat hands the new credential over', r.body);
  const cred1b = r.body.rotate.credential;
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred1);
  ok(r.status === 200 && /^vsite_/.test(r.body.rotate?.credential) && r.body.rotate.credential !== cred1b, 'an agent that missed the answer is handed it again (old one still works)', r.status);
  const cred1c = r.body.rotate.credential;
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred1b);
  ok(r.status === 401, 'the superseded hand-over no longer works', r.status);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred1c);
  ok(r.status === 200 && r.body.rotate === null, 'the new credential works and nothing more is waiting', r.body);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred1);
  ok(r.status === 401, 'the old credential stopped working once the new one was used', r.status);
  const cred = cred1c;

  console.log('== disabled site, withdrawn licence ==');
  r = await api('PATCH', `/api/sites/${site}`, { status: 'disabled' });
  ok(r.status === 200 && r.body.health === 'disabled', 'site disabled', r.body);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred);
  ok(r.status === 403, 'a disabled site refuses its agents', r);
  r = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  ok(r.status === 400, 'no enrolment into a disabled site', r);
  await api('PATCH', `/api/sites/${site}`, { status: 'active' });
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred);
  ok(r.status === 200, 'enabled again: the agent is back');
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  r = await api('POST', '/api/site-agent/heartbeat', { host: facts('enc-01') }, cred);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'licence withdrawn: the agent is refused with licence_required', r);
  r = await api('GET', `/api/sites/${site}`);
  ok(r.status === 403 && r.body?.code === 'licence_required', 'licence withdrawn: the console routes refuse', r);
  ok((await one<any>(`SELECT count(*)::int AS n FROM site_hosts WHERE site_id = $1`, [site]))!.n === 2, 'withdrawing the licence deletes nothing');
  await query(`UPDATE accounts SET licences = '{hybrid_sites}' WHERE id = $1`, [acct]);

  console.log('== audit ==');
  const audit = await query<any>(`SELECT action, entity_type FROM audit_log WHERE account_id = $1`, [acct]);
  const has = (a: string, e: string) => audit.some((x) => x.action === a && x.entity_type === e);
  ok(has('create', 'site') && has('update', 'site'), 'site creation and edits audited');
  ok(has('create', 'site_enrolment_token') && has('delete', 'site_enrolment_token'), 'tokens issued and withdrawn audited');
  ok(has('create', 'site_host') && has('update', 'site_host'), 'enrolment and decisions audited');
  ok(has('create', 'site_credential'), 'rotation audited');

  console.log('== the real agent ==');
  const dir = mkdtempSync(join(tmpdir(), 'site-agent-'));
  const stateFile = join(dir, 'state', 'site.json');
  r = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const real = await agent.gatherFacts({ dataDir: dir });
  ok(real.hostname && real.cpuCores > 0 && real.memoryBytes > 0 && real.diskFreeBytes! > 0 && Array.isArray(real.gpus), 'the agent reads this machine: cores, memory, disk, GPUs', real);
  const st = await agent.enrol(base, r.body.token, stateFile);
  ok(st.hostId && /^vsite_/.test(st.credential) && st.status === 'pending', 'agent enrolled through its own module', st);
  ok((statSync(stateFile).mode & 0o077) === 0, 'its state file is readable by its owner only', (statSync(stateFile).mode & 0o777).toString(8));
  const b1 = await agent.beat(st, stateFile);
  ok(b1.status === 'pending' && st.config?.work === 'waiting_for_approval', 'first heartbeat pulled config: waiting for approval', st.config);
  await api('POST', `/api/sites/${site}/hosts/${st.hostId}/approve`, {});
  await api('POST', `/api/sites/${site}/hosts/${st.hostId}/rotate-credential`, {});
  const before = st.credential;
  const b2 = await agent.beat(st, stateFile);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  ok(b2.approved && st.config?.work === 'ready' && saved.credential !== before && saved.credential === st.credential, 'approval and a rotated credential picked up and saved', { work: st.config?.work });

  // A second process: `volt-agent site run` with that state file.
  const tsx = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [join(__dirname, '..', '..', 'volt-agent', 'src', 'cli.ts'), 'site', 'run', stateFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (!/host approved/.test(out) && Date.now() - t0 < 20_000) await new Promise((res) => setTimeout(res, 200));
  child.kill('SIGTERM');
  ok(/host approved/.test(out), '`volt-agent site run` as a second process heartbeats against the control plane', out.slice(0, 400));
  const after = await one<any>(`SELECT last_heartbeat_at, last_credential FROM (SELECT h.last_heartbeat_at, (SELECT max(last_used_at) FROM site_credentials c WHERE c.host_id = h.id) AS last_credential FROM site_hosts h WHERE h.id = $1) x`, [st.hostId]);
  ok(after && new Date(after.last_heartbeat_at).getTime() >= t0 - 1000, 'its heartbeat recorded', after);

  srv.close();
  await pool.end();
  console.log(`\nsites: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
