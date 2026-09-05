// ============================================================================
//  AUDIO LEVEL — one definition of "how tall is this bar", used by every meter
//  and waveform in the app (radio visualiser, channel/video dock meter,
//  clipping workbench).
//
//  THE RULE: a waveform plots PEAK AMPLITUDE on a LINEAR scale.
//
//  Not loudness, and not anything mapped linearly in dB. Both of those look
//  right in isolation and are wrong on real broadcast audio, which is
//  loudness-normalised and compressed:
//
//    * EBU R128 momentary loudness moves under 4 LU across a music segment (a
//      live station measured -17.8 to -14.0 LUFS), so every value lands in the
//      same narrow band.
//    * A dB scale over a 60 dB window puts -4 dBFS at 0.93 and -13 dBFS at
//      0.78 — a 9 dB swing rendered as a 15% difference in height.
//
//  Either way the result is a solid block of near-full-height bars: it reads as
//  "pinned at 100%" and shows no dynamics at all. Linear amplitude is what a
//  waveform view (SoundCloud and friends) actually draws: -4 dBFS is 0.63 of
//  full height, -13 dBFS is 0.22, and transients read as transients.
// ============================================================================

/** dBFS → linear amplitude 0..1, floored at -60 dBFS. */
export function dbToAmp(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)))
}

/** dBFS → 0..1 across a 60 dB window.
 *  FALLBACK ONLY, for a feed that predates per-frame true peak and carries
 *  loudness frames alone. Never use this for a new meter: see the note above. */
export function dbToUnit(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

/**
 * Peak amplitude (0..1) of the analyser's current window, measured in the TIME
 * domain, which is the browser-side equivalent of ffmpeg's per-frame true peak.
 *
 * Deliberately not `getByteFrequencyData`: those bytes are already a dB mapping
 * (minDecibels..maxDecibels scaled to 0..255), so an RMS over them is an RMS
 * over decibels, which is not amplitude and lands high for anything audible.
 * That, plus a perceptual `^0.6` boost on top, is what pinned the video page's
 * meter near the top of its strip.
 *
 * `buf` must be `analyser.fftSize` bytes; pass a reused array to avoid churn.
 */
export function analyserPeak(analyser: AnalyserNode, buf: Uint8Array): number {
  analyser.getByteTimeDomainData(buf as unknown as Uint8Array<ArrayBuffer>)
  let peak = 0
  for (let i = 0; i < buf.length; i++) {
    const d = Math.abs((buf[i] - 128) / 128)
    if (d > peak) peak = d
  }
  return Math.max(0, Math.min(1, peak))
}

/**
 * Linear amplitude (0..1) → bar height (0..1) for DISPLAY.
 *
 * The data stays linear peak amplitude (see the rule above); this is only the
 * drawing curve. Pure linear made speech look faint: football commentary
 * peaking at -13 dBFS is a bar 22% tall, which reads as "soft" next to music at
 * -4 dBFS (63%). A square-root curve is what most waveform displays draw:
 * -13 dBFS → 47%, -4 dBFS → 79%, -30 dBFS → 18%, -50 dBFS → 6%. Dynamics
 * survive (the spread between -4 and -13 is still a third of the height) and
 * silence is still silence.
 */
export function ampToBar(amp: number): number {
  if (!(amp > 0)) return 0
  return Math.min(1, Math.sqrt(amp))
}
