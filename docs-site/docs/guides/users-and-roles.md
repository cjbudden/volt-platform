---
title: Users & Roles
sidebar_position: 10.7
description: Invite the people who run your account, give them roles, make your own roles, and look after the public users who watch.
guide: section
---

# Users & Roles

**Users & Roles** is where you add the people who work in the console, decide what each can see and do, and look after the public users who watch through your apps. It has three tabs: **Admin users**, **Roles** and **Public users**. Most people come here to invite a colleague with the right role, or to help a viewer who cannot sign in.

![The Users & Roles page on Admin users: the two-step sign-in policy, then the account's people with their roles, tier, two-step sign-in and status](/img/screens/users-and-roles.png)

## What it is for

- **Admin users.** The people who sign in to this console: invite them, give them roles, disable or delete them, reset their password or two-step sign-in, and require two-step sign-in for everyone.
- **Roles.** Named sets of access: a level in each area of Volt. The default roles are the same in every account; you can copy one, start from a template or build your own.
- **Public users.** The viewers who sign in through your apps and players: find one, sign them out everywhere, disable or delete them, and see what they have bought.

Each tab is shown only to people whose roles include it. How levels and roles work, and what each default role gives, is in [Roles and access](../getting-started/roles-and-access.md).

## Before you start

- The person's email address. An invitation is the usual way in; setting a password yourself is for an address that cannot receive email.
- You can only give access you hold yourself. A role above your own access cannot be given, and a user with more access than you can be viewed but not changed.
- Access: see [Who can do it](#who-can-do-it).

## Step by step

### Invite a colleague

1. Open **Admin** and choose **Users & Roles**. It opens on **Admin users**.
2. Choose **Invite user**.
3. Type their **Email** and, if you like, their **Name**.
4. Under **How they get in**, keep **Email an invitation** (they get a link, confirm their address with a 6-digit code and choose their own password), or choose **Set a password now** and type one of at least 10 characters to share with them securely.
5. Under **Roles**, tick one or more. The user gets the highest level any of their roles gives. A role marked **Above your access** cannot be ticked.
6. Choose **Send invitation** (or **Add user**). The page confirms **Invitation sent.** with when the link expires.

The user is listed as **Invited** until they finish setting up.

### Change a user

1. Choose **Open** on the user's row.
2. Change their **Name** or their **Roles**. **Effective access** lists what they end up with, area by area.
3. For an invited user, **Invitation** says whether they have opened it; **Send again** sends a new link (the earlier one stops working) and **Withdraw** cancels it. When no invitation is open, **Send invitation** sends one.
4. **Account active** off ends their sessions at once and blocks sign-in until you turn it back on. Disable rather than delete to keep their history.
5. **Set password** gives them a new password (at least 10 characters); their sessions end.
6. Under **Sign-in security**, **Reset two-step sign-in** turns it off when they have lost their phone or codes. If the account requires it, they set it up again at their next sign-in.
7. Choose **Save changes**. **Delete** removes the user for good after you confirm.

You cannot change yourself here: your own name, email, password and two-step sign-in are under **My account**.

### Require two-step sign-in for everyone

1. On **Admin users**, the box at the top says how many active users have two-step sign-in on.
2. Turn on **Require two-step sign-in for all admin users** and confirm. People without it are asked to set it up when they next sign in, and sessions that did not use it end within a few minutes.

People can use an authenticator app, an emailed code or a texted code, and get backup codes when they turn it on.

### Make a role

1. Choose the **Roles** tab, then **New role**.
2. Under **Start from**, keep **Blank** or choose a template (for example **Channel Operator** or **Clip Editor**). A template fills the form; anything above your own access is lowered to what you hold, and the form says which.
3. Type a **Name** and, if you like, a **Description**.
4. Choose the **Tier**: **Operator** (levels apply as set) or **Viewer** (every level is capped at view).
5. For each area under **Content**, **Insight** and **Administration**, choose **none**, **view**, **operate** (where the area has it; the line under the area says what operate allows) or **manage**.
6. Choose **Create role**.

A default role (tagged **default**) is read-only: open it and choose **Copy** to make your own variation. **Delete role** on a custom role asks you to type its name; its members lose the access it gave them.

### Help a public user

1. Choose the **Public users** tab.
2. Search by email, name or external id, and narrow by **Any status**, **Active**, **Disabled** or **Deleted**.
3. Choose **Open** on the viewer. You see how they sign in (a Volt account, or your own sign-in system), their groups, active sessions, the access they hold and their purchases.
4. **Sign out everywhere** ends all their sessions. **Disable** stops them signing in; **Enable** lets them back. **Reset two-step sign-in** helps a viewer with a Volt account who lost their phone.
5. **Delete** removes their personal data after you confirm; their purchases are kept for your records.

## How it connects

| Section | How it relates |
|---|---|
| [Permissions map](permissions-map.md) | Every role, default and your own, against every area |
| [Payments](payments.md) | Viewers' purchases, and granting a product by hand |
| [API Keys & Apps](api-keys-and-apps.md) | The apps public users sign in through |
| [Notifications](notifications.md) | Alerts go to the people who run the account |
| [Audit log](audit-log.md) | Changes to users and roles are recorded |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See admin users | Admin users: View |
| Invite, change, disable, delete users; reset passwords and two-step sign-in | Admin users: Manage, and only for users within your own access |
| Require two-step sign-in for everyone | Owner or Administrator |
| See roles | Roles & access: View (or Admin users: View) |
| Create, change, copy or delete roles | Roles & access: Manage, with levels you hold yourself |
| See and search public users | Public users: View |
| Sign a public user out everywhere | Public users: Operate |
| Disable, enable, delete public users or reset their two-step sign-in | Public users: Manage |

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **User added, but the email did not send.** | The user exists but the mail server refused the invitation | Open the user and choose **Send again**, or **Set password** instead |
| **The invitation sent ... has expired.** | They did not set up their account in time | Choose **Send again** |
| **No open invitation. They cannot sign in until you send one.** | The invitation was withdrawn, or none was sent | Choose **Send invitation** |
| **Above your access** beside a role | The role gives more than you hold | Ask someone with that access to give it |
| **This user has access you do not hold (or a higher tier), so you can view but not change them.** | Their access is above yours | Ask an Owner or Administrator |
| **This is you.** | You opened your own user | Change your details under **My account** |
| **Lowered to your own access: ...** | A template asked for more than you hold | The listed areas were set to your level; ask someone with more access to raise them |
| **This role grants access you do not hold, so you cannot change it.** | The role is above your access | Ask someone with that access |
| **Password must be at least 10 characters** | The password typed is too short | Type a longer one |
| **No public users** | No one has signed in through your apps yet | Viewers appear when they register or sign in through one of your apps |
| **Couldn't load users and roles.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/users` | The admin users |
| `POST /api/users/invite` | Invites one (`email`, `roleIds`, optional `displayName`) |
| `PATCH /api/users/{id}` | Changes roles, name or `status` (`active`, `disabled`) |
| `POST /api/users/{id}/mfa/reset` | Resets their two-step sign-in |
| `GET /api/user-groups` | The roles; `POST`, `PATCH`, `DELETE` and `POST /api/user-groups/{id}/copy` change them |
| `PUT /api/users/security-policy` | Requires two-step sign-in for everyone (`requireAdminMfa`) |
| `GET /api/viewers` | Public users (`q`, `status`) |
| `POST /api/viewers/{id}/sign-out` | Signs a viewer out everywhere |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email": "sam@example.com", "roleIds": ["<role id>"], "displayName": "Sam"}' \
  "https://your-volt-host/api/users/invite"
```

Every route is in the [API reference](/api-reference).
