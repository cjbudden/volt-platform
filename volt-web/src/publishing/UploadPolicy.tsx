// ============================================================================
//  THE POLICY A NEW UPLOAD WILL GET (build queue P4, PUBLISHING_POLICIES.md
//  "Upload and ingest"). DRM is decided when the file is packaged, so the
//  upload panel says before anything uploads what the publishing policy will
//  do with these files: from the content type chosen (its rule, the account
//  default under it), or the account default when the ingest rules decide.
//  A metadata rule can still apply once the title's details are saved; that
//  is said rather than guessed, because it matches on the stored title.
// ============================================================================
import { useEffect, useState } from 'react'
import { apiRequest } from '../api'
import type { ResolvedPolicy } from './policyApi'

const RUNG_WORDS: Record<string, string> = {
  baseline: 'platform default', account: 'account default', schema: 'content type rule',
  owner: 'channel or event rule', metadata: 'metadata rule', asset: 'title',
}

function from(r: ResolvedPolicy, field: string, key?: string): string {
  const rung = r.fieldSources?.[field] ?? (key ? (r.sources as any)?.[key] : undefined) ?? 'baseline'
  const row = [...r.rungs].reverse().find(x => x.rung === rung) as any
  return row?.name ? `${RUNG_WORDS[rung] ?? rung} "${row.name}"` : (RUNG_WORDS[rung] ?? rung)
}

export function UploadPolicy({ typeId, byRules }: { typeId: string | null; byRules: boolean }) {
  const [r, setR] = useState<ResolvedPolicy | null>(null)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    let live = true
    const qs = typeId ? `?schemaId=${encodeURIComponent(typeId)}` : ''
    const ask = apiRequest('/publishing-rules/resolve' + qs) as Promise<ResolvedPolicy>
    ask
      .then(x => { if (live) { setR(x); setHidden(false) } })
      // A role that cannot read publishing rules simply does not see the line.
      .catch(() => { if (live) setHidden(true) })
    return () => { live = false }
  }, [typeId])
  if (hidden || !r) return null
  const s = r.settings
  const access = s.access === 'paid' ? 'Paid' : s.access === 'entitled' ? 'Members and entitled viewers' : 'Free'
  const drm = !!s.protection?.drm
  return (
    <div className="ig-type ig-policy" role="group" aria-label="Publishing policy for the files you add" data-testid="upload-policy">
      <span className="ig-type-l">Publishing policy</span>
      <div className="ig-policy-body">
        <span className="ig-policy-facts">
          <span className="tag"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>{drm ? 'DRM on' : 'DRM off'}</span>
          <span className="tag">{access}</span>
          <span className="tag">{s.autoPublish ? 'Published when ready' : 'Kept as a draft'}</span>
        </span>
        <span className="ig-policy-why">
          DRM from the {from(r, 'protection.drm')}, access from the {from(r, 'access', 'access')}.
          {byRules ? ' The content type the ingest rules pick can change this.' : ''}
          {' '}A metadata rule may still apply once a title's details are saved.
          {drm && r.drmReady !== false ? ' These files are packaged with DRM, so they get no MP4 download.' : ''}
          {drm && r.drmReady === false ? ' This account has no DRM key service set up, so these files will not encode until DRM is set up for the account or turned off in the policy.' : ''}
        </span>
      </div>
    </div>
  )
}
