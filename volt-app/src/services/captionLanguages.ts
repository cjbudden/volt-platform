// ============================================================================
//  CAPTION OUTPUT LANGUAGES the pipeline can actually deliver.
//
//  One list, read by GET /api/caption-languages (the console's language
//  pickers) and by the captions settings API (modules/captionsSettings.ts),
//  which refuses a target that is not on it. It must stay in step with the
//  encoder: whisper transcribes ~100 languages and natively translates
//  X->English; every non-English target here is served by the NLLB MT stage
//  and needs a FLORES mapping in volt-encoder/bin/captions.py.
// ============================================================================
export const CAPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ms', label: 'Malay' },
  { code: 'id', label: 'Indonesian' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)' },
  { code: 'ta', label: 'Tamil' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'ar', label: 'Arabic' },
];

export const CAPTION_LANGUAGE_CODES = new Set(CAPTION_LANGUAGES.map((l) => l.code));
