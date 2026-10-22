# Onboarding: invitations, registration and password reset

How people get into Volt without anyone handling their password.

## The model

- A **client** is a tenant account (`accounts`). Everything in Volt belongs to one.
- A **user** belongs to one client and has a tier and roles (ACCESS_CONTROL.md).
- A client is created in one of three ways: by platform staff, by registering on the promo site (`volt-site/`), or with `/api/auth/register` in development.
- Users join a client by **invitation** from someone in that client who manages users.

## One flow for every way in

Admin invitations, promo site registrations and forgotten passwords all use the same three steps.

1. **Link.** The person gets an email with a one-time link: `<console>/welcome#t=…` (or `/reset-password#t=…`).
2. **Code.** Opening the link changes nothing. It shows who the link is for, with a button that emails a 6-digit code to the same address. The code proves the person holds the mailbox now, not just that the link reached someone once.
3. **Password.** The right code is exchanged for a 15 minute setup token, and that token sets the password. The person is signed in, or taken through two-step sign-in if the client requires it.

Why the code step: a link is a bearer secret that travels. It is forwarded, pasted into tickets, opened by mail scanners and kept in history. With the code, a leaked link is not enough to take the account, and a scanner that opens the page does nothing.

### Security properties

| Property | How |
| --- | --- |
| Tokens are not stored | 256 random bits; only the SHA-256 is kept (`user_access_links.token_hash`) |
| Tokens stay out of logs | They sit in the URL fragment, which browsers never send. The console moves them into the tab's session storage and clears the address bar. API calls carry them in the body |
| One live link per person | A newer link of the same kind revokes the older one. Using a link revokes every other open link for that person |
| Expiry | Invitations `INVITE_TTL_HOURS` (default 168, 7 days). Reset links `RESET_TTL_MINUTES` (default 60). Codes 10 minutes, 5 guesses, rate limited (the shared security code store) |
| No probing | Every unusable link (wrong, used, revoked, expired, user disabled) gets the same `410 link_invalid`. Forgot password answers the same for any address. Registering a known address makes no account and emails a pointer to sign-in instead |
| Passwords | At least 10 characters, not a common password, not containing the email name. Setting one ends every existing session |
| Setup token | Audience `volt:onboard`, type `onboard_setup`, 15 minutes, single use (the link is locked and consumed). It is not a session: the admin API refuses it |
| Two-step sign-in | If the client requires it, finishing returns the same challenge as sign-in, which enrols a method |

## Admin invitations

In the console: **Admin → Users & Roles → Invite user**. Choose roles as usual. "Email an invitation" is the default. "Set a password now" remains for an address that cannot receive mail.

The user is `invited` (cannot sign in) until they finish. Their drawer shows when the invitation was sent and when it expires, with **Send again** (the old link stops working) and **Withdraw**. Disabling an invited user kills their link.

The same guard rails as creating a user apply: nobody invites someone with more access than they have, and only an owner invites an owner.

| Route | Access | |
| --- | --- | --- |
| `POST /api/users/invite` | users:manage | `{email, displayName?, roleIds[], role?}`. Returns the user and `invite: {sent, sentTo, expiresAt, error?}` |
| `POST /api/users/:id/invite` | users:manage | Send a fresh link |
| `DELETE /api/users/:id/invite` | users:manage | Withdraw open links |
| `GET /api/users/:id` | users:view | Now includes `invite: {sentAt, expiresAt, expired, verified}` for an invited user |

## Public onboarding routes

| Route | |
| --- | --- |
| `POST /api/onboarding/link {token}` | Who the link is for: masked email, client name, who invited them, whether they are the client's founder |
| `POST /api/onboarding/code {token}` | Email the code |
| `POST /api/onboarding/verify {token, code}` | `{setupToken, expiresIn: 900}` |
| `POST /api/onboarding/complete {setupToken, password, displayName?, accountName?}` | A session, or a two-step sign-in step. `next: 'invite_team'` for a founder |
| `POST /api/onboarding/forgot {email}` | Always 202. Active user: reset link. Invited user: a fresh welcome link |

Console pages: `/welcome`, `/reset-password`, `/forgot-password` (linked from the sign-in form).

## Registration from the promo site (SaaS)

Registering creates the **client** and its first user, the **founder**, who becomes its owner with the Administrator role. The organisation name on the form is the client's name, and the founder can confirm or change it when they choose their password. After that they land on Users & Roles to invite their team, and each colleague goes through the same invitation flow into the same client.

`SIGNUP_MODE` decides what registering does:

| Mode | What happens |
| --- | --- |
| `waitlist` (default) | The details are stored as a lead (`saas_signups`) and a thank-you email is sent. Platform staff let a lead in with `POST /api/platform/signups/:id/invite`, which creates the client and sends the welcome link |
| `open` | The client is created at once on the chosen plan (its limits from the plan catalogue), and the founder gets the welcome link. A free trial |
| `paid` | The client is created `pending` and the founder is sent to Stripe Checkout. The webhook `checkout.session.completed` activates the client and sends the welcome link. `customer.subscription.deleted` suspends it and ends its sessions |
| `off` | Registration closed; the site still shows the product |

Enterprise (talk-to-us) plans are always leads. A hidden honeypot field drops bots quietly, and registrations are rate limited per network and per address.

| Route | |
| --- | --- |
| `GET /api/signup/config` | Mode, plans (no Stripe ids), whether online purchase is on, console URL |
| `POST /api/signup` | `{email, name?, company, plan?, website (honeypot), source?}`. Answers `waitlist`, `check_email`, `contact`, or `checkout` with `checkoutUrl` |
| `POST /api/signup/checkout-status {sessionId}` | For the thank-you page: `pending`, `active` or `cancelled` |
| `POST /api/signup/webhooks/stripe` | Stripe, verified by `SAAS_STRIPE_WEBHOOK_SECRET` over the raw body |
| `GET /api/platform/signups` | Platform staff: registrations, newest first (`?status=&q=`) |
| `POST /api/platform/signups/:id/invite` | Platform support: turn a waitlist lead into a client |

The plan catalogue is `services/saasPlans.ts`. Replace it with `SAAS_PLANS_JSON`, and connect a plan to Stripe with `SAAS_STRIPE_PRICE_<PLAN>`. The default prices are placeholders.

`POST /api/auth/register` (account plus owner with a password, no email check) is closed in production unless `ALLOW_DIRECT_REGISTER=1`.

## Email

Welcome, reset, already-registered and waitlist emails have a plain text and an HTML part (`services/mail/templates.ts`, sent as multipart/alternative by `services/mail/smtp.ts`). Because they carry a secret link they are sent directly and never stored in the notifications log. Configure `SMTP_URL` and `NOTIFY_FROM`, and set `CONSOLE_BASE_URL` so links point at the console.

## Tests

- `test/onboarding.check.ts`: 78 assertions. Invitation, the three steps, resend, withdraw, disabled invitee, forgotten password, two-step policy, escalation guard, waitlist, open trial with founder naming the client and inviting a colleague, paid signup against a fake Stripe with forged and real webhooks, cancellation.
- `test/onboarding-mail.check.ts`: 22 assertions. Templates, escaping, multipart structure, password rules.
