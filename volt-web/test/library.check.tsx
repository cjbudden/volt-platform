// ============================================================================
//  MEDIA LIBRARY COMPONENTS: the filter state and its URL round trip, the
//  grid / list toggle, the filter chips, and the grid cards (selection, lazy
//  keyscreens, keyboard reachable controls).
//
//    npx tsx --tsconfig test/tsconfig.json test/library.check.tsx
//
//  Rendering uses react-dom. The interaction half needs a DOM: it uses jsdom
//  when it can be imported (a dev dependency, or JSDOM_PATH pointing at an
//  installed copy) and is skipped with a notice otherwise, so the pure half
//  always runs.
// ============================================================================
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMPTY_FILTERS, filtersToApi, filtersToSearch, isFiltered, parseColumns, parseFilters, DEFAULT_COLUMNS, type LibraryFilters } from '../src/pages/vod/libraryQuery'

let pass = 0, fail = 0
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m) } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`) } }
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), m, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)

// The app's own files are compiled with the classic JSX transform here (their
// tsconfig is the bundler's), which expects React in scope.
;(globalThis as any).React = React
// localStorage for usePref outside a browser
;(globalThis as any).localStorage ??= (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } } })()

const ID1 = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222'

;(async () => {
  console.log('== filters <-> URL ==')
  const f: LibraryFilters = { ...EMPTY_FILTERS, source: ['channel', 'none'], media: ['song'], types: [ID1, ID2], avail: ['available'], origin: ['clip', 'upload'], missing: true, res: [1080, 720], codec: ['h264'], from: '2026-10-01', to: '2026-10-18', durMin: 5, durMax: 60, q: 'harbour final', sort: 'least_complete', review: 'needs', stale: true }
  const url = filtersToSearch(f)
  eq(parseFilters(url), f, 'every filter survives the round trip through the page URL')
  ok(url.includes(`type=${encodeURIComponent(`${ID1},${ID2}`)}`) && url.includes('missing=1') && url.includes('res=1080%2C720'), `short, shareable parameters (${url})`)
  eq(filtersToSearch(EMPTY_FILTERS), '', 'nothing filtered: a clean URL')
  ok(!isFiltered({ ...EMPTY_FILTERS, sort: 'title' }) && isFiltered({ ...EMPTY_FILTERS, missing: true }), 'sort alone does not count as filtered')
  const bad = parseFilters('?type=not-an-id,' + ID1 + '&avail=nonsense,available&res=abc,1080&from=yesterday&dmin=-3&sort=hack&codec=H.264!')
  eq([bad.types, bad.avail, bad.res, bad.from, bad.durMin, bad.sort, bad.codec], [[ID1], ['available'], [1080], '', null, 'newest', []], 'malformed URL values are dropped, never thrown')
  const api = new URLSearchParams(filtersToApi(f, { limit: 48, cursor: 'abc' }))
  eq(api.get('schema_id'), `${ID1},${ID2}`, 'API: content types as schema_id (any of)')
  eq([api.get('source'), api.get('media_type')], ['channel,none', 'song'], 'API: source and asset type')
  eq([api.get('availability_state'), api.get('origin'), api.get('metadata_missing_required'), api.get('top_height'), api.get('video_codec')], ['available', 'clip,upload', 'true', '1080,720', 'h264'], 'API: availability, source, missing metadata, resolution, codec')
  eq([api.get('created_at[gte]'), api.get('created_at[lt]')], ['2026-10-01', '2026-10-19'], 'API: date range, the end day included')
  eq([api.get('duration_ms[gte]'), api.get('duration_ms[lte]')], ['300000', '3600000'], 'API: duration range in ms')
  eq([api.get('review_state'), api.get('has_stale_publication'), api.get('q')], ['in_review,changes_requested', 'true', 'harbour final'], 'API: review, stale, search')
  eq([api.get('sort'), api.get('limit'), api.get('count'), api.get('cursor')], ['metadata_completeness,-created_at', '48', 'true', 'abc'], 'API: sort, page size, total, cursor')
  const fq = new URLSearchParams(filtersToApi(f, { facets: true }))
  ok(!fq.has('sort') && !fq.has('limit') && !fq.has('cursor') && fq.get('schema_id') === `${ID1},${ID2}`, 'facet query: the filters without paging')
  eq(parseColumns(null), DEFAULT_COLUMNS, 'default optional columns')
  eq(parseColumns('codec,bogus,renditions'), ['codec', 'renditions'], 'stored columns are validated')
  eq(parseColumns(''), [], 'every optional column can be turned off')

  console.log('\n== grid cards (static render) ==')
  const { LibraryGrid } = await import('../src/pages/vod/LibraryGrid')
  const rows: any[] = [
    { id: ID1, title: 'Harbour: The Pilot', duration_ms: 3_725_000, poster_key: 'https://cdn.example/p1.jpg', schema_name: 'Programme / episode', schema_org_type: 'Episode', availability_state: 'available', metadata_completeness: 62, metadata_missing_required: true, top_height: 1080, video_codec: 'h264', rendition_count: 3, created_at: '2026-10-18' },
    { id: ID2, title: null, duration_ms: 42_000, schema_name: null, availability_state: 'draft', metadata_completeness: null, encode_state: 'running', encode_pct: 40, created_at: '2026-10-18' },
  ]
  const html = renderToStaticMarkup(<LibraryGrid rows={rows} selected={new Set([ID1])} onToggle={() => {}} onOpen={() => {}} openId={null} />)
  ok((html.match(/<li /g) ?? []).length === 2, 'one card per asset')
  ok(/loading="lazy"/.test(html), 'keyscreens load lazily')
  ok(html.includes('1:02:05') && html.includes('1080p'), 'length and top rendition on the keyscreen')
  ok(html.includes('Programme / episode') && html.includes('title="schema.org Episode"'), 'content type with its schema.org type')
  ok(html.includes('Available') && html.includes('Not published'), 'availability as a word')
  ok(html.includes('62%') && html.includes('H.264 · 3 renditions'), 'completeness and encode summary')
  ok(html.includes('No type') && html.includes('Encoding 40%') && html.includes('Untitled'), 'an asset still encoding, with no type or title, says so')
  ok(/class="lib-card on"/.test(html) && /checked=""/.test(html), 'the selected card is marked and its box ticked')
  ok(html.includes('aria-label="Open Harbour: The Pilot"') && html.includes('aria-label="Select Harbour: The Pilot"'), 'open and select are labelled controls (keyboard reachable)')
  ok(!/border-left/.test(html), 'no edge accent bar')

  console.log('\n== toolbar and filter panel (static render) ==')
  const { LibraryToolbar, LibraryFilterPanel } = await import('../src/pages/vod/LibraryFilters')
  const tb = (view: 'list' | 'grid') => renderToStaticMarkup(<LibraryToolbar filters={EMPTY_FILTERS} onChange={() => {}} view={view} onView={() => {}} columns={DEFAULT_COLUMNS} onColumns={() => {}} />)
  ok(/role="radio" aria-checked="true"[^>]*>.*?List/.test(tb('list')) && tb('list').includes('Grid'), 'view toggle: List and Grid with icons, List on')
  ok(/aria-checked="true"[^>]*><svg[^]*?Grid/.test(tb('grid').split('List</button>')[1] ?? ''), 'view toggle: Grid on')
  ok(tb('list').includes('Columns') && !tb('grid').includes('Columns'), 'optional columns only in the list view')
  const facets: any = { total: 9, facets: {
    types: [{ id: ID1, name: 'Programme / episode', key: 'episode', schema_org_type: 'Episode', n: 4 }, { id: ID2, name: 'Movie', key: 'movie', schema_org_type: 'Movie', n: 2 }, { id: null, name: null, key: null, schema_org_type: null, n: 3 }],
    availability: [{ value: 'available', n: 5 }, { value: 'draft', n: 4 }], origins: [{ value: 'clip', n: 7 }, { value: 'upload', n: 2 }],
    sources: [{ value: 'channel', n: 5 }, { value: 'upload', n: 3 }, { value: 'none', n: 1 }], media_types: [{ value: 'video', n: 6 }, { value: 'song', n: 3 }],
    resolutions: [{ value: 720, n: 2 }, { value: 1080, n: 7 }], codecs: [{ value: 'h264', n: 9 }], metadata: [{ value: true, n: 6 }, { value: false, n: 3 }] } }
  const panel = renderToStaticMarkup(<LibraryFilterPanel filters={{ ...EMPTY_FILTERS, types: [ID2] }} onChange={() => {}} facets={facets} />)
  ok(/aria-pressed="false"[^>]*>Programme \/ episode<span class="ct">4/.test(panel) && /aria-pressed="true"[^>]*>Movie<span class="ct">2/.test(panel), 'content type chips: multi-select toggles with counts')
  ok(panel.includes('3 with no type'), 'assets with no type are counted')
  ok(/Missing required<span class="ct">6/.test(panel), 'missing required metadata with its count')
  const plain = renderToStaticMarkup(<LibraryFilterPanel filters={EMPTY_FILTERS} onChange={() => {}} facets={facets} />)
  ok(!plain.includes('Top resolution') && !plain.includes('Content type') && plain.includes('More filters'), 'secondary filters (content type among them) folded away until asked for')
  ok(/Asset type/.test(plain) && />Video<span class="ct">6/.test(plain) && />Audio<span class="ct">0/.test(plain) && />Song<span class="ct">3/.test(plain), 'asset type chips: video, audio, song with counts')
  ok(/>Channel<span class="ct">5/.test(plain) && />Event<span class="ct">0/.test(plain) && />Radio</.test(plain) && />Upload<span class="ct">3/.test(plain) && />No source<span class="ct">1/.test(plain), 'source chips: channel, event, radio, upload and no source')
  ok(plain.includes('Created as'), 'how it was made is labelled Created as, not Source')
  const panel2 = renderToStaticMarkup(<LibraryFilterPanel filters={{ ...EMPTY_FILTERS, res: [1080] }} onChange={() => {}} facets={facets} />)
  ok(panel2.indexOf('1080p') < panel2.indexOf('720p') && panel2.includes('Top resolution') && panel2.includes('Clear filters'), 'a secondary filter in use opens the panel; resolutions highest first; Clear shown')

  console.log('\n== interaction (DOM) ==')
  let JSDOM: any = null
  for (const spec of [process.env.JSDOM_PATH, 'jsdom'].filter(Boolean) as string[]) {
    try { JSDOM = (await import(spec)).JSDOM; break } catch { /* try the next */ }
  }
  if (!JSDOM) {
    console.log('SKIP no jsdom: set JSDOM_PATH to an installed jsdom to run the interaction checks')
  } else {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/vod' })
    const g: any = globalThis
    for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'HTMLInputElement']) Object.defineProperty(g, k, { value: dom.window[k], configurable: true, writable: true })
    g.IS_REACT_ACT_ENVIRONMENT = true
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useState } = await import('react')
    const { usePref } = await import('../src/listFilters')
    const root = createRoot(document.getElementById('root')!)
    let lastFilters: LibraryFilters = EMPTY_FILTERS
    function Harness() {
      const [view, setView] = usePref<'list' | 'grid'>('vod.view', 'list', ['list', 'grid'])
      const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS)
      const [sel, setSel] = useState<Set<string>>(new Set())
      lastFilters = filters
      return (
        <div>
          <LibraryToolbar filters={filters} onChange={setFilters} view={view} onView={setView} columns={DEFAULT_COLUMNS} onColumns={() => {}} />
          <LibraryFilterPanel filters={filters} onChange={setFilters} facets={facets} />
          {view === 'grid'
            ? <LibraryGrid rows={rows} selected={sel} onToggle={(id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })} onOpen={() => {}} openId={null} />
            : <table id="list"><tbody>{rows.map((r) => <tr key={r.id}><td>{r.title}</td></tr>)}</tbody></table>}
          <output id="sel">{[...sel].join(',')}</output>
        </div>
      )
    }
    await act(async () => { root.render(<Harness />) })
    const $ = (sel: string) => document.querySelector(sel) as HTMLElement
    const byText = (sel: string, t: string) => [...document.querySelectorAll(sel)].find((e) => e.textContent?.includes(t)) as HTMLElement
    ok(!!$('#list') && !$('.lib-grid'), 'starts in the list view')
    await act(async () => { byText('.segmented button', 'Grid').click() })
    ok(!!$('.lib-grid') && !$('#list'), 'Grid shows the cards')
    ok(localStorage.getItem('volt.list.vod.view') === 'grid', 'the choice is remembered in this browser')
    await act(async () => { root.unmount() })
    const root2 = createRoot(document.getElementById('root')!)
    await act(async () => { root2.render(<Harness />) })
    ok(!!$('.lib-grid'), 'coming back opens in the remembered view')
    await act(async () => { ($('.lib-card-sel input') as HTMLInputElement).click() })
    ok($('#sel').textContent === ID1, 'ticking a card selects it (the same selection the bulk bar uses)')
    await act(async () => { byText('.lib-chip', 'Programme / episode').click() })
    await act(async () => { byText('.lib-chip', 'Movie').click() })
    eq(lastFilters.types, [ID1, ID2], 'two content type chips: both selected (multi-select)')
    await act(async () => { byText('.lib-chip', 'Programme / episode').click() })
    eq(lastFilters.types, [ID2], 'clicking again deselects')
    await act(async () => { byText('.lib-chip', 'Missing required').click() })
    ok(lastFilters.missing, 'missing required metadata filter')
    await act(async () => { byText('button', 'More filters').click() })
    ok(!!byText('.chip-group-l', 'Top resolution'), 'More filters opens resolution, codec, review, date and duration')
    await act(async () => { byText('.lib-chip', '1080p').click() })
    eq(lastFilters.res, [1080], 'resolution filter')
    ok($('button[aria-pressed]').tagName === 'BUTTON', 'chips are real buttons (Tab and Enter work)')
    await act(async () => { byText('button', 'Clear filters').click() })
    ok(!isFiltered(lastFilters), 'Clear filters clears everything')
    await act(async () => { root2.unmount() })
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
