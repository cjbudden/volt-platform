---
title: Payments
sidebar_position: 10.4
description: Connect the payment providers you use, match each product to the provider's own id, and look up or grant what a viewer holds.
guide: section
---

# Payments

**Payments** connects Volt to the providers that take your viewers' money, matches each product you sell to that provider's own id for it, and lets you look up what a viewer has bought or been given. The price and what a purchase unlocks are not set here: they come from the premium terms on your access rules. Most people come here to connect a provider once, and then to help a viewer who says they paid but cannot watch.

![The Payments page: four provider cards, the products made from your access rules with each provider's id, and the viewer look-up](/img/screens/payments.png)

## What it is for

- **Providers.** Stripe, the Apple App Store, Google Play, and **Manual (invoiced / comp)** for payments taken some other way. Each is connected and enabled separately.
- **Products.** One row per premium term on your access rules: its name, key, term and price. You type each provider's id for it (a Stripe price, an App Store product id, a Play SKU) and can turn a product off.
- **Viewers.** Look up a viewer by the id your app knows them by, see their purchases and entitlements, grant a product by hand, or record a payment taken elsewhere.

Volt only grants access on a verified payment: Stripe's notifications are signature-checked, and App Store and Google Play purchases are recorded as pending until their confirmation is in place.

## Before you start

- A premium access rule with a term, which is what makes a product: on a channel, a radio station, an event, a content type or a library item, or under [Publishing Rules](publishing-rules.md).
- An account with each provider you will use, and its keys. Secret values are not typed into this page: they are kept in your Volt deployment's secrets store, and the page asks only for a **Secret reference** to them. Your Volt provider can help with that step.
- Access: **Payments & products** (see [Who can do it](#who-can-do-it)).

## Step by step

### Connect a provider

1. Open **Admin** and choose **Payments**.
2. Under **Providers**, find the provider's card. It says **not connected**, **connected** or **disabled**.
3. Fill in its settings:

   | Provider | Settings |
   |---|---|
   | **Stripe** | **Publishable key**, and **Stripe account id** for Connect |
   | **Apple App Store** | **Bundle id**, and **Environment** (Sandbox or Production) |
   | **Google Play** | **Package name**, and **Pub/Sub topic** for real-time developer notifications |
   | **Manual (invoiced / comp)** | Nothing: payments are recorded by a person |

4. Type the **Secret reference** (the card's hint says which secrets it needs). Once saved it shows **· set**; the value itself is never shown again.
5. Tick **enabled**.
6. Copy the **webhook** address shown on the card into the provider's own settings, so it tells Volt about payments.
7. Choose **Connect** (or **Save** when it is already connected). The card says **Saved.**

### Match products to the providers' ids

1. Under **Products**, each row is a premium term from your access rules, with its **Term** and price.
2. In **Stripe price**, **App Store id** and **Play SKU**, type the id that provider uses for the same product.
3. Choose **Save ids**, which appears once you change one.
4. Untick **Enabled** to stop selling a product without changing the rule.

### Help a viewer

1. Under **Viewers**, type the viewer's id as your app knows it and choose **Look up** (or press Enter).
2. The line under it gives their email, their groups and how many **active entitlements** they hold. The table lists each purchase (provider, status, period, amount) and each manual grant.
3. To give them a product without payment, choose it in **Grant a product by hand…** and choose **Grant**. The page says **Granted.**
4. To record a payment taken elsewhere, for example an invoice, choose the product and choose **Record a payment taken elsewhere**. The page says **Payment recorded.** and the purchase appears as **paid** through the **manual** provider.

## How it connects

| Section | How it relates |
|---|---|
| [Publishing Rules](publishing-rules.md), [Content Types](content-types.md) | Premium rules with terms are where products, prices and what they unlock come from |
| [Channels](channels.md), [Radio](radio.md), [Events](events.md), [Media Library](media-library.md) | Can carry their own premium rules |
| [Users & Roles](users-and-roles.md) | **Public users** shows each viewer's purchases and access too |
| [API Keys & Apps](api-keys-and-apps.md) | Your apps check a purchase with their publishable key |
| [Analytics](analytics.md) | Counts viewers refused for lack of access as **Blocked** |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See providers, products and a viewer's purchases | Payments & products: View |
| Connect a provider, change product ids, grant a product, record a payment | Payments & products: Manage |

Only Owners and Administrators have **Payments & products: Manage** by default; the System Viewer can see the page.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **No products yet.** | No premium rule with a term exists | Add one under [Publishing Rules](publishing-rules.md), or on a channel, station, event, content type or library item |
| A purchase shown as **pending** | The provider told Volt, but the payment is not yet confirmed | Nothing is granted until it is; check the provider's own dashboard |
| A viewer paid but has no entitlement | The product's provider id here does not match the provider's, or the webhook is not set up | Check the id in **Products** and the webhook address at the provider; grant the product by hand meanwhile |
| An error beside **Look up** | No viewer has that id in your account | Use the id your app gives Volt for that person |
| **Couldn't load payments.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/payments/providers` | The providers and their webhook address |
| `PUT /api/payments/providers/{provider}` | Connects or changes one (`config`, `secretRef`, `enabled`) |
| `GET /api/payments/products` | The products |
| `PATCH /api/payments/products/{id}` | Its provider ids (`providerIds`) or `enabled` |
| `GET /api/payments/viewers/{externalId}` | A viewer's purchases and entitlements |
| `POST /api/payments/grants` | Grants a product by hand (`viewerExternalId`, `productKey`) |
| `POST /api/payments/manual` | Records a payment taken elsewhere (`viewerExternalId`, `productKey`, `reference`) |

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"viewerExternalId": "member-1042", "productKey": "sport-month"}' \
  "https://your-volt-host/api/payments/grants"
```

Every route is in the [API reference](/api-reference).
