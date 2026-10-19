// ============================================================================
//  THE ENGINE: plays one source in one media element and reports what it sees.
//
//  Shaka for HLS and DASH (adaptive bitrate, tracks, live windows), the
//  browser's own HLS where Shaka cannot run or where it must not (Safari with
//  AirPlay: AirPlay sends the URL to the TV, which an MSE player has no URL
//  for), and a plain src for progressive MP3/MP4.
//
//  The engine never draws. It answers questions (snapshot()) and obeys
//  commands; the player turns that into state and the skin into pixels.
// ============================================================================
import shaka from 'shaka-player/dist/shaka-player.compiled';
import type { AudioTrackInfo, Quality, Source, TextTrackInfo } from './types';
import { qualityLabel, qualityList, sourceKind } from './schedule';

let polyfilled = false;

export type EngineMode = 'shaka' | 'native' | 'progressive';

export interface EngineSnapshot {
  live: boolean;
  duration: number;
  seekable: { start: number; end: number } | null;
  presentationStart: number | null;
  qualities: Quality[];
  activeQuality: Quality | null;
  quality: string;
  textTracks: TextTrackInfo[];
  textTrack: string | null;
  audioTracks: AudioTrackInfo[];
  audioTrack: string | null;
  audioOnly: boolean;
  bandwidth: number | null;
}

export interface EngineOptions {
  requestHeaders?: (url: string) => Record<string, string> | null;
  /** Use the browser's HLS on Apple devices (AirPlay needs it). */
  nativeHlsOnApple: boolean;
  /**
   * Where subtitles are drawn. Shaka renders cues as elements in this box
   * (not the browser's own cue box), so a skin can keep them clear of its
   * controls and the theme's font applies.
   */
  textContainer?: HTMLElement;
}

/** Raw in-stream triggers as the engine received them; sdk/triggers.ts turns them into graphics. */
export type TriggerReport =
  | { kind: 'hls'; regions: Array<{ startTime: number; endTime: number; metadataType: string; payload: any }> }
  | { kind: 'dash'; region: any }
  | { kind: 'native'; cues: Array<{ id?: string; type?: string; startTime: number; endTime: number; value?: any }> };

export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua) || /iPad|iPhone|iPod/.test(ua);
}

/** Turn a Shaka or media error into something a viewer can act on. */
export function readableError(e: any): string {
  const code = e?.code ?? e?.detail?.code;
  if (code === 1001 || code === 1002) {
    const status = e?.data?.[1] ?? e?.detail?.data?.[1];
    if (status === 401 || status === 403) return 'You do not have access to this stream.';
    if (status === 451) return 'This is not available in your region.';
    if (status === 404) return 'This stream is not available right now.';
    return 'The stream could not be reached.';
  }
  if (code === 4032 || code === 4001 || code === 4016) return 'This browser cannot play this stream format.';
  if (code === 3016 || code === 3015 || code === 3014) return 'The media could not be decoded.';
  if (code === 6001 || code === 6007 || code === 6012) return 'This stream is protected and cannot be played on this device.';
  if (e?.name === 'NotAllowedError') return 'Press play to start.';
  return 'Playback failed.';
}

function langName(code: string): string {
  if (!code || code === 'und') return 'Unknown';
  try {
    const n = new (Intl as any).DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code);
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : code;
  } catch { return code; }
}

export class Engine {
  /** In-stream triggers (graphics), reported as they are parsed, before they are due. */
  onTrigger: ((r: TriggerReport) => void) | null = null;
  readonly media: HTMLVideoElement;
  mode: EngineMode | null = null;
  private sp: any = null;
  private pinned: string | null = null;
  private textOn = false;
  private o: EngineOptions;
  /** Called whenever tracks, adaptation or the window change. */
  onChange: () => void = () => {};
  onError: (msg: string, code: string | number | null) => void = () => {};

  constructor(media: HTMLVideoElement, o: EngineOptions) {
    this.media = media;
    this.o = o;
    if (!polyfilled) { try { shaka.polyfill.installAll(); } catch { /* old browser: native paths still work */ } polyfilled = true; }
  }

  /** Which way each source will be played, best first. */
  plan(src: Source): Array<{ mode: EngineMode; url: string; kind: string }> {
    const mse = shaka.Player.isBrowserSupported();
    const nativeHls = !!this.media.canPlayType('application/vnd.apple.mpegurl');
    const out: Array<{ mode: EngineMode; url: string; kind: string }> = [];
    const hls = src.hls ?? (src.url && sourceKind(src.url) === 'hls' ? src.url : null);
    const dash = src.dash ?? (src.url && sourceKind(src.url) === 'dash' ? src.url : null);
    const prog = src.url && ['mp3', 'mp4'].includes(sourceKind(src.url)) ? src.url : null;
    if (hls) {
      if (nativeHls && (this.o.nativeHlsOnApple && isApple() || !mse)) out.push({ mode: 'native', url: hls, kind: 'hls' });
      else if (mse) out.push({ mode: 'shaka', url: hls, kind: 'hls' });
    }
    if (dash && mse) out.push({ mode: 'shaka', url: dash, kind: 'dash' });
    if (prog) out.push({ mode: 'progressive', url: prog, kind: sourceKind(prog) });
    if (src.mp3) out.push({ mode: 'progressive', url: src.mp3, kind: 'mp3' });
    return out;
  }

  /** Load the first plan that works. Throws a readable error when none does. */
  async load(src: Source, startAt?: number): Promise<{ mode: EngineMode; kind: string; url: string }> {
    const plan = this.plan(src);
    if (!plan.length) throw Object.assign(new Error('This browser cannot play this stream format.'), { code: 'no-plan' });
    let last: any = null;
    for (const p of plan) {
      try {
        await this.unload();
        if (p.mode === 'shaka') await this.loadShaka(p.url, startAt);
        else {
          this.media.src = p.url;
          if (startAt) { const go = () => { try { this.media.currentTime = startAt; } catch { /* */ } }; this.media.addEventListener('loadedmetadata', go, { once: true }); }
          await new Promise<void>((ok, bad) => {
            const done = () => { cleanup(); ok(); };
            const fail = () => { cleanup(); bad(Object.assign(new Error('media error'), { code: this.media.error?.code ?? 'media' })); };
            const cleanup = () => { this.media.removeEventListener('loadedmetadata', done); this.media.removeEventListener('error', fail); };
            this.media.addEventListener('loadedmetadata', done, { once: true });
            this.media.addEventListener('error', fail, { once: true });
            this.media.preload = 'auto';
            this.media.load();
          });
        }
        this.mode = p.mode;
        if (p.mode === 'native' && p.kind === 'hls') this.watchNativeCues();
        this.onChange();
        return p;
      } catch (e) { last = e; }
    }
    throw Object.assign(new Error(readableError(last)), { code: last?.code ?? null });
  }

  private async loadShaka(url: string, startAt?: number) {
    const sp = new shaka.Player();
    this.sp = sp;
    await sp.attach(this.media);
    const box = this.o.textContainer;
    if (box) {
      try {
        sp.setVideoContainer(box);
        sp.configure({ textDisplayFactory: () => new (shaka as any).text.UITextDisplayer(this.media, box) });
      } catch { /* older Shaka: the browser draws the cues */ }
    }
    sp.configure({
      streaming: {
        // Live: stay a little back from the edge so a late segment is not a stall.
        rebufferingGoal: 2,
        bufferingGoal: 20,
        retryParameters: { maxAttempts: 4, baseDelay: 800, backoffFactor: 2, timeout: 20000 },
      },
      abr: { enabled: true },
      manifest: { retryParameters: { maxAttempts: 4, baseDelay: 800, backoffFactor: 2, timeout: 15000 } },
    });
    const hdr = this.o.requestHeaders;
    if (hdr) {
      sp.getNetworkingEngine()?.registerRequestFilter((_t: unknown, req: any) => {
        const h = hdr(req.uris?.[0] ?? '');
        if (h) Object.assign(req.headers, h);
      });
    }
    const changed = () => this.onChange();
    for (const ev of ['trackschanged', 'variantchanged', 'adaptation', 'textchanged', 'texttrackvisibility', 'abrstatuschanged', 'loaded'])
      sp.addEventListener(ev, changed);
    // IN-STREAM TRIGGERS. Reported when PARSED (`...added`), not when entered:
    // the player decides what is on screen from currentTime, which also covers a
    // viewer who joined inside a window or scrubbed into one. Shaka splits an HLS
    // DATERANGE into one region per attribute; they arrive together, so they are
    // batched for a tick and regrouped in sdk/triggers.ts.
    let batch: any[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    sp.addEventListener('metadataadded', (ev: any) => {
      batch.push({ startTime: ev.startTime, endTime: ev.endTime, metadataType: ev.metadataType, payload: ev.payload });
      if (!flush) flush = setTimeout(() => { const b = batch; batch = []; flush = null; this.onTrigger?.({ kind: 'hls', regions: b }); }, 0);
    });
    sp.addEventListener('timelineregionadded', (ev: any) => { if (ev?.detail) this.onTrigger?.({ kind: 'dash', region: ev.detail }); });
    sp.addEventListener('error', (ev: any) => {
      const d = ev?.detail;
      if (d?.severity === 2 /* CRITICAL */) this.onError(readableError(d), d?.code ?? null);
    });
    await sp.load(url, startAt ?? null);
    // Subtitles start off; the viewer turns them on. A remembered choice is applied by the player.
    sp.setTextTrackVisibility(this.textOn);
  }

  private stopCues: (() => void) | null = null;

  /**
   * Safari's own HLS turns each DATERANGE attribute into a DataCue on a metadata
   * text track. The track must be 'hidden' (not 'disabled') for cues to load.
   * Scanned on add and every two seconds: cuechange only fires as cues become
   * ACTIVE, and the player wants them as soon as they are known.
   */
  private watchNativeCues() {
    const tracks = this.media.textTracks;
    if (!tracks) return;
    const scan = () => {
      const cues: any[] = [];
      for (const t of Array.from(tracks)) {
        if (t.kind !== 'metadata') continue;
        if (t.mode === 'disabled') t.mode = 'hidden';
        for (const c of Array.from(t.cues ?? [])) cues.push({ id: c.id, type: (c as any).type, startTime: c.startTime, endTime: c.endTime, value: (c as any).value });
      }
      if (cues.length) this.onTrigger?.({ kind: 'native', cues });
    };
    const onAdd = () => scan();
    tracks.addEventListener?.('addtrack', onAdd);
    const iv = setInterval(scan, 2000);
    this.stopCues = () => { clearInterval(iv); tracks.removeEventListener?.('addtrack', onAdd); };
  }

  async unload(): Promise<void> {
    this.stopCues?.();
    this.stopCues = null;
    const sp = this.sp;
    this.sp = null;
    this.mode = null;
    this.pinned = null;
    if (sp) { try { await sp.destroy(); } catch { /* already gone */ } }
    try { this.media.removeAttribute('src'); this.media.load(); } catch { /* */ }
  }

  snapshot(): EngineSnapshot {
    const m = this.media;
    const sp = this.sp;
    let live = false, seekable: EngineSnapshot['seekable'] = null, presentationStart: number | null = null;
    let qualities: Quality[] = [], activeQuality: Quality | null = null;
    let textTracks: TextTrackInfo[] = [], textTrack: string | null = null;
    let audioTracks: AudioTrackInfo[] = [], audioTrack: string | null = null;
    let audioOnly = false, bandwidth: number | null = null;
    if (sp) {
      try {
        live = !!sp.isLive();
        const r = sp.seekRange();
        if (r && Number.isFinite(r.start) && Number.isFinite(r.end)) seekable = { start: r.start, end: r.end };
        presentationStart = live ? sp.getPresentationStartTimeAsDate()?.getTime() ?? null : null;
        const variants: any[] = sp.getVariantTracks() ?? [];
        const active = variants.find((v) => v.active) ?? null;
        // Same audio language as what plays now (channel counts are learned only for
        // the active variant, so they cannot be compared).
        const sameAudio = variants.filter((v) => !active || v.language === active.language);
        qualities = qualityList(sameAudio.map((v) => ({ id: v.id, height: v.height, width: v.width, bandwidth: v.bandwidth })));
        audioOnly = variants.length > 0 && variants.every((v) => !v.height && !v.videoCodec);
        if (active) {
          bandwidth = active.bandwidth ?? null;
          activeQuality = active.height ? { id: String(active.id), height: active.height, width: active.width ?? null, bitrate: active.bandwidth, label: qualityLabel(active.height) }
            : { id: String(active.id), height: null, width: null, bitrate: active.bandwidth, label: `${Math.round(active.bandwidth / 1000)} kbps` };
        }
        const langs = new Map<string, AudioTrackInfo>();
        for (const v of variants) {
          const k = v.language || 'und';
          if (!langs.has(k)) langs.set(k, { id: k, lang: k, label: v.label || langName(k), channels: v.channelsCount ?? null });
        }
        audioTracks = langs.size > 1 ? [...langs.values()] : [];
        audioTrack = active?.language || null;
        const texts: any[] = (sp.getTextTracks() ?? []).filter((t: any) => t.kind !== 'metadata');
        textTracks = texts.map((t) => ({ id: String(t.id), lang: t.language || 'und', label: t.label || langName(t.language) + (t.forced ? ' (forced)' : ''), kind: t.kind || 'subtitle' }));
        const on = sp.isTextTrackVisible();
        textTrack = on ? (texts.find((t) => t.active) ? String(texts.find((t) => t.active).id) : null) : null;
      } catch { /* a half-loaded player: report what is known */ }
    } else if (this.mode) {
      live = !Number.isFinite(m.duration) || m.duration === Infinity;
      if (m.seekable && m.seekable.length) seekable = { start: m.seekable.start(0), end: m.seekable.end(m.seekable.length - 1) };
      const sd = (m as any).getStartDate?.();
      if (live && sd && !isNaN(sd.getTime()) && sd.getTime() > 0) presentationStart = sd.getTime();
      const tt = m.textTracks ? Array.from(m.textTracks).filter((t) => t.kind === 'subtitles' || t.kind === 'captions') : [];
      textTracks = tt.map((t, i) => ({ id: `n${i}`, lang: t.language || 'und', label: t.label || langName(t.language), kind: t.kind }));
      const on = tt.findIndex((t) => t.mode === 'showing');
      textTrack = on >= 0 ? `n${on}` : null;
      audioOnly = this.mode === 'progressive' && /\.(mp3|aac|m4a)(\?|$)/i.test(m.currentSrc || '') || (m.readyState >= 1 && m.videoWidth === 0 && this.mode === 'progressive');
    }
    return {
      live, duration: live ? NaN : (Number.isFinite(m.duration) ? m.duration : NaN), seekable, presentationStart,
      qualities, activeQuality, quality: this.pinned ?? 'auto',
      textTracks, textTrack, audioTracks, audioTrack, audioOnly, bandwidth,
    };
  }

  setQuality(id: string): void {
    const sp = this.sp;
    if (!sp) return;
    if (id === 'auto') { this.pinned = null; sp.configure({ abr: { enabled: true } }); this.onChange(); return; }
    const t = (sp.getVariantTracks() ?? []).find((v: any) => String(v.id) === id);
    if (!t) return;
    this.pinned = id;
    sp.configure({ abr: { enabled: false } });
    // clearBuffer: a viewer who picks 1080p wants to see it now, not in 20 s.
    sp.selectVariantTrack(t, true);
    this.onChange();
  }

  setTextTrack(id: string | null): void {
    const sp = this.sp;
    this.textOn = id != null;
    if (sp) {
      if (id == null) { sp.setTextTrackVisibility(false); this.onChange(); return; }
      const t = (sp.getTextTracks() ?? []).find((x: any) => String(x.id) === id);
      if (t) { sp.selectTextTrack(t); sp.setTextTrackVisibility(true); }
      this.onChange();
      return;
    }
    const tt = Array.from(this.media.textTracks ?? []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    tt.forEach((t, i) => { t.mode = id === `n${i}` ? 'showing' : 'disabled'; });
    this.onChange();
  }

  /** Re-apply a remembered subtitle language after a new item loads. */
  textByLang(lang: string): string | null {
    const s = this.snapshot();
    return s.textTracks.find((t) => t.lang === lang)?.id ?? null;
  }

  setAudioTrack(lang: string): void {
    try { this.sp?.selectAudioLanguage(lang); } catch { /* */ }
    this.onChange();
  }

  goLive(): void {
    const r = this.snapshot().seekable;
    if (r) this.media.currentTime = r.end;
  }

  async destroy(): Promise<void> { await this.unload(); }
}
