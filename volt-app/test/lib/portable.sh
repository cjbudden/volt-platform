# ============================================================================
#  THE SUITES HAVE TO RUN ON THE MACHINE THE PRODUCT IS DEMONSTRATED ON.
#
#  This file exists because of a plain failure: seven suites could not start at
#  all on a Mac, and the message was "setsid: command not found". Not a failing
#  assertion, not a diagnosis of anything about the product -- the harness
#  simply did not run. A test suite that only runs on the author's operating
#  system tells the person with the demo machine nothing at all.
#
#  Three commands were assumed and none of them is on macOS:
#
#    setsid    Linux (util-linux). Used to put the API in its own process group
#              so the whole tree can be killed at the end. macOS has no
#              equivalent binary at all.
#    timeout   GNU coreutils. Present as `gtimeout` only if somebody installed
#              coreutils from Homebrew.
#    stat -c   GNU stat. BSD stat spells the same thing `stat -f`, and the GNU
#              form does not error -- it silently reads a DIFFERENT argument, so
#              a size check quietly compares the wrong number.
#
#  Everything here degrades to plain POSIX shell plus python3, which this
#  project already requires for the encoder, so there is nothing new to install.
#
#  Usage:  . "$(dirname "$0")/lib/portable.sh"
#          vsetsid <cmd> ...      # run in its own process group, backgroundable
#          vtimeout <secs> <cmd>  # bounded run, returns 124 on timeout
#          vsize <file>           # size in bytes, or 0
#          vkilltree <pid>        # stop a process and its children
# ============================================================================

# ---------------------------------------------------------------------------
#  vsetsid — start a command in a NEW PROCESS GROUP.
#
#  Why a group at all: the API spawns encoders, which spawn ffmpeg. Killing the
#  API alone leaves those running, holding ports and writing segments into the
#  next suite's fixtures. The group is what makes one signal reach the family.
#
#  python3's os.setsid is the portable form of exactly what setsid(1) does, and
#  os.execvp replaces the interpreter so no extra process is left in the middle
#  to confuse the caller's $!.
# ---------------------------------------------------------------------------
if command -v setsid >/dev/null 2>&1; then
  vsetsid() { setsid "$@"; }
else
  vsetsid() {
    # `exec` matters. Without it the function leaves a shell between the caller
    # and the command, so `vsetsid cmd &` gives $! the SHELL's pid while the new
    # process group belongs to the command -- and `kill -TERM -$!` then signals
    # the wrong group, silently falls back to killing one process, and leaves
    # the ffmpeg children this whole mechanism exists to reach. exec replaces
    # the subshell, so $! is the group leader, which is what setsid(1) gives.
    exec "${PYTHON_BIN:-python3}" -c 'import os,sys
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
  }
fi

# ---------------------------------------------------------------------------
#  vtimeout — bound a command, whatever the platform calls it.
#  Returns 124 when it had to be killed, matching GNU timeout so callers that
#  check for 124 keep working.
# ---------------------------------------------------------------------------
if command -v timeout >/dev/null 2>&1; then
  vtimeout() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  vtimeout() { gtimeout "$@"; }
else
  vtimeout() {
    _vt_secs="$1"; shift
    "$@" & _vt_pid=$!
    _vt_i=0; _vt_ticks=$(( _vt_secs * 10 ))
    while kill -0 "$_vt_pid" 2>/dev/null && [ "$_vt_i" -lt "$_vt_ticks" ]; do
      sleep 0.1; _vt_i=$(( _vt_i + 1 ))
    done
    if kill -0 "$_vt_pid" 2>/dev/null; then
      kill -9 "$_vt_pid" 2>/dev/null; wait "$_vt_pid" 2>/dev/null; return 124
    fi
    wait "$_vt_pid"; return $?
  }
fi

# ---------------------------------------------------------------------------
#  vsize — a file's size in bytes.
#
#  THE QUIET ONE. `stat -c %s` on BSD does not fail: -c means something else
#  there, so the check returns a number that is not the size and an assertion
#  about "at least 20000 bytes of audio" passes or fails on nonsense. Wrong
#  answers are worse than errors, which is why this wraps it rather than
#  leaving each caller to remember.
# ---------------------------------------------------------------------------
vsize() {
  [ -f "$1" ] || { echo 0; return 0; }
  wc -c < "$1" 2>/dev/null | tr -d ' ' || echo 0
}

# ---------------------------------------------------------------------------
#  vkilltree — stop a process group started by vsetsid, and never signal
#  our own group by accident.
#
#  `kill -TERM -0` is not a no-op: 0 means "my own process group", so an
#  unguarded cleanup on an early exit signals the test runner itself and the
#  suite looks like it hung rather than like it bailed out. That has happened
#  here, more than once.
# ---------------------------------------------------------------------------
vkilltree() {
  [ -n "${1:-}" ] || return 0
  [ "$1" -gt 0 ] 2>/dev/null || return 0
  kill -TERM -"$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null
  return 0
}
