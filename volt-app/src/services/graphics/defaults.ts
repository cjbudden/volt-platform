// ============================================================================
//  VOLT DEFAULT GRAPHICS TEMPLATES, shipped with the product.
//
//  Read from assets/graphics/<key>/ at boot and kept in the library as
//  platform templates (account_id NULL): every account sees them read-only
//  and duplicates one to change it. Idempotent: a template whose files have
//  not changed is left alone; changed files become the next published version,
//  so setups pinned to the old version keep it until they are moved.
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
const SHIPPED: { key: string; kind: string }[] = [
  { key: 'news-package', kind: 'lower_third' },
  { key: 'lower-third', kind: 'lower_third' },
  { key: 'ticker', kind: 'ticker' },
  { key: 'clock-weather', kind: 'bug' },
  { key: 'locator', kind: 'bug' },
  { key: 'weather-panel', kind: 'full_frame' },
  { key: 'scorebug', kind: 'scorebug' },
  { key: 'corner-bug', kind: 'bug' },
  { key: 'countdown', kind: 'full_frame' },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

export async function ensureDefaultTemplates(root = join(__dirname, '../../../assets/graphics')): Promise<number> {
  if (!existsSync(root)) return 0;
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
        const latest = (await c.query(`SELECT manifest->>'digest' AS d FROM gfx_template_versions WHERE template_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`, [t.id])).rows[0];
        if (latest?.d === digest) return 0;
      } else {
        t = (await c.query(`INSERT INTO gfx_templates(account_id, name, kind, source) VALUES (NULL, $1, $2, 'volt') RETURNING *`, [a.manifest.name ?? s.key, s.kind])).rows[0];
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
