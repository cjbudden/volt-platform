#!/bin/sh
# One-time, per clone: point git at the repo's hooks (the change-note check).
set -e
cd "$(dirname "$0")/../.."
TOP="$(git rev-parse --show-toplevel)"
REL="$(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1],sys.argv[2]))" "$PWD/.githooks" "$TOP")"
git config core.hooksPath "$REL"
echo "hooks installed: core.hooksPath=$REL"
