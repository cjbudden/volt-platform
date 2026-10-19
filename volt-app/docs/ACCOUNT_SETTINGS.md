# Account settings: logo, colours and where content can be watched

**Admin > Account settings** holds the account's own look for the pages it
shows to people outside it, and the one geo rule that applies to all of its
content. The share page uses it now; anything else the
account shows to outsiders (players, apps, email) can read the same values.

| Setting | Used on the share page for | Default |
|---|---|---|
| **Logo** (image library, or an http(s) address) | The top of the page, in place of the name; the PIN and email-code screens | The account name |
| **Primary colour** | Buttons, the play control, avatars | `#2563eb` |
| **Secondary colour** | The information band and the "Your access" card | `#eef2ff` |

* Text on each colour is black or white, whichever reads better; the form
  warns when a primary colour is mid-tone (hard to read whatever the text).
* The form shows a live preview of the share page header in the chosen
  colours. Saving applies at once, to links already sent as well (the page
  reads the brand each time it opens).
* Choosing the default colour stores "no custom colour", so a later change
  of the Volt default still reaches the account.
* The PIN and email-code screens are branded too, but only for a link that
  exists and asks for a PIN: a made-up link gets no brand, so the brand never
  answers "is this a real link".

## Where content can be watched (account-wide geo)

One rule above every other, for everything the account has: channels, events,
radio stations, on-demand assets and share links.

| Setting | Means |
|---|---|
| Anywhere | No account-wide restriction (the default) |
| Everywhere except these countries | A block list, e.g. RTM: nothing from IL |
| Only in these countries | An allow list; a viewer whose country cannot be told is not let in |

* Nothing lower down can undo it: a channel's own geo setting, an access rule
  or a programme blackout can narrow it further, never open it up.
* The play gate checks the layers in order and reports the first that says
  no: **account** geo, then the **channel's** own geo (Channel settings >
  Geo), then **access rules**, then the **programme** on air (blackout).
* Where it is enforced: the app play gate, the public live URL (451 with the
  reason; HLS, DASH and radio MP3), share links (`geo_blocked`, "not
  available in your region"). The public URL varies by viewer country only
  when the account or the channel has a restriction, so everything else keeps
  one shared CDN entry.
* A change reaches every API process at once (cache tag `acct:<id>`,
  migration 0053) and is in the audit log (`account_geo_access`).

### Checking it: "View as a viewer in…"

The output player on a channel page has **View as a viewer in [country]**,
and who the viewer is (not signed in, signed in, has paid). It asks the play
gate (`GET /api/channels/:id/access-check?country=IL&viewer=anonymous`) and
shows the answer on the picture: "Blocked for a viewer in Israel … Decided by
the account-wide geo rule", a replacement programme, or "Can watch". The
decision is the same one the apps and the public URL get.

## Who

| | Owner, administrator, system administrator | Roles with `settings` | Everyone else |
|---|---|---|---|
| See it | Yes | Yes | Yes (forms and previews read it) |
| Change it | Yes | No | No |

Every change is in the audit log (`account_branding`).

## API

| Route | Who | Does |
|---|---|---|
| `GET /api/account-settings` | anyone signed in | `{name, logo, primary, secondary, custom:{primary,secondary}, defaults, canEdit, editReason}` |
| `PATCH /api/account-settings` | account admin or owner | `{logo?, primary?, secondary?, geoAccess?}`; `null` restores the default. Colours `#RRGGBB` only; the logo a `/library/...` path or an http(s) address; `geoAccess` `{mode: 'block'\|'allow', countries: ['IL']}` or `null` (an empty allow list is refused); 422 otherwise |
| `GET /api/channels/:id/access-check?country=&viewer=` | anyone who can see the channel | `{allowed, layer: account\|channel\|rules\|programme\|none, reason, products, replacement}` |

The share view (`POST /api/share/:token/resolve`) carries
`brand: {account, logo, primary, secondary}`, and so does its 401 answer when
the link asks for a PIN or an email code.

Storage: `accounts.brand_logo_ref`, `brand_primary`, `brand_secondary`
(migration 0052), `accounts.geo_access` (0053). Tests: `bash
test/account-branding.check.sh` (12 checks), `bash test/geo-access.check.sh` (15).
