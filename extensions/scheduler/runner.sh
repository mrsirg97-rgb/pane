#!/bin/sh
# pane-scheduler fire: cron invokes `runner.sh <key>`.
# Cold-shell rule (watchdog lesson): cron inherits no interactive env, so set
# a baseline PATH first; ~/.pi/cron-env may then extend it. node, pi and the
# crontab binary must resolve from that PATH alone.
set -u

KEY="${1:-}"
[ -n "$KEY" ] || { echo "runner.sh: missing <key>" >&2; exit 2; }
[ -n "${HOME:-}" ] || { echo "runner.sh: no HOME" >&2; exit 2; }

PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
export PATH
[ -f "$HOME/.pi/cron-env" ] && . "$HOME/.pi/cron-env"

DIR="$HOME/.pi/agent/scheduler"
mkdir -p "$DIR/locks"
LOCK="$DIR/locks/$(printf '%s' "$KEY" | tr ':' '_').lock"

if command -v flock >/dev/null 2>&1; then
  # one fire per key at a time; -E 73 marks "lock held" distinctly from a
  # runner failure (which keeps its own non-zero code and reaches cron mail)
  flock -n -E 73 "$LOCK" -c "exec node \"$DIR/runner.mjs\" \"$KEY\""
  rc=$?
  if [ "$rc" -eq 0 ]; then
    exit 0
  fi
  if [ "$rc" -eq 73 ]; then
    node "$DIR/runner.mjs" "$KEY" --lock-skip
    exit 0
  fi
  exit "$rc"
fi
exec node "$DIR/runner.mjs" "$KEY"
