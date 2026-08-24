/* ============================================================================
   UPLOAD SERVICE WORKER

   This exists for one job: to be awake when the page is not.

   Background Fetch hands the transfer to the browser. The browser keeps sending
   chunks with the tab closed, shows its own progress UI, and then wakes THIS
   worker to say what happened. The assembly call has to be made from here,
   because by then there may be no page left to make it.

   It is deliberately not a caching service worker. It does not intercept fetch,
   does not cache anything, and has no opinion about the rest of the app — a
   worker that quietly serves stale assets is a debugging problem nobody expects,
   and this one has no reason to take that on.
   ========================================================================== */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

/** The session id is carried in the fetch's own id, so the worker needs no state. */
function sessionIdOf(fetchId) {
  return String(fetchId || '').startsWith('volt-upload-')
    ? String(fetchId).slice('volt-upload-'.length)
    : null
}

async function tell(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  for (const c of clients) c.postMessage({ channel: 'volt-upload', ...message })
}

/**
 * The capability token, recovered from the requests themselves.
 *
 * The worker is never told the token directly. It does not need to be: the page
 * built every chunk request with the token in its Authorization header, and
 * those requests are still readable from the completed fetch. So the credential
 * travels with the work rather than being stored anywhere.
 */
async function tokenFrom(registration) {
  try {
    const records = await registration.matchAll()
    for (const r of records) {
      const auth = r.request.headers.get('authorization')
      if (auth && auth.startsWith('Bearer upl_')) return auth.slice(7)
    }
  } catch { /* fall through */ }
  return null
}

/** Did every chunk actually land? A 4xx on one of them is a failure that
 *  Background Fetch itself reports as success, so it has to be checked. */
async function allChunksOk(registration) {
  try {
    const records = await registration.matchAll()
    for (const r of records) {
      const res = await r.responseReady.catch(() => null)
      if (!res || !res.ok) return false
    }
    return true
  } catch {
    return false
  }
}

self.addEventListener('backgroundfetchsuccess', (event) => {
  const sessionId = sessionIdOf(event.registration.id)
  if (!sessionId) return
  event.waitUntil((async () => {
    const token = await tokenFrom(event.registration)
    if (!token) {
      await tell({ type: 'error', sessionId, error: 'the upload token was lost' })
      return
    }

    // Background Fetch calls a transfer successful when every request COMPLETED,
    // not when every request succeeded. A chunk rejected with a 400 completes
    // perfectly well. Assembling on that basis would produce a file with a hole
    // in it, so the responses are checked before anything is assembled.
    if (!(await allChunksOk(event.registration))) {
      await tell({ type: 'error', sessionId, error: 'some chunks were rejected' })
      try {
        await event.updateUI({ title: 'Upload failed — some chunks were rejected' })
      } catch { /* updateUI is only allowed once */ }
      return
    }

    try {
      const r = await fetch(`/api/uploads/${sessionId}/finish`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        await tell({ type: 'error', sessionId, error: body.error || `assembly failed (${r.status})` })
        try { await event.updateUI({ title: 'Upload failed during assembly' }) } catch { /* */ }
        return
      }
      const out = await r.json()
      await tell({ type: 'done', sessionId, assetId: out.assetId, bytes: out.bytes })
      try { await event.updateUI({ title: 'Upload complete' }) } catch { /* */ }
    } catch (e) {
      await tell({ type: 'error', sessionId, error: String(e && e.message ? e.message : e) })
    }
  })())
})

self.addEventListener('backgroundfetchfail', (event) => {
  const sessionId = sessionIdOf(event.registration.id)
  if (!sessionId) return
  // NOT an error the user has to act on. Every chunk that did land is on the
  // server, so reopening the page resumes from there. Saying "failed" without
  // saying that is how people delete a nearly-finished upload and start again.
  event.waitUntil(tell({
    type: 'error', sessionId,
    error: 'The upload was interrupted. Reopen Loops & Fillers to resume it — ' +
           'everything already sent is kept.',
  }))
})

self.addEventListener('backgroundfetchabort', (event) => {
  const sessionId = sessionIdOf(event.registration.id)
  if (sessionId) event.waitUntil(tell({ type: 'error', sessionId, error: 'The upload was cancelled.' }))
})

/** Clicking the browser's own progress notification brings the admin forward. */
self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    if (clients.length) return clients[0].focus()
    return self.clients.openWindow('/loops')
  })())
})
