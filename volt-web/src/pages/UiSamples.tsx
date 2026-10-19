// ============================================================================
//  UI SAMPLES (/ui-samples): every kind of error, warning and result in the
//  place it appears, drawn with the real components. A living reference for
//  docs/UI_FEEDBACK.md; nothing here talks to the API.
// ============================================================================
import { useState } from 'react'
import { PageHead, NewButton, EntityCell, StatusTag } from '../scaffold'
import { Notice, usePageNotice, useNotify, showGlobal, dismissGlobal, PageError, FormStatus, FieldError, type NoticeKind } from '../notices'
import { RowMenu, Icons, BulkBar, ConfirmDialog } from '../listActions'

function Section({ n, title, where, children }: { n: number; title: string; where: string; children: React.ReactNode }) {
  return (
    <section className="uis-sec">
      <div className="uis-h"><span className="uis-n">{n}</span><div><h2>{title}</h2><p>{where}</p></div></div>
      {children}
    </section>
  )
}

export default function UiSamples() {
  const notify = useNotify()
  const [held, setHeld] = useState(true)
  const [confirm, setConfirm] = useState<'stop' | 'remove' | null>(null)

  // The page region at the top shows these while the sample page is open.
  usePageNotice('s-load', held ? { kind: 'error', title: "Couldn't load channels.", message: 'The server answered 503: service unavailable.', actions: [{ label: 'Retry', onClick: () => notify({ kind: 'ok', message: 'Loaded.' }) }] } : null)
  usePageNotice('s-limit', held ? { kind: 'warn', title: 'New channels are unavailable.', message: 'RTM Main is full: it allows 21 channels and stations together and has 2 TV channels and 19 radio stations. Remove one, choose another group, or ask for a higher limit.', actions: [{ label: 'View radio stations', onClick: () => {} }] } : null)
  usePageNotice('s-role', held ? { kind: 'info', message: 'Your role lets you run items here but not change their settings.' } : null)

  const kinds: NoticeKind[] = ['error', 'warn', 'info', 'ok']
  const text: Record<NoticeKind, [string, string]> = {
    error: ["Couldn't save the channel.", 'This channel changed since you opened it. Reopen settings and retry.'],
    warn: ['Auto reconnect gave up.', 'After 5 failed attempts at 14:02. Starting the channel clears this.'],
    info: ['Recording is off for this channel.', 'Turn it on in Settings to keep a 7 day archive.'],
    ok: ['Removed 3 channels.', 'Each removal is in the audit log.'],
  }

  return (
    <>
      <PageHead title="Notices and errors: samples" sub="Every kind of message in the place it appears. The three notices above are this page's own page region, live." />

      <Section n={1} title="Global: under the top bar, on every page" where="States of the whole app: the server can't be reached, the session is ending, the account is suspended. Try them: they appear above this page and stay on every page until cleared.">
        <div className="uis-row">
          <button className="btn ghost" onClick={() => showGlobal('offline', { kind: 'error', title: "Can't reach the server.", message: 'Check the connection. This clears by itself when it is back.' })}>Show "can't reach the server"</button>
          <button className="btn ghost" onClick={() => showGlobal('session', { kind: 'warn', title: 'Your session ends in 2 minutes.', message: 'Save your work.', dismissible: true, actions: [{ label: 'Stay signed in', onClick: () => dismissGlobal('session') }] })}>Show "session ending"</button>
          <button className="btn ghost" onClick={() => showGlobal('maint', { kind: 'info', title: 'Maintenance tonight 01:00 to 01:30 AEST.', message: 'Streams keep running; the console is read only.', dismissible: true })}>Show "maintenance"</button>
          <button className="btn ghost" onClick={() => { dismissGlobal('offline'); dismissGlobal('session'); dismissGlobal('maint') }}>Clear all</button>
        </div>
      </Section>

      <Section n={2} title="Page: top of the content, above the title" where="This page could not load (with Retry), why something on it is unavailable, what the role allows, and the result of an action taken here. Errors first, then warnings, info, results.">
        <div className="uis-row">
          <button className="btn ghost" onClick={() => notify({ kind: 'ok', message: 'Started 2. Stopped 1.' })}>Raise a result (clears in 8 s)</button>
          <button className="btn ghost" onClick={() => notify({ kind: 'error', message: 'Stopped 1. RTM Sport: not permitted.' })}>Raise a failed result</button>
          <button className="btn ghost" onClick={() => setHeld(h => !h)}>{held ? 'Clear' : 'Show'} the held notices</button>
        </div>
        <p className="uis-note">The four kinds, as they look in the page region:</p>
        <div className="uis-stack">
          {kinds.map(k => <Notice key={k} kind={k} title={text[k][0]} message={text[k][1]} onDismiss={k === 'ok' || k === 'error' ? () => {} : undefined}
            actions={k === 'error' ? [{ label: 'Retry', onClick: () => {} }] : undefined} />)}
        </div>
      </Section>

      <Section n={3} title="Page could not load at all" where="In place of the page's content, with Try again.">
        <div className="uis-frame"><PageError title="Couldn't load this channel." message="Not found, or not in your account." onRetry={() => {}} /></div>
      </Section>

      <Section n={4} title="Forms: in the footer, left of the buttons" where="Drawers and dialogs. The last attempt's error, or why the main button is disabled. Seen whichever tab or scroll position the form is at.">
        <div className="uis-drawer">
          <div className="uis-drawer-h">New channel</div>
          <div className="uis-drawer-b">
            <div className="field has-err"><label>Channel name <span className="req">*</span></label>
              <input className="inp" defaultValue="" placeholder="e.g. RTM News 24" />
              <FieldError>Give the channel a name.</FieldError>
              <div className="uis-cap">A field's own problem: under the field, the field outlined.</div>
            </div>
          </div>
          <div className="drawer-f"><FormStatus error="Check these fields: name: Required; sources.0.ingestUrl: Invalid url" /><button className="btn ghost">Cancel</button><button className="btn primary">Create channel</button></div>
          <div className="drawer-f"><FormStatus blocked="RTM Main is full: it allows 21 channels and stations together. Remove one, choose another group, or ask for a higher limit." /><button className="btn ghost">Cancel</button><button className="btn primary" disabled>Create channel</button></div>
        </div>
        <div className="uis-cap">Top footer: an error from the last attempt. Bottom footer: why Create is unavailable, with the button disabled.</div>
      </Section>

      <Section n={5} title="Lists: an item's own state stays in its row" where="A row's status tag and inline text; a disabled action says why in the row's menu; disabled buttons look disabled and repeat the reason as a tooltip.">
        <div className="card">
          <table>
            <thead><tr><th>Channel</th><th>Status</th><th>Detail</th><th></th></tr></thead>
            <tbody>
              <tr>
                <td><EntityCell name="RTM News 24" sub="RTM Main" index={0} /></td>
                <td><StatusTag label="Error" cls="down" sub="input gate" /></td>
                <td><span className="err">Source lost: no packets for 12 s on srt://ingest-1:9000</span></td>
                <td><div className="row-actions"><button className="btn act ghost">Stop</button>
                  <RowMenu label="More actions for RTM News 24" items={[
                    { key: 'view', label: 'View', icon: Icons.view, onSelect: () => {} },
                    { key: 'edit', label: 'Edit settings', icon: Icons.settings, onSelect: () => {} },
                    { key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, separator: true, disabledReason: 'Stop the channel first', onSelect: () => {} },
                  ]} /></div></td>
              </tr>
              <tr>
                <td><EntityCell name="RTM Sport" sub="RTM Main" index={1} /></td>
                <td><StatusTag label="Degraded" cls="warn" sub="1 rendition behind" /></td>
                <td style={{ color: 'var(--muted)' }}>720p is 6 s behind the others</td>
                <td><div className="row-actions"><button className="btn act ghost">Stop</button><RowMenu label="More actions for RTM Sport" items={[{ key: 'view', label: 'View', icon: Icons.view, onSelect: () => {} }]} /></div></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="uis-row" style={{ marginTop: 10 }}>
          <NewButton label="New channel" onClick={() => {}} blockedReason="RTM Main is full" />
          <span className="uis-cap" style={{ margin: 0 }}>A blocked create button: disabled, the reason in the page region (section 2) and as a tooltip.</span>
        </div>
      </Section>

      <Section n={6} title="Bulk actions and confirmations" where="The bulk bar while rows are ticked, its progress, and the confirmation for disruptive or destructive actions.">
        <BulkBar count={3} noun={['channel', 'channels']} onClear={() => {}} actions={[
          { key: 'start', label: 'Start', icon: Icons.start, count: 2, onRun: () => {} },
          { key: 'stop', label: 'Stop', icon: Icons.stop, count: 1, onRun: () => setConfirm('stop') },
          { key: 'remove', label: 'Remove', icon: Icons.remove, danger: true, count: 2, onRun: () => setConfirm('remove') },
        ]} />
        <BulkBar count={3} noun={['channel', 'channels']} onClear={() => {}} busy="Stopping 2 of 3…" actions={[]} />
        <div className="uis-row">
          <button className="btn ghost" onClick={() => setConfirm('stop')}>Open "stop" confirmation</button>
          <button className="btn ghost" onClick={() => setConfirm('remove')}>Open "remove" confirmation</button>
        </div>
        <p className="uis-note">Inside a dialog, a summary uses the compact notice:</p>
        <div className="uis-stack" style={{ maxWidth: 480 }}>
          <Notice kind="ok" variant="compact" message="Removed 2 channels. Skipped 1." />
          <Notice kind="warn" variant="compact" title="1 will be skipped.">
            <ul className="bulk-list" style={{ marginTop: 4 }}><li>RTM News 24: Stop the channel before deleting it</li></ul>
          </Notice>
        </div>
      </Section>

      {confirm === 'stop' && (
        <ConfirmDialog title="Stop 1 channel?" confirmLabel="Stop" danger onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); notify({ kind: 'ok', message: 'Stopped 1.' }) }}
          body={<><p style={{ margin: '0 0 6px' }}>Their encoders come down and viewers lose the stream. They can be started again.</p><ul className="bulk-list"><li>RTM Sport</li></ul></>} />
      )}
      {confirm === 'remove' && (
        <ConfirmDialog title="Remove 2 channels?" confirmLabel="Remove 2 channels" danger typeToConfirm="remove 2" onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); notify({ kind: 'ok', message: 'Removed 2 channels. Each removal is in the audit log.' }) }}
          body={<><p style={{ margin: '0 0 6px' }}>This cannot be undone. Their recordings, clips, guide entries and schedules go with them.</p><ul className="bulk-list"><li>Berita</li><li>TV Okey</li></ul></>} />
      )}
    </>
  )
}
