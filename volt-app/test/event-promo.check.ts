// ============================================================================
//  Event promo projection: what the player renders, derived from the schema.org
//  metadata we capture. Pure logic, no database.
//
//    npx tsx test/event-promo.check.ts
// ============================================================================
import assert from 'node:assert';
import {
  inferTemplate, promoFromMetadata, presentationFromEventStatus, sportsEventJsonLd,
} from '../src/services/eventPromo';

let n = 0;
const ok = (label: string, fn: () => void) => { fn(); n++; console.log(`  ok  ${label}`); };

const HARBOUR = { id: 't1', name: 'Harbour', logo: 'https://cdn/h.png', subtitle: 'Won last 5' };
const NORTH = { id: 't2', name: 'Northbank', logo: 'https://cdn/n.png', subtitle: '2nd, 71 pts' };

console.log('template inference');
ok('home + away is a fixture', () => {
  assert.equal(inferTemplate('SportsEvent', { homeTeam: HARBOUR, awayTeam: NORTH }), 'versus');
});
ok('two competitors is also a fixture', () => {
  assert.equal(inferTemplate('SportsEvent', { competitor: [HARBOUR, NORTH] }), 'versus');
});
ok('more than two competitors is a field', () => {
  assert.equal(inferTemplate('SportsEvent', { competitor: [HARBOUR, NORTH, { id: 't3' }] }), 'field');
});
ok('performers with no job title are a billing', () => {
  assert.equal(inferTemplate('MusicEvent', { performer: [{ id: 'p', name: 'The Nocturnes' }] }), 'billing');
});
ok('a job title turns the same shape into a session', () => {
  assert.equal(inferTemplate('Event', { performer: [{ id: 'p', name: 'Dr Boyd', jobTitle: 'Chair' }] }), 'people');
});
ok('a bulletin is plain', () => assert.equal(inferTemplate('BroadcastEvent', {}), 'plain'));
ok('an explicit choice still wins', () => {
  assert.equal(inferTemplate('SportsEvent', { homeTeam: HARBOUR, awayTeam: NORTH, promoTemplate: 'billing' }), 'billing');
});

console.log('projection');
ok('a fixture projects two sides, in order, with badges', () => {
  const p = promoFromMetadata({
    homeTeam: HARBOUR, awayTeam: NORTH,
    superEvent: { name: 'Coastal Cup' }, location: { name: 'Harbour Stadium' }, round: 'Round 38',
  }, { type: 'SportsEvent' })!;
  assert.equal(p.template, 'versus');
  assert.deepEqual(p.sides!.map((s) => s.name), ['Harbour', 'Northbank']);
  assert.equal(p.sides![0].imageUrl, 'https://cdn/h.png');
  assert.equal(p.sides![1].subtitle, '2nd, 71 pts');
  assert.equal(p.headline, 'Coastal Cup');
  assert.equal(p.subhead, 'Harbour Stadium · Round 38');
});
ok('a speaker\'s role becomes the qualifier', () => {
  const p = promoFromMetadata({
    performer: [{ id: 'p1', name: 'Dr Amara Boyd', image: 'https://cdn/a.png', affiliation: { name: 'Marine Institute' } }],
  }, { type: 'Event' })!;
  assert.equal(p.template, 'people');
  assert.equal(p.sides![0].subtitle, 'Marine Institute');
  assert.equal(p.sides![0].imageUrl, 'https://cdn/a.png');
});
ok('a bare event promotes nothing rather than an empty panel', () => {
  assert.equal(promoFromMetadata({}, { type: 'BroadcastEvent' }), null);
});
ok('a resolver supplies what an inline reference lacks', () => {
  const p = promoFromMetadata({ homeTeam: 't1', awayTeam: 't2' }, {
    type: 'SportsEvent',
    resolve: (r) => (r.id === 't1' ? HARBOUR : NORTH),
  })!;
  assert.equal(p.sides![0].name, 'Harbour');
  assert.equal(p.sides![0].imageUrl, 'https://cdn/h.png');
});

console.log('eventStatus drives the phase');
ok('cancelled', () => assert.equal(presentationFromEventStatus('EventCancelled'), 'cancelled'));
ok('postponed', () => assert.equal(presentationFromEventStatus('EventPostponed'), 'postponed'));
ok('rescheduled is a postponement with a new date', () => {
  assert.equal(presentationFromEventStatus('https://schema.org/EventRescheduled'), 'postponed');
});
ok('scheduled says nothing about the phase', () => {
  assert.equal(presentationFromEventStatus('EventScheduled'), null);
});

console.log('JSON-LD out');
ok('the same bag serialises to SportsEvent', () => {
  const ld = sportsEventJsonLd(
    { id: 'e1', name: 'Coastal Cup Final', scheduled_start: '2026-10-12T09:00:00Z' },
    { homeTeam: HARBOUR, awayTeam: NORTH, superEvent: { name: 'Coastal Cup' }, sport: 'Football',
      eventStatus: 'EventPostponed', previousStartDate: '2026-10-05T09:00:00Z' },
    { type: 'SportsEvent', baseUrl: 'https://api.example.com' }
  );
  assert.equal(ld['@type'], 'SportsEvent');
  assert.equal(ld.homeTeam.name, 'Harbour');
  assert.equal(ld.homeTeam.logo, 'https://cdn/h.png');
  assert.equal(ld.awayTeam['@type'], 'SportsTeam');
  assert.equal(ld.eventStatus, 'https://schema.org/EventPostponed');
  assert.equal(ld.previousStartDate, '2026-10-05T09:00:00.000Z');
  assert.equal(ld.superEvent.name, 'Coastal Cup');
});
ok('nothing undefined survives serialisation', () => {
  const ld = sportsEventJsonLd({ id: 'e2' }, {}, {});
  assert.equal(JSON.stringify(ld).includes('undefined'), false);
  assert.equal(ld['@type'], 'Event');
});

console.log(`\n${n}/${n} assertions passed.`);
