---
scope: internal
type: added
---
Migration safety check: a migration the previous release could not run on (dropping, renaming or retyping a column or table, NOT NULL without a default, a blocking index) is refused before commit, release and deploy. Removals take two releases and a `-- volt:contract` line; concurrent indexes go in a `-- volt:no-transaction` migration, which the runner now supports. Shipped migrations are baselined in release/migrations-baseline.json and may not be edited.
