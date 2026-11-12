// ============================================================================
//  PUBLISHING POLICY FOR SELECTED TITLES (the Media Library bulk bar, build
//  queue P3-2c). The asset rung for many titles at once: apply a preset as
//  their own policy, or clear their own settings so the rules decide again.
//
//  Before you save is the server's answer to the same request with ?dryRun=1
//  (POST /api/vod/bulk/availability): each title is checked as the asset's own
//  editor checks one, so a title whose policy would change a field locked by a
//  rule beneath it, or bring a conflict, is named with why and left as it is,
//  while the rest are saved. The numbers are summed over the titles that take
//  it. DRM on published titles needs the box ticked, as a rule's save does.
//  Published titles take the change up within a minute (the restamp), without
//  posting to social accounts again.
// ============================================================================
import { useEffect, useState } from 'react'
import { ConflictLine } from '../RuleEditor'
import { FormStatus } from '../notices'
import { bulkPolicyApi, policyApi, policyRefusal, type BulkPolicyAnswer, type BulkPolicyBody, type Preset, type PresetKey } from './policyApi'
import './policy.css'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const SHOWN = 8

export default function BulkPolicyDialog({ ids, onClose, onDone }: {
  ids: string[]; onClose: () => void; onDone: (r: BulkPolicyAnswer) => void
}) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [action, setAction] = useState<'apply' | 'clear'>('apply')
  const [presetKey, setPresetKey] = useState<PresetKey | ''>('')
  const [check, setCheck] = useState<BulkPolicyAnswer | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { policyApi.presets().then(setPresets).catch(() => setPresets([])) }, [])

  const body: BulkPolicyBody | null = action === 'clear' ? { ids, action: 'clear' } : presetKey ? { ids, action: 'apply', presetKey } : null
  const key = JSON.stringify(body)
  // A dry run each time the choice changes; the last answer wins.
  useEffect(() => {
    setCheck(null); setConfirm(false); setErr('')
    if (!body) return
    let live = true
    setChecking(true)
    bulkPolicyApi.dryRun(body).then(r => { if (live) setCheck(r) })
      .catch((e: any) => { if (live) setErr(e?.forbidden ? 'Your role cannot change publishing settings.' : (e?.message || 'Could not check what this would do')) })
      .finally(() => { if (live) setChecking(false) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const repackage = check?.impact.repackage ?? 0
  const ready = !!check?.canSave && (!repackage || confirm)
  const preset = presets.find(p => p.key === presetKey)

  async function go() {
    if (!body || !ready) return
    setBusy(true); setErr('')
    try { onDone(await bulkPolicyApi.save(body, confirm)) }
    catch (e: any) {
      const r = policyRefusal(e)
      setErr(r ? r.message : e?.forbidden ? 'Your role cannot change publishing settings.' : (e?.message || 'The change was not saved'))
      bulkPolicyApi.dryRun(body).then(setCheck).catch(() => {})
    } finally { setBusy(false) }
  }

  const verb = action === 'clear' ? 'Clear' : 'Apply to'
  return (
    <div className="drawer-scrim" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="bulkpol-t" data-bulk-policy
        onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}
        style={{ width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', padding: 20 }}>
        <h3 id="bulkpol-t" style={{ margin: '0 0 8px' }}>Publishing policy for {plural(ids.length, 'title')}</h3>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 12px' }}>
          A title's own policy sits on top of the rules (account default, content type, channel or event, metadata rule) and replaces any it had before.
          Fields a rule locked cannot be changed here: titles that would need that are left as they are.
        </p>
        <div className="field" role="radiogroup" aria-label="What to do" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="radio" name="bulkpol-action" checked={action === 'apply'} onChange={() => setAction('apply')} data-bulk-policy-action="apply" />
            Apply a preset as their own policy
          </label>
          {action === 'apply' && (
            <div style={{ paddingLeft: 24 }}>
              <select className="inp" aria-label="Preset" value={presetKey} onChange={e => setPresetKey(e.target.value as PresetKey | '')} data-bulk-policy-preset style={{ maxWidth: '100%' }}>
                <option value="">Choose a preset…</option>
                {presets.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
              {preset && <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>{preset.summary}</div>}
              {preset && (preset.key === 'geo_locked' || preset.key === 'rights_managed') &&
                <div style={{ color: 'var(--warn)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>This preset leaves the countries for you to choose: set them on each title, or on a rule.</div>}
            </div>)}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="radio" name="bulkpol-action" checked={action === 'clear'} onChange={() => setAction('clear')} data-bulk-policy-action="clear" />
            Clear their own settings, so the rules decide
          </label>
        </div>

        {(check || checking) && (
          <div className="pol-check" data-policy-check aria-live="polite">
            <div className="pol-check-h">Before you save{checking && <span style={{ color: 'var(--faint)', fontWeight: 400 }}> · checking…</span>}</div>
            {check && <>
              <div className="pol-impact" data-impact>
                <span data-impact-ok><b>{check.ok}</b> of {ids.length} can take this</span>
                <span><b>{check.impact.published}</b> published</span>
                <span>Saving changes <b>{check.impact.changed}</b></span>
                {repackage > 0 && <span style={{ color: 'var(--warn)' }}><b>{repackage}</b> published title{repackage === 1 ? '' : 's'} to be packaged again</span>}
                {(check.impact.unavailableNow ?? 0) > 0 && <span style={{ color: 'var(--warn)' }} data-impact-unavailable><b>{check.impact.unavailableNow}</b> become{check.impact.unavailableNow === 1 ? 's' : ''} unavailable now</span>}
              </div>
              {(check.impact.publishedChanged ?? 0) > 0 && <div style={{ color: 'var(--muted)' }} data-impact-published>
                <b>{check.impact.publishedChanged}</b> published title{check.impact.publishedChanged === 1 ? '' : 's'} take{check.impact.publishedChanged === 1 ? 's' : ''} this up within a minute, without posting to social accounts again.</div>}
              {check.refused.length > 0 && (
                <div data-bulk-refused>
                  <ConflictLine level="block" message={`${plural(check.refused.length, 'title')} left as ${check.refused.length === 1 ? 'it is' : 'they are'}:`} />
                  <ul style={{ margin: '4px 0 0', paddingLeft: 30, maxHeight: 160, overflow: 'auto' }}>
                    {check.refused.slice(0, SHOWN).map(r => <li key={r.id} data-refused-title={r.title}><b>{r.title}</b>: {r.conflicts.map(c => c.message).join(' ')}</li>)}
                    {check.refused.length > SHOWN && <li style={{ color: 'var(--muted)' }}>and {check.refused.length - SHOWN} more</li>}
                  </ul>
                </div>)}
              {check.missing.length > 0 && <ConflictLine level="warn" message={`${plural(check.missing.length, 'title')} could not be found: removed, or not in this account.`} />}
              {check.warnings.map((c, i) => <ConflictLine key={c.code + i} level="warn" message={c.message} />)}
              {check.impact.warnings.map(w => <ConflictLine key={'iw' + w.code} level="warn" message={`${w.count} title${w.count === 1 ? '' : 's'}: ${w.message}`} titles={w.titles} />)}
              {!check.refused.length && !check.missing.length && !check.warnings.length && !check.impact.warnings.length && <div style={{ color: 'var(--muted)' }}>No conflicts.</div>}
            </>}
          </div>)}
        {check && repackage > 0 && (
          <label className="pol-confirm" data-policy-confirm style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} style={{ marginTop: 3 }} />
            <span><b>Package {plural(repackage, 'published title')} again.</b> DRM changes, so their files must be packaged again; they keep their current protection until then.</span>
          </label>)}
        <p style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', margin: '10px 0 0' }}>Each change is recorded in the audit log with your name, title by title.</p>
        <div className="modal-f">
          <FormStatus error={err} blocked={check && !check.canSave ? 'None of the selected titles can take this.' : undefined} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={busy || !ready} data-bulk-policy-save>
            {busy ? 'Saving…' : `${verb} ${plural(check?.ok ?? 0, 'title')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
