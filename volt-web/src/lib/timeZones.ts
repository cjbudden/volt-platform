// The time zone choices for a FAST channel's clock.
//
// Why this exists: Intl.supportedValuesOf('timeZone') lists canonical IANA
// zones only, and browsers leave `UTC` out of it. A browser in UTC (and any
// channel saved as UTC) then had no matching option, so the select showed the
// first zone in the list (Africa/Abidjan) while UTC was what got saved.
// UTC goes first, and a saved zone the list does not know is kept as a choice
// so the select always shows what is really stored.

const FALLBACK = ['Australia/Brisbane', 'Australia/Sydney', 'Europe/London', 'America/New_York']

export function zoneList(supported?: string[] | null, current?: string | null): string[] {
  let all: string[]
  if (supported) all = supported
  else {
    try { all = (Intl as any).supportedValuesOf('timeZone') as string[] } catch { all = FALLBACK }
  }
  const out = ['UTC', ...all.filter(z => z !== 'UTC' && z !== 'Etc/UTC')]
  if (current && !out.includes(current)) out.splice(1, 0, current)
  return out
}

/** The browser's zone, `UTC` when it cannot tell (or says Etc/UTC). */
export function browserZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone
    return !z || z === 'Etc/UTC' ? 'UTC' : z
  } catch { return 'UTC' }
}
