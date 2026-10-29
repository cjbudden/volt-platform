// ============================================================================
//  VOLT DEFAULT GRAPHICS TEMPLATES, shipped with the product.
//
//  Read from assets/graphics/<key>/ at boot and kept in the library as
//  platform templates (account_id NULL) in a SET (News, General, Sport scores).
//  An account sees a set's templates read-only when the set is on for it
//  (services/graphics/sets.ts; System Admin > Graphics library) and duplicates
//  one to change it. Idempotent: a template whose files have not changed is left
//  alone; changed files become the next published version, so setups pinned to
//  the old version keep it until they are moved.
//
//  A SaaS admin can also publish versions of these templates, move them between
//  sets or retire them (modules/platformGraphics.ts). Boot never undoes that: it
//  compares against the last version Volt shipped, sets a template's set only
//  when it has none, and never touches retired_at or a set's name or default.
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { tx } from '../../db';
import { analyse } from './templatePackage';

// The news family follows the broadcast L-bar: a strap (tag + headline), a flipping
// ticker under it, and a channel block with rotating clocks and city weather at its
// right end; plus a locator, a name super and a weather panel. Original designs with
// open fonts in each package (docs/GRAPHICS_TEMPLATE_STANDARD.md).
export const SHIPPED_SETS: { key: string; name: string; description: string; sort: number }[] = [
  { key: 'news', name: 'News', description: 'The broadcast L-bar: strap, tickers, clocks and weather, locator, name super, breaking banner.', sort: 10 },
  { key: 'general', name: 'General', description: 'Any programme: social badge, up next, quote card, title card, QR callout, corner bug, countdown.', sort: 20 },
  { key: 'sport', name: 'Sport scores', description: 'Score overlays: field sports, tennis, badminton, table tennis, squash, pickleball, volleyball.', sort: 30 },
];

const SHIPPED: { key: string; kind: string; set: string }[] = [
  { key: 'news-package', kind: 'lower_third', set: 'news' },
  { key: 'lower-third', kind: 'lower_third', set: 'news' },
  { key: 'ticker', kind: 'ticker', set: 'news' },
  { key: 'clock-weather', kind: 'bug', set: 'news' },
  { key: 'locator', kind: 'bug', set: 'news' },
  { key: 'weather-panel', kind: 'full_frame', set: 'news' },
  { key: 'scorebug', kind: 'scorebug', set: 'sport' },
  { key: 'corner-bug', kind: 'bug', set: 'general' },
  { key: 'countdown', kind: 'full_frame', set: 'general' },
  // Second set (25 Oct 2026): basics with full in and out sequences. A crawl ticker and a social badge
  // (follow us: label, platform icons, handle), then breaking banner, name super with accent line, up
  // next, quote card, title card and QR callout. Social glyphs are Simple Icons (CC0); the QR callout
  // bundles qrcode-generator (MIT) in lib/.
  { key: 'crawl-ticker', kind: 'ticker', set: 'news' },
  { key: 'social-badge', kind: 'bug', set: 'general' },
  { key: 'breaking-banner', kind: 'lower_third', set: 'news' },
  { key: 'name-super-line', kind: 'lower_third', set: 'news' },
  { key: 'up-next', kind: 'bug', set: 'general' },
  { key: 'quote-card', kind: 'full_frame', set: 'general' },
  { key: 'title-card', kind: 'full_frame', set: 'general' },
  { key: 'qr-callout', kind: 'bug', set: 'general' },
  // Racket and net sports (25 Oct 2026): one score bug per sport, each scored its own way (tennis
  // points 15/30/40/AD and tie-breaks, rally scoring to 21, 11 or 25, pickleball's server number).
  { key: 'tennis-score', kind: 'scorebug', set: 'sport' },
  { key: 'badminton-score', kind: 'scorebug', set: 'sport' },
  { key: 'table-tennis-score', kind: 'scorebug', set: 'sport' },
  { key: 'squash-score', kind: 'scorebug', set: 'sport' },
  { key: 'pickleball-score', kind: 'scorebug', set: 'sport' },
  { key: 'volleyball-score', kind: 'scorebug', set: 'sport' },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

/** The shipped sets exist (made on first boot; a SaaS admin's renames and defaults are kept). */
async function ensureSets(): Promise<Map<string, string>> {
  return tx(async (c) => {
    const ids = new Map<string, string>();
    for (const s of SHIPPED_SETS) {
      const r = (await c.query(`INSERT INTO gfx_template_sets(key, name, description, sort, shipped) VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (key) DO UPDATE SET shipped = true RETURNING id`, [s.key, s.name, s.description, s.sort])).rows[0];
      ids.set(s.key, r.id);
    }
    return ids;
  });
}

export async function ensureDefaultTemplates(root = join(__dirname, '../../../assets/graphics')): Promise<number> {
  if (!existsSync(root)) return 0;
  const sets = await ensureSets();
  let changed = 0;
  for (const s of SHIPPED) {
    const dir = join(root, s.key);
    if (!existsSync(dir)) continue;
    const raw = walk(dir).map((p) => ({ path: relative(dir, p).split('\\').join('/'), data: readFileSync(p) }));
    const a = analyse(raw);
    const digest = createHash('sha256').update(a.files.map((f) => f.path + ':' + f.sha256).sort().join('\n')).digest('hex');
    changed += await tx(async (c) => {
      // One row per shipped key, found by its stable source_ref in the manifest.
      let t = (await c.query(`SELECT t.* FROM gfx_templates t WHERE t.account_id IS NULL AND t.source = 'volt'
                                AND EXISTS (SELECT 1 FROM gfx_template_versions v WHERE v.template_id = t.id AND v.manifest->>'voltKey' = $1)`, [s.key])).rows[0];
      if (t) {
        if (!t.set_id) await c.query(`UPDATE gfx_templates SET set_id = $2 WHERE id = $1`, [t.id, sets.get(s.set) ?? null]);
        // The last version VOLT shipped (it carries the digest); a SaaS admin's own versions do not count.
        const latest = (await c.query(`SELECT manifest->>'digest' AS d FROM gfx_template_versions WHERE template_id = $1 AND status = 'published'
                                         AND manifest ? 'digest' ORDER BY version DESC LIMIT 1`, [t.id])).rows[0];
        if (latest?.d === digest) return 0;
      } else {
        t = (await c.query(`INSERT INTO gfx_templates(account_id, name, kind, source, set_id) VALUES (NULL, $1, $2, 'volt', $3) RETURNING *`,
          [a.manifest.name ?? s.key, s.kind, sets.get(s.set) ?? null])).rows[0];
      }
      const n = (await c.query(`SELECT COALESCE(max(version), 0) + 1 AS n FROM gfx_template_versions WHERE template_id = $1`, [t.id])).rows[0].n;
      const manifest = { ...a.manifest, voltKey: s.key, digest };
      const v = (await c.query(`INSERT INTO gfx_template_versions(template_id, status, version, manifest, checks, size_bytes, file_count, published_at, note)
         VALUES ($1,'draft',NULL,$2::jsonb,$3::jsonb,$4,$5,NULL,'Shipped with Volt') RETURNING id`,
        [t.id, JSON.stringify(manifest), JSON.stringify(a.checks), a.sizeBytes, a.files.length])).rows[0];
      for (const f of a.files) {
        await c.query(`INSERT INTO gfx_files(version_id, path, content_type, sha256, size_bytes, content) VALUES ($1,$2,$3,$4,$5,$6)`, [v.id, f.path, f.contentType, f.sha256, f.data.length, f.data]);
      }
      await c.query(`UPDATE gfx_template_versions SET status = 'published', version = $2, published_at = now() WHERE id = $1`, [v.id, n]);
      await c.query(`UPDATE gfx_templates SET name = $2, kind = $3, updated_at = now() WHERE id = $1`, [t.id, a.manifest.name ?? t.name, s.kind]);
      return 1;
    });
  }
  return changed;
}
