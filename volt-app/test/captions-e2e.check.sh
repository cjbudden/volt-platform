#!/usr/bin/env bash
# ============================================================================
#  SUBTITLES, PROVEN AGAINST REAL AUDIO AND A REAL MODEL.
#
#  Reported: "I am yet to see subtitles working at all in any stable way."
#
#  Three suites already cover captions and all three pass, and none of them
#  answers that sentence, because every one of them tests a DECISION rather than
#  an OUTPUT: captions-plan asserts which mode is chosen, captions-toggle that
#  the switch is respected, captions-orchestration that a task is launched. Not
#  one of them puts audio in and reads a subtitle out. A feature can be entirely
#  broken with all three green.
#
#  So this one runs the shipped bin/captions.py over REAL SPEECH with the REAL
#  faster-whisper model and checks the artefacts a player actually fetches:
#  segmented WebVTT with a timestamp map, and a conformant HLS subtitle
#  playlist. If those are right, subtitles work; if they are not, they do not.
#
#  IT SKIPS RATHER THAN FAILS when the model runtime or a text-to-speech voice
#  is missing, because neither is a defect in this codebase -- but the skip says
#  exactly what to install, so "it skipped" never quietly becomes "it passed".
#
#  Usage: bash test/captions-e2e.check.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }

PY=${PYTHON_BIN:-python3}
CAP=../volt-encoder/bin/captions.py
[ -f "$CAP" ] || CAP=$(cd "$(dirname "$0")/../../volt-encoder/bin" 2>/dev/null && pwd)/captions.py
[ -f "$CAP" ] || { echo "SKIP could not find volt-encoder/bin/captions.py"; echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }

if ! "$PY" -c "import faster_whisper" >/dev/null 2>&1; then
  echo "SKIP faster-whisper is not installed, so the self-hosted engine cannot run here."
  echo "     This is the ENGINE, not the wiring:  pip install faster-whisper"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi

# SPEECH, NOT A TONE. Whisper transcribes language; a sine wave proves nothing
# about a transcription pipeline. espeak-ng is used because it is offline and
# deterministic -- its robotic voice transcribes imperfectly, which is fine:
# this asserts that the PIPELINE produces well-formed timed text, not that a
# small model is accurate on synthetic speech.
VOICE=""
command -v espeak-ng >/dev/null 2>&1 && VOICE=espeak-ng
[ -z "$VOICE" ] && command -v espeak >/dev/null 2>&1 && VOICE=espeak
[ -z "$VOICE" ] && command -v say >/dev/null 2>&1 && VOICE=say   # macOS
if [ -z "$VOICE" ]; then
  echo "SKIP no offline text-to-speech available to generate a spoken source."
  echo "     macOS has 'say' built in; on Linux:  apt-get install espeak-ng"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
LINE="This is the Volt streaming platform. Subtitles are generated from the audio. The quick brown fox jumps over the lazy dog."

echo "== a spoken source =="
if [ "$VOICE" = "say" ]; then
  say -o "$WORK/speech.aiff" "$LINE" >/dev/null 2>&1
  ffmpeg -hide_banner -loglevel error -y -i "$WORK/speech.aiff" "$WORK/speech.wav" >/dev/null 2>&1
else
  "$VOICE" -v en -s 130 -w "$WORK/speech.wav" "$LINE" >/dev/null 2>&1
fi
ok "speech was synthesised" '[ -s "$WORK/speech.wav" ]'
[ -s "$WORK/speech.wav" ] || { echo; echo "== RESULT: $pass passed, $((fail+1)) failed =="; exit 1; }

echo "== the shipped captions job, with the self-hosted engine =="
CFG=$(cat <<JSON
{"enabled":true,"engine":"whisper","audio_path":"$WORK/speech.wav",
 "source_lang":"en","targets":[],"model_size":"tiny",
 "segment_seconds":6,"total_seconds":12,"offset_sec":0}
JSON
)
# The manifest goes to a FILE. It is JSON, so it is full of quotes, and passing
# it through `ok`'s eval turns a passing assertion into a failing one for
# reasons that have nothing to do with captions.
CAPTIONS_CONFIG_JSON="$CFG" WORK_DIR="$WORK" "$PY" "$CAP" >"$WORK/out.json" 2>"$WORK/err.log"
RC=$?
if [ "$RC" != "0" ]; then
  echo "  FAIL captions.py exited $RC"; sed 's/^/       /' "$WORK/err.log" | tail -6
  echo; echo "== RESULT: $pass passed, $((fail+1)) failed =="; exit 1
fi
ok "it reports captions enabled" 'grep -q "\"enabled\": *true" "$WORK/out.json"'
ok "and that it wrote a language" 'grep -q "\"en\"" "$WORK/out.json"'

D="$WORK/subtitles/en"
echo "== the artefacts a player fetches =="
ok "a segmented subtitle exists"      '[ -s "$D/sub_0.vtt" ]'
ok "an HLS subtitle playlist exists"  '[ -s "$D/subs.m3u8" ]'
ok "and a whole-programme VTT"        '[ -s "$D/final.vtt" ]'

echo "== the WebVTT is well formed =="
ok "it starts with the WEBVTT signature" 'head -1 "$D/sub_0.vtt" | grep -q "^WEBVTT"'
# WITHOUT THIS LINE THE SUBTITLES DRIFT. X-TIMESTAMP-MAP ties VTT time to the
# media timeline; an HLS player given a VTT without it aligns cues to the
# segment rather than the programme, and captions slide further out with every
# segment. It is one line and it is the difference between working and useless.
ok "it carries an X-TIMESTAMP-MAP, so cues align to the media" \
   'grep -q "^X-TIMESTAMP-MAP=" "$D/sub_0.vtt"'
ok "it contains at least one cue timing" \
   'grep -qE "^[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3} --> " "$D/sub_0.vtt"'
ok "and actual words against that timing" \
   '[ "$(grep -cE "^[A-Za-z]" "$D/sub_0.vtt")" -ge 2 ]'

echo "== the playlist is conformant =="
ok "it is an M3U8"                        'head -1 "$D/subs.m3u8" | grep -q "^#EXTM3U"'
ok "with a target duration"               'grep -q "^#EXT-X-TARGETDURATION:" "$D/subs.m3u8"'
ok "and it references the segments"       'grep -q "^sub_0.vtt$" "$D/subs.m3u8"'
ok "closed with ENDLIST"                  'grep -q "^#EXT-X-ENDLIST" "$D/subs.m3u8"'

echo "== the transcription is real, not a placeholder =="
# The pipeline must not be able to pass this suite by writing an empty or
# canned file. Whisper on a robotic voice is imperfect, so the assertion is on
# SUBSTANCE rather than on exact words: several words of English, not one.
WORDS=$(grep -vE "^(WEBVTT|X-TIMESTAMP-MAP|[0-9]{2}:|$)" "$D/final.vtt" | wc -w | tr -d ' ')
ok "the transcript carries real content (${WORDS} words)" '[ "'"$WORDS"'" -ge 8 ]'
echo
echo "   what the model heard:"
grep -vE "^(WEBVTT|X-TIMESTAMP-MAP|[0-9]{2}:|$)" "$D/final.vtt" | sed 's/^/     /' | head -5

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
