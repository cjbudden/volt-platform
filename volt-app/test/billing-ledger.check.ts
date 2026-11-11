// ============================================================================
//  BILLING: MODES, THE CHARGES LEDGER AND MONTHLY INVOICES (build queue B1;
//  services/invoicing, modules/billing.ts, migration 0169).
//
//  `VOLT_BILLING` off charges nothing; contract makes every account contract;
//  automated keeps each account's own handling. The ledger takes rows from the
//  plan fee, metered server time at the price list (effective dated, unpriced
//  types listed and not charged) and the System Admin's charges and credits;
//  it is append only. Closing a month makes one numbered invoice per account
//  with the right lines, tax and total, and closing it again changes nothing.
//  A contract invoice is marked paid by hand with a reference.
//    DATABASE_URL=... npx tsx test/billing-ledger.check.ts
// ============================================================================
import type { AddressInfo } from 'node:net';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++; }
};

const A = '00000000-0000-4000-8000-00000000b1a1';   // Pro, automated, 20% tax
const B = '00000000-0000-4000-8000-00000000b1b1';   // Starter bought through Stripe Checkout, contract
const C = '00000000-0000-4000-8000-00000000b1c1';   // made this month
const UA = '00000000-0000-4000-8000-00000000b1a2', UB = '00000000-0000-4000-8000-00000000b1b2', SYS = '00000000-0000-4000-8000-00000000b1f1';

(async () => {
  delete process.env.VOLT_BILLING; delete process.env.VOLT_BILLING_TAX_RATE;
  const I = await import('../src/services/invoicing');
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess, AUD_PLATFORM } = await import('../src/auth/jwt');

  // ---------------------------------------------------------------- months
  check('months are UTC calendar months', [I.monthOf(new Date('2026-01-31T23:59:59Z')), I.previousMonth('2026-01-01'), I.nextMonth('2026-12-01'), I.parseMonth('2026-10')], ['2026-01-01', '2025-12-01', '2027-01-01', '2026-10-01']);
  let bad = 0; for (const s of ['2026-13', '26-10', 'x']) { try { I.parseMonth(s); } catch { bad++; } }
  check('a malformed month is refused', bad, 3);

  const cur = I.monthOf(), prev = I.previousMonth(cur);
  const inPrev = (day: number, h = 0) => `${prev.slice(0, 8)}${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

  await query(`INSERT INTO accounts(id, name, plan_tier, created_at) VALUES ($1,'Billed Pro','pro', now() - interval '70 days'), ($2,'Billed Starter','starter', now() - interval '70 days'), ($3,'Brand new','pro', now())`, [A, B, C]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'bill-a@test.local','x','owner','active'), ($3,$4,'bill-b@test.local','x','owner','active')`, [UA, A, UB, B]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES ($1,$2,'bill-sys@test.local','x','owner','active','saas_admin')`, [SYS, C]);
  await query(`INSERT INTO saas_signups(email, plan_key, mode, status, account_id, stripe_subscription_id) VALUES ('bill-b@test.local','starter','paid','active',$1,'sub_test_b')`, [B]);
  // Server time last month: two hours on c6i.large, one on c6i.xlarge, half an hour of unknown type.
  for (const [type, d, s] of [['c6i.large', 3, 3600], ['c6i.large', 9, 3600], ['c6i.xlarge', 12, 3600], [null, 20, 1800]] as const) {
    await query(`INSERT INTO usage_accruals(account_id, instance_type, from_at, to_at, seconds) VALUES ($1,$2,$3::timestamptz,$3::timestamptz + make_interval(secs => $4),$4)`, [A, type, inPrev(d), s]);
  }
  await query(`INSERT INTO usage_accruals(account_id, instance_type, from_at, to_at, seconds) VALUES ($1,'c6i.large',now(),now() + interval '1 hour',3600)`, [A]);

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, who: { sub: string; acct: string; aud?: string } = { sub: UA, acct: A }) => {
    const tok = signAccess({ sub: who.sub, account_id: who.acct, role: 'owner' } as any, who.aud ? { aud: who.aud } as any : {});
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* csv */ }
    return { s: r.status, j, text, ct: r.headers.get('content-type') ?? '' };
  };
  const sys = { sub: SYS, acct: C, aud: AUD_PLATFORM };
  const ledgerCount = async () => Number((await one<any>(`SELECT count(*)::int AS n FROM billing_charges`))!.n);

  try {
    // ---------------------------------------------------------------- off
    const offView = await call('GET', '/api/billing');
    check('off (the default): the account sees mode off and no month', [offView.s, offView.j?.mode, offView.j?.currentMonth, offView.j?.invoices], [200, 'off', null, []]);
    check('off: closing a month is refused', (await call('POST', '/api/platform/billing/close', { month: prev.slice(0, 7) }, sys)).s, 409);
    check('off: a manual charge is refused', (await call('POST', '/api/platform/billing/charges', { accountId: A, amountUsd: 5, description: 'x' }, sys)).s, 409);
    check('off: closeMonth writes nothing', [(await I.closeMonth(prev)).off, await ledgerCount()], [true, 0]);

    // ---------------------------------------------------------------- access
    check('the platform billing routes need a platform session', (await call('GET', '/api/platform/billing')).s, 403);

    // ---------------------------------------------------------------- automated
    process.env.VOLT_BILLING = 'automated';
    let d = await I.draftFor(A, prev);
    check('no price list yet: server time is listed as unpriced and not charged',
      [d.lines.map((l: any) => l.source), d.unpriced.map((u) => [u.instanceType, u.quantity])], [['plan'], [['c6i.large', 2], ['c6i.xlarge', 1], [null, 0.5]]]);

    const addPrice = (b: any) => call('POST', '/api/platform/billing/prices', b, sys);
    const p1 = await addPrice({ unitKey: 'server_hour', name: 'Server time', unit: 'hour', unitUsd: 0.5, effectiveFrom: '2020-01-01T00:00:00Z' });
    await addPrice({ unitKey: 'server_hour', instanceType: 'c6i.xlarge', name: 'Server time', unit: 'hour', unitUsd: 0.9, effectiveFrom: '2020-01-01T00:00:00Z' });
    // A later price must not reach a month that started before it.
    await addPrice({ unitKey: 'server_hour', instanceType: 'c6i.large', name: 'Server time', unit: 'hour', unitUsd: 5, effectiveFrom: `${cur}T00:00:00Z` });
    check('a System Admin adds prices (201), a plain account owner may not', [p1.s, (await call('POST', '/api/platform/billing/prices', { unitKey: 'server_hour', name: 'x', unit: 'hour', unitUsd: 1 })).s], [201, 403]);

    check('handling and tax set per account by the System Admin',
      [(await call('PATCH', `/api/platform/billing/accounts/${A}`, { taxRate: 0.2 }, sys)).j?.taxRate, (await call('PATCH', `/api/platform/billing/accounts/${B}`, { handling: 'contract' }, sys)).j?.handling,
       (await call('PATCH', `/api/platform/billing/accounts/${B}`, { handling: 'monthly' }, sys)).s],
      [0.2, 'contract', 422]);

    const ch1 = await call('POST', '/api/platform/billing/charges', { accountId: A, amountUsd: 25, description: 'Setup help', reference: 'TKT-1', month: prev.slice(0, 7) }, sys);
    const cr1 = await call('POST', '/api/platform/billing/charges', { accountId: A, amountUsd: -10, description: 'Goodwill credit', month: prev.slice(0, 7) }, sys);
    await call('POST', '/api/platform/billing/charges', { accountId: B, amountUsd: 40, description: 'Extra storage, agreed by email', month: prev.slice(0, 7) }, sys);
    check('a manual charge and a credit land in the ledger', [ch1.s, ch1.j?.source, ch1.j?.amountUsd, cr1.j?.amountUsd], [201, 'manual', 25, -10]);

    d = await I.draftFor(A, prev);
    check('the draft before the close: plan, usage at the price in force at the month start, and the manual rows',
      d.lines.map((l: any) => [l.source, l.itemKey, l.quantity, l.amountUsd]),
      [['plan', 'plan:pro', 1, 490], ['usage', 'server_hour:c6i.large', 2, 1], ['usage', 'server_hour:c6i.xlarge', 1, 0.9], ['usage', 'server_hour:any', 0.5, 0.25], ['manual', 'charge', 1, 25], ['manual', 'credit', 1, -10]]);
    check('...with its totals (20% tax)', [d.subtotalUsd, d.taxRate, d.taxUsd, d.totalUsd, d.unpriced.length], [507.15, 0.2, 101.43, 608.58, 0]);
    const dB = await I.draftFor(B, prev);
    check('a plan bought through Stripe Checkout is not billed twice, and it says why', [dB.lines.map((l: any) => l.source), dB.notes.length], [['manual'], 1]);

    check('the open month cannot be closed yet', (await call('POST', '/api/platform/billing/close', { month: cur.slice(0, 7) }, sys)).s, 409);

    const close = await call('POST', '/api/platform/billing/close', { month: prev.slice(0, 7) }, sys);
    const byAcct = new Map((close.j?.issued ?? []).map((x: any) => [x.accountId, x]));
    check('closing last month issues one invoice each for the two accounts with charges (the new account is not in it)',
      [close.s, byAcct.size, byAcct.has(A), byAcct.has(B), byAcct.has(C)], [200, 2, true, true, false]);
    const invA: any = byAcct.get(A), invB: any = byAcct.get(B);
    check('invoice numbers carry the month and a sequence', [new RegExp(`^V${prev.slice(0, 4)}${prev.slice(5, 7)}-\\d{6}$`).test(invA.number), invA.number !== invB.number], [true, true]);

    const rows = await query<any>(`SELECT source, created_by, invoice_id FROM billing_charges WHERE account_id = $1 ORDER BY id`, [A]);
    check('ledger rows from each source, each tied to the invoice', [rows.map((r) => r.source).sort(), rows.every((r) => r.invoice_id === invA.invoiceId), [...new Set(rows.map((r) => r.created_by))].sort()],
      [['manual', 'manual', 'plan', 'usage', 'usage', 'usage'], true, ['system-admin', 'volt']]);
    const full = await call('GET', `/api/platform/billing/invoices/${invA.invoiceId}`, undefined, sys);
    check('the invoice: status, handling, lines and totals', [full.j?.status, full.j?.handling, full.j?.lines?.length, full.j?.subtotalUsd, full.j?.taxUsd, full.j?.totalUsd], ['issued', 'automated', 6, 507.15, 101.43, 608.58]);
    const fullB = await call('GET', `/api/platform/billing/invoices/${invB.invoiceId}`, undefined, sys);
    check('the contract account\'s invoice: contract, no tax, one line', [fullB.j?.handling, fullB.j?.totalUsd, fullB.j?.lines?.length], ['contract', 40, 1]);

    // ---------------------------------------------------------------- idempotent, append only
    const before = await ledgerCount();
    const again = await call('POST', '/api/platform/billing/close', { month: prev.slice(0, 7) }, sys);
    const again2 = await I.closeDue();
    check('closing the same month again issues nothing and adds no rows (route and the scheduler pass)',
      [again.j?.issued?.length, again.j?.existing, again2?.issued.length, await ledgerCount(), Number((await one<any>(`SELECT count(*)::int AS n FROM billing_invoices`))!.n)], [0, 2, 0, before, 2]);
    let refused = '';
    try { await query(`UPDATE billing_charges SET amount_usd = 1 WHERE account_id = $1`, [A]); } catch (e: any) { refused = String(e.message); }
    check('the ledger is append only: an edit is refused', /append only/.test(refused), true);
    check('a charge for a month already invoiced is refused (it goes on the open month)',
      (await call('POST', '/api/platform/billing/charges', { accountId: A, amountUsd: 5, description: 'late', month: prev.slice(0, 7) }, sys)).s, 409);
    const late = await call('POST', '/api/platform/billing/charges', { accountId: A, amountUsd: 5, description: 'late' }, sys);
    check('...and lands on the open month by default', [late.s, (await I.draftFor(A)).lines.some((l: any) => l.description === 'late')], [201, true]);

    // ---------------------------------------------------------------- paid by hand
    check('an automated invoice is not marked paid by hand', (await call('POST', `/api/platform/billing/invoices/${invA.invoiceId}/paid`, { reference: 'x' }, sys)).s, 409);
    const paid = await call('POST', `/api/platform/billing/invoices/${invB.invoiceId}/paid`, { reference: 'BACS 2026-12-03' }, sys);
    check('a contract invoice is marked paid with a reference', [paid.s, paid.j?.status, paid.j?.paidReference], [200, 'paid', 'BACS 2026-12-03']);
    check('...once', (await call('POST', `/api/platform/billing/invoices/${invB.invoiceId}/paid`, { reference: 'again' }, sys)).s, 409);
    check('every billing change is audited', Number((await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_type IN ('invoice','billing_charge','billing_price','account_billing')`))!.n) >= 9, true);

    // ---------------------------------------------------------------- the account's side
    const mine = await call('GET', '/api/billing');
    check('the account sees its handling, this month so far and its invoice',
      [mine.j?.mode, mine.j?.handling, mine.j?.currentMonth?.period, mine.j?.currentMonth?.lines?.[0]?.itemKey, mine.j?.invoices?.map((i: any) => i.number)],
      ['automated', 'automated', cur.slice(0, 7), 'plan:pro', [invA.number]]);
    check('...with this month\'s usage so far at this month\'s price', mine.j?.currentMonth?.lines?.find((l: any) => l.itemKey === 'server_hour:c6i.large')?.amountUsd, 5);
    const list = await call('GET', '/api/billing/invoices?status=issued');
    check('the invoice list (list standard)', [list.s, list.j?.length, list.j?.[0]?.number], [200, 1, invA.number]);
    const one1 = await call('GET', `/api/billing/invoices/${invA.invoiceId}`);
    check('an invoice with its lines and a CSV link', [one1.s, one1.j?.lines?.length, one1.j?._links?.csv?.href], [200, 6, `/api/billing/invoices/${invA.invoiceId}/csv`]);
    const csv = await call('GET', `/api/billing/invoices/${invA.invoiceId}/csv`);
    check('the CSV: one row per line, then subtotal, tax and total', [csv.s, csv.ct.startsWith('text/csv'), csv.text.trim().split('\r\n').length, csv.text.includes('Total (USD),,,,608.58'), csv.text.includes('Tax (20%)')], [200, true, 10, true, true]);
    check('another account cannot read it', [(await call('GET', `/api/billing/invoices/${invA.invoiceId}`, undefined, { sub: UB, acct: B })).s, (await call('GET', `/api/billing/invoices/${invA.invoiceId}/csv`, undefined, { sub: UB, acct: B })).s], [404, 404]);

    // ---------------------------------------------------------------- contract deployment
    process.env.VOLT_BILLING = 'contract';
    check('a contract deployment treats every account as contract', [(await call('GET', '/api/billing')).j?.handling, (await call('GET', '/api/platform/billing', undefined, sys)).j?.accounts?.find((a: any) => a.id === A)?.handling], ['contract', 'contract']);
  } catch (e) {
    console.log('FAIL unexpected error', e); fail++;
  } finally {
    srv.close(); await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
