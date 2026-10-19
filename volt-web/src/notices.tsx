// ============================================================================
//  NOTICES: one look and one place for every error, warning and result.
//  The rules are in volt-app/docs/UI_FEEDBACK.md. In short:
//
//    GLOBAL   under the top bar, full width, on every page until it clears:
//             the connection is down, the session is about to end, the
//             account is suspended or over a limit that blocks work anywhere.
//             showGlobal() / dismissGlobal(), rendered by <GlobalNotices/>.
//
//    PAGE     at the top of the page content, above the title, stacked:
//             this page could not load (with Retry), something on this page
//             is unavailable and why (a full group), the result of an action
//             taken here (Removed 3 channels, Started 2, 1 failed).
//             usePageNotice(id, notice) while a condition holds, or
//             useNotify()(notice) for a one-off result. Rendered once by the
//             app shell, cleared when you leave the page.
//
//    FORM     drawers and dialogs: in the footer, left of the buttons, so it
//             is seen whichever tab or scroll position the form is on.
//             <FormStatus/>. A field's own problem goes under that field:
//             <FieldError/>.
//
//    INLINE   a row or item's own state (a failed upload, a publish error)
//             stays in that row as text: className="err" or a status tag.
//             It is never a banner per row.
//
//  A page that cannot show anything at all renders <PageError/> in place of
//  its content.
// ============================================================================
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

export type NoticeKind = 'error' | 'warn' | 'info' | 'ok'

export interface NoticeAction { label: string; onClick: () => void }

export interface NoticeSpec {
  kind: NoticeKind
  /** a short bold lead: "Couldn't load channels" */
  title?: string
  message?: ReactNode
  actions?: NoticeAction[]
  /** can the person close it (default: yes for results, no for conditions) */
  dismissible?: boolean
  /** results clear themselves; errors never do */
  autoHideMs?: number
  /** called when the person dismisses it (clear the state that raised it) */
  onDismiss?: () => void
}

const ICON: Record<NoticeKind, ReactNode> = {
  error: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></svg>,
  warn: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4.5M12 17.5v.01" /></svg>,
  info: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5v.01" /></svg>,
  ok: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.7L16 9.8" /></svg>,
}

/** The one presentation of a notice. */
export function Notice({ kind, title, message, actions, onDismiss, variant = 'page', children }: NoticeSpec & {
  onDismiss?: () => void; variant?: 'page' | 'global' | 'compact'; children?: ReactNode
}) {
  const urgent = kind === 'error' || kind === 'warn'
  return (
    <div className={`notice notice-${kind} notice-${variant}`} role={urgent ? 'alert' : 'status'} aria-live={urgent ? 'assertive' : 'polite'}>
      <span className="notice-ic" aria-hidden="true">{ICON[kind]}</span>
      <div className="notice-body">
        {title && <b className="notice-title">{title}</b>}
        {(message || children) && <span className="notice-msg">{message}{children}</span>}
      </div>
      {(actions?.length || onDismiss) && (
        <div className="notice-actions">
          {actions?.map(a => <button key={a.label} type="button" className="btn ghost sm" onClick={a.onClick}>{a.label}</button>)}
          {onDismiss && (
            <button type="button" className="notice-x" onClick={onDismiss} aria-label="Dismiss">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---- GLOBAL ------------------------------------------------------------------

type Keyed = NoticeSpec & { id: string }
let globals: Keyed[] = []
const gSubs = new Set<() => void>()
const gEmit = () => gSubs.forEach(f => f())

/** Show (or replace) an app-wide notice. Same id = same notice, updated. */
export function showGlobal(id: string, n: NoticeSpec) {
  globals = [...globals.filter(g => g.id !== id), { ...n, id }]
  gEmit()
}
export function dismissGlobal(id: string) {
  if (!globals.some(g => g.id === id)) return
  globals = globals.filter(g => g.id !== id)
  gEmit()
}

export function GlobalNotices() {
  const list = useSyncExternalStore(cb => { gSubs.add(cb); return () => gSubs.delete(cb) }, () => globals, () => globals)
  if (!list.length) return null
  return (
    <div className="global-notices" aria-label="Notices for the whole app">
      {list.map(n => <Notice key={n.id} {...n} variant="global" onDismiss={n.dismissible ? () => dismissGlobal(n.id) : undefined} />)}
    </div>
  )
}

// ---- PAGE --------------------------------------------------------------------

interface PageCtx { set: (id: string, n: NoticeSpec | null) => void }
const Ctx = createContext<PageCtx | null>(null)
let seq = 0

/**
 * The page notice region. The app shell renders this once, at the top of the
 * content area, keyed by the route so leaving a page clears its notices.
 */
export function PageNoticesProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Keyed[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const set = useCallback((id: string, n: NoticeSpec | null) => {
    const t = timers.current.get(id); if (t) { clearTimeout(t); timers.current.delete(id) }
    setList(l => {
      const rest = l.filter(x => x.id !== id)
      return n ? [...rest, { ...n, id }] : rest
    })
    if (n?.autoHideMs) timers.current.set(id, setTimeout(() => setList(l => l.filter(x => x.id !== id)), n.autoHideMs))
  }, [])
  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])
  const ctx = useMemo(() => ({ set }), [set])
  // errors first, then warnings, then the rest, each in the order raised
  const rank: Record<NoticeKind, number> = { error: 0, warn: 1, info: 2, ok: 3 }
  const shown = [...list].sort((a, b) => rank[a.kind] - rank[b.kind])
  return (
    <Ctx.Provider value={ctx}>
      {shown.length > 0 && (
        <div className="page-notices" aria-label="Notices for this page">
          {shown.map(n => <Notice key={n.id} {...n} onDismiss={n.dismissible === false ? undefined : (n.onDismiss || n.dismissible || n.kind === 'ok' || n.autoHideMs) ? () => { n.onDismiss?.(); set(n.id, null) } : undefined} />)}
        </div>
      )}
      {children}
    </Ctx.Provider>
  )
}

/**
 * Hold a notice while a condition holds: pass null to clear it. Cleared when
 * the component goes away. The notice is compared by content, so passing a
 * fresh object each render is fine.
 */
export function usePageNotice(id: string, n: NoticeSpec | null | undefined | false) {
  const ctx = useContext(Ctx)
  const key = n ? JSON.stringify({ k: n.kind, t: n.title, m: typeof n.message === 'string' ? n.message : seq, a: n.actions?.map(a => a.label) }) : ''
  const latest = useRef(n); latest.current = n
  useEffect(() => {
    if (!ctx) return
    ctx.set(id, latest.current || null)
    // eslint-disable-next-line
  }, [ctx, id, key])
  useEffect(() => () => { ctx?.set(id, null) }, [ctx, id])
}

/**
 * Raise a one-off result on the page: notify({kind:'ok', message:'Removed 3'}).
 * Same id replaces the last one (default "result"). Successes clear themselves
 * after 8 seconds; errors stay until dismissed.
 */
export function useNotify() {
  const ctx = useContext(Ctx)
  return useCallback((n: NoticeSpec & { id?: string }) => {
    if (!ctx) return
    const { id = 'result', ...rest } = n
    ctx.set(id, { dismissible: true, autoHideMs: rest.kind === 'ok' || rest.kind === 'info' ? 8000 : undefined, ...rest })
  }, [ctx])
}

/** Clear a result raised with useNotify. */
export function useClearNotice() {
  const ctx = useContext(Ctx)
  return useCallback((id = 'result') => ctx?.set(id, null), [ctx])
}

// ---- WHOLE-PAGE FAILURE, FORMS, FIELDS --------------------------------------------

/** The page could not show anything: in place of its content. */
export function PageError({ title = 'This page could not load', message, onRetry }: { title?: string; message?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="page-error">
      <Notice kind="error" title={title} message={message} actions={onRetry ? [{ label: 'Try again', onClick: onRetry }] : undefined} />
    </div>
  )
}

/**
 * The status line in a drawer or dialog footer, left of the buttons: an error
 * from the last attempt, else why the main button is unavailable.
 */
export function FormStatus({ error, blocked }: { error?: ReactNode; blocked?: ReactNode }) {
  if (error) return <div className="form-status form-status-error" role="alert">{ICON.error}<span>{error}</span></div>
  if (blocked) return <div className="form-status form-status-warn" role="status">{ICON.warn}<span>{blocked}</span></div>
  return <div className="form-status" />
}

/** A field's own problem, directly under it. */
export function FieldError({ children, id }: { children?: ReactNode; id?: string }) {
  if (!children) return null
  return <div className="field-err" id={id} role="alert">{children}</div>
}
