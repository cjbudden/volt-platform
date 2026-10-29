# Permissions map: default user types

Who can do what in Volt, by default. The console shows the same map, built
live from the access rules and the account's roles, under **Admin >
Permissions map**. The enforcement is `src/auth/roles.ts` (areas and levels),
`src/auth/defaultRoles.ts` (default roles), `src/services/plan.ts` (plan and
groups) and `requireMinRole` on removals.

## 1. Kinds of user

| User type | Kind | In short |
|---|---|---|
| **System administrator** | Platform staff (`users.platform_role = saas_admin`; also `support`, `read_only`) | Every account, from System Admin, after a second sign-in step. Sets plans, creates accounts, suspends them |
| **Owner** | Account tier | Everything in the account. In a single-client deployment, the super user who also sets the plan |
| **Administrator** | Account tier (and the default role "Administrator") | Everything in the account except changing the plan |
| **Event Manager** | Operator-tier role | Creates, schedules and runs events, their EPG and recordings; publishes results |
| **Radio Manager** | Operator-tier role | Creates, configures and runs radio stations, their schedules and clips |
| **FAST Manager** | Operator-tier role | Builds and runs FAST channels: run orders, ads, brand and filler, ladders, the titles they air, images, loops and slates, uploads and the encode queue; sees reports. No live TV, radio or events |
| **Report and Analytics Manager** | Operator-tier role | Analytics and reports; sees content and usage, cannot change or run it |
| **System Viewer** | Viewer-tier role | Reads everything in the admin; changes nothing, starts nothing |
| **Public user** | Viewer account (not an admin user) | Watches through apps and players; never reaches the console |

Operators and viewers get their access from their roles; a user with several
roles holds the highest level any of them gives. A viewer-tier role is capped
at View. Nobody can give access they do not hold.

## 2. Levels by area

View: see lists and pages. Operate: run (start, stop, on air, publish).
Manage: create, edit, remove.

FAST channels are their own area (28 Oct 2026; they were under *TV
channels*): `/api/fast`, and `/api/channels/<id>` for a FAST channel.
Reads and lineup previews need View; on and off air, activating a lineup,
starting the playout and a test break decision need Operate; creating
channels, lineups, ads, ad servers, ladder, filler, prepare and apply need
Manage. Ad breaks on a stream (`/api/fast/streams/<kind>/<id>/breaks`)
follow the stream: FAST, TV channels, Radio stations or Events, View to
list and Operate to add or cancel (`test/fast-access.check.ts`). A role
saved before the split keeps its TV channels level for FAST.
*Encoding profiles & ladders* came out of Account settings the same way.

| Area | System admin | Owner | Administrator | Event Manager | Radio Manager | FAST Manager | Report & Analytics | System Viewer |
|---|---|---|---|---|---|---|---|---|
| Live & monitoring | Manage | Manage | Manage | View | View | — | View | View |
| TV channels | Manage | Manage | Manage | View | — | — | View | View |
| FAST channels | Manage | Manage | Manage | — | — | Manage | View | View |
| Radio stations | Manage | Manage | Manage | — | Manage | — | View | View |
| Events | Manage | Manage | Manage | Manage | — | — | View | View |
| EPG & schedules | Manage | Manage | Manage | Manage | Manage | View | View | View |
| Recordings & clips | Manage | Manage | Manage | Manage | Manage | — | View | View |
| Media library & publishing | Manage | Manage | Manage | Operate | — | Manage | View | View |
| Files, uploads & storage | Manage | Manage | Manage | Manage | Manage | Manage | View | View |
| Share links | Manage | Manage | Manage | Manage | Manage | Manage | View | View |
| Analytics & reports | Manage | Manage | Manage | View | View | View | Manage | View |
| Fleet & usage | Manage | Manage | Manage | — | — | — | View | View |
| Admin users | Manage | Manage | Manage | — | — | — | — | View |
| Roles & access | Manage | Manage | Manage | — | — | — | — | View |
| Public users | Manage | Manage | Manage | — | — | — | View | View |
| Apps, API keys & players | Manage | Manage | Manage | — | — | — | — | View |
| Payments & products | Manage | Manage | Manage | — | — | — | — | View |
| Account settings | Manage | Manage | Manage | — | — | — | — | View |
| Encoding profiles & ladders | Manage | Manage | Manage | — | — | Manage | — | View |
| Encoding profiles & ladders | Manage | Manage | Manage | — | — | Manage | — | View |

## 3. Account controls

| Control | System admin | Owner | Administrator | Roles |
|---|---|---|---|---|
| Change the plan | Yes | Yes in single-client, View in SaaS | View | View with `settings` |
| New groups, shares of the plan, default group, remove groups | Yes | Yes | Yes | Rename and profile with `settings: manage` |
| Set the account logo and colours (Account settings) | Yes | Yes | Yes | View with `settings` |
| Remove channels and radio stations | Yes | Yes | Yes | No |
| Remove events | Yes | Yes | Yes | With `events: manage` |
| Read the audit log | Yes | Yes | Yes | No |
| Add users and give roles | Yes | Yes | Yes | With `users: manage`, within own access |
| Other accounts, suspend an account | Yes | No | No | No |

## 4. Custom roles

Accounts make their own roles under **Users & Roles > Roles > New role**: a
name, a tier (operator, or viewer to cap everything at View) and a level per
area. A role gives exactly what it lists; every other area is None, and the
console hides what a role does not include. The Permissions map shows custom
roles next to the defaults.

**Start from a template.** The New role form offers starting points that fill
the form (still editable, and lowered to the creator's own access):

| Template | Gives |
|---|---|
| EPG Administrator | EPG & schedules: Manage |
| Channel Operator | Live & monitoring View; TV, radio and events Operate; EPG and recordings View |
| Clip Editor | Recordings Manage; Media library Operate; Files View; Share links Manage; monitoring and EPG View |
| Media Librarian | Files and Media library Manage; Recordings View; Share links Manage |
| Viewer Support | Public users Operate; Analytics and monitoring View |

**Example: an EPG Administrator** (tested end to end in
`test/custom-role.check.sh`, 31 checks). With only *EPG & schedules: Manage*
the user:

* sees only EPG (and their notifications) in the menu and lands on it;
* creates and edits guides for channels, stations and events, enters,
  copies and removes programmes, sets guide icons and XMLTV ids;
* creates XMLTV export feeds and import sources, runs and maps imports, and
  marks feed channels as not used;
* cannot list, create, start or remove channels, stations, events or
  recordings, see users, roles or the audit log, or change groups or the plan;
* cannot create channels from an import lineup: that needs *TV channels:
  Manage* as well (the button says so);
* can browse the image library to pick icons: reading the library is open to
  any signed-in user for pickers; uploading or changing it needs *Files*.

Their removals, and any removal they are refused, are in the audit log.
