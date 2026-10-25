// FAST time zone choices (build queue 1.14-G1a).
//   npx tsx volt-web/test/time-zones.check.ts
import { zoneList } from '../src/lib/timeZones'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)))

// What Chromium's Intl.supportedValuesOf('timeZone') looks like: no UTC.
const chromeLike = ['Africa/Abidjan', 'Africa/Accra', 'Australia/Sydney', 'Europe/London']
const a = zoneList(chromeLike, 'UTC')
ok(a[0] === 'UTC', 'UTC is offered, first')
ok(a.filter(z => z === 'UTC').length === 1, 'UTC once only')
ok(a.includes('Africa/Abidjan') && a.length === chromeLike.length + 1, 'the browser list is kept')
ok(zoneList([...chromeLike, 'UTC', 'Etc/UTC'], null).filter(z => /UTC/.test(z)).join() === 'UTC', 'a list that has UTC or Etc/UTC still shows one UTC')
const b = zoneList(chromeLike, 'Asia/Kolkata')
ok(b.includes('Asia/Kolkata'), 'a saved zone the list does not know stays a choice, so the select shows what is stored')
ok(zoneList(chromeLike, 'Europe/London').length === chromeLike.length + 1, 'a known saved zone is not added twice')
const real = zoneList(null, 'UTC')
ok(real[0] === 'UTC' && real.length > 10, `this runtime's list starts with UTC (${real.length} zones)`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
