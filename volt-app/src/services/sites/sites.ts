// ============================================================================
//  HYBRID SITES: sites, hosts, enrolment and credentials (build queue H1,
//  HYBRID_SITES.md).
//
//  THE LIFE OF A HOST
//    1. An administrator creates a site and an ENROLMENT TOKEN for it in the
//       console. The token is shown once, works once, and expires (24 h by
//       default).
//    2. The agent on the customer's server sends the token with the host's
//       facts (cores, memory, GPUs and their encode sessions, free disk). The
//       token is spent, a HOST is registered as pending, and the agent gets
//       its own HOST CREDENTIAL in exchange, shown once.
//    3. The host waits for approval in the console. A pending host may report
//       and pull config, but is given no work. A rejected host is refused.
//    4. The approved host sends a heartbeat every HEARTBEAT_SECONDS and pulls
//       config when its config version is behind.
//
//  A HOST CREDENTIAL IS NARROW. It is not an account key and not a session:
//  requireAuth refuses it, so no admin route can be reached with it. It opens
//  only the agent routes, and only for its own host, site and account.
//
//  ROTATION never strands an agent. The console makes a new credential; the
//  next heartbeat with the old one carries it back; the old one stops working
//  the first time the new one is used.
// ============================================================================
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, one, tx } from '../../db';
import { unauthorized, forbidden, badRequest, notFound } from '../../util/http';
import { writeAudit } from '../audit';
import { licenceRequired } from './licences';

/** How often an agent reports. */
export const HEARTBEAT_SECONDS = 30;
/** A host not heard from for three heartbeats is stale. */
export const STALE_AFTER_S = 3 * HEARTBEAT_SECONDS;
/** Ten minutes without a heartbeat and the host is offline. */
export const OFFLINE_AFTER_S = 600;
export const TOKEN_TTL_HOURS_DEFAULT = 24;

export type HostHealth = 'never' | 'online' | 'stale' | 'offline';
export type SiteHealth = 'disabled' | 'no_hosts' | 'healthy' | 'degraded' | 'offline';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const TOKEN_PREFIX = 'vsenrol_';
const CRED_PREFIX = 'vsite_';

/** A host's health from when it was last heard from. Pure, for the suites. */
export function hostHealth(lastHeartbeat: Date | string | null, now = Date.now()): HostHealth {
  if (!lastHeartbeat) return 'never';
  const age = (now - new Date(lastHeartbeat).getTime()) / 1000;
  if (age <= STALE_AFTER_S) return 'online';
  if (age <= OFFLINE_AFTER_S) return 'stale';
  return 'offline';
}

/**
 * A site's health from its APPROVED hosts only: a pending host does no work,
 * so it neither makes a site healthy nor drags it down.
 */
export function siteHealth(status: string, approvedHosts: HostHealth[]): SiteHealth {
  if (status === 'disabled') return 'disabled';
  if (!approvedHosts.length) return 'no_hosts';
  const up = approvedHosts.filter((h) => h === 'online').length;
  if (up === approvedHosts.length) return 'healthy';
  return up > 0 ? 'degraded' : 'offline';
}

// ---- the facts a host reports -------------------------------------------------

export interface HostFacts {
  hostname: string;
  cpuCores?: number | null;
  memoryBytes?: number | null;
  gpus?: { name: string; vendor?: string | null; memoryBytes?: number | null; encodeSessions?: number | null }[];
  diskFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
  encoderVersion?: string | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Keep what a host sends to known, bounded fields: it is input from outside. */
export function cleanFacts(raw: any): HostFacts {
  const hostname = str(raw?.hostname, 253);
  if (!hostname) throw badRequest('hostname is required');
  const gpus = Array.isArray(raw?.gpus) ? raw.gpus.slice(0, 16).map((g: any) => ({
    name: str(g?.name) ?? 'GPU', vendor: str(g?.vendor, 40), memoryBytes: num(g?.memoryBytes), encodeSessions: num(g?.encodeSessions),
  })) : [];
  return {
    hostname, cpuCores: num(raw?.cpuCores), memoryBytes: num(raw?.memoryBytes), gpus,
    diskFreeBytes: num(raw?.diskFreeBytes), diskTotalBytes: num(raw?.diskTotalBytes),
    os: str(raw?.os, 80), arch: str(raw?.arch, 20), agentVersion: str(raw?.agentVersion, 40), encoderVersion: str(raw?.encoderVersion, 40),
  };
}

async function saveFacts(c: PoolClient | null, hostId: string, f: HostFacts) {
  const sql = `UPDATE site_hosts SET hostname = $2, cpu_cores = $3, memory_bytes = $4, gpus = $5::jsonb,
       disk_free_bytes = $6, disk_total_bytes = $7, os = $8, arch = $9, agent_version = $10, encoder_version = $11,
       facts = $12::jsonb, updated_at = now() WHERE id = $1`;
  const p = [hostId, f.hostname, f.cpuCores, f.memoryBytes, JSON.stringify(f.gpus ?? []), f.diskFreeBytes, f.diskTotalBytes,
    f.os, f.arch, f.agentVersion, f.encoderVersion, JSON.stringify(f)];
  if (c) await c.query(sql, p); else await query(sql, p);
}

// ---- console side ---------------------------------------------------------------

/** A new enrolment token. The clear token is returned here and never again. */
export async function createEnrolmentToken(accountId: string, siteId: string, userId: string | null, label: string, ttlHours = TOKEN_TTL_HOURS_DEFAULT) {
  const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
  const row = await one<any>(
    `INSERT INTO site_enrolment_tokens(site_id, account_id, token_hash, prefix, expires_at, created_by)
     VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5), (SELECT id FROM users WHERE id = $6))
     RETURNING id, prefix, expires_at, created_at`,
    [siteId, accountId, sha256(token), token.slice(0, TOKEN_PREFIX.length + 6), ttlHours, userId]);
  await writeAudit(null, { accountId, userId, label, action: 'create', entityType: 'site_enrolment_token', entityId: row.id,
    snapshot: { siteId, prefix: row.prefix, expiresAt: row.expires_at } });
  return { id: row.id, token, prefix: row.prefix, expiresAt: row.expires_at, createdAt: row.created_at };
}

/** Approve or reject a pending (or previously decided) host. */
export async function decideHost(accountId: string, siteId: string, hostId: string, decision: 'approved' | 'rejected', userId: string | null, label: string) {
  return tx(async (c) => {
    const h = (await c.query(`SELECT * FROM site_hosts WHERE id = $1 AND site_id = $2 AND account_id = $3 FOR UPDATE`, [hostId, siteId, accountId])).rows[0];
    if (!h) throw notFound('host not found');
    if (h.status === decision) return h;
    const row = (await c.query(
      `UPDATE site_hosts SET status = $2, decided_at = now(), decided_by = (SELECT id FROM users WHERE id = $3), updated_at = now()
        WHERE id = $1 RETURNING *`, [hostId, decision, userId])).rows[0];
    // A rejected host's credentials stop working at once.
    if (decision === 'rejected') await c.query(`UPDATE site_credentials SET revoked_at = now() WHERE host_id = $1 AND revoked_at IS NULL`, [hostId]);
    await c.query(`UPDATE sites SET config_version = config_version + 1, updated_at = now() WHERE id = $1`, [siteId]);
    await writeAudit(c, { accountId, userId, label, action: 'update', entityType: 'site_host', entityId: hostId,
      changes: { status: { from: h.status, to: decision } } });
    return row;
  });
}

/** Make a new credential for a host; it reaches the agent on its next heartbeat. */
export async function rotateCredential(accountId: string, siteId: string, hostId: string, userId: string | null, label: string) {
  const h = await one<any>(`SELECT id, status FROM site_hosts WHERE id = $1 AND site_id = $2 AND account_id = $3`, [hostId, siteId, accountId]);
  if (!h) throw notFound('host not found');
  if (h.status === 'rejected') throw badRequest('A rejected host has no credential to rotate');
  return tx(async (c) => {
    // Only one rotation waits at a time: a second click replaces the first.
    // (The credential in use has activated_at set; a waiting one has not.)
    await c.query(`UPDATE site_credentials SET revoked_at = now() WHERE host_id = $1 AND activated_at IS NULL AND revoked_at IS NULL`, [hostId]);
    // Its clear value is made when it is handed over (heartbeat), so this one
    // is never seen by anybody.
    const secret = CRED_PREFIX + randomBytes(32).toString('base64url');
    const row = (await c.query(
      `INSERT INTO site_credentials(site_id, account_id, host_id, secret_hash, prefix, created_by)
       VALUES ($1,$2,$3,$4,$5,(SELECT id FROM users WHERE id = $6)) RETURNING id, prefix, created_at`,
      [siteId, accountId, hostId, sha256(secret), secret.slice(0, CRED_PREFIX.length + 6), userId])).rows[0];
    await writeAudit(c, { accountId, userId, label, action: 'create', entityType: 'site_credential', entityId: row.id,
      snapshot: { hostId, prefix: row.prefix, rotation: true } });
    return { id: row.id, prefix: row.prefix, createdAt: row.created_at, pending: true };
  });
}

// ---- agent side -----------------------------------------------------------------

/** Spend an enrolment token: register the host as pending and give it a credential. */
export async function enrol(token: string, rawFacts: any) {
  const facts = cleanFacts(rawFacts);
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) throw unauthorized('Enrolment token not valid');
  return tx(async (c) => {
    // FOR UPDATE: two agents racing with one token, only one wins.
    const t = (await c.query(
      `SELECT t.*, s.status AS site_status, s.name AS site_name, a.licences
         FROM site_enrolment_tokens t JOIN sites s ON s.id = t.site_id JOIN accounts a ON a.id = t.account_id
        WHERE t.token_hash = $1 FOR UPDATE OF t`, [sha256(token)])).rows[0];
    if (!t || t.used_at || t.revoked_at || new Date(t.expires_at).getTime() <= Date.now()) {
      throw unauthorized('Enrolment token not valid: it may have been used already or expired. Create a new one in Admin, Sites.');
    }
    if (!(t.licences ?? []).includes('hybrid_sites')) throw licenceRequired('hybrid_sites');
    if (t.site_status !== 'active') throw forbidden('This site is disabled');
    const host = (await c.query(
      `INSERT INTO site_hosts(site_id, account_id, hostname) VALUES ($1,$2,$3) RETURNING id, status`,
      [t.site_id, t.account_id, facts.hostname])).rows[0];
    await saveFacts(c, host.id, facts);
    const secret = CRED_PREFIX + randomBytes(32).toString('base64url');
    await c.query(
      `INSERT INTO site_credentials(site_id, account_id, host_id, secret_hash, prefix, delivered_at, activated_at)
       VALUES ($1,$2,$3,$4,$5, now(), now())`,
      [t.site_id, t.account_id, host.id, sha256(secret), secret.slice(0, CRED_PREFIX.length + 6)]);
    await c.query(`UPDATE site_enrolment_tokens SET used_at = now(), used_by_host = $2 WHERE id = $1`, [t.id, host.id]);
    await writeAudit(c, { accountId: t.account_id, userId: null, label: `site agent on ${facts.hostname}`, action: 'create',
      entityType: 'site_host', entityId: host.id, snapshot: { siteId: t.site_id, hostname: facts.hostname, enrolmentToken: t.prefix } });
    return { siteId: t.site_id, siteName: t.site_name, hostId: host.id, status: host.status, credential: secret, heartbeatSeconds: HEARTBEAT_SECONDS };
  });
}

export interface SitePrincipal { credentialId: string; hostId: string; siteId: string; accountId: string; hostStatus: string; siteStatus: string; justActivated: boolean }

/**
 * Who a host credential belongs to. Refuses unknown, revoked and rejected
 * credentials, disabled sites and unlicensed accounts.
 */
export async function authenticateSite(header: string | undefined): Promise<SitePrincipal> {
  const [scheme, secret] = String(header ?? '').split(' ');
  if (scheme !== 'Bearer' || !secret?.startsWith(CRED_PREFIX)) throw unauthorized('A site host credential is required');
  const hash = sha256(secret);
  const r = await one<any>(
    `SELECT c.id, c.host_id, c.site_id, c.account_id, c.secret_hash, c.activated_at, c.revoked_at,
            h.status AS host_status, s.status AS site_status, a.licences
       FROM site_credentials c JOIN site_hosts h ON h.id = c.host_id JOIN sites s ON s.id = c.site_id JOIN accounts a ON a.id = c.account_id
      WHERE c.secret_hash = $1`, [hash]);
  // Constant-time compare of the hashes, even though the lookup already matched.
  if (!r || !timingSafeEqual(Buffer.from(r.secret_hash), Buffer.from(hash)) || r.revoked_at) throw unauthorized('Site host credential not valid');
  if (!(r.licences ?? []).includes('hybrid_sites')) throw licenceRequired('hybrid_sites');
  if (r.host_status === 'rejected') throw forbidden('This host was rejected in the console');
  if (r.site_status !== 'active') throw forbidden('This site is disabled');
  let justActivated = false;
  if (!r.activated_at) {
    // FIRST USE OF A ROTATED CREDENTIAL: it becomes the host's credential and
    // every older one stops working.
    await tx(async (c) => {
      await c.query(`UPDATE site_credentials SET activated_at = now() WHERE id = $1`, [r.id]);
      await c.query(`UPDATE site_credentials SET revoked_at = now() WHERE host_id = $1 AND id <> $2 AND revoked_at IS NULL`, [r.host_id, r.id]);
    });
    justActivated = true;
  }
  await query(`UPDATE site_credentials SET last_used_at = now() WHERE id = $1`, [r.id]);
  return { credentialId: r.id, hostId: r.host_id, siteId: r.site_id, accountId: r.account_id, hostStatus: r.host_status, siteStatus: r.site_status, justActivated };
}

/** A heartbeat: the host's latest facts; the answer says whether to pull config and hands over a rotated credential. */
export async function heartbeat(p: SitePrincipal, rawFacts: any, heldConfigVersion: number | null) {
  const facts = cleanFacts(rawFacts);
  await saveFacts(null, p.hostId, facts);
  await query(`UPDATE site_hosts SET last_heartbeat_at = now() WHERE id = $1`, [p.hostId]);
  const s = await one<any>(`SELECT config_version FROM sites WHERE id = $1`, [p.siteId]);
  // A rotated credential waiting for this host: hand it over in clear, once.
  // It is stored only as a hash, so it is re-made here and the hash replaced.
  let rotate: { credential: string } | null = null;
  const waiting = await one<any>(
    `SELECT id FROM site_credentials WHERE host_id = $1 AND activated_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [p.hostId]);
  if (waiting) {
    const secret = CRED_PREFIX + randomBytes(32).toString('base64url');
    await query(`UPDATE site_credentials SET secret_hash = $2, prefix = $3, delivered_at = now() WHERE id = $1`,
      [waiting.id, sha256(secret), secret.slice(0, CRED_PREFIX.length + 6)]);
    rotate = { credential: secret };
  }
  return {
    hostId: p.hostId, status: p.hostStatus, approved: p.hostStatus === 'approved',
    configVersion: s?.config_version ?? 1, pullConfig: heldConfigVersion == null || heldConfigVersion !== s?.config_version,
    heartbeatSeconds: HEARTBEAT_SECONDS, rotate,
  };
}

/**
 * What a host should run. In H1 this is the site, the host's own standing and
 * the encoder version the cloud pins; H2 and later add the site's watchfolders
 * and pools. A pending host gets the same shape with nothing to do.
 */
export async function siteConfig(p: SitePrincipal) {
  const s = await one<any>(`SELECT id, name, config_version FROM sites WHERE id = $1`, [p.siteId]);
  await query(`UPDATE site_hosts SET last_config_version = $2 WHERE id = $1`, [p.hostId, s.config_version]);
  const approved = p.hostStatus === 'approved';
  return {
    configVersion: s.config_version,
    site: { id: s.id, name: s.name },
    host: { id: p.hostId, status: p.hostStatus, approved },
    heartbeatSeconds: HEARTBEAT_SECONDS,
    // The released encoder image every site runs; a site never picks its own.
    encoder: { image: 'volt-encoder', version: process.env.VOLT_ENCODER_VERSION || null },
    watchfolders: [] as unknown[],
    pools: [] as unknown[],
    work: approved ? 'ready' : 'waiting_for_approval',
  };
}

// ---- reading for the console --------------------------------------------------

export function hostView(h: any, now = Date.now()) {
  return {
    id: h.id, siteId: h.site_id, hostname: h.hostname, status: h.status,
    health: h.status === 'approved' ? hostHealth(h.last_heartbeat_at, now) : (h.last_heartbeat_at ? hostHealth(h.last_heartbeat_at, now) : 'never'),
    cpuCores: h.cpu_cores, memoryBytes: h.memory_bytes != null ? Number(h.memory_bytes) : null, gpus: h.gpus ?? [],
    diskFreeBytes: h.disk_free_bytes != null ? Number(h.disk_free_bytes) : null, diskTotalBytes: h.disk_total_bytes != null ? Number(h.disk_total_bytes) : null,
    os: h.os, arch: h.arch, agentVersion: h.agent_version, encoderVersion: h.encoder_version,
    lastHeartbeatAt: h.last_heartbeat_at, lastConfigVersion: h.last_config_version,
    decidedAt: h.decided_at, createdAt: h.created_at,
  };
}

export function siteView(s: any, hosts: any[], now = Date.now()) {
  const hv = hosts.map((h) => hostView(h, now));
  const approved = hv.filter((h) => h.status === 'approved');
  const contacts = hv.map((h) => h.lastHeartbeatAt).filter(Boolean).map((t) => new Date(t).getTime());
  return {
    id: s.id, name: s.name, description: s.description, status: s.status, version: s.version, configVersion: s.config_version,
    health: siteHealth(s.status, approved.map((h) => h.health as HostHealth)),
    hosts: { total: hv.length, approved: approved.length, pending: hv.filter((h) => h.status === 'pending').length, online: approved.filter((h) => h.health === 'online').length },
    agentVersions: [...new Set(hv.map((h) => h.agentVersion).filter(Boolean))],
    encoderVersions: [...new Set(hv.map((h) => h.encoderVersion).filter(Boolean))],
    lastContactAt: contacts.length ? new Date(Math.max(...contacts)).toISOString() : null,
    createdAt: s.created_at, updatedAt: s.updated_at,
  };
}
