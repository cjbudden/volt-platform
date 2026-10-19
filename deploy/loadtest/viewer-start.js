// Volt viewer-start load test (k6).
//
// Simulates the kick-off rush: viewers arriving at a rising rate, each one
// asking the play gate for a token and sending a `start` beacon, then a few
// heartbeats. Reports latency per step and the edge cache hit rate.
//
//   k6 run -e BASE=http://staging.example.internal \
//          -e APP_KEY=pk_live_... -e ASSET=<channel uuid> \
//          -e PEAK=2000 -e RAMP=60s -e HOLD=120s \
//          deploy/loadtest/viewer-start.js
//
// PEAK is viewer starts per SECOND at the top of the ramp. 1M viewers in 90 s
// is ~11,000/s; one k6 machine drives roughly 5-10k/s, so run several (or
// k6 cloud / distributed k6) for the full figure. Start with PEAK=500 against
// staging and raise it.
//
// Geo: staging's nginx takes the viewer country from X-Test-Country; behind
// CloudFront it comes from the viewer's real location and the header is ignored.
//
// Thresholds fail the run if p95 latency or errors go above target, so this
// can gate a release.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost';
const APP_KEY = __ENV.APP_KEY;
const ASSET = __ENV.ASSET;
const PEAK = Number(__ENV.PEAK || 500);
const RAMP = __ENV.RAMP || '60s';
const HOLD = __ENV.HOLD || '60s';
const HEARTBEATS = Number(__ENV.HEARTBEATS || 2);
const ORIGIN = __ENV.ORIGIN || '';                 // set for web apps with an origin allow-list
const COUNTRIES = (__ENV.COUNTRIES || 'AU,NZ,SG,PH,HK').split(',');

if (!APP_KEY || !ASSET) throw new Error('set -e APP_KEY=pk_... -e ASSET=<uuid>');

const edgeHit = new Rate('edge_cache_hit');
const gateMs = new Trend('gate_ms', true);
const beaconMs = new Trend('beacon_ms', true);

export const options = {
  scenarios: {
    kickoff: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.floor(PEAK / 20)),
      timeUnit: '1s',
      preAllocatedVUs: Math.max(100, PEAK),
      maxVUs: Math.max(500, PEAK * 4),
      stages: [
        { target: PEAK, duration: RAMP },
        { target: PEAK, duration: HOLD },
        { target: 0, duration: '15s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    gate_ms: ['p(95)<300'],
    beacon_ms: ['p(95)<300'],
  },
};

export default function () {
  const country = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
  const headers = { 'X-Test-Country': country };
  if (ORIGIN) headers.Origin = ORIGIN;

  const gate = http.get(`${BASE}/api/availability?appKey=${encodeURIComponent(APP_KEY)}&assetId=${ASSET}`, { headers, tags: { step: 'gate' } });
  gateMs.add(gate.timings.duration);
  const xc = gate.headers['X-Edge-Cache'] || gate.headers['X-Cache'] || '';
  edgeHit.add(/HIT/i.test(xc));
  const okGate = check(gate, { 'gate answered': (r) => r.status === 200 || r.status === 451 || r.status === 402 });
  if (!okGate || gate.status !== 200) return;

  const token = gate.json('playbackToken');
  const session = `lt-${__VU}-${__ITER}-${Date.now()}`;
  const send = (event, seconds) => {
    const r = http.post(`${BASE}/api/analytics/beacon`, JSON.stringify({ playbackToken: token, sessionId: session, event, seconds }),
      { headers: { 'Content-Type': 'application/json' }, tags: { step: 'beacon' } });
    beaconMs.add(r.timings.duration);
    check(r, { 'beacon accepted': (x) => x.status === 202 });
  };
  send('start', 0);
  for (let i = 0; i < HEARTBEATS; i++) {
    sleep(1 + Math.random());
    send('heartbeat', 30);
  }
}
