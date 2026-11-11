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
| **Couldn't load billing.** | The page could not reach Volt | Choose **Retry** |

## Through the API

| Request | Does |
|---|---|
| `GET /api/billing` | This month so far, the latest invoices, how they are paid, and whether the card can be changed (`paymentMethod`) |
| `GET /api/billing/invoices` | Every invoice, newest month first, with the list standard |
| `GET /api/billing/invoices/{id}` | One invoice with its lines |
| `GET /api/billing/invoices/{id}/pdf` and `.../csv` | The invoice as a PDF or CSV |
| `POST /api/billing/portal` | A one-off link to the payment provider's page to change the card (Account settings: Manage) |

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-volt-host/api/billing"
```

Every route is in the [API reference](/api-reference).
