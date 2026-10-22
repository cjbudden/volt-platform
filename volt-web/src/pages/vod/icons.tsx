// Line icons for the Media Library, drawn on the Volt icon grid: 24 x 24,
// 2-unit stroke, round caps and joins, no fills. They take currentColor.
const s = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
export const LibIcon = {
  grid: <svg {...s}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>,
  list: <svg {...s}><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h0M4.5 12h0M4.5 18h0" /></svg>,
  search: <svg {...s}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /></svg>,
  filter: <svg {...s}><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></svg>,
  columns: <svg {...s}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></svg>,
  audio: <svg {...s}><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></svg>,
  wave: <svg {...s}><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0" /></svg>,
  media: <svg {...s}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9.5v5l4.5-2.5z" /></svg>,
  epg: <svg {...s}><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 10h18M8 3v4M16 3v4M7 14h4M7 17h7" /></svg>,
  encode: <svg {...s}><path d="M4 7h10M4 12h16M4 17h7" /><circle cx="17" cy="7" r="2" /><circle cx="14" cy="17" r="2" /></svg>,
  check: <svg {...s}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  alert: <svg {...s}><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h0" /></svg>,
  empty: <svg {...s}><circle cx="12" cy="12" r="7" strokeDasharray="3 3" /></svg>,
  clock: <svg {...s}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>,
  close: <svg {...s}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  prev: <svg {...s}><path d="M15 6l-6 6 6 6" /></svg>,
  next: <svg {...s}><path d="M9 6l6 6-6 6" /></svg>,
  publish: <svg {...s}><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 14v5h14v-5" /></svg>,
  open: <svg {...s}><path d="M14 4h6v6M20 4l-8 8M18 14v5H5V6h5" /></svg>,
}
