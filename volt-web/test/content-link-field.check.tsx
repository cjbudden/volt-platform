// ============================================================================
//  CONTENT-LINK FIELD (src/ContentLinkField.tsx): the three states are drawn
//  differently, and a stored value of any shape reads the same way.
//    npx tsx --tsconfig test/tsconfig.json test/content-link-field.check.tsx
// ============================================================================
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
;(globalThis as any).React = React
// Components import their stylesheet (the app's pattern); outside the bundler a .css import is empty.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`export async function load(url, ctx, next) { if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }; return next(url, ctx) }`))

let pass = 0, fail = 0
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m) } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`) } }
const ID = '11111111-1111-4111-8111-111111111111'

;(async () => {
  const { ContentLinkField, linkValueOf } = await import('../src/ContentLinkField')
  const field = { key: 'trailerFor', label: 'Trailer for', type: 'content' as const, relation: 'trailer_for', required: true }
  const r = (value: any, link: any = null) => renderToStaticMarkup(<ContentLinkField field={field} value={value} onChange={() => {}} assetId={ID} link={link} />)

  const linked = r({ id: ID, name: 'Movie Title (2025)' }, { field: 'trailerFor', state: 'linked', name: 'Movie Title (2025)', source: 'auto', confidence: 0.97,
    reasons: ['One record matches clearly.'], candidates: [], asset: { id: ID, title: 'Movie Title (2025)', contentType: { id: 'x', name: 'Movie / feature film', key: 'movie' } } })
  ok(linked.includes('cl-linked') && linked.includes('Linked') && linked.includes('Movie / feature film'), 'linked: solid box, state and the record\'s type')
  ok(/Linked automatically, 97% sure/.test(linked), 'linked: says it was automatic and how sure')
  ok(linked.includes('Why this record') && linked.includes('One record matches clearly.'), 'linked: the reasons can be opened')
  ok(linked.includes('Change') && linked.includes('aria-label="Remove the Trailer for link"'), 'linked: change and remove')

  const named = r({ name: 'Movie Title' }, { field: 'trailerFor', state: 'unresolved', name: 'Movie Title', source: 'auto', confidence: 0.9, reasons: ['Two records are close.'],
    candidates: [{ assetId: ID, title: 'Movie Title (2025)', score: 0.92, reasons: [], asset: { id: ID, title: 'Movie Title (2025)' } }], asset: null })
  ok(named.includes('cl-name') && named.includes('Not linked to a record'), 'name only: dashed box, "Not linked to a record"')
  ok(named.includes('Is it one of these?') && named.includes('Movie Title (2025)') && named.includes('92%'), 'name only: the suggestions, with how alike')
  ok(named.includes('Find the record'), 'name only: find the record')
  ok(!named.includes('cl-linked'), 'name only never looks linked')

  const empty = r(undefined)
  ok(empty.includes('role="combobox"') && empty.includes('Search the library by name'), 'empty: a search box (combobox)')
  ok(!empty.includes('cl-linked') && !empty.includes('cl-name'), 'empty: neither state')

  ok(JSON.stringify([linkValueOf('Old text'), linkValueOf({ name: 'N' }), linkValueOf({ id: ID, name: 'T' }), linkValueOf(''), linkValueOf(null)]) ===
     JSON.stringify([{ name: 'Old text' }, { name: 'N' }, { id: ID, name: 'T' }, null, null]), 'stored values of every shape (older text, name, link, empty)')

  const stale = r({ id: '22222222-2222-4222-8222-222222222222', name: 'Other' }, { field: 'trailerFor', state: 'linked', source: 'auto', confidence: 0.9, reasons: ['x'], candidates: [], asset: { id: ID, title: 'Movie Title (2025)' } })
  ok(stale.includes('Other') && !stale.includes('Linked automatically'), 'a value changed in the form does not borrow the saved link\'s reasons')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
