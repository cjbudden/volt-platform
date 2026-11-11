// ============================================================================
//  THE PUBLIC STATUS AS THE CONSOLE SHOWS IT (build queue P1-2): its label,
//  colour and one line, for the library's column and filters and the
//  Availability tab (Lifecycle.tsx). No stylesheet import here, so the
//  library's static-render test can load it.
// ============================================================================
/** The ten public statuses, as the library and this tab show them. */
export const PUBLIC_STATUS_UI: Record<string, { label: string; cls: string; tip: string }> = {
  draft: { label: 'Draft', cls: 'idle', tip: 'Not published: no viewer can find or play it' },
  in_review: { label: 'In review', cls: 'sched', tip: 'Waiting for approval in Review' },
  changes_requested: { label: 'Changes requested', cls: 'warn', tip: 'Review asked for changes' },
  rejected: { label: 'Rejected', cls: 'down', tip: 'Rejected in Review' },
  processing: { label: 'Processing', cls: 'sched', tip: 'Published, but the media is not ready to play' },
  scheduled: { label: 'Scheduled', cls: 'sched', tip: 'Published; its window has not opened' },
  available: { label: 'Available', cls: 'live', tip: 'Viewers can find and play it' },
  restricted: { label: 'Restricted', cls: 'warn', tip: 'Published, but its rights say no right now' },
  expired: { label: 'Expired', cls: 'warn', tip: 'Its window has closed' },
  archived: { label: 'Archived', cls: 'idle', tip: 'Off the catalogue and not playable; the media is kept' },
}

export function PublicStatusTag({ status, reason, withdrawn }: { status?: string | null; reason?: string | null; withdrawn?: boolean }) {
  const ui = PUBLIC_STATUS_UI[status ?? 'draft'] ?? PUBLIC_STATUS_UI.draft
  const label = status === 'draft' && withdrawn ? 'Access removed' : ui.label
  return (
    <span className={`tag ${ui.cls} lib-pill`} title={reason ?? ui.tip}>
      <span className="lib-dot" aria-hidden="true" />{label}
    </span>
  )
}

