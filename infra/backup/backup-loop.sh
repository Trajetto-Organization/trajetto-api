#!/bin/sh
#
# The trajetto-backup container's main process: sleeps until BACKUP_AT_UTC
# (default 02:30) and runs backup-to-r2, every day, for ever.
#
# 02:30 UTC because the first nightly job that deletes data runs at 03:17 UTC
# (node-cron runs in UTC) and the last, the trail partition DROP, at 04:10: a
# wrong predicate in any of them is recoverable from the same night's dump.
#
# A failed run is logged and the loop goes on — backup-to-r2 has already
# pinged the heartbeat's /fail, which is what pages someone; exiting would
# only make Swarm restart the container and lose the schedule's place.
#
#   BACKUP_RUN_NOW=true   also run once at start (a first deploy, a drill)
#
# Usage for tests: backup-loop.sh --seconds-until HH:MM <epoch-seconds>
set -u

# Seconds from <now> until the next HH:MM UTC. Never 0: at the exact second
# the next run is tomorrow's, so a fast run cannot loop.
seconds_until() {
  hours="${1%%:*}"
  minutes="${1#*:}"

  # "08" is octal to $(( )): strip the leading zero first.
  hours="${hours#0}"
  minutes="${minutes#0}"

  target=$((${hours:-0} * 3600 + ${minutes:-0} * 60))
  delay=$(((target - $2 % 86400 + 86400) % 86400))

  if [ "$delay" -eq 0 ]; then delay=86400; fi

  echo "$delay"
}

if [ "${1:-}" = "--seconds-until" ]; then
  seconds_until "$2" "$3"
  exit 0
fi

AT="${BACKUP_AT_UTC:-02:30}"

case "$AT" in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *)
    echo "[backup-loop] ERRO: BACKUP_AT_UTC='${AT}' não é HH:MM (UTC)" >&2
    exit 64
    ;;
esac

run_backup() {
  backup-to-r2 || echo "[backup-loop] ERRO: o backup falhou (o heartbeat /fail já foi avisado)" >&2
}

# PID 1 ignores SIGTERM unless it handles it: without this every stop waited
# for the whole stop_grace_period and ended in SIGKILL.
trap 'echo "[backup-loop] encerrando"; exit 0' TERM INT

if [ "${BACKUP_RUN_NOW:-false}" = "true" ]; then
  run_backup
fi

while :; do
  wait_seconds="$(seconds_until "$AT" "$(date -u +%s)")"

  echo "[backup-loop] próximo backup em ${wait_seconds}s (${AT} UTC)"

  # In the background and waited on, so the TERM trap runs immediately
  # instead of after the sleep.
  sleep "$wait_seconds" &
  wait $!

  run_backup
done
