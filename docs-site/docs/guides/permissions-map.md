---
title: Permissions map
sidebar_position: 10.8
description: What each kind of user, and each of your own roles, can do in every area of Volt.
guide: section
---

# Permissions map

The **Permissions map** shows every kind of user against every area of Volt, with the level each one has: the default user types, the default roles and the roles you have made. It is built from the same rules Volt enforces, so it always matches what a person will actually be allowed to do. Most people come here before inviting someone, to choose the role that gives them what they need and no more.

![The Permissions map: one column per kind of user, one row per area of Volt, with None, View, Operate or Manage in each cell](/img/screens/permissions-map.png)

## What it is for

- **Choosing a role.** Read across a row to see who can work in that area, or down a column to see everything a role gives.
- **Checking your own roles.** The roles you have made appear as columns, marked **Custom**.
- **Account controls.** The actions that depend on the kind of user rather than a level: changing the plan, sharing the plan between groups, the logo and colours, removing channels and events, the audit log and adding users.

## Before you start

- Nothing to set up. Roles are made and changed under [Users & Roles](users-and-roles.md); this page only shows them.
- Access: **Roles & access: View** (see [Who can do it](#who-can-do-it)).

## Step by step

### Read the map

1. Open **Admin** and choose **Permissions map**.
2. The key at the top explains the levels: **View** (see lists and pages), **Operate** (run: start and stop, on air, publish), **Manage** (create, edit, remove) and **—** (no access).
3. Each column is a kind of user: **Owner** and **Administrator** (account tiers), then each default role and each of your own roles, with its tier under its name. Point at a column heading to read its description.
4. Rows are grouped into **Content and operations**, **Insight** and **Administration**. Under an area's name, **Operate:** says what that level allows there, for example "Start/stop, on/off air, auto connect, test streams, clear QC" for TV channels.
5. **Account controls** at the foot shows **Yes**, **—** or a short answer for each action: **View** where the role can see but not change it, **Within own access** where it may add users only up to its own access, **Rename, profile** where it may rename groups and change their profile but not share the plan.
6. When you have made roles, **Show this account's custom roles** shows or hides their columns.

### Read the notes

**How access works** under the map sums up the rules:

- **Tiers.** Owners and administrators have full access to the account. Operators and viewers get access from their roles; a viewer-tier role is capped at View.
- **Roles add up.** A user with several roles holds the highest level any of them gives for each area.
- **No escalation.** Nobody can give a user or a role more than they hold themselves.
- **The plan.** Who sets it, and that administrators share it between channel groups.
- **Public users** are a separate kind of account and never reach the console.

## How it connects

| Section | How it relates |
|---|---|
| [Users & Roles](users-and-roles.md) | Where users are given roles and roles are made |
| [Plan & limits](plan-and-limits.md), [Channel Groups](channel-groups.md) | The plan and sharing it out are account controls on the map |
| [Account settings](account-settings.md) | The logo and colours are an account control |
| [Audit log](audit-log.md) | Reading it is an account control: Owners and Administrators only |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the Permissions map | Roles & access: View |

The page changes nothing. Owners, Administrators and the System Viewer can see it by default.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| A level differs from what you expected for a role | A viewer-tier role is capped at View, whatever it was set to | Use an operator-tier role, or copy the role and change its tier |
| A person can do more than their role says | They have several roles, and get the highest level any gives | Open the user in [Users & Roles](users-and-roles.md) and read **Effective access** |
| Your own role is missing | **Show this account's custom roles** is off | Tick it |
| **Couldn't load the permissions map.** | The page could not reach Volt | Reload the page |

## Through the API

| Request | Does |
|---|---|
| `GET /api/user-groups/catalogue` | Every area, its label and what Operate allows there |
| `GET /api/user-groups` | Every role in the account with its levels and tier |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/user-groups/catalogue"
```

Every route is in the [API reference](/api-reference).
