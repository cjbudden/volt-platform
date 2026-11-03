// ============================================================================
//  The server's exact still of the frame somebody stepped to, laid over the
//  player while it is paused (build queue 3.2-3, see frames.ts for why the
//  player's own picture is not trusted for this). It lets clicks through to
//  the player's controls, and says in words that it is the exact frame.
// ============================================================================
import type { ExactFrame } from './frames'

export function FrameStill({ still, busy }: { still: ExactFrame | null; busy: boolean }) {
  if (!still && !busy) return null
  return (
    <div className="frame-still" aria-live="polite">
      {still && <img src={still.image.url} alt={`Frame ${still.frame}, timecode ${still.timecode}`} />}
      <span className="frame-still-tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14" />
        </svg>
        {busy && !still ? 'Finding the exact frame…' : `Exact frame ${still!.frame} · ${still!.timecode}`}
      </span>
    </div>
  )
}

/** A small exact still for the In or Out mark, with its timecode. */
export function MarkFrame({ label, still }: { label: string; still: ExactFrame | null }) {
  if (!still) return null
  return (
    <figure className="mark-frame">
      <img src={still.image.url} alt={`${label} frame ${still.frame}`} />
      <figcaption><span style={{ color: 'var(--faint)' }}>{label} </span>{still.timecode}</figcaption>
    </figure>
  )
}
