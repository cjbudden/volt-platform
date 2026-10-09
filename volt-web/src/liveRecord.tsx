// ============================================================================
//  ANOTHER ADMIN CHANGED THIS WHILE YOU HAD IT OPEN.
//
//  The 409 already existed and it is the wrong end of the problem. `patchEntity`
//  carries a version, a stale save is refused, and the settings drawer says "this
//  channel changed since you opened it, reopen and retry" -- AFTER the operator
//  has retyped a form and pressed Save. Everything they just entered is still on
//  screen and now has to be redone against a record they cannot see.
//
//  The optimistic-concurrency check is the SAFETY NET and stays exactly as it is.
//  What was missing is the part that stops it being needed: a form that knows,
//  while it is open, that the record underneath it has moved.
//
//  THE FRAME CARRIES SHAPE, NOT CONTENT. `patchEntity` publishes which columns
//  changed, the new version and who, and never the values -- so this notice can
//  say "someone changed the name and the DVR window" without the server having
//  to decide whether this viewer is allowed to read either. Re-reading is the
//  page's own job, through its own credential.
//
//  DELIBERATELY NOT AUTO-MERGING. A drawer that silently repopulated itself
//  mid-edit would be worse than the 409: the operator would be looking at fields
//  they did not type and would not know which were theirs. It tells them, names
//  what moved, and leaves the decision where it belongs.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import { subscribeLive, type LiveMsg } from './liveStatus'

export interface RecordChange {
  /** Columns another admin changed, newest first and de-duplicated. */
  changed: string[]
  /** The record's version after their edit. */
  version: number | null
  /** How many separate edits have landed since this was mounted. */
  edits: number
}

/**
 * Is this frame somebody ELSE's edit, or our own coming back around the hub?
 *
 * Pure and exported so it can be pinned without a DOM. The hub fans out to every
 * subscriber on the account INCLUDING the client that caused the change, so
 * without this every save you made would accuse you of conflicting with
 * yourself -- a warning that fires on the happy path is one nobody reads.
 */
export function isForeignEdit(frameVersion: number | null | undefined, baseVersion: number | null | undefined): boolean {
  if (frameVersion == null) return true;        // no version to compare: report it
  if (baseVersion == null) return true;         // we hold no baseline: report it
  return frameVersion > baseVersion;
}

/** Fold a new frame into what is already being shown. */
export function mergeChange(prev: RecordChange | null, frame: { changed?: string[]; version?: number | null }): RecordChange {
  const merged = [...new Set([...(frame.changed ?? []), ...(prev?.changed ?? [])])];
  return { changed: merged, version: frame.version ?? null, edits: (prev?.edits ?? 0) + 1 };
}

/**
 * Watch one record for changes made by somebody else.
 *
 * `sinceVersion` is the version the caller is holding. Frames at or below it are
 * this client's OWN write coming back around the hub, and reporting those would
 * mean every save you made accused you of a conflict with yourself.
 */
export function useRecordWatch(
  kind: string, id: string | null | undefined, sinceVersion?: number | null
): { change: RecordChange | null; clear: () => void } {
  const [change, setChange] = useState<RecordChange | null>(null)
  // Held in a ref as well as in state: the subscription is registered once and
  // must see the CURRENT baseline, not the one captured when it was created.
  const base = useRef<number | null>(sinceVersion ?? null)
  useEffect(() => { base.current = sinceVersion ?? null }, [sinceVersion])

  useEffect(() => {
    if (!id) return
    const off = subscribeLive(`${kind}:${id}`, (m: LiveMsg) => {
      if (m.type !== 'record') return
      // OUR OWN SAVE, ECHOED BACK. The hub fans out to every subscriber on the
      // account including the one that caused the change.
      if (!isForeignEdit(m.version, base.current)) return
      setChange((prev) => mergeChange(prev, m))
    })
    return off
  }, [kind, id])

  return { change, clear: () => setChange(null) }
}

/** Column names as an operator would say them. */
const FIELD_LABEL: Record<string, string> = {
  name: 'name', dvr_mode: 'DVR mode', dvr_window_sec: 'DVR window',
  recording_enabled: 'recording', recording_retention_sec: 'retention',
  geo_mode: 'geo rules', geo_countries: 'geo countries', brand_ref: 'brand image',
  output_profile_id: 'output profile', radio_config: 'station settings',
  captions_config: 'captions', watermark: 'watermark', status: 'status',
  desired_state: 'desired state', on_air: 'on air',
}
export function describeFields(cols: string[]): string {
  const named = cols.map((c) => FIELD_LABEL[c] ?? c.replace(/_/g, ' '));
  if (!named.length) return 'this record'
  if (named.length === 1) return `the ${named[0]}`
  if (named.length === 2) return `the ${named[0]} and ${named[1]}`
  return `the ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
}

/**
 * The notice itself. Amber rather than red on purpose: nothing has failed and
 * nothing has been lost. It is a warning that saving will now be refused, shown
 * while there is still time to do something about it.
 */
export function LiveEditNotice({ change, onReload, onDismiss }: {
  change: RecordChange | null
  /** Offered only where the caller can actually reload without losing work. */
  onReload?: () => void
  onDismiss?: () => void
}) {
  if (!change) return null
  const many = change.edits > 1
  return (
    <div role="status" style={{
      margin: '0 0 14px', padding: '12px 14px', borderRadius: 10,
      display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0,
      background: 'rgba(251,191,36,.10)', border: '1px solid rgba(251,191,36,.4)',
    }}>
      <span className="dot-s warn" style={{ marginTop: 6, flex: 'none' }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'var(--fs-body)', color: 'var(--text)' }}>
          Someone else changed {describeFields(change.changed)}
          {many ? ` (${change.edits} edits)` : ''} while this was open.
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 3 }}>
          Saving now will be refused, so nothing you have typed can overwrite their
          change. Reload to start from what is there.
        </div>
      </div>
      {onReload && (
        <button className="btn ghost" onClick={onReload} style={{ flex: 'none', alignSelf: 'center' }}
          title="Discard what is typed here and reopen against the current record">
          Reload
        </button>
      )}
      {onDismiss && (
        <button className="btn ghost" onClick={onDismiss} style={{ flex: 'none', alignSelf: 'center' }}>
          Dismiss
        </button>
      )}
    </div>
  )
}
