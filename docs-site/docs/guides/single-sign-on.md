---
title: Single sign-on
sidebar_position: 10.75
description: Let your team sign in to Volt with your own identity provider, give them their roles from its groups, and make it compulsory if you want.
guide: section
---

# Single sign-on

Single sign-on lets your team sign in to the Volt console with your organisation's identity provider: Microsoft Entra ID, Okta, Google Workspace, Auth0, or any OpenID Connect or SAML 2.0 provider. Volt can create their user on the first sign-in and give them roles from the provider's groups, so joining and leaving is handled where you already manage people.

![The Single sign-on page: an OpenID Connect provider with its on switch, Test, Edit and Remove, an email domain waiting for its DNS record, and the redirect URI to give the provider](/img/screens/single-sign-on.png)

## What it is for

- **One sign-in for your staff.** People type their work email on the Volt sign-in page and choose **Continue with** your provider.
- **People and roles from the provider.** New people can be created as they first sign in, at a tier you choose, and the provider's groups can give them Volt roles and keep those roles in step.
- **Your sign-in rules.** The provider's own two-step sign-in can count as Volt's, and you can close password sign-in for your domains.

It is for the people who use the console. Viewers who watch your streams sign in another way (see [Users & Roles](users-and-roles.md)).

An administrator sets it up once, with whoever runs your identity provider.

## Before you start

- An account with your identity provider where you can register an application.
- Access to your domain's DNS, to add one TXT record that proves the email domain is yours.
- The [roles](users-and-roles.md) you want people to have.
- The **Admin** tier and **Admin users: Manage** (see [Who can do it](#who-can-do-it)).

## Step by step

### Add a provider

1. Open **Admin**, then **Single sign-on** under Access.
2. Choose **Add a provider** and pick yours. A line under the choices says where to register Volt in that provider.
3. Fill in **Name on the sign-in button** (for example *Example Entra ID*).
4. For OpenID Connect: fill in **Issuer URL**, **Client ID** and **Client secret** from your provider. The secret is stored encrypted and never shown again; leave it blank when editing to keep it. **Scopes** rarely needs changing.
5. For SAML 2.0: paste the provider's metadata, or its address, into **Provider metadata** and choose **Read metadata**. It fills **Provider entity ID**, **Provider sign-in URL** and **Signing certificate**, and says how many certificates it read and until when they are valid.
6. Set how people get in (next task), then **Add provider**.

The provider's card shows what to give your provider under **Give your provider**: the **Redirect URI** for OpenID Connect, or the **ACS URL**, **Entity ID** and **Metadata** address for SAML. Copy them into the application you registered.

### Decide how people get in and which roles they have

In the provider's form, under **People and roles**:

1. **Create Volt users on their first sign-in** makes a user for anyone at a verified domain who signs in for the first time. Leave it off to let in only people you have invited.
2. **New users' tier** is the tier those new users get: Viewer, Operator or Admin.
3. **Role when no group matches** is the role they get when none of their groups is mapped.
4. **Provider groups to Volt roles**: choose **Add a mapping**, type a group's name or ID as the provider sends it, and pick the Volt role. Entra ID sends group IDs unless it is set to send names. The tier follows the highest mapped role, never above Admin; nobody becomes an account owner through single sign-on.
5. **Keep roles in sync at every sign-in** adds and removes the mapped roles each time someone signs in. Roles that no mapping mentions are left alone.
6. **Claim names (advanced)** is only needed when your provider sends the email, name or groups under unusual names.

### Verify your email domain

Nobody can sign in through a provider until one of its domains is verified.

1. On the provider's card, under **Email domains**, type your domain (for example *example.com*) and choose **Add domain**.
2. Add the TXT record shown, with the **Name** and **Value** given (use **Copy**), at your DNS provider.
3. Choose **Verify**. When the record is found the domain shows **Verified**. DNS can take a while to update; if it is not found yet, try again later.

A domain can belong to only one provider in Volt. Public mail services (such as Gmail or Outlook) cannot be added, because anyone can have an address there.

### Check the set-up

1. Choose **Test** on the provider's card.
2. Each check is shown with a tick or a cross: the provider's discovery document or metadata, its keys or certificates (and when they expire), the client details, and how many domains are verified.
3. Fix anything crossed, then **Test** again. Then sign out and sign in with an address at your domain: **Continue with** and the provider's name appears as you type the email.

### Make single sign-on compulsory

1. Choose **Edit** on the provider.
2. Under **Security**, tick **Make single sign-on compulsory for this provider's verified domains**, then **Save changes**.

Password sign-in closes for addresses at those domains, and the sign-in page offers only the provider (with **Use a password instead** for account owners). Account owners keep their password and two-step sign-in, so a problem at the provider can never lock the account out.

**Count the provider's two-step sign-in as Volt's** (on by default) means someone who used two-step sign-in at the provider is not asked again by Volt. Untick it to have Volt ask for its own.

### Switch a provider off or remove it

- Untick **On** on the card to stop offering the provider without losing its settings.
- **Remove** deletes it after you confirm. People who signed in with it need a password or another provider.

## How it connects

| Section | How it relates |
|---|---|
| [Users & Roles](users-and-roles.md) | People created by single sign-on appear there, with the roles their groups gave them; the two-step sign-in policy is set there |
| [Permissions map](permissions-map.md) | What each role given through a mapping can do |
| [Audit log](audit-log.md) | Changes to providers are recorded there |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See the providers and their domains | Admin tier, with Admin users: View |
| Add, change, test, switch off and remove providers; add, verify and remove domains | Admin tier, with Admin users: Manage |

Single sign-on is an administrator's decision: Operator and Viewer tiers cannot open it, whatever their roles allow.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Nobody can sign in through it until a domain is verified.** | No domain of this provider is verified yet | Add the TXT record and choose **Verify** |
| "The TXT record was not found at" and the record name | The record is missing, wrong, or DNS has not updated yet | Check the name and value against the ones shown, wait, then **Verify** again |
| "is a public mail service" | The domain is a mail service anyone can use | Use your organisation's own domain |
| "The issuer is not a web address" or "must start with https://" | The **Issuer URL** is still the example, or not a full https address | Copy the issuer from your provider |
| A cross on **Discovery document** in **Test** | Volt could not load the provider's settings from the issuer | Check the **Issuer URL**; for Entra ID it includes your tenant ID |
| **Last problem** on the card | The last sign-in through this provider failed, and why | Fix what it names, then **Test** |
| **Continue with** does not appear on the sign-in page | The email's domain is not verified for an active provider | Verify the domain and check **On** is ticked |
| Someone signs in but is refused | **Create Volt users on their first sign-in** is off and they were not invited, or their address belongs to another Volt account | Invite them in [Users & Roles](users-and-roles.md), or turn it on |
| Someone has the wrong role | Their groups are not mapped, or are sent as IDs rather than names | Check the group values your provider sends and the mappings |

## Through the API

| Request | Does |
|---|---|
| `GET /api/sso-connections`, `POST /api/sso-connections` | The account's providers with their domains, and the roles you can map to; or a new provider (`protocol` `oidc` or `saml`, `name`, and its settings) |
| `PATCH /api/sso-connections/{id}`, `DELETE /api/sso-connections/{id}` | Changes a provider (including `enabled` and `enforce`), or removes it |
| `POST /api/sso-connections/metadata` | Reads a SAML provider's metadata from `xml` or a `url` |
| `POST /api/sso-connections/{id}/test` | Runs the checks **Test** runs |
| `POST /api/sso-connections/{id}/domains`, `POST /api/sso-connections/{id}/domains/{domain}/verify`, `DELETE /api/sso-connections/{id}/domains/{domain}` | Adds, verifies or removes an email domain |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}' \
  "https://your-volt-host/api/sso-connections/$CONNECTION_ID/domains"
```

Every route is in the [API reference](/api-reference).
