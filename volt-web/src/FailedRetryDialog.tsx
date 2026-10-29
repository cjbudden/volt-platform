// ============================================================================
//  RE-UPLOADING A FILE WHOSE ENCODE FAILED. Shown by the ingest panel before the
//  file moves, when the rules preview says it matches a library record whose
//  encode failed. Three answers, applied by the server when the bytes land
//  (volt-app/src/services/uploads.ts completeLanded, migration 0082):
//    reattach  the new file becomes that record's source; it keeps its id,
//              metadata and links and is encoded again (the default)
//    replace   the failed record and its files are deleted; the upload is a new record
//    new       both stay
// ============================================================================
import { useState } from 'react'
import type { IngestFailedMatch } from './api'

export type RetryAction = 'reattach' | 'replace' | 'new'
export interface RetryAsk { id: string; fileName: string; bytes: number; match: IngestFailedMatch }

const when = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const gb = (n: number | null) => n == null ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`

const OPTIONS: { key: RetryAction; title: string; detail: (m: IngestFailedMatch) => string }[] = [
  { key: 'reattach', title: 'Use it as the source of the existing record',
    detail: (m) => `Keeps the record and everything on it${m.metadataFields ? ` (${m.metadataFields} metadata field${m.metadataFields === 1 ? '' : 's'})` : ''}, swaps in this file and encodes it again. The old file is removed.` },
  { key: 'replace', title: 'Delete the old record and replace it',
    detail: () => 'The failed record and its files are deleted. This upload becomes a new record, with only the metadata you give it now.' },
  { key: 'new', title: 'Create a new record',
    detail: () => 'Both stay. The failed record remains in the Media Library marked "Encode failed" until you delete it.' },
]

export function FailedRetryDialog({ asks, onAnswer, onCancel }: {
  asks: RetryAsk[]
  onAnswer: (answers: Record<string, RetryAction>) => void
  onCancel: (ids: string[]) => void
}) {
  const [choice, setChoice] = useState<Record<string, RetryAction>>(() => Object.fromEntries(asks.map((a) => [a.id, 'reattach' as RetryAction])))
  const [same, setSame] = useState(true)
  const many = asks.length > 1
  const shown = many && same ? [asks[0]] : asks
  const answer = () => onAnswer(many && same ? Object.fromEntries(asks.map((a) => [a.id, choice[asks[0].id]])) : choice)

  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onCancel(asks.map((a) => a.id)) }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="retry-t" onKeyDown={(e) => { if (e.key === 'Escape') onCancel(asks.map((a) => a.id)) }}
        style={{ width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', padding: 20 }}>
        <h3 id="retry-t" style={{ margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--warn)" strokeWidth="2" aria-hidden="true"><path d="M12 3 2 21h20L12 3z" /><path d="M12 10v5M12 18h.01" /></svg>
          {many ? `${asks.length} files match records whose encode failed` : 'This file matches a record whose encode failed'}
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-body)', margin: '0 0 12px' }}>Choose what happens before the upload starts.</p>
        {many && (
          <label className="gfx-meta" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} /> The same answer for all {asks.length}
          </label>
        )}
        {shown.map((a) => (
          <div key={a.id} style={{ marginBottom: 14 }}>
            {!(many && same) && <div style={{ fontWeight: 600, marginBottom: 4 }}>{a.fileName}</div>}
            <div className="hintxt" style={{ marginBottom: 8 }}>
              {many && same ? 'For example ' : ''}<b>{a.match.title}</b>, uploaded {when(a.match.createdAt)}{a.match.bytes ? ` (${gb(a.match.bytes)}${a.match.sameSize ? ', the same size' : ''})` : ''}.
              {a.match.error ? <> The encode failed: <i>{a.match.error}</i></> : null}
            </div>
            <div role="radiogroup" aria-label={`What to do with ${a.fileName}`} style={{ display: 'grid', gap: 6 }}>
              {OPTIONS.map((o) => (
                <label key={o.key} className="toggle-row" style={{ cursor: 'pointer', alignItems: 'flex-start', gap: 10, margin: 0,
                  outline: choice[a.id] === o.key ? '1px solid var(--brand)' : undefined, borderRadius: 8 }}>
                  <input type="radio" name={`retry-${a.id}`} checked={choice[a.id] === o.key} onChange={() => setChoice((c) => ({ ...c, [a.id]: o.key }))} style={{ marginTop: 3 }} />
                  <div>
                    <div className="tt">{o.title}{o.key === 'reattach' ? <span className="gfx-meta"> · recommended</span> : null}</div>
                    <div className="td">{o.detail(a.match)}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="modal-f">
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={() => onCancel(asks.map((a) => a.id))}>Don't upload {many ? 'these' : 'it'}</button>
          <button className="btn primary" autoFocus onClick={answer}>Upload</button>
        </div>
      </div>
    </div>
  )
}
