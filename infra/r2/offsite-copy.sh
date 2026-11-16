#!/bin/sh
#
# offsite-copy.sh: the weekly copy of the delivery proofs to a bucket in
# another Cloudflare account (plano-escala F1-23; infra/r2/offsite-copy.md).
#
# The uploads bucket, the tokens that can delete from it and the Dokploy
# that holds them all live under one account: whoever takes that account
# takes every receipt with it. This copies the proofs (the PDFs, and the
# photos and signatures they are made of) to a bucket of a second account,
# with a token the API never holds, under a 30-day Bucket Lock and a 90-day
# Expiration.
#
# `rclone copy`, never `sync`: a delete in the source (a tenant leaving, an
# anonymisation, an LGPD request) is not carried by this script; it leaves
# the copy through the bucket's own 90-day Expiration. A sync would also
# turn a wiped source into a wiped copy. Existing objects are never
# rewritten (--immutable, --size-only, --no-update-modtime): the proofs are
# write-once, and the lock would refuse the overwrite anyway.
#
# Runs in the trajetto-offsite Application (the official rclone image, by
# digest, capped at 64 MiB), from its weekly Schedule Job:
#
#   sh /opt/trajetto/offsite-copy.sh
#
# Environment (the Application's):
#   OFFSITE_SOURCE_ENDPOINT, OFFSITE_SOURCE_BUCKET, OFFSITE_SOURCE_KEY,
#   OFFSITE_SOURCE_KEY_SECRET  the uploads bucket, with a READ-ONLY token;
#   OFFSITE_DEST_ENDPOINT, OFFSITE_DEST_BUCKET, OFFSITE_DEST_KEY,
#   OFFSITE_DEST_KEY_SECRET    the copy: another account, so another
#                              endpoint, and a token on that bucket only;
#   OFFSITE_PREFIXES           what is copied; default
#                              "deliveryProofs/ deliveryPhotos/";
#   OFFSITE_PING_URL           the healthchecks.io check (optional).
#
# No secret reaches the output or a ping: the keys reach rclone through its
# own environment, never its command line, and the keys and the ping URL
# are blanked out of whatever rclone prints. POSIX sh: the image's shell is
# busybox.
#
# Exit status: 0 ok; 1 configuration; 3 the copy failed.
set -eu

DEFAULT_PREFIXES="deliveryProofs/ deliveryPhotos/"
SECRET_NAMES="OFFSITE_SOURCE_KEY OFFSITE_SOURCE_KEY_SECRET OFFSITE_DEST_KEY OFFSITE_DEST_KEY_SECRET OFFSITE_PING_URL"

PING_URL=${OFFSITE_PING_URL:-}
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
started=$(date +%s)

# Blanks every secret out of stdin. awk index(), not sed: a key or a URL
# may hold any of sed's special characters.
redact() {
  NAMES=$SECRET_NAMES awk '
    BEGIN {
      n = split(ENVIRON["NAMES"], names, " ")
      for (i = 1; i <= n; i++) if (ENVIRON[names[i]] != "") secrets[++m] = ENVIRON[names[i]]
    }
    {
      line = $0
      for (i = 1; i <= m; i++) {
        out = ""
        while ((p = index(line, secrets[i])) > 0) {
          out = out substr(line, 1, p - 1) "<redacted>"
          line = substr(line, p + length(secrets[i]))
        }
        line = out line
      }
      print line
    }'
}

# A JSON string from stdin: redacted, escaped, the lines joined by \n.
json_string() {
  redact | awk '
    {
      gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, " "); gsub(/\r/, "")
      out = out (NR > 1 ? "\\n" : "") $0
    }
    END { printf "\"%s\"", out }'
}

# ping [start|fail] [body]: never fails the run, never prints the URL.
ping() {
  [ -n "$PING_URL" ] || return 0
  url=${PING_URL%/}${1:+/$1}
  for attempt in 1 2 3; do
    if wget -q -T 10 -O /dev/null --header 'Content-Type: application/json' \
      --post-data "${2:-}" "$url" > /dev/null 2>&1; then
      return 0
    fi
    [ "$attempt" -eq 3 ] || sleep $((attempt * 2))
  done
  echo "offsite-copy: AVISO: o healthchecks não respondeu (3 tentativas)." >&2
}

fail() {
  code=$1 reason=$2 detail=$3
  echo "offsite-copy: FALHOU (${reason}): ${detail}" | redact >&2
  tail_text=""
  if [ -s "$LOG" ]; then
    tail_text=$(tail -n 20 "$LOG")
    printf '%s\n' "$tail_text" | redact >&2
  fi
  ping fail "{\"result\":\"fail\",\"reason\":\"${reason}\",\"detail\":$(printf '%s' "$detail" | json_string),\"log\":$(printf '%s' "$tail_text" | json_string)}"
  exit "$code"
}

# Which copy of this file runs: the Application mounts it from the panel,
# so a stale paste shows here against `sha256sum infra/r2/offsite-copy.sh`.
echo "offsite-copy: $(sha256sum "$0" 2> /dev/null | cut -d' ' -f1)" >&2

# --- the configuration -----------------------------------------------------------

missing=""
for name in OFFSITE_SOURCE_ENDPOINT OFFSITE_SOURCE_BUCKET OFFSITE_SOURCE_KEY \
  OFFSITE_SOURCE_KEY_SECRET OFFSITE_DEST_ENDPOINT OFFSITE_DEST_BUCKET \
  OFFSITE_DEST_KEY OFFSITE_DEST_KEY_SECRET; do
  eval "value=\${${name}:-}"
  [ -n "$value" ] || missing="${missing} ${name}"
done
[ -z "$missing" ] || fail 1 config "faltam no Environment:${missing}"

endpoint_ok() { printf '%s' "$1" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$'; }
bucket_ok() { printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,62}$'; }
host_of() { printf '%s' "$1" | sed -e 's#^https://##' -e 's#/$##' | tr 'A-Z' 'a-z'; }

for name in OFFSITE_SOURCE_ENDPOINT OFFSITE_DEST_ENDPOINT; do
  eval "value=\${${name}}"
  endpoint_ok "$value" || fail 1 config "${name} precisa ser https://<host>, sem caminho"
done
for name in OFFSITE_SOURCE_BUCKET OFFSITE_DEST_BUCKET; do
  eval "value=\${${name}}"
  bucket_ok "$value" || fail 1 config "${name} não é um nome de bucket"
done
# Another account is another endpoint (the account id is in the host). The
# same one would be a copy that falls with the original.
if [ "$(host_of "$OFFSITE_SOURCE_ENDPOINT")" = "$(host_of "$OFFSITE_DEST_ENDPOINT")" ]; then
  fail 1 config "a cópia precisa estar noutra conta: OFFSITE_DEST_ENDPOINT igual ao OFFSITE_SOURCE_ENDPOINT"
fi

PREFIXES=${OFFSITE_PREFIXES:-$DEFAULT_PREFIXES}
includes=""
for prefix in $PREFIXES; do
  printf '%s' "$prefix" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]*/$' \
    || fail 1 config "OFFSITE_PREFIXES: '${prefix}' não é um prefixo como deliveryProofs/"
  includes="${includes} ${prefix}"
done
[ -n "$includes" ] || fail 1 config "OFFSITE_PREFIXES vazio"

# --- rclone, configured through its own environment --------------------------------

for side in SRC DST; do
  if [ "$side" = SRC ]; then from=SOURCE; else from=DEST; fi
  eval "export RCLONE_CONFIG_${side}_TYPE=s3"
  eval "export RCLONE_CONFIG_${side}_PROVIDER=Cloudflare"
  eval "export RCLONE_CONFIG_${side}_REGION=auto"
  eval "export RCLONE_CONFIG_${side}_ENDPOINT=\"\${OFFSITE_${from}_ENDPOINT}\""
  eval "export RCLONE_CONFIG_${side}_ACCESS_KEY_ID=\"\${OFFSITE_${from}_KEY}\""
  eval "export RCLONE_CONFIG_${side}_SECRET_ACCESS_KEY=\"\${OFFSITE_${from}_KEY_SECRET}\""
  # Bucket-scoped tokens cannot create buckets: never try.
  eval "export RCLONE_CONFIG_${side}_NO_CHECK_BUCKET=true"
done
# The Go runtime returns memory before the 64 MiB cap does it the hard way.
export GOMEMLIMIT="${GOMEMLIMIT:-40MiB}" GOGC="${GOGC:-50}"

set -- copy "src:${OFFSITE_SOURCE_BUCKET}" "dst:${OFFSITE_DEST_BUCKET}"
for prefix in $includes; do
  set -- "$@" --include "/${prefix}**"
done
set -- "$@" \
  --immutable --size-only --no-update-modtime --max-delete 0 \
  --transfers 2 --checkers 4 --buffer-size 0 \
  --s3-upload-concurrency 1 --s3-chunk-size 5Mi \
  --retries 3 --low-level-retries 10 \
  --use-json-log --log-level NOTICE --stats 10m --stats-log-level NOTICE

ping start ""

if rclone "$@" > "$LOG" 2>&1; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || fail 3 copy-failed "rclone copy terminou com ${status}"

# --- the summary -------------------------------------------------------------------

# The last stats line rclone printed: its own totals of this run.
stats=$(grep '"stats":' "$LOG" | tail -n 1 || true)
number() {
  value=$(printf '%s' "$stats" | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -n 1)
  printf '%s' "${value:-0}"
}

seconds=$(($(date +%s) - started))
summary="{\"result\":\"ok\",\"prefixes\":$(printf '%s' "${includes# }" | json_string),\"transfers\":$(number transfers),\"checks\":$(number checks),\"errors\":$(number errors),\"bytes\":$(number bytes),\"seconds\":${seconds}}"
printf '%s\n' "$summary"
ping "" "$summary"
