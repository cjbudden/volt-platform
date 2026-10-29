// ============================================================================
//  THE SOURCE FILE, as delivered: what an operator checks first about any
//  upload. Container, size, duration, overall bitrate; the video's codec,
//  profile and level, resolution, aspect, frame rate, scan, bitrate, bit depth
//  and colour; every audio track; subtitle tracks. From the ingest probe
//  (volt-app services/ingest/metadata.ts interpretProbe), refreshed by each
//  encode, so it is there from the moment the upload lands.
// ============================================================================
import type { ReactNode } from 'react'

const CODEC: Record<string, string> = {
  h264: 'H.264 / AVC', hevc: 'H.265 / HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', prores: 'Apple ProRes', mpeg2video: 'MPEG-2', dnxhd: 'Avid DNxHD / HR',
  mjpeg: 'Motion JPEG', png: 'PNG', gif: 'GIF', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)', pcm_s16le: 'PCM 16-bit', pcm_s24le: 'PCM 24-bit', pcm_s32le: 'PCM 32-bit', alac: 'Apple Lossless',
}
const FORMAT: Record<string, string> = {
  'mov,mp4,m4a,3gp,3g2,mj2': 'MP4 / QuickTime', matroska: 'Matroska (MKV)', 'matroska,webm': 'WebM / Matroska', mpegts: 'MPEG transport stream',
  mxf: 'MXF', avi: 'AVI', mp3: 'MP3', wav: 'WAV', flac: 'FLAC', ogg: 'Ogg', aac: 'AAC (ADTS)',
}
const codecName = (c?: string | null) => (c ? CODEC[c] ?? c.toUpperCase() : null)
const rate = (kbps?: number | null) => (kbps ? (kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 10000 ? 0 : 1)} Mb/s` : `${kbps} kb/s`) : null)
const size = (b?: number | null) => (b ? (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${(b / 1048576).toFixed(1)} MB`) : null)
const dur = (s?: number | null) => {
  if (s == null) return null
  const t = Math.round(s * 1000) / 1000, h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${sec.toFixed(2).padStart(5, '0')}`
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
const ratio = (w: number, h: number) => { const g = gcd(w, h); const r = `${w / g}:${h / g}`; return r === '64:27' ? '21:9 (64:27)' : r }
const scan = (f?: string | null) => (!f || f === 'progressive' ? 'Progressive' : f === 'tt' || f === 'tb' ? 'Interlaced, top field first' : f === 'bb' || f === 'bt' ? 'Interlaced, bottom field first' : f)
const layout = (l?: string | null, ch?: number) => l ? l.replace(/\(.*\)/, '').replace('stereo', 'Stereo').replace('mono', 'Mono') : ch ? `${ch} ch` : null
const level = (codec?: string, l?: number | null) => (l ? (codec === 'h264' ? (l / 10).toFixed(1) : codec === 'hevc' ? (l / 30).toFixed(1) : String(l)) : null)
const colour = (v: any) => {
  const parts = [v.colorPrimaries, v.colorTransfer, v.colorSpace].filter(Boolean)
  const hdr = v.colorTransfer === 'smpte2084' ? 'HDR10 (PQ)' : v.colorTransfer === 'arib-std-b67' ? 'HLG' : null
  const label = parts.length && parts.every((p: string) => /709/.test(p)) ? 'Rec. 709 (SDR)' : hdr ? `${hdr}, ${v.colorPrimaries ?? ''}`.replace(/, $/, '') : parts.join(' / ')
  return label ? `${label}${v.colorRange ? ` · ${v.colorRange === 'tv' ? 'limited range' : v.colorRange === 'pc' ? 'full range' : v.colorRange}` : ''}` : null
}

function Row({ k, v, warn }: { k: string; v: ReactNode; warn?: string | null }) {
  if (v == null || v === '') return null
  return <><dt>{k}</dt><dd>{v}{warn && <span className="src-warn" title={warn}> · {warn}</span>}</dd></>
}

export function SourceFacts({ probe, bytes, filename, mime }: { probe: any; bytes?: number | string | null; filename?: string | null; mime?: string | null }) {
  if (!probe) return null
  const v = probe.video, tracks: any[] = probe.audioTracks?.length ? probe.audioTracks : probe.audio ? [probe.audio] : []
  const fmt = FORMAT[probe.format] ?? probe.formatLong ?? probe.format
  const odd = v && v.width && v.width % 2 ? 'odd width' : null
  return (
    <section className="src-facts" aria-label="Source file">
      <div className="sec-label">Source file</div>
      <dl>
        <Row k="File" v={filename ?? null} />
        <Row k="Container" v={fmt ? `${fmt}${mime ? ` (${mime})` : ''}` : null} />
        <Row k="Size" v={size(Number(bytes) || probe.sizeBytes)} />
        <Row k="Duration" v={dur(probe.durationSec)} />
        <Row k="Overall bitrate" v={rate(probe.bitrateKbps)} />
      </dl>
      {v && <>
        <div className="src-h">Video</div>
        <dl>
          <Row k="Codec" v={[codecName(v.codec), v.profile, level(v.codec, v.level) && `level ${level(v.codec, v.level)}`].filter(Boolean).join(' · ')} />
          <Row k="Resolution" v={v.width ? `${v.width} × ${v.height}${v.height >= 2160 ? ' (4K UHD)' : v.height >= 1080 ? ' (Full HD)' : v.height >= 720 ? ' (HD)' : ''}` : null} warn={odd} />
          <Row k="Aspect" v={v.displayAspect && v.displayAspect !== '0:1' ? `${v.displayAspect}${v.sampleAspect && v.sampleAspect !== '1:1' ? ` (pixels ${v.sampleAspect})` : ''}` : v.width && v.height ? ratio(v.width, v.height) : null} />
          <Row k="Frame rate" v={v.fps ? `${v.fps} fps` : null} />
          <Row k="Scan" v={scan(v.fieldOrder)} />
          <Row k="Bitrate" v={rate(v.bitrateKbps)} />
          <Row k="Bit depth" v={v.bitDepth ? `${v.bitDepth}-bit` : null} />
          <Row k="Pixel format" v={v.pixFmt} />
          <Row k="Colour" v={colour(v)} />
          <Row k="Frames" v={v.frames ? Number(v.frames).toLocaleString() : null} />
        </dl>
      </>}
      {tracks.map((a, i) => (
        <div key={i}>
          <div className="src-h">Audio{tracks.length > 1 ? ` ${i + 1}` : ''}{a.language ? ` · ${a.language}` : ''}</div>
          <dl>
            <Row k="Codec" v={[codecName(a.codec), a.profile].filter(Boolean).join(' · ')} />
            <Row k="Channels" v={layout(a.channelLayout, a.channels)} />
            <Row k="Sample rate" v={a.sampleRate ? `${(a.sampleRate / 1000).toFixed(1)} kHz` : null} />
            <Row k="Bitrate" v={rate(a.bitrateKbps)} />
          </dl>
        </div>
      ))}
      {!v && !tracks.length && <div className="hintxt">No video or audio streams were found in the file.</div>}
      {probe.subtitles?.length > 0 && <>
        <div className="src-h">Subtitles</div>
        <dl><Row k="Tracks" v={probe.subtitles.map((s: any) => `${s.codec ?? '?'}${s.language ? ` (${s.language})` : ''}`).join(', ')} /></dl>
      </>}
    </section>
  )
}
