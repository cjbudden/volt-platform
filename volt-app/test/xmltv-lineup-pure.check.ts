// ============================================================================
//  XMLTV import lineup, without a database: names, the feed's regional words,
//  suggestions, and same-named channels. The lineup is xmltv.net's Sydney feed
//  as it was on 10 Oct 2026 (names, channel numbers, programme counts only):
//  47 channels, "7 Sydney" three times, HD and SD simulcasts, a name with a
//  trailing tab, radio beside TV, and two channels with no programmes.
//
//  Usage: npx tsx test/xmltv-lineup-pure.check.ts
// ============================================================================
import { normName, commonWords, coreName, suggest, duplicateNames } from '../src/services/xmltvLineup';
import { XmlStream, mapChannel } from '../src/services/xmltvParse';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('PASS ' + m); pass++; }
  else { console.log(`FAIL ${m} -- expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`); fail++; }
};

const SYDNEY: [string, string, number][] = [
  ['SBS Sydney', '3', 270], ['10 Sydney', '10', 277], ['10 Comedy Sydney', '11', 382], ['10 Drama Sydney', '12', 260], ['Nickelodeon Sydney', '13', 409],
  ['10 HD Sydney +1', '14', 276], ['10 HD Sydney', '1', 277], ['gecko NSW', '17', 72], ['ABC TV HD NSW', '20', 217], ['ABC TV NSW', '2', 217],
  ['ABC Kids/ABC Family NSW\t', '22', 896], ['ABC Entertains NSW', '23', 427], ['ABC News (NSW) Australia', '24', 295], ['SBS HD Sydney', '30', 270],
  ['SBS2 HD NSW', '31', 251], ['SBS World Movies (NSW) Australia', '32', 95], ['SBS Food NSW', '33', 352], ['NITV HD NSW', '34', 334], ['NITV NSW', '36', 334],
  ['TVS', '44', 0], ['you.tv NSW', '16', 182], ['7Bravo NSW', '75', 202], ['TVSN NSW', '77', 193], ['RACING.COM NSW', '78', 204], ['7 Sydney', '70', 151],
  ['7 Sydney', '7', 151], ['7TWO HD Sydney', '72', 218], ['7mate Sydney', '73', 0], ['7mate HD Sydney', '74', 208], ['7flix NSW', '76', 225],
  ['9HD Sydney', '90', 217], ['Channel Nine Sydney', '9', 217], ['9Gem Sydney', '92', 215], ['9Go! Sydney', '93', 248], ['9Life Sydney', '94', 258],
  ['9Gem HD Sydney', '95', 215], ['9Rush Sydney Australia', '96', 249], ['Extra', '97', 359], ['9Go! HD Sydney', '99', 248], ['Double J Sydney', '200', 68],
  ['ABC Jazz Sydney', '201', 72], ['SBS Radio 1 NSW', '301', 85], ['SBS Radio 2 NSW', '302', 105], ['ABC TV NSW', '21', 217], ['7 Sydney', '71', 151],
  ['10 HD Sydney', '15', 277], ['Channel Nine Sydney', '91', 217],
];
const feed = SYDNEY.map(([name, lcn, count]) => ({ id: `ch${lcn}`, name, lcn, count }));

check('normalised name: case, punctuation, the trailing tab', normName('ABC Kids/ABC Family NSW\t'), 'abc kids abc family nsw');
check('normalised name keeps "9Go!" and "+1" distinct', [normName('9Go! Sydney'), normName('10 HD Sydney +1')], ['9go! sydney', '10 hd sydney +1']);
const common = commonWords(feed.map((f) => f.name));
check('the feed\'s regional words are found', [...common].sort(), ['nsw', 'sydney']);
check('core name drops them', [coreName('9Gem HD Sydney', common), coreName('SBS World Movies (NSW) Australia', common)], ['9gem hd', 'sbs world movies australia']);
check('a name that is only regional words keeps them', coreName('Sydney', common), 'sydney');
check('a small feed has no regional words', [...commonWords(['A Sydney', 'B Sydney'])], []);

const ours = [
  { id: 'abc', name: 'ABC TV' }, { id: 'sbs', name: 'SBS' }, { id: 'seven', name: '7 Sydney' }, { id: 'mate', name: '7mate' },
  { id: 'gem', name: '9Gem' }, { id: 'dj', name: 'Double J' }, { id: 'drama', name: '10 Drama' }, { id: 'news', name: 'RTM News 24' },
];
const s = suggest(feed, ours);
const by = (lcn: string) => s.get(`ch${lcn}`) ?? null;
check('ABC TV: suggested once, for the lowest number of the exact name (2, not 20 or 21)', [by('2'), by('20'), by('21')], ['abc', null, null]);
check('SBS: the SD channel (3), not the HD simulcast (30)', [by('3'), by('30')], ['sbs', null]);
check('7 Sydney on 7, 70 and 71: suggested once, for 7', [by('7'), by('70'), by('71')], ['seven', null, null]);
check('7mate: 73 has no programmes, so the HD channel 74 is suggested', [by('73'), by('74')], [null, 'mate']);
check('9Gem: 92 (exact) over 95 (HD)', [by('92'), by('95')], ['gem', null]);
check('radio and partial names: Double J, 10 Drama', [by('200'), by('12')], ['dj', 'drama']);
check('no Volt channel is suggested twice', new Set(s.values()).size, s.size);
check('nothing invented: 7 suggestions for 7 matching channels', s.size, 7);
check('two of ours that look alike suggest neither', suggest([{ id: 'f', name: 'Sport' }], [{ id: 'a', name: 'Sport' }, { id: 'b', name: 'sport' }]).size, 0);

const dup = duplicateNames(SYDNEY.map(([name, lcn]) => ({ id: lcn, display_name: name, lcn, external_id: `x${lcn}` })));
check('same-named: 7 Sydney on 7 lists 70 and 71', dup.get('7'), ['70', '71']);
check('same-named: Channel Nine on 9 and 91', [dup.get('9'), dup.get('91')], [['91'], ['9']]);
check('a unique name has no siblings', dup.get('3'), undefined);

const nodes: any[] = [];
const x = new XmlStream(new Set(['channel']), (n) => nodes.push(n));
x.write('<tv><channel id="251831auepg.com.au">\n<display-name>SBS Sydney</display-name>\n<lcn>3</lcn>\n<icon src="https://x.example/251831.png?a=1&amp;b=2" />\n</channel></tv>');
x.end();
check('the channel number is read from <lcn>', mapChannel(nodes[0]).lcn, '3');
check('the icon URL keeps its query', mapChannel(nodes[0]).icon, 'https://x.example/251831.png?a=1&b=2');

console.log(`\nxmltv-lineup-pure.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
