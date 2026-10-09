// ============================================================================
//  COUNTDOWN.
//
//  Somebody builds the page days before the event and links to it. So the page
//  has to be worth arriving at when there is nothing to play, and what it shows
//  is a promise: this thing, at this time.
//
//  ------------------------------------------------------------------------
//  FOUR STYLES, BECAUSE "BEFORE THE EVENT" IS NOT ONE SITUATION.
//
//    none       no countdown, just the title and the operator's message. For a
//               page whose own design already says when the thing is.
//    datetime   the date and time, in the VIEWER'S timezone. For an event three
//               weeks out, where "in 19 days" is less useful than "Sat 12 Oct".
//    relative   "starts in 3 days" / "starts in 2 hours". One line, no ticking,
//               so it is calm in a page that is mostly text.
//    digits     ticking DD HH MM SS. For the last day, and for the page people
//               sit on waiting.
//
//  A selection rather than one answer, because the same platform serves a
//  conference keynote announced in March and a football match that kicks off in
//  ten minutes, and neither wants the other's treatment.
//
//  ------------------------------------------------------------------------
//  THE COUNTDOWN NEVER STARTS THE PLAYER.
//
//  Reaching zero changes the words on screen and nothing else. Events start
//  late, and a client that promotes itself to live on the scheduled second
//  shows a dead stream to everyone who arrived on time. The server says when it
//  is live. See `EventInfo.phase`.
// ============================================================================

export type CountdownStyle = 'none' | 'datetime' | 'relative' | 'digits';

export function countdownStyle(v: unknown): CountdownStyle {
  return v === 'none' || v === 'datetime' || v === 'relative' || v === 'digits'
    ? v
    : 'digits';
}

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

export interface Parts { d: number; h: number; m: number; s: number }

export function parts(ms: number): Parts {
  const t = Math.max(0, ms);
  return {
    d: Math.floor(t / DAY),
    h: Math.floor((t % DAY) / HOUR),
    m: Math.floor((t % HOUR) / MIN),
    s: Math.floor((t % MIN) / SEC),
  };
}

/**
 * The date and time, in the viewer's own timezone.
 *
 * Their zone rather than the broadcaster's, because the one question this
 * answers is "when is it, for me". The zone name is shown so a viewer who is
 * travelling can tell which clock they are being given.
 */
export function absolute(at: number): string {
  try {
    const d = new Date(at);
    const day = new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
    }).format(d);
    const time = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(d);
    return `${day}, ${time}`;
  } catch {
    return new Date(at).toString();
  }
}

/**
 * "starts in 3 days", to one unit.
 *
 * One unit on purpose: "in 3 days, 4 hours and 11 minutes" is a number nobody
 * reads and nobody acts on. The unit sharpens as it gets closer, which is the
 * only part a waiting viewer cares about.
 */
export function relative(ms: number): string {
  if (ms <= 0) return 'Starting shortly';
  const p = parts(ms);
  if (p.d >= 1) return `Starts in ${p.d} day${p.d === 1 ? '' : 's'}`;
  if (p.h >= 1) return `Starts in ${p.h} hour${p.h === 1 ? '' : 's'}`;
  if (p.m >= 1) return `Starts in ${p.m} minute${p.m === 1 ? '' : 's'}`;
  return 'Starts in under a minute';
}

export function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

/**
 * How often the display needs redrawing, in ms.
 *
 * A ticking clock needs a second. A relative line changes at most once a
 * minute, and redrawing it every second is a wasted frame on every embed on
 * the internet. A fixed date never changes at all.
 */
export function tickInterval(style: CountdownStyle): number | null {
  if (style === 'digits') return SEC;
  if (style === 'relative') return 30 * SEC;
  return null;
}
