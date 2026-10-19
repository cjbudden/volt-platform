// ============================================================================
//  Fleet consolidation planner, without a fleet: the rules Christian set on
//  13 Oct 2026 (multiple under-used hosts, similar needs, no effect on the
//  streams already on the target, no downtime) each pinned by a case.
//
//  Usage: npx tsx test/consolidation-plan.check.ts
// ============================================================================
import { planConsolidation, DEFAULT_POLICY } from '../src/services/fleet/consolidation';
import { host, task, load, checker } from './fleet-fixtures';

const { check, done } = checker();

// 1. MULTIPLE is the key: one quiet host alone is never touched.
{
  const p = planConsolidation([host('a', [task()]), host('b', [task()], { cpuPct: 55 })]);
  check('single under-used host: nothing drains', p.drain, []);
  check('...and it says why', p.skipped[0]?.reason.startsWith('only 1 under-used'), true);
}

// 2. Two under-used hosts in one class: the emptier one drains into the other.
{
  const p = planConsolidation([host('a', [task()]), host('b', [task(), task()])]);
  check('two under-used hosts: the 1-stream host drains', p.drain, ['a']);
  check('its stream goes to the other host', p.moves.map((m) => [m.from, m.to]), [['a', 'b']]);
  check('one server saved', p.serversSaved, 1);
}

// 3. SIMILAR: under-used hosts in different classes do not count together.
{
  check('spot + on-demand never mix', planConsolidation([host('a', [task()]), host('b', [task()], { lifecycle: 'spot' })]).drain, []);
  check('cpu + gpu never mix', planConsolidation([host('a', [task()]), host('b', [task()], { instanceType: 'g4dn.xlarge', gpu: true })]).drain, []);
  check('shared + dedicated never mix', planConsolidation([host('a', [task()]), host('b', [task()], { pool: 'dedicated:x' })]).drain, []);
  check('different AZs never mix', planConsolidation([host('a', [task()]), host('b', [task()], { availabilityZone: 'ap-southeast-2b' })]).drain, []);
}

// 4. NO IMPACT: a target is never pushed over the ceiling, on CPU or network.
{
  const ok = planConsolidation([
    host('a', [task(load(500))]),
    host('b', [task(load(900))]),
    host('c', [task(load(1400))], { cpuPct: 45 }),
  ]);
  check('best fit: goes to the FULLEST host that still fits', ok.moves.map((m) => m.to), ['c']);
  const no = planConsolidation([host('a', [task(load(1000))]), host('b', [task(load(1000))])], { ...DEFAULT_POLICY, fit: { ...DEFAULT_POLICY.fit, ceiling: 0.4 } });
  check('would cross the ceiling: nothing drains', no.drain, []);
  const net = planConsolidation([host('a', [task(load(200, 300))]), host('b', [task(load(200, 300))])]);
  check('network-bound pair (each ~19% NIC, 38%+safety): drains', net.drain.length, 1);
  const net2 = planConsolidation([host('a', [task(load(200, 480))]), host('b', [task(load(200, 480))])], { ...DEFAULT_POLICY, underusedNet: 0.35 });
  check('network-bound pair over the ceiling together: nothing drains', net2.drain, []);
}

// 5. Measured load beats the estimate: a stream observed busier than modelled is moved as busy.
{
  const hot = task(load(300), { observedCpuUnitsP95: 1300 });
  const p = planConsolidation([host('a', [hot], { cpuPct: 28 }), host('b', [task(load(1100))], { cpuPct: 29 })], { ...DEFAULT_POLICY, fit: { ...DEFAULT_POLICY.fit, ceiling: 0.6 } });
  check('observed 1300 units, not the 300 estimate, decides the fit', p.drain, []);
}

// 6. ALL OR NONE: a host with one immovable stream is left whole.
{
  const p = planConsolidation([host('a', [task(), task(undefined, { ingest: 'push' })]), host('b', [task()]), host('c', [task()])], { ...DEFAULT_POLICY, maxHostsPerPass: 5 });
  check('push-ingest stream pins its host', p.skipped.find((s) => s.hostId === 'a')?.reason.includes('push ingest'), true);
  check('...but another under-used host can still drain', p.drain.length >= 1, true);
  check('...and nothing moves off the pinned host', p.moves.some((m) => m.from === 'a'), false);
}

// 7. NO DOWNTIME: streams the handoff cannot carry invisibly are not moved.
{
  const why = (o: Parameters<typeof task>[1]) =>
    planConsolidation([host('a', [task(undefined, o)]), host('b', [task(), task()])]).skipped[0]?.reason ?? '';
  check('unhealthy stream not moved', why({ healthy: false }).includes('not fully healthy'), true);
  check('stream on filler not moved', why({ onFallback: true }).includes('filler'), true);
  check('DRM stream not moved (v1)', why({ drm: true }).includes('DRM'), true);
  check('event ending soon is left to end', why({ endsInMinutes: 20 }).includes('ends soon'), true);
  check('recently moved stream is not moved again', why({ minutesSinceMove: 30 }).includes('cooldown'), true);
}

// 8. Missing telemetry is never idleness; a just-placed task makes the window untrusted.
{
  const p = planConsolidation([host('a', [task()], { observed: null }), host('b', [task()]), host('c', [task()], { observed: { cpuUnitsP95: 100, netBpsP95: 1, windowMinutes: 60, coverage: 0.5 } })]);
  check('a host with a gap is neither a candidate nor a target', p.drain, []);
  const q = planConsolidation([host('a', [task()]), host('b', [task(undefined, { pending: true })])]);
  check('a host with a pending placement is not trusted yet', q.classes[0].underused, 1);
}

// 9. One host per pass, and a receiver is not drained in the same pass.
{
  check('pass limit: one host drained', planConsolidation([host('a', [task()]), host('b', [task()]), host('c', [task()]), host('d', [task()])]).drain.length, 1);
  const q = planConsolidation([host('a', [task()]), host('b', [task()]), host('c', [task()])], { ...DEFAULT_POLICY, maxHostsPerPass: 5 });
  check('with a higher limit, 3 hosts -> 1', [q.drain.length, new Set(q.moves.map((m) => m.to)).size], [2, 1]);
}

// 10. Reservation and slots are enforced on the target too.
{
  const s = planConsolidation([host('a', [task()]), host('b', [task(), task(), task()], { cpuPct: 20 })]);
  check('target with every slot used cannot receive, and 3 streams do not fit 2 free slots', s.drain, []);
  check('...both directions are explained', s.skipped.map((x) => x.reason), ['not every stream fits elsewhere without crossing the ceiling', 'not every stream fits elsewhere without crossing the ceiling']);
}

done();
