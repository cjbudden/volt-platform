---
title: Billing
sidebar_position: 10.25
description: What Volt charges your account, this month so far, your invoices with their PDF and CSV, and how they are paid.
guide: section
---

# Billing

**Billing** shows what Volt charges your account: the month so far, every invoice issued, and how your invoices are paid. Most people come here to download an invoice for their accounts team, or to check what this month will come to before it ends.

![The Billing page: this month so far with its lines, subtotal, tax and total, how invoices are paid, then the list of invoices with their status and PDF and CSV downloads](/img/screens/billing.png)

## What it is for

- **This month so far.** Each line charged in the open month: your plan fee, server time at the price in force, and any charge or credit your Volt provider added, with the subtotal, tax and total so far. Lines marked **So far** grow until the month ends.
- **How invoices are paid.** Either **Charged to the card on file**, where each invoice is charged when it is issued, or **Paid under your contract**, where your accounts team pays as agreed and the invoice is marked paid when the payment arrives.
- **Invoices.** One per calendar month, issued on the 1st for the month before, each with its status and a **PDF** and **CSV** to download.

## Before you start

- Billing is shown only where your Volt provider bills through Volt. Where it does not, the page says **Billing is not used on this deployment.** and nothing is charged or invoiced.
- Amounts are US dollars. An invoice never changes once issued: a correction appears as a credit on a later invoice.
- Whether you pay by card or under a contract is agreed with your Volt provider; ask them to change it.

## Step by step

### Check this month so far

1. Open **Admin** and choose **Billing**.
2. **This month so far** lists every line with its quantity, unit price and amount. Server time is counted as it runs, so lines marked **So far** keep growing until the month ends.
3. Below the lines are the **Subtotal**, the **Tax** at your rate, and the **Total so far**.

### Download an invoice

1. Under **Invoices**, find the month. Each row shows the invoice number, when it was issued, the period, its status and its total.
2. Choose **PDF** for a printable invoice, or **CSV** for a spreadsheet: one row per line, then subtotal, tax and total.
3. To see the lines first, choose the row. The invoice opens with its period, issue date, how it is paid, its status and, once paid, the payment reference. **PDF** and **CSV** are at the bottom; **Close** or Escape closes it.

![An invoice opened: its period, issue date, how it is paid and its status, the payment reference, every line with subtotal, tax and total, and the PDF and CSV buttons](/img/screens/billing-invoice.png)

### Change the card invoices are charged to

Only when your invoices are **Charged to the card on file**.

1. Under **How invoices are paid**, choose **Change card**.
2. The payment provider's secure page opens. Add the new card there and remove the old one; you can also see your past payments.
3. When you are done, the provider's page brings you back to **Billing**.

Volt never sees or keeps your card number: it stays with the payment provider.

### Add-ons and packs

Add-ons are extra services your Volt provider offers for a monthly price, such as storage for archive copies. Each includes a quantity of something (for example 100 GB) and may offer **packs** that add more for their own monthly price. They are listed under **Add-ons** on the Billing page.

![Add-ons on the Billing page: Archive storage on with the Small pack, its price and a meter of the GB used this month with what is left and when it starts again, and Extra transcode hours off with Turn on](/img/screens/billing-addons.png)

1. To start one, choose **Turn on**, pick the add-on on its own or with a pack, and choose **Turn on**. The drawer says what is charged now before you confirm.
2. To get more or less, choose **Change pack** on an add-on that is on, pick another pack (or **No pack**) and choose **Change pack**.
3. To stop one, choose **Turn off** and confirm.

![Changing the Archive storage pack: no pack, the Small pack (current) and the Large pack chosen, with what it costs now: the Large pack's full month charged and the bigger allowance at once](/img/screens/billing-addon-change.png)

The meter under an add-on that is on shows how much of this month's quantity is used, what is left, and the day it starts again.

How they are charged:

- **Turning an add-on on**, or moving it to a **bigger pack**, charges the full monthly price for the current month. There is no part-month price.
- A month already paid for an add-on or pack is not charged again, so turning it off and on again in the same month costs nothing more.
- **Moving to a smaller pack** or **turning an add-on off** takes effect at once. Nothing is refunded for the rest of the month.
- An add-on that stays on is charged again on the 1st of each month, at the price in force then.
- The included quantity **starts again on the 1st**. What you did not use does not carry over to the next month.
- When a month's quantity is used up, Volt refuses more until you move to a bigger pack or the month ends.

Add-on charges are lines on your monthly invoice, beside the plan fee.

### What the statuses mean

| Status | Means |
|---|---|
| **Issued**, Being charged | A card invoice that has been issued and is being charged |
| **Issued**, Awaiting payment | A contract invoice waiting for your payment |
| **Paid** | Paid, with the date; the invoice shows the payment reference |
| **Payment failed**, Being retried | The card was declined. It is tried again automatically over the next days, and your owners and administrators are told in [Notifications](notifications.md). The service carries on meanwhile |
| **Void** | Cancelled by your Volt provider; nothing is owed |

## How it connects

| Section | How it relates |
|---|---|
| [Plan & limits](plan-and-limits.md) | Your plan; its monthly fee is the first line of each invoice. **Plan & limits** at the top of Billing opens it |
| [Fleet & Usage](fleet-and-usage.md) | The server time behind the server time lines |
| [Notifications](notifications.md) | Where owners and administrators are told about a failed card payment |
| [Account settings](account-settings.md) | Billing needs the same access as Account settings |

See [How Volt fits together](../getting-started/how-volt-fits-together.md) for the whole map.

## Who can do it

| Task | Access needed |
|---|---|
| See this month, the invoices and how they are paid; download PDF and CSV | Account settings: View |
| Change the card | Account settings: Manage |
| See add-ons and how much of each is used | Account settings: View |
| Turn an add-on on or off, or change its pack | Account settings: Manage |
| Change how invoices are paid, the tax rate, or add a charge or credit | Your Volt provider |

Users who can see the page but not change the card see **Changing the card needs Account settings: Manage.** in place of the button.

Roles and levels are explained in [Roles and access](../getting-started/roles-and-access.md).

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| **Billing is not used on this deployment.** | Your Volt provider does not bill through Volt | Nothing to do; ask your provider about your agreement |
| **A card payment failed.** | An invoice could not be charged | It is tried again automatically. If the card has expired, choose **Change card** |
| **Card payments are not set up on this deployment yet.** | Your provider has not finished setting up card payments | Ask your Volt provider |
| **No invoices yet** | No month has been invoiced since your account started | The first invoice is issued on the 1st, for the month before |
| **The PDF could not be downloaded: ...** | The download was refused or the connection dropped | Try again; if it keeps failing, note the invoice number and ask your Volt provider |
| **The ... allowance for this month is used up** | This month's quantity of an add-on is used up | Choose **Change pack** for a bigger pack, or wait for the 1st when it starts again |
| **On this deployment add-ons are switched on by your Volt provider.** | Your provider does not bill through Volt, so add-ons are set up by them | Ask your Volt provider |
| **Turning add-ons on or off needs Account settings: Manage.** | You can see add-ons but not change them | Ask an administrator of your account |
| **Couldn't load billing.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/billing` | This month so far, the latest invoices, how they are paid, and whether the card can be changed (`paymentMethod`) |
| `GET /api/billing/invoices` | Every invoice, newest month first, with the list standard |
| `GET /api/billing/invoices/{id}` | One invoice with its lines |
| `GET /api/billing/invoices/{id}/pdf` and `.../csv` | The invoice as a PDF or CSV |
| `GET /api/billing/addons` | The add-ons on offer, the ones you have on, and how much of each is used this month (`allowance`) |
| `PUT /api/billing/addons/{key}` | Turn an add-on on, or change its pack: `{ "pack": "large" }`, or `{ "pack": null }` for none (Account settings: Manage) |
| `DELETE /api/billing/addons/{key}` | Turn an add-on off, at once and with no refund (Account settings: Manage) |
| `POST /api/billing/portal` | A one-off link to the payment provider's page to change the card (Account settings: Manage) |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/billing"
```

Every route is in the [API reference](/api-reference).
