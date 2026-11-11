-- ============================================================================
--  0169: BILLING, THE CHARGES LEDGER AND MONTHLY INVOICES (build queue B1,
--  Christian, 11 Nov 2026).
--
--  The deployment decides whether anything is billed at all (`VOLT_BILLING`:
--  off, contract or automated, services/invoicing). Each account then says how
--  its invoices are settled: `automated` (card through Stripe) or `contract`
--  (issued for the customer's own accounts team and marked paid by hand).
--
--  THE LEDGER IS APPEND ONLY. One row per charge, with the price frozen onto
--  the row, so a price changed today never rewrites a month already billed. A
--  mistake is corrected by a new row (a credit), never by editing the old one;
--  the trigger below refuses UPDATE so that stays true whatever code runs.
--  `dedupe_key` makes the rows Volt writes by itself (the plan fee, metered
--  usage) idempotent: closing a month twice cannot charge twice.
--
--  Add only (RELEASING.md "Schema: add only"): new tables, and account columns
--  with a default or nullable.
-- ============================================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS billing_handling text NOT NULL DEFAULT 'automated'
  CHECK (billing_handling IN ('automated', 'contract'));
-- Null: the deployment's rate (VOLT_BILLING_TAX_RATE, none by default).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS billing_tax_rate numeric(6,4)
  CHECK (billing_tax_rate IS NULL OR (billing_tax_rate >= 0 AND billing_tax_rate < 1));

-- WHAT VOLT CHARGES A CUSTOMER for a metered unit. Not compute_rates, which is
-- what a server costs Volt. Effective dated like compute_rates: the price in
-- force at the start of the month is the one a month is billed at. A unit with
-- no price is not charged (and the close says so), never charged at zero.
CREATE TABLE IF NOT EXISTS billing_prices (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_key       text NOT NULL,                 -- 'server_hour', 'gb_delivered'
    instance_type  text,                          -- server_hour only; null = any type
    name           text NOT NULL,
    unit           text NOT NULL,                 -- 'hour', 'GB'
    unit_usd       numeric(12,6) NOT NULL CHECK (unit_usd >= 0),
    effective_from timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_prices_lookup ON billing_prices (unit_key, instance_type, effective_from DESC);

CREATE TABLE IF NOT EXISTS billing_charges (
    id            bigserial PRIMARY KEY,
    account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period_month  date NOT NULL CHECK (extract(day FROM period_month) = 1),
    source        text NOT NULL CHECK (source IN ('plan', 'addon', 'addon_pack', 'usage', 'manual')),
    item_key      text NOT NULL,
    description   text NOT NULL,
    quantity      numeric(16,4) NOT NULL,
    unit          text NOT NULL,
    unit_usd      numeric(12,6) NOT NULL,
    amount_usd    numeric(12,2) NOT NULL,
    currency      text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    created_by    text NOT NULL,                  -- 'volt' for the close, else 'system-admin'
    created_by_user uuid,
    reference     text,
    dedupe_key    text UNIQUE,
    invoice_id    uuid,                           -- set once, when the month is closed
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_charges_account_month ON billing_charges (account_id, period_month);

-- Append only: no edits. The one write allowed after insert is attaching the
-- row to its invoice when the month closes (invoice_id from null to a value).
CREATE OR REPLACE FUNCTION billing_charges_append_only() RETURNS trigger AS $$
BEGIN
  IF OLD.invoice_id IS NULL AND NEW.invoice_id IS NOT NULL
     AND (to_jsonb(NEW) - 'invoice_id') = (to_jsonb(OLD) - 'invoice_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'billing_charges is append only: add a correcting charge instead';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS billing_charges_append_only ON billing_charges;
CREATE TRIGGER billing_charges_append_only BEFORE UPDATE ON billing_charges
  FOR EACH ROW EXECUTE FUNCTION billing_charges_append_only();

CREATE SEQUENCE IF NOT EXISTS billing_invoice_number;

CREATE TABLE IF NOT EXISTS billing_invoices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period_month    date NOT NULL,
    number          text NOT NULL UNIQUE,
    status          text NOT NULL CHECK (status IN ('issued', 'paid', 'failed', 'void')),
    handling        text NOT NULL CHECK (handling IN ('automated', 'contract')),
    subtotal_usd    numeric(12,2) NOT NULL,
    tax_rate        numeric(6,4) NOT NULL DEFAULT 0,
    tax_usd         numeric(12,2) NOT NULL,
    total_usd       numeric(12,2) NOT NULL,
    currency        text NOT NULL DEFAULT 'USD',
    issued_at       timestamptz NOT NULL DEFAULT now(),
    paid_at         timestamptz,
    paid_reference  text,
    paid_by         uuid,
    stripe_invoice_id text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, period_month)
);
CREATE INDEX IF NOT EXISTS billing_invoices_status ON billing_invoices (status, issued_at DESC);
