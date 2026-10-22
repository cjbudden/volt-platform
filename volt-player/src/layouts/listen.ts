// "Listen on Apple Music" under the track. Apple's artwork and track details
// may be shown only to promote the song, next to a link to it on Apple Music,
// so when the server's now-playing answer carries `listen` (the cover came from
// Apple), every built-in skin shows it. Hidden otherwise.
import type { NowPlaying } from '../types';

export function listenEl(): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'vp-listen';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  return a;
}

export function setListen(a: HTMLAnchorElement, np: NowPlaying | null | undefined): void {
  const l = np?.listen;
  if (l && /^https:\/\//.test(l.url)) {
    if (a.href !== l.url) a.href = l.url;
    a.textContent = `Listen on ${l.service}`;
    a.style.display = '';
  } else a.style.display = 'none';
}

/** The link's look, shared by the skins (inherits their dim ink colour). */
export const LISTEN_CSS = (scope: string) =>
  `${scope} .vp-listen { display: inline-block; margin-top: 4px; font-size: 12px; color: var(--vp-ink-dim); text-decoration: underline; text-underline-offset: 2px; }
${scope} .vp-listen:hover { color: var(--vp-ink); }`;
