-- ACCOUNT BRANDING (docs/ACCOUNT_SETTINGS.md): a logo and two colours per
-- account, used by the pages the account shows to outsiders (the share page
-- first). NULL means "use the Volt default".
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS brand_logo_ref TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS brand_primary TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS brand_secondary TEXT;
