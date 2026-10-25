// Every record in a list, page by page, by following the Link header (Node 18 or later)
const base = 'https://your-volt-host'
const token = 'sk_live_...'

let url = '/api/vod?sort=-created_at&limit=200'
let total = 0
while (url) {
  const res = await fetch(base + url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const page = await res.json()
  total += page.length
  url = (res.headers.get('Link') ?? '').match(/<([^>]+)>;\s*rel="next"/)?.[1]
}
console.log(JSON.stringify({ assets: total }))
