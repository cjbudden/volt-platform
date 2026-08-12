# Sourced by run-local.sh and validate.sh. Resolves ffmpeg/python3/packager,
# auto-downloading the right Shaka Packager build into <encoder>/.bin if missing.
volt_os_arch() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64) echo "osx-arm64" ;;
    Darwin/x86_64) echo "osx-x64" ;;
    Linux/x86_64) echo "linux-x64" ;;
    Linux/aarch64) echo "linux-arm64" ;;
    *) echo "" ;;
  esac
}
volt_ensure_deps() {
  local enc="$1" pkgver="v3.4.2"
  command -v python3 >/dev/null || { echo "ERROR: python3 not found. Install Python 3." >&2; return 1; }
  command -v ffmpeg  >/dev/null || { echo "ERROR: ffmpeg not found. macOS: brew install ffmpeg" >&2; return 1; }
  if ! ffmpeg -hide_banner -protocols 2>/dev/null | grep -qi '^[[:space:]]*srt$'; then
    echo "ERROR: your ffmpeg has no SRT support. macOS: brew install ffmpeg (the Homebrew build includes SRT)." >&2; return 1
  fi
  export PATH="$enc/.bin:$PATH"
  if ! command -v packager >/dev/null; then
    local tag; tag="$(volt_os_arch)"
    [ -n "$tag" ] || { echo "ERROR: unsupported OS/arch for auto Shaka download; put a 'packager' binary on PATH." >&2; return 1; }
    echo "  downloading Shaka Packager ($pkgver $tag) into $enc/.bin ..."
    mkdir -p "$enc/.bin"
    curl -fsSL -o "$enc/.bin/packager" \
      "https://github.com/shaka-project/shaka-packager/releases/download/${pkgver}/packager-${tag}" || {
        echo "ERROR: could not download Shaka Packager. Download packager-${tag} from the Shaka releases page into $enc/.bin/packager." >&2; return 1; }
    chmod +x "$enc/.bin/packager"
  fi
  return 0
}
