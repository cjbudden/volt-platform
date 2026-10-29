// ============================================================================
//  KEYBOARD OPERABILITY for things that are interactive but are not buttons.
//
//  The console is full of `<div onClick=...>`: filter chips, toggles, table
//  rows, tiles, sign out. Every one of them is invisible to the keyboard. A div
//  is not focusable, does not answer Enter or Space, and is announced as a
//  lump of text, so the whole interface is unusable without a mouse and
//  substantially unusable with a screen reader.
//
//  The honest fix for most of them is a real `<button>`, and where a rewrite is
//  cheap that is what should happen. But there are ninety-odd of these across
//  twenty files, and hand-converting each one is exactly the sort of wide
//  mechanical edit that introduces layout regressions and typos. So this gives
//  the div the four things a button has, in one place, where the behaviour can
//  be got right once:
//
//    role="button"    it is announced as what it is
//    tabIndex         it can be reached, and reached in document order
//    Enter and Space  the two keys a button responds to, with Space's page
//                     scroll suppressed, which is the bit hand-written versions
//                     usually forget
//    aria-disabled    a disabled control stays announced but stops responding,
//                     rather than vanishing from the tab order
//
//  Prefer <button type="button" class="..."> for anything new. Reach for this
//  when the element cannot be a button without disturbing the layout.
// ============================================================================
import { useEffect, useRef, type KeyboardEvent } from 'react'

export interface PressableOptions {
  /** Announced label, when the element's own text is not enough on its own. */
  label?: string
  /** Non-interactive for now: still announced, still focusable, does nothing. */
  disabled?: boolean
  /** For a control that expresses an on/off state, e.g. a filter chip. */
  pressed?: boolean
  /** Keep out of the tab order. Only for a control duplicated by a real one. */
  skipTabStop?: boolean
}

/**
 * Spread onto a non-button element that behaves like a button.
 *
 *   <div className="chip" {...pressable(() => setFilter('loops'), { pressed: f === 'loops' })}>
 *
 * The click handler is called by both the pointer and the keyboard, so there is
 * exactly one code path to reason about.
 */
export function pressable(onPress: (e?: any) => void, opts: PressableOptions = {}) {
  const disabled = !!opts.disabled
  return {
    role: 'button' as const,
    tabIndex: disabled || opts.skipTabStop ? -1 : 0,
    'aria-label': opts.label,
    'aria-disabled': disabled || undefined,
    'aria-pressed': opts.pressed,
    // THE EVENT IS FORWARDED. Plenty of these handlers call stopPropagation
    // on a row inside another clickable row, or read the target. Dropping the
    // event would silently change what they do, which is a worse bug than the
    // one being fixed.
    onClick: disabled ? undefined : (e: any) => onPress(e),
    onKeyDown: disabled ? undefined : (e: KeyboardEvent) => {
      // ONLY KEYS PRESSED ON THIS ELEMENT. Key events bubble: without this, a
      // pressable drawer or backdrop swallowed every Space and Enter typed into
      // any field inside it (the create-stream form could not take a space).
      // A button answers when IT has focus, never for its descendants.
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return
      // Space scrolls the page by default, which is the single most common
      // reason a hand-rolled keyboard handler feels broken.
      e.preventDefault()
      e.stopPropagation()
      onPress(e)
    },
  }
}

/**
 * The same, for a row or tile whose whole area opens something.
 *
 * Separate from `pressable` because the role differs and screen readers treat
 * them differently: a row that navigates is a link, not a button, and
 * announcing it as a button tells the user the wrong thing about what will
 * happen when they press it.
 */
export function openable(onOpen: (e?: any) => void, label?: string) {
  return {
    role: 'link' as const,
    tabIndex: 0,
    'aria-label': label,
    onClick: (e: any) => onOpen(e),
    onKeyDown: (e: KeyboardEvent) => {
      // A link responds to Enter only. Space is the button contract, and
      // making a link answer it is how you end up scrolling nowhere.
      if (e.key !== 'Enter') return
      e.preventDefault()
      onOpen(e)
    },
  }
}

// ============================================================================
//  ESCAPE CLOSES THE DIALOG ON TOP (29 Oct 2026, from the EPG guide).
//
//  Dialogs open over drawers (a picker over a form), so a plain document
//  listener in each would close every layer at once on one key press. Each
//  open dialog registers here and only the most recent one answers Escape.
// ============================================================================
const escStack: (() => void)[] = []
let escBound = false

export function useEscape(active: boolean, onEscape: () => void) {
  const cb = useRef(onEscape)
  cb.current = onEscape
  useEffect(() => {
    if (!active) return
    const h = () => cb.current()
    escStack.push(h)
    if (!escBound) {
      escBound = true
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !escStack.length) return
        e.preventDefault()
        escStack[escStack.length - 1]()
      })
    }
    return () => { const i = escStack.lastIndexOf(h); if (i >= 0) escStack.splice(i, 1) }
  }, [active])
}
