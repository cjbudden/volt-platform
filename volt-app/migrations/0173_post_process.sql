-- ============================================================================
--  0173: AFTER ENCODING, SUBTITLES AND AN AI DESCRIPTION (Christian, 12 Nov 2026).
--  services/media/postProcess.ts, services/media/aiDescribe.ts,
--  jobs vod.subtitles and vod.describe, /api/vod/:id/post-process.
--
--  vod_assets.post_process: what was asked for this asset (the plan: from
--  an ingest rule, the account default or a person) and how each step went:
--    { plan: { subtitles, addonId, spoken, languages, model, describe, by, from },
--      subtitles: { state, engine, files, message, at, ... },
--      describe:  { state, source, message, at, ... } }
--  States: waiting (for the encode), queued, running, done, skipped, failed,
--  used_up (the month's AI descriptions are used up), off (no add-on).
--
--  THE ADD-ON. AI descriptions is an add-on of the B2 catalogue (0171), like
--  AI Find details (0172): off by default, offered only when the server has
--  the model's key. Starting prices, which the System Admin can change: $15 a
--  month with 500 descriptions; packs of +1,000 for $20, +5,000 for $75 and
--  +20,000 for $250. ON CONFLICT DO NOTHING keeps an edited catalogue.
--
--  EACH DESCRIPTION written by the model is a row in ai_descriptions, with
--  where its text came from, the tokens and the cost, so the margin can be
--  checked against the price. A failed call is kept too (counted = false).
--
--  Add only (RELEASING.md "Schema: add only").
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS post_process jsonb;

INSERT INTO billing_addons(key, name, description, monthly_usd, included_quantity, unit, licence, active)
VALUES ('ai_descriptions', 'AI descriptions',
        'An AI model writes a short description of an asset from its subtitles or its audio, when it has no description from anything else.',
        15, 500, 'descriptions', NULL, true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO billing_addon_packs(addon_key, key, name, extra_quantity, monthly_usd, active) VALUES
  ('ai_descriptions', 'plus_1000',  '+1,000 descriptions',  1000,  20, true),
  ('ai_descriptions', 'plus_5000',  '+5,000 descriptions',  5000,  75, true),
  ('ai_descriptions', 'plus_20000', '+20,000 descriptions', 20000, 250, true)
ON CONFLICT (addon_key, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_descriptions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    vod_asset_id   uuid REFERENCES vod_assets(id) ON DELETE SET NULL,
    field          text,                       -- the field written, e.g. description
    source         text NOT NULL,              -- captions | audio
    source_file_id uuid,                       -- the caption file read, when source = captions
    text_hash      text NOT NULL,              -- sha256 of the text sent
    model          text NOT NULL,
    status         text NOT NULL CHECK (status IN ('ok', 'failed')),
    counted        boolean NOT NULL DEFAULT false,
    input_tokens   integer,
    output_tokens  integer,
    cost_usd       numeric(12,6),
    description    text,
    error          text,
    created_by     text,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_descriptions_asset ON ai_descriptions (vod_asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_descriptions_month ON ai_descriptions (account_id, created_at);
