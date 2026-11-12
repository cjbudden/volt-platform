-- ============================================================================
--  0172: AI FIND DETAILS (build queue F4, Christian, 11 Nov 2026).
--  services/media/aiDetails.ts, POST /api/vod/:id/details/ai.
--
--  THE ADD-ON. AI Find details is an add-on of the B2 catalogue (0171): off
--  by default, an account administrator turns it on. Christian's starting
--  prices, which the System Admin can change in the catalogue: $15 a month
--  with 500 lookups; packs of +1,000 for $20, +5,000 for $75 and +20,000 for
--  $250 a month. ON CONFLICT DO NOTHING: a catalogue the System Admin has
--  already edited (or a deployment that made the key by hand) is left as it is.
--
--  EACH LOOKUP is a row in ai_lookups: one page read by the model for one
--  asset. It keeps the tokens and the cost the model's answer reported, so the
--  margin can be checked against the price, and the answer itself, so asking
--  again about the same page for the same asset that day costs nothing and
--  counts nothing, and so the values a person applies can name the sentence
--  they came from. A failed call is kept too (counted = false).
--
--  Add only (RELEASING.md "Schema: add only"): catalogue rows and a new table.
-- ============================================================================
INSERT INTO billing_addons(key, name, description, monthly_usd, included_quantity, unit, licence, active)
VALUES ('find_details_ai', 'AI Find details',
        'Find details reads a page that publishes no structured data with an AI model, and shows each value with the sentence it came from for you to confirm.',
        15, 500, 'lookups', NULL, true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO billing_addon_packs(addon_key, key, name, extra_quantity, monthly_usd, active) VALUES
  ('find_details_ai', 'plus_1000',  '+1,000 lookups',  1000,  20, true),
  ('find_details_ai', 'plus_5000',  '+5,000 lookups',  5000,  75, true),
  ('find_details_ai', 'plus_20000', '+20,000 lookups', 20000, 250, true)
ON CONFLICT (addon_key, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_lookups (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    vod_asset_id   uuid REFERENCES vod_assets(id) ON DELETE SET NULL,
    schema_id      uuid,
    user_id        uuid,
    url            text NOT NULL,
    page_hash      text NOT NULL,              -- sha256 of the text sent, so a changed page is a new lookup
    model          text NOT NULL,
    status         text NOT NULL CHECK (status IN ('ok', 'failed')),
    counted        boolean NOT NULL DEFAULT false,
    input_tokens   integer,
    output_tokens  integer,
    cost_usd       numeric(12,6),
    result         jsonb,
    error          text,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_lookups_reuse ON ai_lookups (account_id, vod_asset_id, page_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_lookups_month ON ai_lookups (account_id, created_at);
