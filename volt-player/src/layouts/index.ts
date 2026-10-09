// ============================================================================
//  Layout registry.
//
//  A named lookup with a FALLBACK rather than a bare map access, because the
//  name arrives from the database and from an embedder's options object. A
//  config saved by a newer console, or a typo in an embed, must render the
//  default player rather than throwing and leaving a blank box on a customer's
//  website.
//
//  ------------------------------------------------------------------------
//  THIS FILE IS LOAD-BEARING IN A WAY THAT DOES NOT LOOK IT.
//
//  It was once a card-only registry sitting beside four finished layouts. The
//  database's CHECK constraint allowed 'stage', the console offered it, an
//  operator could select it and save it, and the embed then fell through to the
//  card. Everything "worked": no error, no warning, no failed request. The only
//  symptom was a customer's site quietly showing the wrong skin.
//
//  A missing entry here is invisible at runtime BY DESIGN, since falling back
//  is the correct behaviour for a genuinely unknown name. What stops that being
//  a trap is layouts.check.ts, which asserts this registry and the migration's
//  CHECK constraint name the same layouts. Add one to either and the suite
//  fails until it is in both.
// ============================================================================
import type { Layout, LayoutName } from '../types'
import { cardLayout } from './card'
import { barLayout } from './bar'
import { heroLayout } from './hero'
import { stageLayout } from './stage'

const REGISTRY: Record<LayoutName, () => Layout> = {
  // AUDIO. A station is a continuous thing; these render what is playing now.
  card: cardLayout,
  bar: barLayout,
  hero: heroLayout,
  // VIDEO. An event has a life, most of which is not "playing": the stage
  // reserves the picture's box before there is a picture, and hands the
  // pre / ended / replay phases to the phase renderer.
  stage: stageLayout,
}

export function pickLayout(name: string | undefined): Layout {
  const make = REGISTRY[String(name ?? 'card') as LayoutName] ?? cardLayout
  return make()
}

export function layoutNames(): LayoutName[] {
  return Object.keys(REGISTRY) as LayoutName[]
}
