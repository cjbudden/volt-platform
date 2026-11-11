// "Search the web" in Find details (build queue F3). The free option only
// (Christian, 11 Nov 2026): Volt opens a web search in the person's own
// browser, in a new tab, with the term filled in, and the person pastes the
// link of a result back into "Or paste a link", which reads it as in F2. Volt
// calls no search service and holds no setting or key for one, so nothing
// here costs anything or leaves the browser except the tab the person opens.
// Google, as the song finder's "look by hand" links already use it
// (volt-app/src/modules/vodImage.ts searchLinks). A pure function, so the
// check suite can pin the address without a browser.

/** Longer terms are cut: a search box never needs more, and it keeps the address short. */
export const WEB_SEARCH_MAX = 200

/** The web search address for a term, or null when there is nothing to search for. */
export function webSearchUrl(term: string | null | undefined): string | null {
  const q = (term ?? '').replace(/\s+/g, ' ').trim().slice(0, WEB_SEARCH_MAX).trim()
  if (!q) return null
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`
}
