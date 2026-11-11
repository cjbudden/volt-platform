// ============================================================================
//  The policy's five sections in the rule editor (build queue P3-2).
//
//  A rung of the publishing ladder is shown as the five sections of a policy
//  (PUBLISHING_POLICIES.md): Lifecycle, Access, Protection, Distribution and
//  Retention. The plain keys (geo, expire...) are whole values; the fields of
//  protection, distribution and retention resolve one by one on the server
//  (services/publishingRules.ts SECTION_FIELDS), so here each is its own row
//  with a dotted id ("protection.drm"), the same name a lock uses.
//
//  This file holds what is about those rows: their ids and labels, reading
//  and writing a dotted id inside a rung's settings, how an inherited value
//  reads, the controls for the section fields, and the padlock.
// ============================================================================
import type { ReactElement } from 'react'
import type { RuleKey } from '../api'
import type { PolicySettings, SectionKey } from './policyApi'
import { SECTION_KEYS } from './policyApi'

export type FieldId = RuleKey | `${SectionKey}.${string}`

/** The sections in the order a policy is read, the same grouping as the API's GET /fields. */
export const SECTIONS: { key: 'lifecycle' | 'access' | 'protection' | 'distribution' | 'retention'; label: string; hint: string; fields: FieldId[] }[] = [
  { key: 'lifecycle', label: 'Lifecycle', hint: 'When content is published, becomes available and expires, and what must pass first.',
    fields: ['autoPublish', 'availableFrom', 'expire', 'gate'] },
  { key: 'access', label: 'Access', hint: 'Who can watch, where, and whether they pay.',
    fields: ['accessRules', 'geo', 'access', 'paywall'] },
  { key: 'protection', label: 'Protection', hint: 'How playback is protected. DRM changes the files, so turning it on or off for published titles asks first.',
    fields: ['protection.drm', 'protection.tokenLifetimeSec', 'protection.waf', 'protection.referrers', 'protection.concurrentStreams', 'protection.tokenFree'] },
  { key: 'distribution', label: 'Distribution', hint: 'Where it is published and what else may be done with it.',
    fields: ['targets', 'distribution.mp4Download', 'distribution.shareLinks', 'distribution.fastEligible', 'distribution.sitemap', 'archive'] },
  { key: 'retention', label: 'Retention', hint: 'How long a title is kept. Stored now; the sweep that deletes comes later.',
    fields: ['retention.keep', 'retention.days', 'retention.anchor', 'retention.legalHoldAllowed', 'retention.archiveTier'] },
]

export const SECTION_FIELD_LABEL: Record<string, string> = {
  'protection.drm': 'DRM', 'protection.tokenLifetimeSec': 'Playback token lifetime', 'protection.waf': 'WAF profile',
  'protection.referrers': 'Allowed referrer domains', 'protection.concurrentStreams': 'Concurrent streams', 'protection.tokenFree': 'Token-free playback',
  'distribution.mp4Download': 'MP4 download', 'distribution.shareLinks': 'Share links', 'distribution.fastEligible': 'FAST eligible',
  'distribution.sitemap': 'Sitemap and schema.org', 'retention.keep': 'Retention', 'retention.days': 'Retention days',
  'retention.anchor': 'Retention counts from', 'retention.legalHoldAllowed': 'Legal hold allowed', 'retention.archiveTier': 'Archive storage tier',
}

/** The platform's own values beneath the account default (services/publishingRules.ts BASELINE). */
export const BASELINE_SECTIONS = {
  protection: { drm: false, tokenLifetimeSec: null, waf: 'off', referrers: [], concurrentStreams: null, tokenFree: false },
  distribution: { mp4Download: true, shareLinks: true, fastEligible: true, sitemap: true },
  retention: { keep: 'forever', days: null, anchor: 'available_until', legalHoldAllowed: true, archiveTier: null },
} as const

export const isSectionField = (id: string): id is `${SectionKey}.${string}` => id.includes('.')
const split = (id: string) => id.split('.') as [SectionKey, string]

/** A field's value in a rung's settings; undefined when the rung does not state it. */
export function getVal(s: PolicySettings | Record<string, any> | null | undefined, id: FieldId): any {
  if (!s) return undefined
  if (!isSectionField(id)) return (s as any)[id]
  const [sec, f] = split(id)
  return (s as any)[sec]?.[f]
}

/** A copy of the settings with the field set, or removed when `v` is undefined.
 *  An emptied section is removed too, so the rung inherits it whole. */
export function withVal(s: PolicySettings, id: FieldId, v: any): PolicySettings {
  const n: any = { ...s }
  if (!isSectionField(id)) { if (v === undefined) delete n[id]; else n[id] = v; return n }
  const [sec, f] = split(id)
  const part = { ...(n[sec] ?? {}) }
  if (v === undefined) delete part[f]; else part[f] = v
  if (Object.keys(part).length) n[sec] = part; else delete n[sec]
  return n
}

/** Every field a rung states, by id (for counting and for presets). */
export function statedIds(s: PolicySettings): FieldId[] {
  const out: FieldId[] = []
  for (const [k, v] of Object.entries(s ?? {})) {
    if ((SECTION_KEYS as string[]).includes(k)) { for (const [f, x] of Object.entries(v ?? {})) if (x !== undefined) out.push(`${k as SectionKey}.${f}`) }
    else if (v !== undefined) out.push(k as RuleKey)
  }
  return out
}

/** The baseline value of a section field. */
export const baselineOf = (id: `${SectionKey}.${string}`) => { const [sec, f] = split(id); return (BASELINE_SECTIONS as any)[sec][f] }

const WAF_LABEL = { off: 'Off', standard: 'Standard: VPN and proxy flagged', rights_managed: 'Rights-managed: VPN, proxy, hosting and Tor blocked or challenged' } as const
const ANCHOR_LABEL = { ingest: 'when it came in', available_from: 'when it became available', available_until: 'when it stops being available' } as const

/** How an inherited section value reads. */
export function describeSection(id: string, v: any): string {
  if (v === undefined) return 'not set'
  switch (id) {
    case 'protection.drm': return v ? 'on' : 'off'
    case 'protection.tokenLifetimeSec': return v == null ? 'platform default' : v % 60 === 0 ? `${v / 60} min` : `${v} s`
    case 'protection.waf': return (WAF_LABEL as any)[v] ?? v
    case 'protection.referrers': return v?.length ? v.join(', ') : 'any site'
    case 'protection.concurrentStreams': return v == null ? 'no limit' : `${v} at once`
    case 'protection.tokenFree': return v ? 'plain addresses' : 'play tokens'
    case 'retention.keep': return v === 'days' ? 'for a number of days' : 'forever'
    case 'retention.days': return v == null ? 'not set' : `${v} day${v === 1 ? '' : 's'}`
    case 'retention.anchor': return (ANCHOR_LABEL as any)[v] ?? v
    // The Storage page's words for the classes (pages/Storage.tsx): what the tier does, not its cloud name.
    case 'retention.archiveTier': return v == null ? 'stays where it is' : v === 'glacier' ? 'Archive, restore in hours' : 'Infrequent access'
    default: return typeof v === 'boolean' ? (v ? 'allowed' : 'not allowed') : String(v)
  }
}

/** The control for one section field. */
export function SectionFieldControl({ id, value, onChange }: { id: string; value: any; onChange: (v: any) => void }): ReactElement {
  const inp = { className: 'inp', style: { fontSize: 'var(--fs-sm)', padding: '5px 8px' } as const }
  const check = (label: string) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
      <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />{label}
    </label>)
  switch (id) {
    case 'protection.drm': return check('Encrypt with DRM')
    case 'protection.tokenLifetimeSec':
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-sm)' }}>
          <input {...inp} type="number" min={1} max={1440} aria-label="Token lifetime in minutes" placeholder="default" style={{ ...inp.style, width: 100 }}
            value={value == null ? '' : Math.round(value / 60)}
            onChange={e => onChange(e.target.value === '' ? null : Math.min(86_400, Math.max(60, Math.round(Number(e.target.value)) * 60)))} />
          <span style={{ color: 'var(--muted)' }}>minutes; empty for the platform default</span>
        </div>)
    case 'protection.waf':
      return (
        <select className="inp sel-sm" value={value ?? 'off'} onChange={e => onChange(e.target.value)}>
          <option value="off">Off</option><option value="standard">Standard: VPN and proxy flagged</option><option value="rights_managed">Rights-managed: VPN, proxy, hosting and Tor blocked</option>
        </select>)
    case 'protection.referrers':
      return <input {...inp} placeholder="example.com, *.example.com (empty: any site)" value={(value ?? []).join(', ')}
        onChange={e => onChange(e.target.value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean))} />
    case 'protection.concurrentStreams':
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-sm)' }}>
          <input {...inp} type="number" min={1} max={100} aria-label="Streams at once" placeholder="no limit" style={{ ...inp.style, width: 100 }}
            value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Math.min(100, Math.max(1, Math.round(Number(e.target.value)))))} />
          <span style={{ color: 'var(--muted)' }}>streams one viewer may play at once; empty for no limit</span>
        </div>)
    // Build queue P2-2c: refused by the server when a viewer condition applies (shown under Before you save).
    case 'protection.tokenFree':
      return (
        <div style={{ display: 'grid', gap: 4 }}>
          {check('Play by plain address, without a play token')}
          <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>Only for content anyone may watch: not with geo, rights, DRM, a paywall, sign-in, referrer domains or a streams limit.</span>
        </div>)
    case 'distribution.mp4Download': return check('Allow MP4 download')
    case 'distribution.shareLinks': return check('Allow share links')
    case 'distribution.fastEligible': return check('May be scheduled on FAST channels')
    case 'distribution.sitemap': return check('List in the sitemap and schema.org data')
    case 'retention.keep':
      return (
        <select className="inp sel-sm" value={value ?? 'forever'} onChange={e => onChange(e.target.value)}>
          <option value="forever">Keep forever</option><option value="days">Keep for a number of days</option>
        </select>)
    case 'retention.days':
      return <input {...inp} type="number" min={1} max={36500} aria-label="Days to keep" placeholder="days" style={{ ...inp.style, width: 110 }}
        value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : Math.max(1, Math.round(Number(e.target.value))))} />
    case 'retention.anchor':
      return (
        <select className="inp sel-sm" value={value ?? 'available_until'} onChange={e => onChange(e.target.value)}>
          <option value="ingest">From when it came in</option><option value="available_from">From when it became available</option><option value="available_until">From when it stops being available</option>
        </select>)
    case 'retention.legalHoldAllowed': return check('A title may be put on legal hold')
    case 'retention.archiveTier':
      return (
        <select className="inp sel-sm" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : e.target.value)}>
          <option value="">Stays where it is</option><option value="infrequent">Infrequent access</option><option value="glacier">Archive, restore in hours</option>
        </select>)
    default: return <span />
  }
}

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
/** A padlock, closed or open. */
export function Padlock({ open = false, size = 15 }: { open?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...P}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d={open ? 'M8 11V7a4 4 0 0 1 7.5-1.9' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
    </svg>)
}

/** Section heading icons, drawn like the console's other line icons. */
export function SectionGlyph({ k, size = 16 }: { k: typeof SECTIONS[number]['key']; size?: number }) {
  const s = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, ...P }
  switch (k) {
    case 'lifecycle': return <svg {...s}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
    case 'access': return <svg {...s}><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0M17 11l2 2 3-3" /></svg>
    case 'protection': return <svg {...s}><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" /></svg>
    case 'distribution': return <svg {...s}><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" /></svg>
    case 'retention': return <svg {...s}><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></svg>
  }
}
