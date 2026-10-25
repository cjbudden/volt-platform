// A webhook receiver that checks every call really came from Volt (Node 18 or later).
// The same check works for ingest webhooks and for workflow add-ons.
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = 'whsec_...'
const TOLERANCE_SECONDS = 300

/** X-Volt-Signature is t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">. */
export function verify(header, body, secret = SECRET, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')))
  const t = Number(parts.t)
  if (!t || !parts.v1 || Math.abs(now - t) > TOLERANCE_SECONDS) return false
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest()
  const got = Buffer.from(parts.v1, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    // Check the exact bytes received, before parsing them
    if (!verify(req.headers['x-volt-signature'], body)) {
      res.writeHead(401).end()
      return
    }
    const event = JSON.parse(body)
    console.log(JSON.stringify({ event: event.event, assetId: event.asset.id, file: event.origin.originalName, sha256: event.object.sha256 }))
    res.writeHead(204).end()
  })
}).listen(process.env.PORT ?? 3000)
