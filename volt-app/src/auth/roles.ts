/**
 * ACCESS MODEL FOR ADMIN USERS (client staff). See ACCESS_CONTROL.md.
 *
 * Three kinds of principal exist in Volt and never mix:
 *
 *   platform  SaaS staff, cross-tenant, /api/platform/*  (auth/platform.ts)
 *   admin     a client's staff, one account, /api/*      (THIS FILE)
 *   viewer    a client's audience, /api/public/*         (auth/viewerTokens.ts)
 *
 * An admin user's access is:
 *
 *   TIER (users.role)  owner > admin > operator > viewer
 *     owner / admin    full access to everything in the account
 *     operator         access comes from the user's ROLES (below)
 *     viewer           as operator, but capped at `view`
 *
 *   ROLES (user_groups, many per user)  a level per FEATURE:
 *     none < view < operate < manage
 *       view     see lists and detail pages
 *       operate  run things: start/stop, on/off air, auto connect, publish,
 *                retry jobs (the OPERATE actions listed per feature below)
 *       manage   create, edit, delete, plus everything operate allows
 *     A user's effective level for a feature is the highest any of their
 *     roles grants. Default system roles: auth/defaultRoles.ts.
 *
 * ENFORCEMENT is central and default-on: requireAuth calls enforceAccess for
 * every admin request, which maps method + path to (feature, level). A new
 * router under a mapped prefix is covered without doing anything. The same
 * catalogue is served by /api/auth/me, so the console hides what the API
 * would refuse; the API remains the authority.
 *
 * NO ESCALATION: a user can only grant (to a user or to a role) access they
 * hold themselves, and can only change users whose access they cover
 * (assertCovers / assertCanManageUser).
 *
 * COST: effective access is cached per user and dropped by database triggers
 * the moment a user, role or membership changes (migration 0047), so a check
 * is a map lookup on every request and still takes effect at once.
 */
import { Request, Response, NextFunction } from 'express';
import { one, query } from '../db';
import { forbidden, unauthorized } from '../util/http';
import { cached } from '../scale/cache';

export type Role = 'viewer' | 'operator' | 'admin' | 'owner';
export const ROLE_RANK: Record<string, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };

/**
 * The rank of a role, and ZERO for anything not in the map.
 *
 * Reading ROLE_RANK[role] directly is a fail-OPEN comparison: for an unknown
 * role the lookup is undefined, and `undefined < 3` is false, so the guard
 * that was meant to refuse the request skipped its throw and let it through.
 * Every gate now asks for the rank through here so an unrecognised role is
 * the least privileged thing in the system rather than the most.
 */
export function rankOf(role: unknown): number {
  return ROLE_RANK[String(role)] ?? 0;
}

export const LEVELS = ['none', 'view', 'operate', 'manage'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_RANK: Record<Level, number> = { none: 0, view: 1, operate: 2, manage: 3 };
export const levelRank = (l: unknown): number => LEVEL_RANK[l as Level] ?? 0;

// ---- the catalogue ------------------------------------------------------------

export interface FeatureDef {
  key: string;
  label: string;
  area: 'content' | 'insight' | 'admin';
  /** API prefixes this feature owns. Longest match wins. */
  prefixes: string[];
  /** Writes that are OPERATE rather than MANAGE (path regexes, lower-case, no query). */
  operate?: RegExp[];
  /** What operate means here, for the role editor. */
  operateMeans?: string;
  /** Prefixes any signed-in user may READ (lookups the forms of other features need). */
  readOpen?: string[];
  /** POSTs that change nothing (a dry-run plan): they need view, like a read. */
  readWrites?: RegExp[];
}

const ID = '[^/]+';
export const CATALOGUE: FeatureDef[] = [
  { key: 'monitoring', label: 'Live & monitoring', area: 'content', prefixes: ['/api/status', '/api/monitoring', '/api/timeline', '/api/live-streams'] },
  // FAST CHANNELS ARE THEIR OWN FEATURE (28 Oct 2026). A FAST channel is a
  // channel row (origin = 'playlist'), but building and running one is its own
  // job: a FAST Manager runs FAST channels without touching live TV, and a TV
  // operator need not be able to change a FAST run order. /api/fast is here,
  // and so is /api/channels/<id>/... for a FAST channel (its settings, detail,
  // graphics), decided by what the channel is (channelKind). A role saved
  // before this split has no 'fast' key: it keeps its TV channels level for
  // FAST (cleanPerms), so nobody lost access by the split.
  // Running a FAST channel (on/off air, activating a run order, starting its
  // playout, deciding a break as the stitcher would) is operate; building one
  // (create, run orders, ads, ad servers, ladder, filler) is manage. A preview
  // plans a window and writes nothing, so seeing the builder needs view only.
  { key: 'channels', label: 'TV channels', area: 'content', prefixes: ['/api/channels', '/api/daypart-presets'],
    operate: [new RegExp(`^/api/channels/${ID}/(start|stop|air|auto-connect|test-stream|failover-test|reset-health)$`)],
    operateMeans: 'Start/stop, on/off air, auto connect, test streams, clear QC' },
  { key: 'fast', label: 'FAST channels', area: 'content', prefixes: ['/api/fast'],
    operate: [new RegExp(`^/api/fast/channels/${ID}/on-air$`), new RegExp(`^/api/fast/lineups/${ID}/activate$`),
      new RegExp(`^/api/fast/channels/${ID}/playout$`), new RegExp(`^/api/fast/channels/${ID}/breaks/${ID}/decide$`),
      new RegExp(`^/api/channels/${ID}/(air|on-air)$`)],
    readWrites: [new RegExp(`^/api/fast/lineups/${ID}/preview$`)],
    operateMeans: 'On/off air, activate run orders, start and stop the playout' },
  { key: 'radio', label: 'Radio stations', area: 'content', prefixes: ['/api/radio'],
    operate: [new RegExp(`^/api/radio/${ID}/(start|stop|air|auto-connect|clear-recovery)$`), /^\/api\/radio\/probe$/,
      new RegExp(`^/api/radio/${ID}/log/${ID}$`)],
    operateMeans: 'Start/stop, on/off air, auto connect, clear recovery, correct a log entry\'s class' },
  { key: 'events', label: 'Events', area: 'content', prefixes: ['/api/events'],
    operate: [new RegExp(`^/api/events/${ID}/(start|stop|auto-connect|reset-health|health/reset)$`)],
    operateMeans: 'Start/stop, auto connect, clear QC' },
  { key: 'epg', label: 'EPG & schedules', area: 'content', prefixes: ['/api/epg'],
    operate: [new RegExp(`^/api/epg/import/sources/${ID}/(run|test)$`)],
    operateMeans: 'Run and test XMLTV imports' },
  // HTML graphics (docs/REQ_graphics_overlays.md). Manage = templates, setups,
  // data sources, assignments and rundowns; operate = drive them live.
  { key: 'graphics', label: 'Graphics', area: 'content', prefixes: ['/api/graphics'],
    operate: [new RegExp(`^/api/graphics/assignments/${ID}/(state|air)$`), new RegExp(`^/api/graphics/sources/${ID}/push$`),
      new RegExp(`^/api/graphics/rundowns/${ID}/(take|take-off)$`), new RegExp(`^/api/graphics/rundowns/${ID}/items/${ID}/(skip|restore)$`)],
    operateMeans: 'Take graphics on and off, change their values, run event rundowns' },
  { key: 'recordings', label: 'Recordings & clips', area: 'content', prefixes: ['/api/recordings', '/api/scheduled-clips'],
    operate: [new RegExp(`^/api/recordings/${ID}/publish$`)], operateMeans: 'Publish recordings' },
  { key: 'vod', label: 'Media library & publishing', area: 'content', prefixes: ['/api/vod', '/api/publications', '/api/social', '/api/collections'],
    operate: [new RegExp(`^/api/vod/${ID}/(publish|withdraw)$`), new RegExp(`^/api/publications/vod/${ID}/publish$`),
      new RegExp(`^/api/social/publish/${ID}$`), new RegExp(`^/api/social/publish-image/${ID}$`), new RegExp(`^/api/social/publications/${ID}/retry$`)],
    operateMeans: 'Publish and withdraw' },
  // DOWNLOADING IS ITS OWN PERMISSION (modules/downloads.ts): seeing, describing
  // and publishing an item is not the same as being allowed to take a copy.
  // view = see which files there are; operate = download them. A role that
  // predates this feature has none of it until an admin grants it.
  { key: 'downloads', label: 'Downloads', area: 'content', prefixes: ['/api/downloads'],
    operate: [new RegExp(`^/api/downloads/vod/${ID}/link$`)],
    operateMeans: 'Download media files (MP4, MP3, AAC)' },
  { key: 'media', label: 'Files, uploads & storage', area: 'content',
    prefixes: ['/api/files', '/api/filler-assets', '/api/uploads', '/api/tus', '/api/watchfolders', '/api/storage', '/api/jobs',
      // THE INGEST QUEUE is handling uploads, not configuring ingest: what is held,
      // filling in its metadata, settling a duplicate, transfers and remote pulls.
      // The rules, webhooks and providers under /api/ingest stay account settings.
      '/api/ingest/held', '/api/ingest/assets', '/api/ingest/transfers', '/api/ingest/remote', '/api/ingest/locate'],
    // Image pickers in other features' forms (guide icons, logos, slates) browse
    // the library; reading it is open, changing it is still `media`.
    readOpen: ['/api/files'],
    operate: [new RegExp(`^/api/jobs/${ID}/(retry|cancel)$`), new RegExp(`^/api/watchfolders/${ID}/dry-run$`)],
    operateMeans: 'Retry/cancel jobs, watchfolder dry runs' },
  // ENCODING PROFILES AND LADDERS (28 Oct 2026, from Account settings): what titles
  // are encoded and packaged to, shared by uploads, watch folders and FAST
  // channels. Its own feature so a FAST Manager can set a channel's ladder
  // without account settings. Reading stays open: forms pick a ladder. A role
  // saved before the split keeps its Account settings level here (cleanPerms).
  { key: 'encoding', label: 'Encoding profiles & ladders', area: 'content', prefixes: ['/api/encode-profiles'], readOpen: ['/api/encode-profiles'] },
  { key: 'sharing', label: 'Share links', area: 'content', prefixes: ['/api/share-links'] },
  { key: 'analytics', label: 'Analytics & reports', area: 'insight', prefixes: ['/api/analytics', '/api/reports'] },
  { key: 'fleet', label: 'Fleet & usage', area: 'insight', prefixes: ['/api/fleet'] },
  { key: 'users', label: 'Admin users', area: 'admin', prefixes: ['/api/users', '/api/sso-connections'] },
  { key: 'access', label: 'Roles & access', area: 'admin', prefixes: ['/api/user-groups', '/api/access-roles'] },
  { key: 'viewers', label: 'Public users', area: 'admin', prefixes: ['/api/viewers'],
    operate: [new RegExp(`^/api/viewers/${ID}/sign-out$`)], operateMeans: 'Sign a viewer out everywhere' },
  { key: 'apps', label: 'Apps, API keys & players', area: 'admin', prefixes: ['/api/apps', '/api/player-config'] },
  { key: 'payments', label: 'Payments & products', area: 'admin', prefixes: ['/api/payments'] },
  { key: 'settings', label: 'Account settings', area: 'admin',
    prefixes: ['/api/groups', '/api/plan', '/api/account-settings', '/api/output-profiles', '/api/metadata-schemas', '/api/metadata-lists', '/api/notification-templates',
      '/api/publish-targets', '/api/engines', '/api/addons', '/api/workflows',
      '/api/ingest', '/api/publishing-rules'],
    // The channel, event and station forms read these to fill their pickers.
    readOpen: ['/api/groups', '/api/plan', '/api/account-settings', '/api/output-profiles', '/api/metadata-schemas', '/api/metadata-lists', '/api/engines', '/api/addons'],
    operate: [/^\/api\/workflows\/runs(\/[^/]+\/(cancel|retry))?$/], operateMeans: 'Start, cancel and retry workflow runs' },
];

export const FEATURES = CATALOGUE.map((f) => f.key);
export type Feature = string;
export type Perms = Record<string, Level>;
const BY_KEY = new Map(CATALOGUE.map((f) => [f.key, f]));

/** Prefixes shared by several features: allowed if ANY of them grants the level. */
const SHARED_PREFIXES: { prefix: string; anyOf: string[] }[] = [
  { prefix: '/api/sources', anyOf: ['channels', 'radio', 'events'] },
];

/**
 * LOOKUPS THE UPLOAD PANEL MAKES UNDER /api/ingest (build queue 1.14-G3a-2).
 * Adding a file asks what the ingest rules will do with it (preview), how a
 * name will be cleaned (sanitise), what "inherit" means (baseline) and which
 * cloud drives are linked (providers). None of them changes anything, but they
 * sit under /api/ingest, which is Account settings, and preview and sanitise
 * are POSTs, so only Account settings: Manage could upload: the Media
 * Librarian template could not. They are view-level lookups for either
 * feature: whoever handles files (media) or sets the rules (settings). Linking
 * a provider (POST /api/ingest/providers) and the rules themselves stay
 * Account settings.
 */
const INGEST_LOOKUPS: { method: string; path: string }[] = [
  { method: 'GET', path: '/api/ingest/baseline' },
  { method: 'GET', path: '/api/ingest/providers' },
  { method: 'POST', path: '/api/ingest/preview' },
  { method: 'POST', path: '/api/ingest/sanitise' },
];

/** The features legacy (pre-0047) tiers got when the user had no role. */
const LEGACY_CONTENT = ['channels', 'fast', 'radio', 'events', 'epg', 'recordings', 'vod', 'media', 'sharing', 'analytics', 'monitoring', 'fleet'];

/** Features split out of another: a stored role without the new key keeps the level it had through the old one. */
const SPLIT_FROM: Record<string, string> = { fast: 'channels', encoding: 'settings' };

export function allPerms(level: Level): Perms {
  return Object.fromEntries(FEATURES.map((f) => [f, level])) as Perms;
}

/** Normalise a stored permission map: known features only, known levels only. */
export function cleanPerms(p: Record<string, unknown> | null | undefined): Perms {
  const out = allPerms('none');
  for (const f of FEATURES) {
    const v = p?.[f];
    if (typeof v === 'string' && (LEVELS as readonly string[]).includes(v)) out[f] = v as Level;
  }
  for (const [f, from] of Object.entries(SPLIT_FROM)) if (p && !(f in p)) out[f] = out[from];
  return out;
}

/** Tier default when a member has no roles at all (keeps pre-0047 accounts working). */
export function roleDefaultPerms(role: string): Perms {
  const out = allPerms('none');
  const lvl: Level = rankOf(role) >= ROLE_RANK.operator ? 'manage' : 'view';
  for (const f of LEGACY_CONTENT) out[f] = f === 'monitoring' || f === 'fleet' ? 'view' : lvl;
  return out;
}

/**
 * Effective access: owners and admins hold everything; members hold the
 * highest level any of their roles grants; a viewer-tier member is capped at
 * view.
 */
export function effectivePerms(role: string, rolePerms: (Record<string, unknown> | null)[] | Record<string, unknown> | null): Perms {
  if (rankOf(role) >= ROLE_RANK.admin) return allPerms('manage');
  const list = Array.isArray(rolePerms) ? rolePerms.filter(Boolean) : rolePerms ? [rolePerms] : [];
  if (!list.length) return roleDefaultPerms(role);
  const out = allPerms('none');
  for (const p of list) {
    const c = cleanPerms(p as any);
    for (const f of FEATURES) if (LEVEL_RANK[c[f]] > LEVEL_RANK[out[f]]) out[f] = c[f];
  }
  if (rankOf(role) < ROLE_RANK.operator) {
    for (const f of FEATURES) if (LEVEL_RANK[out[f]] > LEVEL_RANK.view) out[f] = 'view';
  }
  return out;
}

// ---- resolving a request ----------------------------------------------------------

/** A token subject is only a user id when it is shaped like one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedAccess {
  role: string;
  perms: Perms;
  /** Role (group) ids the user holds. */
  roleIds: string[];
  accountId: string | null;
  platformRole: string | null;
}

/**
 * The caller's current access, cached until something about it changes.
 * Tagged user:<id>, ugroup:<each role>, acct:<account> (migration 0047 triggers).
 *
 * A user that no longer exists or is not active resolves to NULL, and the
 * request is refused: a disabled user's unexpired token stops working at once
 * instead of falling back to the role written inside the token.
 */
export async function resolveAccess(userId: string, tokenRole: string): Promise<ResolvedAccess> {
  if (userId.startsWith('apikey:')) {
    // Account secret key: full tenant admin, as the key model has always meant.
    return { role: 'admin', perms: allPerms('manage'), roleIds: [], accountId: null, platformRole: null };
  }
  // A token whose subject is not a user at all. Production refuses it. Local
  // development and the shell suites sign tokens by hand for made-up subjects,
  // so outside production they fall back to the tier written in the token,
  // as before. (A user who exists but is disabled is refused everywhere.)
  const legacy = (): ResolvedAccess => {
    if (process.env.NODE_ENV === 'production' || process.env.ACCESS_STRICT_SUBJECT === 'true') {
      throw unauthorized('Unknown principal');
    }
    return { role: tokenRole, perms: effectivePerms(tokenRole, []), roleIds: [], accountId: null, platformRole: null };
  };
  if (!UUID_RE.test(userId)) return legacy();
  const r = await cached<ResolvedAccess | null | 'missing'>(
    `access:${userId}`,
    {
      ttlSec: 300,
      tags: (v) => v && v !== 'missing' ? [`user:${userId}`, ...v.roleIds.map((g) => `ugroup:${g}`), ...(v.accountId ? [`acct:${v.accountId}`] : [])] : [`user:${userId}`],
    },
    async () => {
      const u = await one<any>(
        `SELECT u.role, u.account_id, u.platform_role, u.status, a.status AS account_status
           FROM users u JOIN accounts a ON a.id = u.account_id
          WHERE u.id=$1`, [userId]);
      if (!u) return 'missing';
      if (u.status !== 'active' || u.account_status === 'suspended') return null;
      const groups = await query<any>(
        `SELECT g.id, g.permissions FROM user_group_members m JOIN user_groups g ON g.id = m.group_id
          WHERE m.user_id = $1 AND g.account_id = $2`, [userId, u.account_id]);
      return {
        role: u.role,
        perms: effectivePerms(u.role, groups.map((g) => g.permissions)),
        roleIds: groups.map((g) => g.id),
        accountId: u.account_id,
        platformRole: u.platform_role ?? null,
      };
    }
  );
  if (r === 'missing') return legacy();
  if (!r) throw unauthorized('This user is disabled or no longer exists');
  return r;
}

/** Kept for callers that used to clear the per-process map; the triggers do it now. */
export function invalidateAccess(_userId?: string) { /* cache invalidation is trigger-driven */ }

/** What a channel id is (tv or radio), cached. Radio stations live in `channels`. */
function channelKind(id: string): Promise<string | null> {
  return cached<string | null>(`chkind:${id}`, { ttlSec: 300, tags: [`asset:${id}`] }, async () => {
    if (!UUID_RE.test(id)) return null;
    const r = await one<any>(`SELECT kind, origin FROM channels WHERE id = $1`, [id]);
    // a FAST channel is a channel row with origin 'playlist': its own feature
    return r ? (r.origin === 'playlist' ? 'fast' : r.kind ?? null) : null;
  });
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface Requirement { features: string[]; level: Level; reason: string }

/**
 * Map one request to what it needs. Exported so tests and the docs generator
 * can ask "what does this endpoint require?" without making the request.
 * Returns null for surfaces outside the catalogue (see enforceAccess).
 */
export async function requirementFor(method: string, rawPath: string, body?: any,
  /** How to tell a station from a TV channel. The docs generator passes its own, so it needs no database. */
  kindOf: (id: string) => Promise<string | null> = channelKind): Promise<Requirement | null> {
  const path = rawPath.split('?')[0].toLowerCase().replace(/\/+$/, '') || '/';
  const write = WRITE_METHODS.has(method.toUpperCase());

  if (INGEST_LOOKUPS.some((l) => l.path === path && l.method === method.toUpperCase())) {
    return { features: ['media', 'settings'], level: 'view', reason: 'ingest lookup' };
  }

  // SENDING A RECORDING OR A CLIP TO AN ADD-ON (build queue 1.14-G3a-3).
  // Workflows sits under Account settings, so Send to add-on on a recording
  // needed Account settings: Operate and a Recordings manager could not use
  // it. Starting a run by hand is working on that recording or asset, so it is
  // Operate on the feature that owns the subject (or Account settings, as
  // before). Reading the runs of one subject, which the button shows beside
  // it, is View on that feature. The subject comes from the body for a start
  // and from the query for the list; anything else stays Account settings.
  if (path === '/api/workflows/runs') {
    const subj = write ? body?.subjectType : new URLSearchParams(rawPath.split('?')[1] ?? '').get('subjecttype');
    const owner = subj === 'recording' ? 'recordings' : subj === 'vod_asset' ? 'vod' : null;
    if (owner && (write || new URLSearchParams(rawPath.split('?')[1] ?? '').get('subjectid'))) {
      return { features: ['settings', owner], level: write ? 'operate' : 'view', reason: `add-on run on a ${subj}` };
    }
  }

  // A STREAM'S OWN PUBLISHING RULE (build queue 1.14-G3a-4). Publishing Rules
  // sit under Account settings, so a stream's Access tab needed Account
  // settings: Manage and an Event or Radio Manager could not set the rule of
  // the events and stations they run. The owner rung of a stream is part of
  // that stream: reading it is View and changing it is Manage on the stream's
  // own feature (or Account settings, as before). The two lookups the rule
  // editor makes beside it (the publishing points and what a rung inherits)
  // change nothing, so they are View for whoever can open a rule editor
  // anywhere. The account default and the content type rungs stay Account
  // settings. A uuid that is not a channel is taken as an event: the handler
  // refuses an owner the account does not have.
  if (path === '/api/publishing-rules/points' || path === '/api/publishing-rules/resolve') {
    return { features: ['settings', 'vod', 'channels', 'radio', 'events', 'fast'], level: 'view', reason: 'publishing rule lookup' };
  }
  const ownerRule = path.match(/^\/api\/publishing-rules\/owner\/([^/]+)$/);
  if (ownerRule) {
    const k = await kindOf(ownerRule[1]);
    const feature = k === 'radio' ? 'radio' : k === 'fast' ? 'fast' : k ? 'channels' : 'events';
    return { features: ['settings', feature], level: write ? 'manage' : 'view', reason: `${feature} publishing rule` };
  }

  for (const s of SHARED_PREFIXES) {
    if (path === s.prefix || path.startsWith(s.prefix + '/')) {
      return { features: s.anyOf, level: write ? 'manage' : 'view', reason: s.prefix };
    }
  }

  // AD BREAKS ON ANY STREAM (/api/fast/streams/<kind>/<id>/breaks). They live
  // in the FAST router but belong to whatever stream they are on: an event's
  // breaks are Events work and a station's are Radio work, not TV channels.
  // Putting a break on air now (Go to break) or cancelling one is running the
  // stream, so operate; listing them is view.
  const brk = path.match(/^\/api\/fast\/streams\/([^/]+)\/([^/]+)\/breaks(\/[^/]+)?$/);
  if (brk) {
    const k = brk[1] === 'event' ? null : await kindOf(brk[2]);
    const feature = brk[1] === 'event' ? 'events' : k === 'radio' ? 'radio' : k === 'fast' ? 'fast' : 'channels';
    return { features: [feature], level: write ? 'operate' : 'view', reason: feature };
  }

  // Longest owning prefix wins (/api/epg/import before /api/epg, etc.).
  let best: FeatureDef | null = null;
  let bestLen = -1;
  for (const f of CATALOGUE) for (const p of f.prefixes) {
    if ((path === p || path.startsWith(p + '/')) && p.length > bestLen) { best = f; bestLen = p.length; }
  }
  if (!best) return null;

  let feature = best.key;
  // RADIO LIVES IN THE CHANNELS TABLE. A station is created with
  // POST /api/channels {kind:'radio'} and many station routes are channel
  // routes, so the feature is decided by what the request is about, not only
  // by the path: a Radio Manager can run stations and still cannot touch TV.
  if (feature === 'channels' && path.startsWith('/api/channels')) {
    const m = path.match(/^\/api\/channels\/([^/]+)/);
    if (m) {
      const k = await kindOf(m[1]);
      if (k === 'radio') feature = 'radio';
      else if (k === 'fast') feature = 'fast';
    } else if (write && body && body.kind === 'radio') {
      feature = 'radio';
    }
  }
  const def = BY_KEY.get(feature)!;

  if (!write) {
    // Listing roles is also needed to ASSIGN them: user managers may read it.
    if (feature === 'access') return { features: ['access', 'users'], level: 'view', reason: 'access' };
    const open = (BY_KEY.get(best.key)?.readOpen ?? []).some((p) => path === p || path.startsWith(p + '/'));
    return { features: [feature], level: open ? 'none' : 'view', reason: open ? 'read-open lookup' : feature };
  }
  if ((def.readWrites ?? []).some((rx) => rx.test(path))) return { features: [feature], level: 'view', reason: feature };
  // Operate patterns are checked on the feature that OWNS the path (channels'
  // patterns for a radio station reached through /api/channels/:id/start).
  const ops = [...(best.operate ?? []), ...(def.operate ?? [])];
  const generic = path.replace(/^\/api\/channels\//, '/api/radio/');
  const isOperate = ops.some((rx) => rx.test(path) || (feature === 'radio' && rx.test(generic)));
  return { features: [feature], level: isOperate ? 'operate' : 'manage', reason: feature };
}

/** True when `perms` meet the requirement. */
export function meets(perms: Perms, need: Requirement): boolean {
  if (need.level === 'none') return true;
  return need.features.some((f) => LEVEL_RANK[perms[f] ?? 'none'] >= LEVEL_RANK[need.level]);
}

/**
 * Central gate, run by requireAuth for every admin request. Throws 403 with
 * the feature and level that were missing, so the console can say exactly
 * why.
 *
 * Surfaces outside the catalogue (the signed-in user's own notifications,
 * support tickets, search, discovery documents) are open to read for any
 * signed-in admin user; writing to them needs the operator tier. Add a new
 * admin router under a catalogue prefix, or add its prefix to a feature, and
 * it is gated with no further work. ACCESS_CONTROL.md has the checklist.
 */
export async function enforceAccess(req: Request): Promise<void> {
  // LOWER-CASED, because Express routes case-insensitively by default while
  // startsWith does not: `/API/apps/secret-keys` must not slip past the map.
  const path = (req.originalUrl || req.url || '').split('?')[0].toLowerCase();
  // The query goes along only for the one route that is decided by it (the
  // add-on runs of one subject, in requirementFor); every other route is
  // decided by its path alone, as before.
  const query = (req.originalUrl || req.url || '').split('?')[1];
  const access = await resolveAccess(String(req.auth!.sub), String(req.auth!.role));
  (req.auth as any).role = access.role;   // keep downstream checks honest after role changes
  req.access = access;

  const need = await requirementFor(req.method, path === '/api/workflows/runs' && query ? `${path}?${query.toLowerCase()}` : path, req.body);
  if (!need) {
    if (WRITE_METHODS.has(req.method.toUpperCase()) && rankOf(access.role) < ROLE_RANK.operator) {
      throw forbidden('This action requires the operator role');
    }
    return;
  }
  if (!meets(access.perms, need)) {
    const label = need.features.map((f) => BY_KEY.get(f)?.label ?? f).join(' or ');
    throw Object.assign(forbidden(`Your role does not allow ${need.level} on ${label}`),
      { code: 'forbidden_feature', feature: need.features[0], level: need.level });
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      access?: ResolvedAccess;
    }
  }
}

/** True when the request's user holds `level` on `feature`. For in-handler decisions. */
export function can(req: Request, feature: string, level: Level): boolean {
  const p = req.access?.perms;
  if (!p) return false;
  return LEVEL_RANK[p[feature] ?? 'none'] >= LEVEL_RANK[level];
}

/** Router guard: require a level on a feature (the central gate already ran; this is explicit intent). */
export function requirePermission(feature: string, level: Level) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!can(req, feature, level)) {
      return next(Object.assign(forbidden(`Your role does not allow ${level} on ${BY_KEY.get(feature)?.label ?? feature}`),
        { code: 'forbidden_feature', feature, level }));
    }
    next();
  };
}

/** Router-level guard for surfaces with an explicit tier floor (kept for owner-only actions). */
export function requireMinRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = String(req.auth?.role ?? 'viewer');
    if (rankOf(role) < ROLE_RANK[min]) return next(forbidden(`This action requires the ${min} role`));
    next();
  };
}

// ---- no escalation ---------------------------------------------------------------

/** Features where `wanted` exceeds `actor`. Empty = covered. */
export function exceeds(actor: Perms, wanted: Perms): string[] {
  return FEATURES.filter((f) => LEVEL_RANK[wanted[f] ?? 'none'] > LEVEL_RANK[actor[f] ?? 'none']);
}

/** Refuse unless the actor holds at least everything in `wanted`. */
export function assertCovers(actor: Perms, wanted: Perms, what: string): void {
  const over = exceeds(actor, wanted);
  if (over.length) {
    throw Object.assign(
      forbidden(`You cannot ${what} with more access than you have yourself (${over.map((f) => `${BY_KEY.get(f)?.label ?? f}: ${wanted[f]}`).join(', ')})`),
      { code: 'escalation', features: over });
  }
}

/**
 * May `actor` change `target` (edit, disable, delete, reassign)? Only if the
 * actor's tier is at least the target's and the actor's access covers the
 * target's current access: nobody manages someone more powerful than they are.
 */
export function assertCanManageUser(actor: ResolvedAccess, actorId: string, target: { id: string; role: string; perms: Perms }): void {
  if (target.id === actorId) throw forbidden('Use your own profile to change your account; you cannot change your own access');
  if (target.role === 'owner' && actor.role !== 'owner') throw forbidden('Only an owner can change an owner');
  if (rankOf(target.role) > rankOf(actor.role)) throw forbidden('You cannot change a user with a higher tier than yours');
  assertCovers(actor.perms, target.perms, 'manage this user, who has');
}

// ---- the model as data (/api/auth/me, the role editor) ---------------------------

export function accessDescription() {
  return {
    tiers: ['viewer', 'operator', 'admin', 'owner'],
    levels: LEVELS,
    features: CATALOGUE.map((f) => ({ key: f.key, label: f.label, area: f.area, operate: f.operateMeans ?? null })),
    notes: [
      'Owners and admins have full access. Operators and viewers get access from their roles.',
      'A user holds the highest level any of their roles grants. Viewer-tier users are capped at view.',
      'view: see. operate: run (start/stop, on air, publish). manage: create, edit, delete.',
      'You can only grant access you hold, and only change users whose access you cover.',
    ],
  };
}
