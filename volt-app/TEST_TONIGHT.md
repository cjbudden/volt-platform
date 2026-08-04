# Volt Streaming — Test it tonight

Bring the whole platform up locally and click through it in a browser. No AWS
needed (the orchestrator runs in `mock` mode).

## Prerequisites
- **Node 20+** and **npm**
- **PostgreSQL 14+** running locally, with an empty/disposable database and
  `psql` on your PATH
- (Optional, for the real media pipeline test) `ffmpeg` + Shaka `packager`

## 1. One command
```bash
cd volt-app
npm install          # first time only
createdb volt        # or any empty DB; see DATABASE_URL below
./run-local.sh
```
`run-local.sh` resets the schema, seeds realistic demo data (2 tenants, live
channels, EPG, VOD, viewers, tickets), and starts the API + console. Point it at
your DB if it isn't the default:
```bash
DATABASE_URL=postgres://USER:PASS@localhost:5432/volt ./run-local.sh
```

## 2. Open the console
```
http://localhost:8080/console
```
Sign in (password **volt1234**):
- **Client admin** — `admin@rtm.example` — the tenant view: Overview, Channels
  (Start/Stop), Events, EPG (now/next), VOD, Analytics (by app/device), Tickets,
  Notifications.
- **SaaS admin** — `saas@volt.example` — adds the **SaaS Admin** tab: active
  servers, projected instances today, active channels + viewers across ALL
  tenants, API status, open tickets.

Things to try: start/stop a channel; file a ticket (see it appear for the SaaS
admin cross-tenant); send a notification; flip between the two logins to see
tenant isolation (each only sees its own data).

## 3. Test the API directly
- **Hydra entrypoint** (navigate the whole API graph):
  `curl http://localhost:8080/api` and follow the links; add
  `-H 'Accept: application/ld+json'` on any GET for the JSON-LD + Hydra form.
- **Full API suite** (34 endpoints, headless): point it at an *empty* DB —
  `DATABASE_URL=postgres://…/volt_verify ./api/verify.sh` → 34 req / 38 assert / 0 fail.
- **Postman**: import `api/Volt.postman_collection.json` (+ environment); every
  request ships a saved example response. `docs/api-playground.html` is the same
  as a searchable page. New endpoint groups are in `docs/API-additions.md`.

## 4. Test the media pipeline (optional, real encode)
```bash
cd e2e
./local-pipeline-test.sh     # ffmpeg → Shaka → HLS+DASH+CMAF, decodable (no Docker)
./run-e2e.sh                 # full Docker stack: encoder → MinIO + live status
./extractor-test.sh          # clip extraction → decodable MP4
```

## 5. Automated backend tests (what's proven)
```bash
# each needs an empty DB via DATABASE_URL; run from volt-app/
bash api/verify.sh                    # API 34/38
npx tsx test/orchestrator.check.ts    # lifecycle 30/30
bash test/hypermedia.check.sh         # JSON-LD + Hydra
bash test/saas.check.sh               # tenancy isolation + platform dashboard
bash test/access-control.check.sh     # public vs admin enforcement
bash test/mfa-login.check.sh          # SaaS-admin 2-step login
bash test/geo-rights.check.sh         # blackout → replacement
bash test/notifications.check.sh      # notification fan-out + retry
bash test/retrim.check.sh             # non-destructive clip re-trim
# encoder unit tests: cd ../volt-encoder/bin && python3 test_*.py
```

## Notes
- `ORCH_LAUNCHER=mock` means channels "start" without launching real AWS tasks —
  status/recordings/analytics all work for the walkthrough. Set `=ecs` only in the
  deployed environment (see `deploy/terraform/`).
- The console is a lightweight test client (single HTML file, `public/console.html`).
  The production admin is the React app on the roadmap; this is enough to exercise
  and demo the platform tonight.
