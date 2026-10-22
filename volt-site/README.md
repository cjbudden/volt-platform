# Volt Streaming promo site

A static marketing site that shows the product and lets an organisation register.
No framework and no build step: HTML, one stylesheet, one script.

| Page | What it does |
| --- | --- |
| `index.html` | Hero with a console view, the two signature workflows (Live → VOD, VOD → Live), the capability grid, the signal flow, pricing (read live from the API) and a call to action |
| `register.html` | Registers an organisation. Creates the **client** (the tenant account) and its owner, or joins the waitlist, depending on `SIGNUP_MODE` |
| `thanks.html` | Where Stripe Checkout returns. Polls the API until the payment is confirmed |

How registration works end to end is in `volt-app/docs/ONBOARDING.md`.

## Configure

Edit `config.js` (or have the deploy step write it):

```js
window.VOLT_SITE = { apiBase: 'https://api.voltstreaming.com', contactEmail: 'hello@voltstreaming.com' };
```

On the control plane:

| Variable | Meaning |
| --- | --- |
| `SIGNUP_MODE` | `waitlist` (default), `open` (free trial, account made at once), `paid` (Stripe Checkout first), `off` |
| `CORS_ORIGIN` | Must allow this site's origin, e.g. `https://voltstreaming.com` |
| `SITE_BASE_URL` | This site's address, for Stripe's return pages |
| `CONSOLE_BASE_URL` | The console, for the welcome links and the Sign in button |
| `SAAS_STRIPE_SECRET_KEY`, `SAAS_STRIPE_WEBHOOK_SECRET` | Paid mode. Webhook endpoint: `POST /api/signup/webhooks/stripe` (events `checkout.session.completed`, `customer.subscription.deleted`) |
| `SAAS_STRIPE_PRICE_<PLAN>` | The Stripe price for a plan, e.g. `SAAS_STRIPE_PRICE_STARTER=price_…`. A plan without one shows "Talk to us" |
| `SAAS_PLANS_JSON` | Replace the plan catalogue (names, prices shown, limits) |
| `SALES_EMAIL`, `TERMS_URL`, `PRIVACY_URL` | Shown on the register page |

The prices in the default catalogue are placeholders taken from the pricing model. Set the real ones with `SAAS_PLANS_JSON` before going public.

## Run locally

```sh
cd volt-site && python3 -m http.server 4173     # or: npx serve -l 4173
```

and start the control plane with, for example, `SIGNUP_MODE=open SITE_BASE_URL=http://localhost:4173`.
On a development server with `SECURITY_CODE_ECHO=1` the register page shows a link straight to the welcome page, so the whole flow can be tried without email.

## Deploy

Any static host. On AWS: an S3 bucket behind CloudFront, with `config.js` served `Cache-Control: no-cache` so the API address can change without a cache flush.
