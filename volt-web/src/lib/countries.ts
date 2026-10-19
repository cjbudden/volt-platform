// Every ISO 3166-1 alpha-2 country, named in English by the browser
// (Intl.DisplayNames), sorted by name. Used by the geo pickers (Account
// settings, the output pane's "view as a viewer in...").
const CODES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE ' +
  'GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP ' +
  'KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF ' +
  'NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN ' +
  'SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ' +
  'ZA ZM ZW').split(' ')

let names: Intl.DisplayNames | null = null
try { names = new Intl.DisplayNames(['en'], { type: 'region' }) } catch { names = null }

export const countryName = (code: string) => { try { return names?.of(code.toUpperCase()) ?? code.toUpperCase() } catch { return code.toUpperCase() } }

export const COUNTRIES: { code: string; name: string }[] =
  CODES.map(code => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name))

/** "Australia (AU)" or "au" or "Australia" to "AU"; null when it is not a country. */
export function toCountryCode(text: string): string | null {
  const t = text.trim()
  const m = /\(([A-Za-z]{2})\)\s*$/.exec(t)
  if (m) return CODES.includes(m[1].toUpperCase()) ? m[1].toUpperCase() : null
  if (/^[A-Za-z]{2}$/.test(t) && CODES.includes(t.toUpperCase())) return t.toUpperCase()
  const hit = COUNTRIES.find(c => c.name.toLowerCase() === t.toLowerCase())
  return hit ? hit.code : null
}
