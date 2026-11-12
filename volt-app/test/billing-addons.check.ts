// ============================================================================
//  BILLING: ADD-ONS AND PACKS AS BILLABLE ITEMS (build queue B2;
//  services/invoicing/addons.ts, modules/billing.ts, migration 0171).
//
//  The System Admin keeps the catalogue (add-ons with an included quantity,
//  packs that add to it). An account administrator turns an add-on on, moves
//  it between packs, and turns it off. Christian's rules: the full monthly
//  price for the current month on turning on or moving to a bigger pack, a
//  reduce or an off at once with no refund, the allowance reset on the 1st
//  with no carry over. Every change is audited and lands in the B1 ledger, so
//  it is on the invoice. The allowance is enforced, and read without a
//  database query when warm.
//    DATABASE_URL=... npx tsx test/billing-addons.check.ts
// ============================================================================
import type { AddressInfo } from 'node:net';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++; }
};

const A = '00000000-0000-4000-8000-00000000b2a1';   // turns things on and off
const B = '00000000-0000-4000-8000-00000000b2b1';   // already licensed by the System Admin
const D = '00000000-0000-4000-8000-00000000b2d1';   // has had the add-on since two months ago
const UA = '00000000-0000-4000-8000-00000000b2a2', UB = '00000000-0000-4000-8000-00000000b2b2', UD = '00000000-0000-4000-8000-00000000b2d2';
const OPA = '00000000-0000-4000-8000-00000000b2a3', SYS = '00000000-0000-4000-8000-00000000b2f1';

(async () => {
  delete process.env.VOLT_BILLING; delete process.env.VOLT_BILLING_TAX_RATE;
  const I = await import('../src/services/invoicing');
  const X = await import('../src/services/invoicing/addons');
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess, AUD_PLATFORM } = await import('../src/auth/jwt');

  const cur = I.monthOf(), prev = I.previousMonth(cur), prev2 = I.previousMonth(prev);
  await query(`INSERT INTO accounts(id, name, plan_tier, created_at) VALUES ($1,'Addon A','pro', now() - interval '90 days'), ($2,'Addon B','pro', now() - interval '90 days'), ($3,'Addon D','pro', now() - interval '90 days')`, [A, B, D]);
  await query(`UPDATE accounts SET subscription_fee_month = 0 WHERE id = ANY($1::uuid[])`, [[A, B, D]]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'b2-a@test.local','x','owner','active'), ($3,$4,'b2-b@test.local','x','owner','active'), ($5,$6,'b2-d@test.local','x','owner','active'), ($7,$2,'b2-op@test.local','x','operator','active')`, [UA, A, UB, B, UD, D, OPA]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES ($1,$2,'b2-sys@test.local','x','owner','active','saas_admin')`, [SYS, D]);
  await query(`UPDATE accounts SET licences = ARRAY['mirror_archive'] WHERE id = $1`, [B]);

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, who: { sub: string; acct: string; aud?: string; role?: string } = { sub: UA, acct: A }) => {
    const tok = signAccess({ sub: who.sub, account_id: who.acct, role: who.role ?? 'owner' } as any, who.aud ? { aud: who.aud } as any : {});
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { s: r.status, j, text };
  };
  const sys = { sub: SYS, acct: D, aud: AUD_PLATFORM };
  const asB = { sub: UB, acct: B }, asD = { sub: UD, acct: D };
  const rows = async (acct: string, month = cur) => (await query<any>(
    `SELECT source, item_key, amount_usd FROM billing_charges WHERE account_id = $1 AND period_month = $2 AND source IN ('addon','addon_pack') ORDER BY id`, [acct, month]))
    .map((r) => [r.item_key, Number(r.amount_usd)]);
  const licences = async (acct: string) => (await one<any>(`SELECT licences FROM accounts WHERE id = $1`, [acct]))!.licences ?? [];
  const mine = async (who = { sub: UA, acct: A }) => (await call('GET', '/api/billing/addons', undefined, who)).j?.addons?.find((a: any) => a.key === 'archive_storage');

  try {
    // ---------------------------------------------------------------- the catalogue
    const add = await call('POST', '/api/platform/billing/addons', { key: 'archive_storage', name: 'Archive storage', description: 'Copies of your media kept in your own store', monthlyUsd: 50, includedQuantity: 100, unit: 'GB', licence: 'mirror_archive' }, sys);
    check('the System Admin adds an add-on to the catalogue', [add.s, add.j?.key, add.j?.includedQuantity, add.j?.licence], [201, 'archive_storage', 100, 'mirror_archive']);
    for (const p of [{ key: 'small', name: 'Small pack', extraQuantity: 100, monthlyUsd: 20 }, { key: 'large', name: 'Large pack', extraQuantity: 500, monthlyUsd: 60 }]) await call('POST', '/api/platform/billing/addons/archive_storage/packs', p, sys);
    const cat = await call('GET', '/api/platform/billing/addons', undefined, sys);
    // The catalogue also ships with AI Find details (migration 0172, build queue F4), so look this one up by key.
    check('...with its packs, smallest first', cat.j?.find((a: any) => a.key === 'archive_storage')?.packs?.map((p: any) => [p.key, p.extraQuantity, p.monthlyUsd]), [['small', 100, 20], ['large', 500, 60]]);
    check('refused: a duplicate key, an unknown licence, a plain account owner',
      [(await call('POST', '/api/platform/billing/addons', { key: 'archive_storage', name: 'x', monthlyUsd: 1, unit: 'GB' }, sys)).s,
       (await call('POST', '/api/platform/billing/addons', { key: 'other', name: 'x', monthlyUsd: 1, unit: 'GB', licence: 'everything' }, sys)).s,
       (await call('POST', '/api/platform/billing/addons', { key: 'mine', name: 'x', monthlyUsd: 1, unit: 'GB' })).s],
      [409, 422, 403]);
    await call('POST', '/api/platform/billing/addons', { key: 'old_thing', name: 'Old thing', monthlyUsd: 5, unit: 'items', active: false }, sys);

    // ---------------------------------------------------------------- off
    const offView = await call('GET', '/api/billing/addons');
    check('off (the default): the account sees the catalogue but cannot turn anything on', [offView.s, offView.j?.mode, offView.j?.addons?.length, (await call('PUT', '/api/billing/addons/archive_storage', {})).s], [200, 'off', 1, 409]);

    process.env.VOLT_BILLING = 'automated';

    // ---------------------------------------------------------------- permissions
    check('an operator (no Account settings: Manage) cannot turn an add-on on', (await call('PUT', '/api/billing/addons/archive_storage', {}, { sub: OPA, acct: A, role: 'operator' })).s, 403);
    check('an add-on no longer offered cannot be turned on', (await call('PUT', '/api/billing/addons/old_thing', {})).s, 409);
    check('an unknown add-on or pack is 404', [(await call('PUT', '/api/billing/addons/nope', {})).s, (await call('PUT', '/api/billing/addons/archive_storage', { pack: 'huge' })).s], [404, 404]);

    // ---------------------------------------------------------------- on
    const on = await call('PUT', '/api/billing/addons/archive_storage', {});
    check('turning on charges the full monthly price for this month', [on.s, on.j?.change, on.j?.charged, await rows(A)], [200, 'on', [{ itemKey: 'addon:archive_storage', amountUsd: 50 }], [['addon:archive_storage', 50]]]);
    check('...grants its licence', await licences(A), ['mirror_archive']);
    check('...and the allowance is the included quantity', [on.j?.addon?.on, on.j?.addon?.allowance?.included, on.j?.addon?.allowance?.used, on.j?.addon?.allowance?.left], [true, 100, 0, 100]);

    // ---------------------------------------------------------------- packs
    const up1 = await call('PUT', '/api/billing/addons/archive_storage', { pack: 'small' });
    const up2 = await call('PUT', '/api/billing/addons/archive_storage', { pack: 'large' });
    check('moving to a bigger pack charges that pack\'s full monthly price', [up1.j?.change, up1.j?.charged?.[0]?.amountUsd, up2.j?.change, up2.j?.charged?.[0]?.amountUsd], ['upgrade', 20, 'upgrade', 60]);
    check('...allowance included plus the pack', (await mine())?.allowance?.included, 600);
    const used = await X.useAllowance(A, 'archive_storage', 450);
    check('usage counts against the allowance', [used.used, used.left], [450, 150]);
    const down = await call('PUT', '/api/billing/addons/archive_storage', { pack: 'small' });
    const after = await mine();
    check('reducing takes effect at once and charges nothing (no refund either)',
      [down.j?.change, down.j?.charged, after?.pack, after?.allowance?.included, after?.allowance?.left, await rows(A)],
      ['reduce', [], 'small', 200, 0, [['addon:archive_storage', 50], ['addon_pack:archive_storage:small', 20], ['addon_pack:archive_storage:large', 60]]]);
    let err: any = null; try { await X.useAllowance(A, 'archive_storage', 1); } catch (e) { err = e; }
    check('over the allowance: refused with a code, nothing counted', [err?.status, err?.code, (await one<any>(`SELECT used FROM addon_usage WHERE account_id = $1`, [A]))?.used], [409, 'allowance_exceeded', '450.0000']);
    const back = await call('PUT', '/api/billing/addons/archive_storage', { pack: 'large' });
    check('back up to a pack already paid this month: no second charge', [back.j?.change, back.j?.charged, (await rows(A)).length], ['upgrade', [], 3]);

    // ---------------------------------------------------------------- the warm path
    await X.allowanceLeft(A, 'archive_storage');
    let n = 0;
    const origQuery = pool.query.bind(pool), origConnect = pool.connect.bind(pool);
    (pool as any).query = (...a: any[]) => { n++; return (origQuery as any)(...a); };
    (pool as any).connect = (...a: any[]) => { n++; return (origConnect as any)(...a); };
    const left = await X.allowanceLeft(A, 'archive_storage');
    (pool as any).query = origQuery; (pool as any).connect = origConnect;
    check('a warm allowance read makes no database query', [left, n], [150, 0]);

    // ---------------------------------------------------------------- off
    const before = await rows(A);
    const offA = await call('DELETE', '/api/billing/addons/archive_storage');
    check('turning off: at once, no refund row, the licence it gave is taken away',
      [offA.s, offA.j?.change, await rows(A), await licences(A), (await mine())?.on, await X.allowanceLeft(A, 'archive_storage')],
      [200, 'off', before, [], false, null]);
    err = null; try { await X.useAllowance(A, 'archive_storage', 1); } catch (e) { err = e; }
    check('...and usage is refused without it', [err?.status, err?.code], [403, 'addon_required']);
    const again = await call('PUT', '/api/billing/addons/archive_storage', {});
    check('on again in the same month: this month is already paid', [again.j?.change, again.j?.charged, (await rows(A)).length], ['on', [], 3]);
    check('turning off what is not on is 404', (await call('DELETE', '/api/billing/addons/archive_storage', undefined, asD)).s, 404);

    // ---------------------------------------------------------------- a licence the System Admin gave
    await call('PUT', '/api/billing/addons/archive_storage', {}, asB);
    await call('DELETE', '/api/billing/addons/archive_storage', undefined, asB);
    check('a licence the System Admin had granted stays when the add-on is turned off', await licences(B), ['mirror_archive']);

    // ---------------------------------------------------------------- the 1st: renewal, reset, no carry over
    await query(`INSERT INTO account_addons(account_id, addon_key, pack_key, started_at) VALUES ($1,'archive_storage','small', $2::date + interval '10 days')`, [D, prev2]);
    await query(`INSERT INTO addon_usage(account_id, addon_key, period_month, used) VALUES ($1,'archive_storage',$2,30)`, [D, prev]);
    check('renewal for last month (the pass on its 1st): the add-on and its pack, once', [await X.renewAddons(prev), await X.renewAddons(prev), await rows(D, prev)],
      [2, 0, [['addon:archive_storage', 50], ['addon_pack:archive_storage:small', 20]]]);
    const dView = (await call('GET', '/api/billing/addons', undefined, asD)).j?.addons?.[0];
    check('a new month starts at zero: last month\'s unused 170 does not carry over', [dView?.allowance?.used, dView?.allowance?.included, dView?.allowance?.left], [0, 200, 200]);
    // A change made before this month's pass ran still charges this month for what was held first.
    const dDown = await call('PUT', '/api/billing/addons/archive_storage', { pack: null }, asD);
    check('a reduce on the 1st, before the pass: this month is charged for what was held, the reduce adds nothing',
      [dDown.j?.change, await rows(D)], ['reduce', [['addon:archive_storage', 50], ['addon_pack:archive_storage:small', 20]]]);
    check('the scheduler pass writes nothing more for it', [await X.renewAddons(cur), (await rows(D)).length], [0, 2]);

    // ---------------------------------------------------------------- the catalogue changes later
    const pat = await call('PATCH', '/api/platform/billing/addons/archive_storage', { monthlyUsd: 75, includedQuantity: 150 }, sys);
    check('a price change leaves charges already made alone', [pat.s, pat.j?.monthlyUsd, (await rows(A))[0]], [200, 75, ['addon:archive_storage', 50]]);
    check('...an included quantity change reaches the allowance at once', (await call('GET', '/api/billing/addons', undefined, asD)).j?.addons?.[0]?.allowance?.included, 150);
    const packOff = await call('PATCH', '/api/platform/billing/addons/archive_storage/packs/large', { active: false }, sys);
    check('a pack set inactive is not offered, but whoever has it keeps it', [packOff.s, (await mine(asD))?.packs?.map((p: any) => p.key), (await mine())?.packs?.map((p: any) => p.key)], [200, ['small'], ['small']]);

    // ---------------------------------------------------------------- the invoice
    const close = await call('POST', '/api/platform/billing/close', { month: prev.slice(0, 7), accountId: D }, sys);
    const inv = await call('GET', `/api/platform/billing/invoices/${close.j?.issued?.[0]?.invoiceId}`, undefined, sys);
    check('closing last month puts the add-on and its pack on the invoice',
      [close.s, inv.j?.lines?.filter((l: any) => l.source.startsWith('addon')).map((l: any) => [l.description, l.amountUsd])],
      [200, [[`Archive storage, ${prev.slice(0, 7)}`, 50], [`Archive storage: Small pack (+100 GB), ${prev.slice(0, 7)}`, 20]]]);
    const csv = await call('GET', `/api/platform/billing/invoices/${close.j?.issued?.[0]?.invoiceId}/csv`, undefined, sys);
    check('...and in its CSV', csv.text.includes('Archive storage: Small pack (+100 GB)'), true);
    check('the month it was turned on in is not renewed (that is the turn-on charge)', [await X.renewAddons(prev2), (await rows(D, prev2)).length], [0, 0]);

    // ---------------------------------------------------------------- the System Admin for an account, and the audit
    const sa = await call('PUT', `/api/platform/billing/accounts/${B}/addons/archive_storage`, { pack: 'small' }, sys);
    check('the System Admin can set an account\'s add-on', [sa.s, sa.j?.change, (await call('GET', `/api/platform/billing/accounts/${B}/addons`, undefined, sys)).j?.find((a: any) => a.key === 'archive_storage')?.pack], [200, 'on', 'small']);
    const audit = await query<any>(`SELECT detail->'snapshot'->>'change' AS c, detail->>'actor' AS by FROM audit_log WHERE entity_type = 'account_addon' AND account_id = $1 ORDER BY created_at`, [A]);
    check('every change on the account is audited, by whom', audit.map((r) => [r.c, r.by]),
      [['on', 'account-admin'], ['upgrade', 'account-admin'], ['upgrade', 'account-admin'], ['reduce', 'account-admin'], ['upgrade', 'account-admin'], ['off', 'account-admin'], ['on', 'account-admin']]);
    check('catalogue changes are audited too', Number((await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'billing_addon'`))!.n) >= 6, true);
    check('the ledger stays append only', await query(`UPDATE billing_charges SET amount_usd = 0 WHERE account_id = $1`, [A]).then(() => 'edited', () => 'refused'), 'refused');
  } catch (e) {
    console.log('FAIL unexpected error', e); fail++;
  } finally {
    srv.close(); await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
