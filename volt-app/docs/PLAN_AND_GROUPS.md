# Plan, limits and channel groups

How many channels and stations an account may have, who sets it, and how
channel groups share it out.

## 1. The model

| Level | What it holds | Who sets it |
|---|---|---|
| **Account: the plan** | A plan name, how many **channels and stations** the account may have in all (`accounts.max_channels`), and how many may **run at once** (`accounts.max_concurrent_sources`) | A system administrator, always. In a **single-client deployment** also the account **owner**, who is the super user there |
| **Group: its share** | How many of the plan's channels and stations the group may hold (`groups.max_channels`), and how many of them may run at once (`groups.max_concurrent`) | Account administrators and owners, and system administrators |

* TV channels and radio stations count together. Events are not counted in
  the plan; they live in a group for their output profile.
* Groups' shares add up to no more than the plan. A share cannot go below
  what the group already holds, and a group cannot be allowed more running
  at once than the plan.
* The plan cannot go below what exists, or below what the groups are given
  (lower a group's share first).
* **A new channel or station needs room in both**: the plan first, then its
  group's share. Each refusal says which, with the numbers.

`VOLT_DEPLOYMENT` chooses the shape: `single` (the default: one client runs
its own Volt, so the owner sets the plan) or `saas` (many clients on one
platform; the plan is what a client pays for, so only platform staff change
it, from System Admin or `/api/platform/accounts/:id`).

## 2. Channel groups

Every channel, station and event belongs to a group. A group sets the output
profile (transcode or packaging, the ladder, captions) and has a share of the
plan.

| Action | Who |
|---|---|
| See groups | anyone signed in (the create forms need them) |
| Rename, choose another output profile of the same workflow | `settings: manage` |
| New group, change a share, make default, remove | account admin or owner, system administrator |

**The default group.** One group per account is the default: new channels,
stations and events start in it, and it cannot be removed. Make another group
the default first. The oldest group of each existing account became its
default (migration 0051).

**Removing a group.** Never the default group, and never while anything is
in it, because removing a group would take its channels, stations and events
with it. The remove dialog shows what is in it ("1 TV channel, 2 radio
stations, 11 events, 10 not yet ended") so you know what to move first. An
empty group is removed after typing its name; its share becomes free to give
to another group. Every removal, and every refused attempt, is in the audit
log.

## 3. Console

* **Admin > Plan & limits**: the plan, channels and stations in use (TV and
  radio), how much is shared out, running now, and each group's use of its
  share. **Change plan** for those allowed; for everyone else a note says who
  sets it.
* **Admin > Channel groups**: the plan strip (in the plan, shared out, not yet
  shared), **New group** on the right, each group's share as a meter, Edit
  and a "⋯" menu (Make default, View its channels, Remove).
* When the plan or a share is used up, New channel and New station are
  disabled and the page says why, with a link to Plan & limits.

## 4. API

| Route | Who | Does |
|---|---|---|
| `GET /api/plan` | anyone signed in | `{planTier, maxChannels, maxConcurrent, used:{total,tv,radio,events,running}, allocated, unallocated, deployment, canEdit, editReason, canManageGroups, groups:[…]}` |
| `PATCH /api/plan` | owner (single) or system admin | `{planTier?, maxChannels?, maxConcurrent?}`; 409 below use or allocation |
| `GET /api/groups` | anyone signed in | adds `is_default`, `event_count` |
| `POST /api/groups` | account admin | `{name, workflowType, outputProfileId?, maxChannels, maxConcurrent, makeDefault?}`; 409 over the plan |
| `PATCH /api/groups/:id` | settings:manage (name, profile); account admin (`maxChannels`, `maxConcurrent`, `isDefault: true`) | 409 below use or over the plan |
| `GET /api/groups/:id/usage` | anyone signed in | `{isDefault, inUse, blocker, counts:{channels, stations, events, eventsUpcoming}}` |
| `DELETE /api/groups/:id` | account admin | 204; 409 `default_group` or `group_in_use` with the counts |

Platform routes (`/api/platform/accounts/:id`, `/groups`) apply the same rules.

## 5. Tests

`bash test/plan-groups.check.sh` (32 checks): plan view and who may change it,
floors, audit; groups created within the plan, shares within the plan and
above use, running-at-once cap, operators refused; create blocked by the plan
and by the share with the right wording; default and in-use removal refused
with counts, the default moved, an empty group removed, all audited.
