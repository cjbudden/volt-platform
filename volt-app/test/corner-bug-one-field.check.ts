// ============================================================================
//  THE CORNER BUG'S ONE FIELD AND ITS PLACEMENT, against Postgres and the HTTP app:
//  a still, GIF or alpha video all go in one image field ('logo'), which may be left
//  empty (cleared); a setup moving to a version whose field "replaces" an older one
//  carries the old choice across; and a "snap" template's anchor puts its box in that
//  spot of the frame, by the same maths the burn-in and the player use.
//
//  Usage: DATABASE_URL=... npx tsx test/corner-bug-one-field.check.ts   (a migrated, disposable database)
// ============================================================================
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

// The setup editor's snap (volt-web/src/graphics/SetupEditor.tsx snapOffset), restated.
const ORIGIN: Record<string, [number, number]> = { top_left: [0, 0], top: [0.5, 0], top_right: [1, 0], left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5], bottom_left: [0, 1], bottom: [0.5, 1], bottom_right: [1, 1] };
function snapOffset(anchor: string, k: number, canvas: [number, number], bbox: [number, number, number, number]): [number, number] {
  const [cw, ch] = canvas, [bx, by, bw, bh] = bbox, [fx, fy] = ORIGIN[anchor];
  const mx = Math.max(0, Math.min(bx, cw - bx - bw)), my = Math.max(0, Math.min(by, ch - by - bh));
  const o = [fx * cw, fy * ch], c = [bx + fx * bw, by + fy * bh], T = [fx * cw + (1 - 2 * fx) * mx, fy * ch + (1 - 2 * fy) * my];
  return [Math.round(T[0] - o[0] - k * (c[0] - o[0])), Math.round(T[1] - o[1] - k * (c[1] - o[1]))];
}

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { ensureDefaultTemplates } = await import('../src/services/graphics/defaults');
  const { placedBox } = await import('../src/services/graphics/burnFeed');
  const { insertMediaRow } = await import('../src/services/mediaLibrary');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cb-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `cb-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const app: any = createServer(); const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch { /* */ }
    return { s: r.status, j };
  };
  const page = (m: any) => `<script type="application/json" id="volt-manifest">${JSON.stringify(m)}</script><img id="logo"><script>function update(d){} function play(){} function stop(){}</script>`;
  const media = (name: string) => insertMediaRow({ accountId: acct, kind: 'bug', path: `bugs/${name}`, folder: 'bugs', name, storeKey: `library/${acct}/bugs/${name}`,
    sizeBytes: 10, contentType: 'image/png', tags: [], userId: user, source: 'upload', facts: {} } as any);

  try {
    console.log('== the shipped Corner bug ==');
    await ensureDefaultTemplates();
    const cb = await one<any>(`SELECT v.manifest FROM gfx_template_versions v WHERE v.manifest->>'voltKey' = 'corner-bug' ORDER BY v.version DESC LIMIT 1`);
    const ids = (cb?.manifest?.fields ?? []).map((f: any) => f.id);
    ok(ids.includes('logo') && !ids.includes('motion') && !ids.includes('position') && !ids.includes('height'), 'one image field; no separate video, position or height', ids.join(','));
    ok(cb.manifest.snap === true && cb.manifest.fields.find((f: any) => f.id === 'logo').replaces?.[0] === 'motion', 'it snaps, and its logo field replaces "motion"');

    console.log('== a setup moving version keeps its video ==');
    const t = await api('POST', '/api/graphics/templates', { html: page({ name: 'Bug old', canvas: [1920, 1080], fields: [{ id: 'logo', type: 'image' }, { id: 'motion', type: 'image' }, { id: 'caption', type: 'text' }] }), kind: 'bug' });
    const v1 = (await api('POST', `/api/graphics/templates/${t.j.id}/draft/publish`)).j;
    await api('PUT', `/api/graphics/templates/${t.j.id}/draft`, { html: page({ name: 'Bug new', canvas: [1920, 1080], bbox: [1500, 58, 324, 120], snap: true,
      fields: [{ id: 'logo', type: 'image', replaces: ['motion'] }, { id: 'caption', type: 'text' }] }) });
    const v2 = (await api('POST', `/api/graphics/templates/${t.j.id}/draft/publish`)).j;
    ok(v1.version === 1 && v2.version === 2 && v2.manifest?.snap === true && v2.manifest.fields[0].replaces?.[0] === 'motion', 'v2 keeps snap and replaces through publishing', JSON.stringify(v2.manifest ?? v2).slice(0, 300));
    const still = await media(`still-${tag}.png`), vid = await media(`vid-${tag}.png`);
    let r = await api('POST', '/api/graphics/setups', { name: 'Old bug', versionId: v1.id, placement: { anchor: 'top_left', x: 0, y: 0, scale: 1, layer: 2 },
      fields: { logo: { source: 'image' }, motion: { source: 'image', imageId: vid.id }, caption: { source: 'text', value: 'Hi' } } });
    ok(r.s === 201, 'an image field left empty (cleared) is accepted', JSON.stringify(r.j).slice(0, 200));
    r = await api('PATCH', `/api/graphics/setups/${r.j.id}`, { versionId: v2.id });
    ok(r.s === 200 && r.j.fields.logo?.imageId === vid.id && !r.j.fields.motion, 'moving to v2 carries the video into the one field', JSON.stringify(r.j.fields));
    ok(r.j.carriedFields?.[0] === 'motion → logo' && !r.j.droppedFields?.includes('motion'), 'and says so instead of saying it was dropped', JSON.stringify([r.j.carriedFields, r.j.droppedFields]));
    ok(r.j.snap === true && r.j.bbox?.[0] === 1500, 'the setup knows its template snaps, with the box');
    const s2 = await api('POST', '/api/graphics/setups', { name: 'Still bug', versionId: v1.id, placement: { anchor: 'top_left', x: 0, y: 0, scale: 1, layer: 2 },
      fields: { logo: { source: 'image', imageId: still.id }, caption: { source: 'text', value: '' } } });
    r = await api('PATCH', `/api/graphics/setups/${s2.j.id}`, { versionId: v2.id });
    ok(r.j.fields.logo?.imageId === still.id && !(r.j.carriedFields ?? []).length, 'a still with no video stays as it was');

    console.log('== the anchor places the bug ==');
    const canvas: [number, number] = [1920, 1080], bbox: [number, number, number, number] = [1500, 58, 324, 120];
    for (const k of [0.5, 1, 1.5, 2]) {
      const at = (a: string) => { const [x, y] = snapOffset(a, k, canvas, bbox); return placedBox({ canvas, bbox, placement: { anchor: a, x, y, scale: k } }); };
      const tr = at('top_right'), bl = at('bottom_left'), br = at('bottom_right'), tl = at('top_left'), c = at('center');
      const near = (a: number, b: number) => Math.abs(a - b) <= 1;
      ok(near(tr[0] + tr[2], 1824) && near(tr[1], 58) && near(tl[0], 96) && near(tl[1], 58)
        && near(bl[0], 96) && near(bl[1] + bl[3], 1022) && near(br[0] + br[2], 1824) && near(br[1] + br[3], 1022)
        && near(c[0] + c[2] / 2, 960) && near(c[1] + c[3] / 2, 540) && near(tr[2], 324 * k),
        `at ${k * 100}% each corner keeps the 96 / 58 px margin and the centre is centred`, JSON.stringify({ tr, bl, c }));
    }
    ok(snapOffset('top_right', 1, canvas, bbox).every((n) => n === 0), 'top right at 100% needs no offset: where it is drawn');
  } catch (e) {
    fail++; console.log('FAIL threw', e);
  } finally {
    srv.close(); await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
