-- ============================================================================
--  0170: AUTOMATED INVOICES THROUGH STRIPE (build queue B1-2).
--
--  An `automated` account's invoice is sent to Stripe after its month closes
--  (services/invoicing/stripe.ts). The Stripe customer is the one its sign-up
--  made, or one made on the first invoice and remembered here. A send that
--  fails is kept on the invoice (`stripe_error`, `stripe_attempts`) and tried
--  again by the next pass; nothing about the invoice itself changes.
--
--  Add only (RELEASING.md "Schema: add only").
-- ============================================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS stripe_error text;
ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS stripe_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS stripe_sent_at timestamptz;
ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS failed_at timestamptz;
