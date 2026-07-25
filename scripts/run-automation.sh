#!/usr/bin/env sh
# POSIX-эквивалент run-automation.ps1 для GitHub Actions, cron и systemd.
# Формат строки лога совпадает с Windows-раннером, чтобы runs/scheduler.log
# оставался читаемым одним и тем же способом на обеих площадках.
set -u

CONFIG="${1:-config/automation.json}"
LOG="${2:-runs/scheduler.log}"

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cd -- "$root" || exit 1

case "$LOG" in
  /*) ;;
  *) LOG="$root/$LOG" ;;
esac
mkdir -p -- "$(dirname -- "$LOG")" || exit 1

# npm пишет предупреждения в stderr даже при успехе, поэтому stderr сливается
# в лог, а не трактуется как признак ошибки — код возврата берётся у npm.
npm run automation:run -- --config "$CONFIG" >>"$LOG" 2>&1
code=$?

if [ "$code" -eq 0 ]; then status=pushed; else status=failed; fi
printf '%s scheduler automation:run status=%s exit=%s config=%s\n' \
  "$(date -Iseconds)" "$status" "$code" "$CONFIG" >>"$LOG"

exit "$code"
