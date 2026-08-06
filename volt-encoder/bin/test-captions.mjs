#!/usr/bin/env node
// ============================================================================
//  Volt TEST live-caption sidecar.
//
//  Writes a live-growing WebVTT per language into <out>/subs/<lang>.vtt, adding a
//  new cue every few seconds so the app's player shows rolling live subtitles that
//  can be switched between English / Malay / Chinese / Tamil.
//
//  Default: cycles a set of synced sample news lines (with real translations) — an
//  instant, deterministic subtitle test. In production this same file is what the
//  Whisper add-on (faster-whisper + NLLB) writes; see test-stream-run.sh --whisper
//  to drive it from real transcription of an espeak speech track instead.
//
//  Usage: test-captions.mjs --out DIR [--langs en,ms,zh,ta] [--interval 4] [--pid FILE]
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const OUT = opt('--out')
if (!OUT) { console.error('--out DIR required'); process.exit(2) }
const LANGS = (opt('--langs', 'en,ms,zh,ta')).split(',').map(s => s.trim()).filter(Boolean)
const INTERVAL = Number(opt('--interval', '4'))
const PIDFILE = opt('--pid')

// aligned sample lines (index i is the same sentence in every language)
const LINES = {
  en: [
    'Good afternoon, and welcome to the midday report.',
    'Our top story: markets rose sharply in early trading.',
    'The weather stays clear across the peninsula today.',
    'Officials confirmed the new transport line opens next month.',
    'Coming up after the break: sport and the headlines.',
    'Stay with us for live coverage throughout the afternoon.',
  ],
  ms: [
    'Selamat tengah hari, dan selamat datang ke laporan tengah hari.',
    'Berita utama kami: pasaran meningkat mendadak pada dagangan awal.',
    'Cuaca kekal cerah di seluruh semenanjung hari ini.',
    'Pihak berkuasa mengesahkan laluan pengangkutan baharu dibuka bulan depan.',
    'Selepas rehat: sukan dan berita utama.',
    'Kekal bersama kami untuk liputan langsung sepanjang petang.',
  ],
  zh: [
    '下午好，欢迎收看午间新闻。',
    '头条新闻：早盘市场大幅上涨。',
    '今天半岛各地天气持续晴朗。',
    '官员确认新的交通线路将于下月开通。',
    '广告之后：体育与要闻。',
    '请继续关注我们下午的现场报道。',
  ],
  ta: [
    'மதிய வணக்கம், மதிய செய்தி அறிக்கைக்கு வரவேற்கிறோம்.',
    'முக்கியச் செய்தி: காலை வர்த்தகத்தில் சந்தைகள் கூர்மையாக உயர்ந்தன.',
    'இன்று தீபகற்பம் முழுவதும் வானிலை தெளிவாக உள்ளது.',
    'புதிய போக்குவரத்து பாதை அடுத்த மாதம் திறக்கப்படும் என அதிகாரிகள் உறுதிப்படுத்தினர்.',
    'இடைவேளைக்குப் பிறகு: விளையாட்டு மற்றும் தலைப்புச் செய்திகள்.',
    'மதியம் முழுவதும் நேரடி செய்திகளுக்கு எங்களுடன் இருங்கள்.',
  ],
}

function ts(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

mkdirSync(join(OUT, 'subs'), { recursive: true })
if (PIDFILE) writeFileSync(PIDFILE, String(process.pid))

// per-language accumulated cues (keep the last ~20 for a rolling file)
const cues = Object.fromEntries(LANGS.map(l => [l, []]))
let i = 0
const start = Date.now()

function emit() {
  const elapsed = (Date.now() - start) / 1000
  const a = elapsed, b = elapsed + INTERVAL
  for (const lang of LANGS) {
    const set = LINES[lang] || LINES.en
    const text = set[i % set.length]
    cues[lang].push(`${ts(a)} --> ${ts(b)}\n${text}`)
    if (cues[lang].length > 20) cues[lang].shift()
    const vtt = 'WEBVTT\n\n' + cues[lang].join('\n\n') + '\n'
    writeFileSync(join(OUT, 'subs', `${lang}.vtt`), vtt)
  }
  i++
}

emit() // write immediately so the file exists
const timer = setInterval(emit, INTERVAL * 1000)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearInterval(timer); process.exit(0) })
console.log(`test-captions: writing ${LANGS.join(', ')} into ${OUT}/subs every ${INTERVAL}s`)
