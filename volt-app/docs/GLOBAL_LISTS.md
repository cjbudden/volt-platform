# Global lists

Reference lists that are the same for every client and are kept by SaaS staff:
**Countries** and **Timezones** ship built in; System Admin can make more
(languages, currencies, regions) without a deploy.

| | Global lists | Account pick lists (Genres) |
|---|---|---|
| Owned by | the platform (System Admin) | each client account |
| Item shape | a stable **code** + structured **fields** | one word |
| Read by | every account, players, the promo site | that account |
| Code | `services/globalLists.ts`, `modules/globalLists.ts` | `services/metadataLists.ts` |

## The model

A **list** declares its fields. An **item** is a stable code plus a value
holding those fields, a position, a default flag and an active flag.

```json
{
  "id": "4a0c…", "listId": "f2f8…", "listKey": "timezones",
  "code": "central-america-standard-time",
  "label": "Central America Standard Time (-6)",
  "value": {
    "en_US": "Central America Standard Time (-6)",
    "abbr": "CAST", "offset": "-6", "isdst": false,
    "text": "(UTC-06:00) Central America",
    "utc": ["America/Belize", "America/Costa_Rica", "America/El_Salvador", "America/Guatemala",
            "America/Managua", "America/Tegucigalpa", "Etc/GMT+6", "Pacific/Galapagos"]
  },
  "position": 10, "isDefault": false, "active": true
}
```

The `value` is exactly the shape of the original timezone sample; `id`,
`listId`, `position` and `isDefault` carry what `id`, `idList`, `position`
and `isDefault` did there (ids are UUIDs, as everywhere in Volt).

### Built-in lists

**countries** (code follows `alpha2`, label `name`)

| Field | Type | Example |
|---|---|---|
| `name` | text, required | Australia |
| `officialName` | text, required | Commonwealth of Australia |
| `alpha2` | text, required, unique, `^[A-Z]{2}$` | AU |
| `alpha3` | text, required, unique, `^[A-Z]{3}$` | AUS |
| `numeric` | text, unique, `^[0-9]{3}$` | 036 |
| `phoneCode` | text, `^\+[0-9]{1,4}$` | +61 |

250 countries and territories (ISO 3166-1, plus Kosovo `XK`). Three have
no calling code of their own and carry no `phoneCode`: Antarctica (AQ),
Heard Island and McDonald Islands (HM) and US Minor Outlying Islands (UM).

**timezones** (code fixed at creation, label `en_US`)

| Field | Type | Example |
|---|---|---|
| `en_US` | text, required | Central America Standard Time (-6) |
| `abbr` | text, required | CAST |
| `offset` | text, required, sorts as a number | -6, 5.75 |
| `isdst` | yes/no, required | false |
| `text` | text, required | (UTC-06:00) Central America |
| `utc` | list of text (IANA zones) | America/Belize, … |

108 entries. Two zones in the source (`Europe/Uzhhorod`,
`Europe/Zaporizhzhia`) were folded into `Europe/Kyiv` by tzdata in 2022;
they still resolve as links in most runtimes and are kept as shipped.

### Field types and rules

`string`, `number`, `boolean`, `string[]`, each with optional `required`,
`unique` (case-insensitive, text and numbers), `pattern` (regex), `maxLength`,
`case` (`upper`/`lower`, applied on save) and `sortAs: "number"` (a text
value filtered and sorted numerically).

**Translations.** Any value key shaped like `fr_FR` that the list does not
declare is an optional translation of the label. `?locale=fr_FR` returns it
as `label`, falling back to the label field.

## The rules that keep references safe

Other records store the **code** (a channel's timezone, a rights rule's
countries), so:

1. **Codes do not drift.** Where a list has a code field (countries:
   `alpha2`) the code follows it. Otherwise the code is set once; built-in
   lists refuse to change it.
2. **Built-in lists never hard-delete.** An item is retired (`active: false`):
   no longer offered, still resolvable by code. Custom lists can delete.
3. **The definition never lies.** A change to a list's fields is saved only
   if every existing item still passes it. Built-in fields can be relabelled
   but not removed or retyped; new fields can be added.
4. **One default per list** (enforced by a unique index).
5. **Every change bumps the list's version**, which is the read API's ETag,
   so CDN and browser caches turn over immediately.
6. **Imports are all or nothing**, and `replace` retires what the file no
   longer has; it never deletes.

## Reading (everyone)

```
GET /api/global-lists                       lists you can read
GET /api/global-lists/countries             all items (default limit 500, max 1000)
GET /api/global-lists/countries/items/AU    one item by code, any case, retired too
```

The item list follows the Volt list standard (`docs/API_STANDARDS.md`):

| Want | Ask |
|---|---|
| search every text field and the code | `?q=commonwealth` |
| a timezone that covers an IANA zone | `/timezones?q=Brisbane` |
| filter on a field | `?value.alpha3=NZL` (or `?alpha3=NZL`) |
| several by code | `?code=AU,NZ,PH` |
| numeric range | `/timezones?value.offset[gte]=8` |
| sort | `?sort=-value.offset,value.en_US` |
| retired items too | `?active=false` or `?active[exists]=true` |
| translated labels | `?locale=fr_FR` |

Every field filters and sorts as `value.<key>`. The bare `<key>` is a
shorthand, except where it would clash with a list-standard parameter: the
timezone `offset` field is `value.offset`, because `offset` is paging.

**Visibility.** `public` lists need no sign-in and are served with
`Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate`
plus an ETag, so CloudFront can serve them to players and the promo site.
`tenant` lists need a session or an account key. `platform` lists are only
on the admin API.

**In the console:** `volt-web/src/lib/globalLists.ts` gives
`useGlobalList('countries')`, `loadGlobalList()` and `globalListItem()`.

## Managing (System Admin > Global lists)

GETs need the `read_only` platform role, changes need `saas_admin`. Every
change is audit-logged as `global_list` / `global_list_item`.

```
GET    /api/platform/global-lists
POST   /api/platform/global-lists                  { key, name, description?, visibility?, fields, labelField, codeField? }
GET    /api/platform/global-lists/:key
PATCH  /api/platform/global-lists/:key             { name?, description?, visibility?, fields?, labelField?, codeField?, archived? }
GET    /api/platform/global-lists/:key/items       retired included
POST   /api/platform/global-lists/:key/items       { code?, value, position?, isDefault?, active? }
PATCH  /api/platform/global-lists/:key/items/:ref  ref = id or code
DELETE /api/platform/global-lists/:key/items/:ref  custom lists only
PUT    /api/platform/global-lists/:key/order       { codes: [...] }  named codes first, the rest keep order after
POST   /api/platform/global-lists/:key/import      { items, mode: merge|replace, dryRun? }
GET    /api/platform/global-lists/:key/export      definition + every item (re-importable)
POST   /api/platform/global-lists/:key/restore     { overwrite? }  built-in lists: put shipped items back
```

## Seeds

The built-in definitions and items live in `src/data/globalLists/*.seed.ts`,
generated by `scripts/global-lists/build-seeds.mjs`. On boot (inside the boot
lock) `ensureGlobalListSeeds()` creates a missing built-in list and, when a
seed's `SEED_VERSION` is newer than the database's `seeded_version`, **adds**
shipped items it lacks, by code. It never overwrites an item a System Admin
edited; **Restore shipped items** (and `restore` with `overwrite: true`) does
that on request, keeping any translations.

### Data sources and licences

| Data | Source | Licence |
|---|---|---|
| Timezones | `timezones.json` 1.7.2 | MIT |
| Country names and ISO codes | `world-countries` 5.1.0 (mledoze/countries) | **ODbL 1.0** |
| Calling codes | `libphonenumber-js` 1.13.15 | MIT |

ODbL asks for attribution and, if a derived database is distributed
publicly, that it is shared under the same licence. Serving the list through
the API to customers is likely to count. Before an outside sale, either keep
the attribution (and accept the share-alike on this one list) or replace the
country names from an ISO 3166 subscription or a public-domain source; the
codes themselves are not the issue.

## Tests

`DATABASE_URL=… npx tsx test/global-lists.check.ts` (`npm run test:global-lists`):
seeds, the public read API, the list standard on list fields, caching, roles,
the code-protection rules, definition changes, import (all or nothing,
dry run, replace retires), order, export and restore. 51 checks.

## Not built yet

- Switching the console's existing pickers to the server lists:
  `lib/countries.ts` (Rights, Account settings, Multiview) and
  `lib/timeZones.ts` (FAST, channel clock, XMLTV import) still use the
  browser's `Intl` data.
- Per-account subsets (an account showing only the countries it sells to).
- More built-in lists: languages (ISO 639), currencies (ISO 4217), regions.
