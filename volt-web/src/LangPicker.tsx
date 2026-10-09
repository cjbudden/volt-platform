// ============================================================================
//  LangPicker — caption output-language multi-select, shared by the channel
//  CREATION drawer and the SETTINGS drawer.
//
//  Selected languages render as removable chips (× to drop one); the dropdown
//  adds any remaining supported language. The supported list comes from the
//  control plane (/api/caption-languages, the single source of truth for what
//  the pipeline can actually deliver); the built-in fallback keeps the form
//  usable if that call fails.
// ============================================================================
import { useEffect, useState } from 'react'
import { api } from './api'

export type LangOpt = { code: string; label: string }

export const FALLBACK_LANGS: LangOpt[] = [
  { code: 'en', label: 'English' }, { code: 'ms', label: 'Malay' },
  { code: 'zh', label: 'Chinese (Simplified)' }, { code: 'ta', label: 'Tamil' },
]

/** Fetch the supported caption output languages once (fallback on failure). */
export function useCaptionLanguages(): LangOpt[] {
  const [opts, setOpts] = useState<LangOpt[]>(FALLBACK_LANGS)
  useEffect(() => {
    let ok = true
    api.captionLanguages()
      .then(r => { if (ok && r?.languages?.length) setOpts(r.languages) })
      .catch(() => { /* fallback list already in place */ })
    return () => { ok = false }
  }, [])
  return opts
}

export function LangPicker({ value, onChange, options }: {
  value: string[]; onChange: (v: string[]) => void; options: LangOpt[]
}) {
  const labelOf = (code: string) => options.find(o => o.code === code)?.label ?? code.toUpperCase()
  const remaining = options.filter(o => !value.includes(o.code))
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {value.map(code => (
        <span key={code} className="selchip sel" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {labelOf(code)}
          <button aria-label={`Remove ${labelOf(code)}`} title="Remove"
            onClick={() => onChange(value.filter(c => c !== code))}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 'var(--fs-body)' }}>
            ×
          </button>
        </span>
      ))}
      {remaining.length > 0 && (
        <select className="inp" value="" style={{ width: 'auto', padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
          aria-label="Add caption language"
          onChange={e => { if (e.target.value) onChange([...value, e.target.value]) }}>
          <option value="">+ Add language…</option>
          {remaining.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
      )}
      {value.length === 0 && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>No languages selected: captions will not be published.</span>}
    </div>
  )
}
