# Billing: running it as the System Admin

Staff guide for **System Admin > Billing** (build queue B1-3). The customer's
side is the Billing guide on the docs site (`docs-site/docs/guides/billing.md`).
How it works underneath: `src/services/invoicing` (modes, ledger, the close),
`src/services/invoicing/stripe.ts` (automated invoices, the card portal) and
`src/modules/billing.ts` (the routes). Decided by Christian, 11 Nov 2026.

## The three switches

| Switch | Where | Values |
|---|---|---|
| Billing on the deployment | `VOLT_BILLING` | `off` (default: nothing charged or invoiced), `contract` (invoices issued and settled outside Volt), `automated` (as contract, and card accounts are charged through Stripe) |
| Default tax rate | `VOLT_BILLING_TAX_RATE` | a fraction, e.g. `0.1`; none by default |
| How an account pays | System Admin > Billing > Accounts > Edit | **Card (Stripe)** or **Contract**; a contract deployment treats every account as contract |

Automated needs `SAAS_STRIPE_SECRET_KEY` and `SAAS_STRIPE_WEBHOOK_SECRET` (the
same Stripe account as the promo site's Checkout). For the customer's
**Change card** button, turn on the customer portal in the Stripe dashboard
(Settings > Billing > Customer portal) and allow updating payment methods.

## The page

Open **System Admin** (authenticator code needed) and choose the **Billing** tab.

- **Billing on this deployment**: the mode, the default tax rate, and which month the scheduler closes next. When the mode is off, **Add charge or credit** and **Close a month** are disabled; accounts and the price list can still be set ahead of turning billing on.
- **Accounts**: each client account with how it pays, its tax rate (or the default), whether its plan fee is an agreed amount or from the plan, and its open invoices. **Edit** sets **Invoices are paid by** and **Tax rate (%)**; leaving the rate empty uses the default. A change applies to invoices issued from then on.
- **Invoices**: **Open** (issued or failed) or **All**. A row shows the Stripe state for card invoices (Sent to Stripe, Waiting to go to Stripe, or Not sent yet with Stripe's answer; it is retried every ten minutes, up to ten times). Choose a row to see its lines; **PDF** and **CSV** download it. **Mark paid** on a contract invoice asks for the payment reference, which the customer sees on the invoice and its PDF. Paid cannot be undone. Card invoices are marked paid by Stripe's webhook.
- **Price list**: what Volt charges a customer for server time per hour, for one instance type or any type without its own price (GB delivered has a price key but no meter yet). Prices are never edited: **Add a price** with a later **In force from** replaces the old one from then. A month is charged at the price in force when it started. With no price, server time is listed as unpriced at the close and never charged.
- **Add charge or credit**: a one-off line on an account's open month (an onboarding workshop, a credit for an outage). The description is printed on the customer's invoice. A line cannot be changed once added: correct it with a credit.
- **Close a month**: the scheduler closes the month before on the 1st by itself. Use this to re-run a close (safe: an account already invoiced is left alone) or to close one account. The result says how many invoices were issued, how many were already invoiced, how many had nothing to bill, and how many had unpriced server time.

Every change (handling, tax rate, charge, price, mark paid) is in the audit log.

## Add-ons and packs (build queue B2)

The catalogue is data (migration 0171, `src/services/invoicing/addons.ts`).
On **System Admin > Billing**, the **Add-ons** section lists each add-on with
its price, included quantity, packs (choose one to edit it, **+ Pack** to
add) and how many accounts have it; **Add an add-on** and **Edit** set the
name, description, price, included quantity, unit, the feature it opens and
whether it is offered. An account's **Edit** drawer lists the add-ons it has
on and how much of each is used. The same through the API, with a platform
session:

| Request | Does |
|---|---|
| `GET /api/platform/billing/addons` | The catalogue, with how many accounts have each add-on |
| `POST /api/platform/billing/addons` | Add one: `key`, `name`, `description`, `monthlyUsd`, `includedQuantity`, `unit`, `licence` (`hybrid_sites`, `mirror_archive` or null), `active` |
| `PATCH /api/platform/billing/addons/{key}` | Change any of those but the key |
| `POST /api/platform/billing/addons/{key}/packs` | Add a pack: `key`, `name`, `extraQuantity`, `monthlyUsd` |
| `PATCH /api/platform/billing/addons/{key}/packs/{pack}` | Change a pack |
| `GET`, `PUT`, `DELETE /api/platform/billing/accounts/{id}/addons[/{key}]` | An account's add-ons, set or turned off for it |

Rules (Christian, 11 Nov 2026): the full monthly price for the current month
when an add-on is turned on or moved to a bigger pack; a smaller pack or off
at once, with no refund; charged again on the 1st while it stays on; the
allowance resets on the 1st with no carry over. Each charge is a ledger row
with a dedupe key per account, add-on or pack, and month, so a month is never
charged twice for the same item (off and on again, or down a pack and back
up, costs nothing more that month). A changed price applies from the next
charge; rows already written keep theirs. An add-on or pack set inactive is
no longer offered; accounts that have it keep it, and it renews, until they
turn it off. An add-on with a `licence` grants that licence when turned on and
takes it away when turned off, unless the account already had it (a licence
you gave by hand stays).

Usage against an allowance is `useAllowance(account, addon, quantity)`; it
refuses over the allowance (409, `allowance_exceeded`) and the read is cached,
so a warm check makes no database query. No feature counts against an
allowance yet: which add-on counts what is B2-2.

Every change is audited (`account_addon`, `billing_addon`).

## Checks

`node scripts/check.js billing` runs `billing-ledger` (the ledger, the close,
the routes), `billing-addons` (add-ons, packs, the charging rules, allowances) and `billing-stripe` (Stripe with a fake API, webhooks, the PDF,
the card portal). With real Stripe test keys, see the B1-2 entry in
`VOLT_BUILD_STATUS.md` for the end to end run with `stripe listen`.
