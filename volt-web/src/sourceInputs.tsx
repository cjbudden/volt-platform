// ============================================================================
//  SOURCE INPUTS AT A GLANCE (channel page, Source pane).
//
//  A packaging channel can have many inputs: one per rendition, and a backup
//  for each. The operator has to see at once whether any of them has a
//  problem, without opening Settings. Every input gets one verdict, from two
//  kinds of evidence:
//
//    * while the channel runs, what the ingest reports for that input (live,
//      no signal), which wins: it is what is happening now;
//    * otherwise (and as detail), a Check source probe from the control
//      plane: reachable, picture size, bitrate (measured for HLS), and
//      whether that matches the rendition's label and bitrate.
//
//  Pull inputs (HLS, DASH, caller SRT, RTSP...) are checked automatically when
//  the page opens; push inputs (RTMP, listener SRT) have nothing to dial until
//  the sender connects, so they wait for the ingest to report.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type SourceProbe } from './api'

export interface InputDef {
  key: string
  role: string
  label: string | null
  protocol: string
  url: string
  kbps: number | null
  /** What the ingest says while the channel runs. */
  live?: { state: string; detail: string } | null
}
export type Level = 'ok' | 'warn' | 'bad' | 'info' | 'pending'
export interface Verdict { level: Level; text: string }
export interface CheckState { busy: boolean; probe?: SourceProbe; error?: string; at?: number }

const kbpsText = (n?: number | null) => n ? (n >= 1000 ? `${(n / 1000).toFixed(1)} Mbps` : `${n} kbps`) : null
export const heightOf = (label?: string | null) => parseInt(label ?? '', 10) || 0
export const isPull = (protocol: string, url: string) => {
  const p = protocol.toLowerCase()
  if (p === 'rtmp' || p === 'rtmps' || p === 'ndi' || p === 'st2110') return false
  if (p === 'srt') return /[?&]mode=caller\b/i.test(url)
  return /^(https?|rtsp|udp|rtp|srt):\/\//i.test(url)
}
export const inputName = (i: InputDef) => [i.label, i.role === 'backup' ? 'backup' : i.label ? null : 'primary'].filter(Boolean).join(' ')

/** One verdict for an input: the ingest's live report first, then the probe. */
export function verdictOf(i: InputDef, c: CheckState | undefined, running: boolean): Verdict {
  if (running && i.live) {
    if (i.live.state === 'down') return { level: 'bad', text: `No signal: ${i.live.detail}` }
    if (i.live.state === 'live') {
      const extra = c?.probe ? probeSummary(i, c.probe) : null
      return { level: extra && extra.level === 'warn' ? 'warn' : 'ok', text: `Receiving${extra ? ` · ${extra.text}` : ''}` }
    }
  }
  if (!i.url) return { level: 'bad', text: 'No address configured' }
  if (c?.busy) return { level: 'pending', text: 'Checking…' }
  if (c?.error) return { level: 'bad', text: c.error }
  if (c?.probe) return probeSummary(i, c.probe)
  if (!isPull(i.protocol, i.url)) return { level: 'info', text: `${i.protocol.toUpperCase()} is pushed to us: it shows here once the sender connects` }
  return { level: 'pending', text: 'Not checked yet' }
}

function probeSummary(i: InputDef, p: SourceProbe): Verdict {
  if (p.error) return { level: 'bad', text: p.error }
  if (!p.reachable) return { level: 'info', text: p.note || 'Not reachable from here' }
  const v = p.video
  const br = p.bitrate
  const kbps = br && br.how !== 'declared' ? br.kbps : null
  const facts = [v?.width && v?.height ? `${v.width}×${v.height}` : (v ? null : 'audio only'),
    kbps ? `${kbpsText(kbps)}${br?.how === 'measured' ? ' measured' : ''}` : br?.how === 'declared' ? `${kbpsText(br.kbps)}${br.maxKbps && br.maxKbps !== br.kbps ? `–${kbpsText(br.maxKbps)}` : ''} declared` : null,
  ].filter(Boolean).join(' · ')
  const issues: string[] = []
  const h = heightOf(i.label)
  if (p.hls?.kind === 'master' && i.label) issues.push('is a master playlist, not one rendition')
  else if (h && v?.height && v.height !== h) issues.push(`labelled ${h}p, stream is ${v.height}p`)
  if (i.kbps && kbps && Math.abs(kbps - i.kbps) / i.kbps > 0.3) issues.push(`set to ${kbpsText(i.kbps)}, sends ${kbpsText(kbps)}`)
  return issues.length ? { level: 'warn', text: `${facts}${facts ? ' · ' : ''}${issues.join('; ')}` } : { level: 'ok', text: facts || 'Reachable' }
}

/** Probes for a set of inputs: run all (two at a time), or one; pull inputs run once on open. */
export function useInputChecks(inputs: InputDef[], auto = true) {
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const sig = inputs.map(i => `${i.key}|${i.protocol}|${i.url}`).join('\n')
  const ran = useRef('')
  const one = useCallback(async (i: InputDef) => {
    setChecks(c => ({ ...c, [i.key]: { ...c[i.key], busy: true, error: undefined } }))
    try {
      const probe = await api.probeSource(i.url, i.protocol.toLowerCase())
      setChecks(c => ({ ...c, [i.key]: { busy: false, probe, at: Date.now() } }))
    } catch (e: any) {
      setChecks(c => ({ ...c, [i.key]: { busy: false, error: e?.message || 'Check failed', at: Date.now() } }))
    }
  }, [])
  const all = useCallback(async (only?: (i: InputDef) => boolean) => {
    const queue = inputs.filter(i => i.url && (!only || only(i)))
    const workers = [0, 1].map(async () => { for (let i = queue.shift(); i; i = queue.shift()) await one(i) })
    await Promise.all(workers)
  }, [inputs, one])
  useEffect(() => {
    if (!auto || ran.current === sig) return
    ran.current = sig
    void all(i => isPull(i.protocol, i.url))
  }, [sig, auto, all])
  return { checks, checkOne: one, checkAll: () => all() }
}

export function LevelDot({ level }: { level: Level }) {
  const cls = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : level === 'bad' ? 'down' : 'idle'
  return <span className={`dot-s ${cls}${level === 'pending' ? ' wait' : ''}`} aria-hidden="true" />
}

/** "3 inputs · all OK" / "2 of 6 inputs have a problem". */
export function summaryOf(inputs: InputDef[], verdicts: Verdict[]): { level: Level; text: string } {
  const bad = verdicts.filter(v => v.level === 'bad').length
  const warn = verdicts.filter(v => v.level === 'warn').length
  const pending = verdicts.filter(v => v.level === 'pending').length
  const n = inputs.length
  const noun = `${n} input${n === 1 ? '' : 's'}`
  if (bad) return { level: 'bad', text: `${bad} of ${noun} not working${warn ? `, ${warn} with a warning` : ''}` }
  if (warn) return { level: 'warn', text: `${warn} of ${noun} need a look` }
  if (pending) return { level: 'pending', text: `${noun} · checking…` }
  if (verdicts.every(v => v.level === 'info')) return { level: 'info', text: `${noun} · waiting for the sender` }
  return { level: 'ok', text: `${noun} · all OK` }
}
