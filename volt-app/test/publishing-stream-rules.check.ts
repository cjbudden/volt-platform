// ============================================================================
//  A STREAM'S OWN PUBLISHING RULE, AND CONTENT TYPE NAMES (build queue 1.14-G3a-4).
//
//  Fixes found writing the media guides, pinned over real HTTP:
//    - a stream's Access tab (its owner rung of the publishing ladder) is
//      part of that stream: View on the stream's feature reads it and Manage
//      changes it, so an Event or Radio Manager sets the rule of what they
//      run; it needed Account settings: Manage. Account settings still works.
//    - the feature follows what the id is: a station is Radio, a FAST channel
//      FAST, a TV channel Channels, anything else an event; a manager of one
//      kind cannot change another kind's rule
//    - the account default and the content type rungs stay Account settings
//    - the two lookups beside the editor (publishing points, what a rung
//      inherits) are View for any role that can open a rule editor
//    - a content type name already taken is refused (409) with words a
//      customer understands (the console now counts copies up instead)
//    DATABASE_URL=... npx tsx test/publishing-stream-rules.check.ts
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`psr-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 50) RETURNING id`, [`psr-other-${tag}`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const tv = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'Volt TV') RETURNING id`, [grp]))!.id;
  const station = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'Volt FM','radio') RETURNING id`, [grp]))!.id;
  const ev = (await one<any>(`INSERT INTO events(group_id, name, scheduled_start, scheduled_end) VALUES ($1,'Cup Final', now() + interval '1 day', now() + interval '1 day 2 hours') RETURNING id`, [grp]))!.id;
  const oprof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [other]))!.id;
  const ogrp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [other, oprof]))!.id;
  const otherEv = (await one<any>(`INSERT INTO events(group_id, name, scheduled_start, scheduled_end) VALUES ($1,'Theirs', now(), now() + interval '1 hour') RETURNING id`, [ogrp]))!.id;
  const schema = (await one<any>(`INSERT INTO metadata_schemas(account_id, name, fields, target_kind) VALUES ($1,'Match','[]'::jsonb,'event') RETURNING id`, [acct]))!.id;

  const users: Record<string, { id: string; tier: string }> = {};
  const person = async (key: string, tier: string, perms: any | null) => {
    const id = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x',$3,'active') RETURNING id`,
      [acct, `psr-${key}-${tag}@volt.test`, tier]))!.id;
    if (perms) {
      const g = (await one<any>(`INSERT INTO user_groups(account_id, name, permissions) VALUES ($1,$2,$3::jsonb) RETURNING id`, [acct, `${key} ${tag}`, JSON.stringify(perms)]))!.id;
      await query(`INSERT INTO user_group_members(user_id, group_id) VALUES ($1,$2)`, [id, g]);
    }
    users[key] = { id, tier };
  };
  await person('eventManager', 'operator', { events: 'manage' });
  await person('eventView', 'operator', { events: 'view' });
  await person('radioManager', 'operator', { radio: 'manage' });
  await person('tvManager', 'operator', { channels: 'manage' });
  await person('settingsManage', 'operator', { settings: 'manage' });
  await person('analyst', 'operator', { analytics: 'view' });
  await person('admin', 'admin', null);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = (k: string) => signAccess({ sub: users[k].id, account_id: acct, role: users[k].tier });
  const call = async (method: string, path: string, k: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok(k)}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await res.json().catch(() => null) as any;
    return { s: res.status, j };
  };
  const msg = (r: { j: any }) => String(r.j?.error?.message ?? r.j?.error ?? r.j?.message ?? '');
  const rule = { settings: { access: 'entitled', geo: { mode: 'allow', countries: ['GB'] } } };

  try {
    console.log('== a stream\'s own rule ==');
    const evPut = await call('PUT', `/api/publishing-rules/owner/${ev}`, 'eventManager', rule);
    check('an Event Manager sets their event\'s rule (200; 403 before)', evPut.s, 200);
    check('...and it is stored on the event\'s rung', (await one<any>(`SELECT settings->>'access' AS a FROM publishing_rules WHERE scope_kind='owner' AND scope_id=$1`, [ev]))?.a, 'entitled');
    check('...they read it back (200)', (await call('GET', `/api/publishing-rules/owner/${ev}`, 'eventManager')).j?.settings?.access, 'entitled');
    check('an Events viewer reads it (200)', (await call('GET', `/api/publishing-rules/owner/${ev}`, 'eventView')).s, 200);
    const viewPut = await call('PUT', `/api/publishing-rules/owner/${ev}`, 'eventView', rule);
    check('...but cannot change it (403, names Events)', [viewPut.s, /Events/.test(msg(viewPut))], [403, true]);
    check('...nor remove it (403)', (await call('DELETE', `/api/publishing-rules/owner/${ev}`, 'eventView')).s, 403);
    check('an Event Manager removes it (204)', (await call('DELETE', `/api/publishing-rules/owner/${ev}`, 'eventManager')).s, 204);

    check('a Radio Manager sets their station\'s rule (200)', (await call('PUT', `/api/publishing-rules/owner/${station}`, 'radioManager', rule)).s, 200);
    check('...not a TV channel\'s (403)', (await call('PUT', `/api/publishing-rules/owner/${tv}`, 'radioManager', rule)).s, 403);
    check('...nor an event\'s (403)', (await call('PUT', `/api/publishing-rules/owner/${ev}`, 'radioManager', rule)).s, 403);
    check('a TV channels manager sets a TV channel\'s rule (200)', (await call('PUT', `/api/publishing-rules/owner/${tv}`, 'tvManager', rule)).s, 200);
    check('...not a station\'s (403)', (await call('PUT', `/api/publishing-rules/owner/${station}`, 'tvManager', rule)).s, 403);
    check('an Event Manager cannot set a TV channel\'s rule (403)', (await call('PUT', `/api/publishing-rules/owner/${tv}`, 'eventManager', rule)).s, 403);
    check('Account settings: Manage still sets any stream\'s rule (200, 200, 200)',
      [(await call('PUT', `/api/publishing-rules/owner/${ev}`, 'settingsManage', rule)).s,
       (await call('PUT', `/api/publishing-rules/owner/${station}`, 'settingsManage', rule)).s,
       (await call('PUT', `/api/publishing-rules/owner/${tv}`, 'settingsManage', rule)).s], [200, 200, 200]);
    check('an id that is not one of the account\'s streams is not found (404)',
      (await call('PUT', `/api/publishing-rules/owner/00000000-0000-4000-8000-0000000000ab`, 'eventManager', rule)).s, 404);
    check('another account\'s event is not found (404)', (await call('PUT', `/api/publishing-rules/owner/${otherEv}`, 'eventManager', rule)).s, 404);
    check('a role with no stream access cannot read a stream\'s rule (403)', (await call('GET', `/api/publishing-rules/owner/${ev}`, 'analyst')).s, 403);

    console.log('== the other rungs stay Account settings ==');
    check('an Event Manager cannot change the account default (403)', (await call('PUT', `/api/publishing-rules/account`, 'eventManager', rule)).s, 403);
    check('...nor a content type\'s rule (403)', (await call('PUT', `/api/publishing-rules/schema/${schema}`, 'eventManager', rule)).s, 403);
    check('...nor list every rung (403)', (await call('GET', `/api/publishing-rules`, 'eventManager')).s, 403);
    check('Account settings: Manage sets a type\'s rule (200)', (await call('PUT', `/api/publishing-rules/schema/${schema}`, 'settingsManage', rule)).s, 200);

    console.log('== the editor\'s lookups ==');
    const pts = await call('GET', `/api/publishing-rules/points`, 'eventManager');
    check('an Event Manager reads the publishing points (200)', [pts.s, Array.isArray(pts.j?.apps), Array.isArray(pts.j?.social)], [200, true, true]);
    const res = await call('GET', `/api/publishing-rules/resolve?eventId=${ev}&schemaId=${schema}`, 'eventManager');
    check('...and what the event\'s rung inherits (200)', [res.s, typeof res.j?.settings], [200, 'object']);
    check('a Radio Manager reads them too (200, 200)',
      [(await call('GET', `/api/publishing-rules/points`, 'radioManager')).s, (await call('GET', `/api/publishing-rules/resolve?channelId=${station}`, 'radioManager')).s], [200, 200]);
    check('a role with no stream, library or settings access does not (403, 403)',
      [(await call('GET', `/api/publishing-rules/points`, 'analyst')).s, (await call('GET', `/api/publishing-rules/resolve`, 'analyst')).s], [403, 403]);

    console.log('== content type names ==');
    const first = await call('POST', '/api/metadata-schemas', 'admin', { name: `Match (copy)`, targetKind: 'event', appliesTo: ['event'], fields: [], extendsId: schema });
    check('a copy of a type (201)', first.s, 201);
    const dup = await call('POST', '/api/metadata-schemas', 'admin', { name: `Match (copy)`, targetKind: 'event', appliesTo: ['event'], fields: [], extendsId: schema });
    check('the same name again is refused in plain words (409, names a content type)', [dup.s, /A content type named "Match \(copy\)" already exists/.test(msg(dup))], [409, true]);
    check('the name the console now picks next is free (201)',
      (await call('POST', '/api/metadata-schemas', 'admin', { name: `Match (copy 2)`, targetKind: 'event', appliesTo: ['event'], fields: [], extendsId: schema })).s, 201);
  } catch (e) {
    console.log('FAIL unexpected error', e); fail++;
  } finally {
    srv.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
