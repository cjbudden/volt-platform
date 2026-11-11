// ============================================================================
//  AUTOMATED INVOICES THROUGH STRIPE, AND THE PDF (build queue B1-2;
//  services/invoicing/stripe.ts and pdf.ts, modules/billing.ts, the Stripe
//  webhook in modules/signup.ts, migration 0170).
//
//  Against a fake Stripe (STRIPE_API_BASE): an automated account's invoice is
//  sent once its month closes (customer, one item per line, tax as a line,
//  finalised); a send that dies half way is tried again with the same
//  idempotency keys, so Stripe ends up with one invoice and the right total;
//  contract invoices never go to Stripe; invoice.paid and
//  invoice.payment_failed come back signed and set the status, the owners are
//  told once; a bad signature is refused. The PDF opens and carries the totals.
//    DATABASE_URL=... npx tsx test/billing-stripe.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++; }
};

const A = '00000000-0000-4000-8000-00000000b2a1';   // Pro, automated, 10% tax, no Stripe customer yet
const B = '00000000-0000-4000-8000-00000000b2b1';   // contract
const C = '00000000-0000-4000-8000-00000000b2c1';   // Starter through Checkout: has a Stripe customer
const UA = '00000000-0000-4000-8000-00000000b2a2', UB = '00000000-0000-4000-8000-00000000b2b2', SYS = '00000000-0000-4000-8000-00000000b2f1';

// ---------------------------------------------------------------- a fake Stripe
type Req = { path: string; body: Record<string, string>; idem: string | null };
const seen: Req[] = [];
const byKey = new Map<string, any>();
const invoices = new Map<string, { items: number[]; meta: Record<string, string> }>();
let n = 0, failItemCall: number | null = null, itemCalls = 0;
const fake = httpServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(raw));
    const idem = (req.headers['idempotency-key'] as string) ?? null;
    const path = req.url ?? '';
    seen.push({ path, body, idem });
    const send = (code: number, j: any) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (path === '/v1/invoiceitems' && ++itemCalls === failItemCall) return send(500, { error: { message: 'simulated outage' } });
    if (idem && byKey.has(idem)) return send(200, byKey.get(idem));       // Stripe's idempotency: same key, same answer
    let out: any;
    if (path === '/v1/customers') out = { id: `cus_${++n}` };
    else if (path === '/v1/invoices') { out = { id: `in_${++n}` }; invoices.set(out.id, { items: [], meta: Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith('metadata['))) }); }
    else if (path === '/v1/invoiceitems') { out = { id: `ii_${++n}` }; invoices.get(body.invoice)?.items.push(Number(body.amount)); }
    else if (/^\/v1\/invoices\/[^/]+\/finalize$/.test(path)) {
      const id = path.split('/')[3]; const inv = invoices.get(id);
      out = { id, status: 'open', number: `FAKE-${id}`, total: (inv?.items ?? []).reduce((a, b) => a + b, 0) };
    } else return send(404, { error: { message: 'unknown path' } });
    if (idem) byKey.set(idem, out);
    send(200, out);
  });
});

(async () => {
  await new Promise<void>((r) => fake.listen(0, r));
  Object.assign(process.env, {
    VOLT_BILLING: 'automated', SAAS_STRIPE_SECRET_KEY: 'sk_test_fake', SAAS_STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    STRIPE_API_BASE: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  });
  const I = await import('../src/services/invoicing');
  const S = await import('../src/services/invoicing/stripe');
  const { invoicePdf } = await import('../src/services/invoicing/pdf');
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess, AUD_PLATFORM } = await import('../src/auth/jwt');

  const prev = I.previousMonth(I.monthOf());
  await query(`INSERT INTO accounts(id, name, plan_tier, created_at, billing_tax_rate) VALUES ($1,'Stripe Pro','pro', now() - interval '70 days', 0.1)`, [A]);
  await query(`INSERT INTO accounts(id, name, plan_tier, created_at, billing_handling) VALUES ($1,'Contract Co','pro', now() - interval '70 days', 'contract')`, [B]);
  await query(`INSERT INTO accounts(id, name, plan_tier, created_at) VALUES ($1,'Checkout Starter','starter', now() - interval '70 days')`, [C]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'pay-a@test.local','x','owner','active'), ($3,$4,'pay-b@test.local','x','owner','active')`, [UA, A, UB, B]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES ($1,$2,'pay-sys@test.local','x','owner','active','saas_admin')`, [SYS, B]);
  await query(`INSERT INTO saas_signups(email, plan_key, mode, status, account_id, stripe_customer_id, stripe_subscription_id) VALUES ('pay-c@test.local','starter','paid','active',$1,'cus_signup','sub_c')`, [C]);
  await I.addManualCharge({ accountId: A, amountUsd: 20, description: 'Onboarding call', month: prev, userId: null });
  await I.addManualCharge({ accountId: C, amountUsd: 15, description: 'Extra storage', month: prev, userId: null });

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, who: { sub: string; acct: string; aud?: string } = { sub: UA, acct: A }) => {
    const tok = signAccess({ sub: who.sub, account_id: who.acct, role: 'owner' } as any, who.aud ? { aud: who.aud } as any : {});
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await r.arrayBuffer()); let j: any = null; try { j = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
    return { s: r.status, j, buf, ct: r.headers.get('content-type') ?? '' };
  };
  const sys = { sub: SYS, acct: B, aud: AUD_PLATFORM };
  const hook = async (ev: any, secret = 'whsec_fake') => {
    const raw = JSON.stringify(ev); const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    const r = await fetch(base + '/api/signup/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: raw });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  const inv = async (acct: string) => one<any>(`SELECT * FROM billing_invoices WHERE account_id = $1 AND period_month = $2`, [acct, prev]);

  try {
    // ---------------------------------------------------------------- the close, with Stripe failing half way
    failItemCall = 2;
    const r1 = await I.closeDue();
    check('the close issues every invoice even while Stripe fails', [r1?.issued.length, !!(await inv(A)), !!(await inv(B)), !!(await inv(C))], [3, true, true, true]);
    const sentAfter1 = [await inv(A), await inv(C)].filter((x) => x.stripe_invoice_id).length;
    const errAfter1 = [await inv(A), await inv(C)].find((x) => x.stripe_error);
    check('...one automated invoice is left unsent with the reason and an attempt counted', [sentAfter1, /simulated outage/.test(errAfter1?.stripe_error ?? ''), errAfter1?.stripe_attempts, errAfter1?.status], [1, true, 1, 'issued']);

    const r2 = await I.closeDue();
    const a = await inv(A), b = await inv(B), c = await inv(C);
    check('the next pass sends it; the month is not closed twice', [r2, !!a.stripe_invoice_id, !!c.stripe_invoice_id, a.stripe_error, c.stripe_error], [null, true, true, null, null]);
    check('a contract invoice never goes to Stripe', [b.stripe_invoice_id, seen.some((q) => q.body['metadata[voltInvoiceId]'] === b.id)], [null, false]);
    check('one Stripe invoice per Volt invoice, made with a key from the Volt invoice', [invoices.size, seen.filter((q) => q.path === '/v1/invoices').every((q) => q.idem === `volt-invoice-${q.body['metadata[voltInvoiceId]']}`)], [2, true]);
    const sa = invoices.get(a.stripe_invoice_id)!;
    check('A in Stripe: the manual line, the plan and tax as items in ledger order, in cents; the total equals Volt\'s', [sa.items, sa.items.reduce((x, y) => x + y, 0), Math.round(Number(a.total_usd) * 100)], [[2000, 49000, 5100], 56100, 56100]);
    check('...charged automatically, with the Volt number on it', [seen.find((q) => q.path === '/v1/invoices' && q.body['metadata[voltInvoiceId]'] === a.id)?.body.collection_method, sa.meta['metadata[voltNumber]']], ['charge_automatically', a.number]);
    const sc = invoices.get(c.stripe_invoice_id)!;
    check('C uses the Stripe customer from its sign-up; its plan stays on the subscription', [seen.find((q) => q.path === '/v1/invoices' && q.body['metadata[voltInvoiceId]'] === c.id)?.body.customer, sc.items], ['cus_signup', [1500]]);
    const custs = seen.filter((q) => q.path === '/v1/customers');
    check('A gets a Stripe customer once, with its owner\'s email, remembered on the account',
      [new Set(custs.map((q) => q.idem)).size, custs[0]?.body.email, (await one<any>(`SELECT stripe_customer_id FROM accounts WHERE id = $1`, [A]))!.stripe_customer_id?.startsWith('cus_')], [1, 'pay-a@test.local', true]);
    const count = seen.length;
    await I.closeDue(); await S.sendPendingToStripe();
    check('later passes send nothing more', seen.length, count);
    check('a contract invoice cannot be pushed to Stripe by hand', (await call('POST', `/api/platform/billing/invoices/${b.id}/stripe`, {}, sys)).s, 409);
    const adm = await call('GET', `/api/platform/billing/invoices/${a.id}`, undefined, sys);
    check('the System Admin sees the Stripe id and no error', [adm.j?.stripeInvoiceId, adm.j?.stripeError, adm.j?.stripeAttempts >= 1], [a.stripe_invoice_id, null, true]);

    // ---------------------------------------------------------------- webhooks
    check('a webhook with a bad signature is refused', (await hook({ type: 'invoice.paid', data: { object: { id: a.stripe_invoice_id } } }, 'whsec_wrong')).s, 400);
    const f1 = await hook({ type: 'invoice.payment_failed', data: { object: { id: a.stripe_invoice_id, next_payment_attempt: Math.floor(Date.now() / 1000) + 3 * 86400, metadata: { voltInvoiceId: a.id } } } });
    const f2 = await hook({ type: 'invoice.payment_failed', data: { object: { id: a.stripe_invoice_id, metadata: { voltInvoiceId: a.id } } } });
    const notes = await query<any>(`SELECT subject, body FROM notifications WHERE account_id = $1 AND topic = 'billing.payment_failed'`, [A]);
    check('payment failed: the invoice is failed and the owners are told once, nothing suspended',
      [f1.j?.outcome, f2.j?.outcome, (await inv(A)).status, notes.length, notes[0]?.subject, (await one<any>(`SELECT status FROM accounts WHERE id = $1`, [A]))!.status], ['failed', 'failed', 'failed', 1, `Payment for Volt invoice ${a.number} failed`, 'active']);
    const p1 = await hook({ type: 'invoice.paid', data: { object: { id: a.stripe_invoice_id, number: 'FAKE-0001' } } });
    const pa = await inv(A);
    check('paid after Stripe\'s retry: paid, with Stripe\'s number as the reference', [p1.j?.outcome, pa.status, pa.paid_reference], ['paid', 'paid', 'Stripe FAKE-0001']);
    check('the same event again changes nothing', (await hook({ type: 'invoice.paid', data: { object: { id: a.stripe_invoice_id } } })).j?.outcome, 'already paid');
    check('a failure after payment is ignored', [(await hook({ type: 'invoice.payment_failed', data: { object: { id: a.stripe_invoice_id } } })).j?.outcome, (await inv(A)).status], ['ignored, paid', 'paid']);
    check('the subscription\'s own invoices are not Volt\'s', (await hook({ type: 'invoice.paid', data: { object: { id: 'in_subscription_1', subscription: 'sub_c' } } })).j?.outcome, 'not a Volt invoice');

    // ---------------------------------------------------------------- the PDF
    const pdf = await call('GET', `/api/billing/invoices/${a.id}/pdf`);
    const text = pdf.buf.toString('latin1');
    check('the account downloads its invoice as a PDF', [pdf.s, pdf.ct, text.startsWith('%PDF-1.4'), text.trimEnd().endsWith('%%EOF')], [200, 'application/pdf', true, true]);
    check('...with its number, the account, the totals and the paid reference', [text.includes(`(Invoice ${a.number})`), text.includes('(Billed to: Stripe Pro)'), text.includes('(561.00)'), text.includes('(51.00)'), text.includes('Stripe FAKE-0001')], [true, true, true, true, true]);
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    const offs = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    check('...a well-formed file: every cross-reference points at its object', [text.slice(xrefAt, xrefAt + 4), offs.length > 0 && offs.every((o, i) => text.startsWith(`${i + 1} 0 obj`, o))], ['xref', true]);
    check('the System Admin gets it too; another account does not', [(await call('GET', `/api/platform/billing/invoices/${b.id}/pdf`, undefined, sys)).s, (await call('GET', `/api/billing/invoices/${a.id}/pdf`, undefined, { sub: UB, acct: B })).s], [200, 404]);
    check('the invoice links to its PDF', (await call('GET', `/api/billing/invoices/${a.id}`)).j?._links?.pdf?.href, `/api/billing/invoices/${a.id}/pdf`);
    const many = invoicePdf({ id: 'x', accountId: A, number: 'V000000-000001', period: '2026-10', status: 'issued', handling: 'contract', currency: 'USD', subtotalUsd: 40, taxRate: 0, taxUsd: 0, totalUsd: 40,
      issuedAt: new Date(), paidAt: null, paidReference: null, failedAt: null,
      lines: Array.from({ length: 40 }, (_, i) => ({ source: 'manual', itemKey: 'charge', description: `Line ${i + 1} (with brackets) and a café`, quantity: 1, unit: 'item', unitUsd: 1, amountUsd: 1, reference: null })) } as any, { accountName: 'Many Lines' }).toString('latin1');
    check('a long invoice runs onto a second page, numbered; brackets are escaped', [/\/Count 2\b/.test(many), many.includes('(Page 2 of 2)'), many.includes('(Line 1 \\(with brackets\\) and a caf\xe9)')], [true, true, true]);

    // ---------------------------------------------------------------- no Stripe set up
    delete process.env.SAAS_STRIPE_SECRET_KEY;
    check('with no Stripe key nothing is sent', await S.sendPendingToStripe(), { sent: 0, failed: 0 });
  } catch (e) {
    console.log('FAIL unexpected error', e); fail++;
  } finally {
    srv.close(); fake.close(); await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
