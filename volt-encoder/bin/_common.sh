# Sourced by run-local.sh and validate.sh.
volt_os_arch() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) echo "osx-arm64";; Darwin/x86_64) echo "osx-x64";;
    Linux/x86_64) echo "linux-x64";; Linux/aarch64) echo "linux-arm64";; *) echo "";;
  esac
}
volt_have_srt() { ffmpeg -hide_banner -protocols 2>/dev/null | grep -qiE '^[[:space:]]*srt$'; }
volt_ensure_deps() {  # $1=encoder dir ; sets nothing fatal for SRT
  local enc="$1" pkgver="v3.4.2"
  command -v python3 >/dev/null || { echo "ERROR: python3 not found. macOS: brew install python" >&2; return 1; }
  command -v ffmpeg  >/dev/null || { echo "ERROR: ffmpeg not found. macOS: brew install ffmpeg" >&2; return 1; }
  export PATH="$enc/.bin:$PATH"
  if ! command -v packager >/dev/null; then
    local tag; tag="$(volt_os_arch)"
    [ -n "$tag" ] || { echo "ERROR: unsupported OS/arch; put a 'packager' on PATH." >&2; return 1; }
    echo "  downloading Shaka Packager ($pkgver $tag) into $enc/.bin ..."; mkdir -p "$enc/.bin"
    curl -fsSL -o "$enc/.bin/packager" \
      "https://github.com/shaka-project/shaka-packager/releases/download/${pkgver}/packager-${tag}" \
      || { echo "ERROR: could not download Shaka Packager; get packager-${tag} into $enc/.bin/packager." >&2; return 1; }
    chmod +x "$enc/.bin/packager"
  fi
  return 0
}
volt_write_job() {  # $1=transport(hls|srt) $2=srcdir $3=outfile
  local t="$1" src="$2" out="$3"
  if [ "$t" = "srt" ]; then
    cat > "$out" <<JSON
{ "channel_id":"volt-local","workflow":"package_only","segment_seconds":2,"fps":25,"dvr_seconds":60,
  "s3":{"bucket":"local-disabled"},
  "inputs":[
    {"rendition_label":"720p","protocol":"srt","url":"srt://127.0.0.1:9000","has_audio":true,"bitrate_kbps":2500},
    {"rendition_label":"480p","protocol":"srt","url":"srt://127.0.0.1:9001","bitrate_kbps":1200},
    {"rendition_label":"360p","protocol":"srt","url":"srt://127.0.0.1:9002","bitrate_kbps":800}
  ] }
JSON
  else
    cat > "$out" <<JSON
{ "channel_id":"volt-local","workflow":"package_only","segment_seconds":2,"fps":25,"dvr_seconds":60,
  "s3":{"bucket":"local-disabled"},
  "inputs":[
    {"rendition_label":"720p","protocol":"hls","url":"$src/720p.m3u8","has_audio":true,"bitrate_kbps":2500},
    {"rendition_label":"480p","protocol":"hls","url":"$src/480p.m3u8","bitrate_kbps":1200},
    {"rendition_label":"360p","protocol":"hls","url":"$src/360p.m3u8","bitrate_kbps":800}
  ] }
JSON
  fi
}
