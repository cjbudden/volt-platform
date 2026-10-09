import { Component, type ErrorInfo, type ReactNode } from 'react'

/* ============================================================================
   THE LAST LINE.

   A render-time throw anywhere in a React tree with no boundary unmounts the
   WHOLE tree. There was no boundary, so one panel reading a field the API had
   returned as null took the entire console to a blank white page — during a
   broadcast, on the screen an operator is using to watch the broadcast.

   A boundary cannot make the broken panel work. What it can do is keep the
   failure the size it actually is: this section is broken, the navigation and
   every other section still work, and here is what went wrong so it can be
   reported. `resetKey` clears the error when the operator navigates, so a
   broken section does not follow them around the app.
   ========================================================================== */

interface Props { children: ReactNode; resetKey?: string; label?: string }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The stack is the only record of this; keep it where a developer looks.
    console.error('[ui] section crashed:', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    // Navigating away clears it. Without this the operator would be stuck
    // looking at one section's crash for the rest of the session.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <>
        <div className="page-head">
          <div>
            <h1>{this.props.label ?? 'This section'} could not be displayed</h1>
            <p>
              Something in this page threw while rendering. The rest of the console is
              unaffected: use the navigation to carry on, and this section will retry
              when you come back to it.
            </p>
          </div>
        </div>
        <div className="card p-4">
          <div style={{
            fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)',
            color: 'var(--down,#f87171)', wordBreak: 'break-word',
          }}>{error.message || String(error)}</div>
          <div style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      </>
    )
  }
}
