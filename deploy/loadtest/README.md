# Viewer-start load test

Faults (kill an encoder, lose a source, lose a zone, Spot interruption) and
scaling under this load are run with the chaos harness: see `CHAOS.md`.

`viewer-start.js` (k6) simulates a kick-off: viewers arriving at a rising
rate, each calling the play gate (`GET /api/availability`), sending a `start`
beacon and a couple of heartbeats. It reports play-gate and beacon latency and
the edge cache hit rate, and fails if p95 goes over 300 ms or more than 1 % of
requests fail.

## Prepare

1. Install k6 (https://k6.io/docs/get-started/installation/).
2. In the console: create an app (type web or tv) and copy its publishable
   key; create a channel, start it and take it **On air** (the gate answers
   for it either way, but `delivery` URLs only appear while it is live).

## Run against staging

```bash
k6 run -e BASE=http://<staging-server> \
       -e APP_KEY=pk_live_... -e ASSET=<channel uuid> \
       -e PEAK=500 -e RAMP=60s -e HOLD=120s \
       deploy/loadtest/viewer-start.js
```

Raise `PEAK` (starts per second) step by step: 500, 1,000, 2,000, 5,000.
Meanwhile watch:

```bash
docker compose -f deploy/staging/docker-compose.yml stats
curl -s http://<staging-server>/health/ready | jq '.cache, .pool, .analytics'
```

`edge_cache_hit` should sit above 95 %. To measure what ONE api-public process
sustains without the edge (the number for `PREWARM_STARTS_PER_TASK`), point
`BASE` at a single api-public container directly and add a fresh `ORIGIN` per
run, or temporarily set `EDGE_AVAILABILITY_MAX_AGE=0`.

## Run against AWS

Same command with `BASE=https://<api_edge_domain>`. `X-Test-Country` is
ignored there (CloudFront supplies the country). One k6 machine drives about
5,000 to 10,000 starts a second; for the full 11,000 to 17,000 a second use
several machines in different regions, or k6 Cloud. Tell AWS Support before a
very large test against CloudFront.

Record per run: peak starts/s, p95, api-public task count and CPU, RDS CPU and
connections, Valkey CPU. Set `prewarm_starts_per_task` to what one task held
at about 60 % CPU.
