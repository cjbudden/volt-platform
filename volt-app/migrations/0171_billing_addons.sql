-- ============================================================================
--  0171: ADD-ONS AND PACKS AS BILLABLE ITEMS (build queue B2, Christian,
--  11 Nov 2026). services/invoicing/addons.ts.
--
--  THE CATALOGUE IS DATA the System Admin edits: an add-on has a monthly
--  price, an included quantity of some unit, and optional packs that add more
--  of that unit for their own monthly price. An add-on can carry one of the
--  existing licences (accounts.licences), which turning it on grants.
--
--  WHAT AN ACCOUNT HAS is account_addons, one row per add-on it has on. The
--  charges themselves are rows in the B1 ledger (billing_charges, source
--  'addon' or 'addon_pack'), written when the add-on is turned on or moved to
--  a bigger pack, and again on the 1st of each month it stays on, with a
--  dedupe key per account, add-on (or pack) and month: nothing is charged
--  twice for the same month, and nothing is refunded.
--
--  USAGE against an allowance is addon_usage, one row per account, add-on and
--  month: a new month is a new row, so the allowance resets on the 1st and
--  unused quantity does not carry over.
--
--  Add only (RELEASING.md "Schema: add only"): new tables.
-- ============================================================================
CREATE TABLE IF NOT EXISTS billing_addons (
    key               text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{2,40}$'),
    name              text NOT NULL,
    description       text,
    monthly_usd       numeric(12,2) NOT NULL CHECK (monthly_usd >= 0),
    included_quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK (included_quantity >= 0),
    unit              text NOT NULL,                 -- 'GB archived', 'sites', 'hours'
    licence           text,                          -- an accounts.licences value, or null
    active            boolean NOT NULL DEFAULT true, -- false: not offered to turn on; accounts that have it keep it
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_addon_packs (
    addon_key      text NOT NULL REFERENCES billing_addons(key) ON DELETE CASCADE,
    key            text NOT NULL CHECK (key ~ '^[a-z0-9_]{1,40}$'),
    name           text NOT NULL,
    extra_quantity numeric(16,4) NOT NULL CHECK (extra_quantity > 0),
    monthly_usd    numeric(12,2) NOT NULL CHECK (monthly_usd >= 0),
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (addon_key, key)
);

CREATE TABLE IF NOT EXISTS account_addons (
    account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    addon_key       text NOT NULL REFERENCES billing_addons(key),
    pack_key        text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    -- True when turning the add-on on is what gave the account its licence, so
    -- turning it off takes the licence away again. A licence the System Admin
    -- had already granted (a contract deal) stays when the add-on goes.
    granted_licence boolean NOT NULL DEFAULT false,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, addon_key)
);

CREATE TABLE IF NOT EXISTS addon_usage (
    account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    addon_key    text NOT NULL,
    period_month date NOT NULL CHECK (extract(day FROM period_month) = 1),
    used         numeric(16,4) NOT NULL DEFAULT 0 CHECK (used >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, addon_key, period_month)
);
