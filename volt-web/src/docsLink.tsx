import { useState } from 'react'
import { api, ApiError } from './api'
import { useNotify } from './notices'
import { pressable } from './a11y'

/* DOCUMENTATION. The docs are a separate static site that only signed-in
   customers can read. Opening them asks the API for a short-lived pass (a
   CloudFront signed cookie on the shared parent domain), then opens the site.

   The new tab is opened FIRST, inside the click, and pointed at the docs once
   the pass arrives: a tab opened after an await is treated as a pop-up and
   blocked by most browsers. */
export function openDocs(notify: ReturnType<typeof useNotify>, path = '') {
  const tab = window.open('about:blank', '_blank')
  return api.docsSession().then(({ url }) => {
    const target = url + path
    if (tab) { tab.opener = null; tab.location.href = target } else window.location.href = target
  }).catch((e: unknown) => {
    tab?.close()
    const notConfigured = e instanceof ApiError && e.status === 404
    notify({
      id: 'docs', kind: 'error',
      title: notConfigured ? 'Documentation is not set up on this server.' : "Couldn't open the documentation.",
      message: notConfigured
        ? 'Ask your Volt administrator for the documentation link.'
        : `${e instanceof Error ? e.message : String(e)}. Try again in a moment.`,
    })
  })
}

export function DocsButton() {
  const notify = useNotify()
  const [busy, setBusy] = useState(false)
  return (
    <div className="icon-btn" title="Documentation" aria-busy={busy}
      {...pressable(() => { setBusy(true); openDocs(notify).finally(() => setBusy(false)) }, { label: 'Documentation' })}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9.6 9.2a2.5 2.5 0 014.8.9c0 1.7-2.4 2.2-2.4 3.6" /><path d="M12 17h.01" /></svg>
    </div>
  )
}
