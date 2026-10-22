# Workflow — Live captions, transcription and translation (+ engine alternative)

Optional per-account feature: caption a live stream (or VOD), and optionally
translate the captions into other languages. Two engine options, chosen per
account.

## The two engines (the "alternative")
- **Whisper (self-hosted)** — faster-whisper on our own GPU. No per-minute fee.
  Transcribes ~100 languages. Its native translate task only goes **X → English**;
  for any OTHER target language (Malay, Chinese, Tamil, …) a downstream **NLLB-200**
  machine-translation model is chained on. NLLB is many-to-many, so one model
  covers every pair (en↔ms, en↔zh, en↔ta and the cross pairs). Proven end-to-end
  (espeak English → whisper → NLLB → ms/zh/ta).
- **Gladia (paid, alternative)** — cloud streaming STT + native multi-target
  translation. No local model or GPU. Chosen when an account prefers a managed
  provider over self-hosting. Live websocket adapter is stubbed pending a key.

The account picks one via the master toggle `accounts.captions_provider`
(`none` | `whisper` | `gladia`). `none` disables captions entirely. A per-profile
`captions_enabled` opts a stream in, but the engine is **pinned to the account's
choice** — a profile can't use an engine the account hasn't enabled.

## End-to-end steps
1. Account sets `captions_provider`. A channel/event's output profile sets
   `captions_enabled`, `caption_source_lang` (or `auto`), `caption_targets`
   (e.g. `["en","ms","zh","ta"]`), `caption_offset_sec`, and `caption_model_size`.
2. On stream start the orchestrator resolves a **captions plan** (captionsPlan.ts):
   - `none` → nothing runs.
   - `gladia` → a thin sidecar rides inside the encoder task (no model, no GPU).
   - `whisper` → a **separate GPU add-on task** (`volt-captions` image) is launched
     ONLY for this stream, sized by model + whether MT is needed (a single T4
     covers up to large-v3 + NLLB), tracked as its own `instances` row (role
     `captions`) so it counts in projected instances + cost, and torn down with the
     stream. The base encoder image never carries the model weight.
3. The captions worker taps the program audio, transcribes (and translates per the
   targets), and writes HLS-aligned segmented WebVTT renditions — one per language —
   applying the playout offset — to the same S3 origin the packager uses.
4. Players pick up the subtitle renditions as selectable caption tracks; a final
   consolidated VTT is written per language when the event ends.

## Translation matrix for the requested languages
English ↔ Malay, English ↔ Chinese, English ↔ Tamil, all via one NLLB model.
"To English" directions can use Whisper's own translate task; all other directions
use NLLB. Adding another language later is a code-map entry, not another install.

## Build state
- **Built:** the 3-engine sidecar, the NLLB MT stage, the account master toggle,
  the captions provisioning plan + sizing + separate-GPU-task launch/teardown.
  Tests: 33 (sidecar) + 9 (plan) + 6 (account toggle) + orchestration.
- **To deliver:** the live Gladia websocket adapter (needs key), the GPU captions
  container image build/push and a live chunked-streaming wrapper for Whisper.
- **Settings screen:** Admin > Captions (22 Oct 2026) sets the account's
  `captions_provider` and each profile's captions through
  `/api/account-settings/captions`.
