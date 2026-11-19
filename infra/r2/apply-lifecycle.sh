#!/bin/sh
#
# apply-lifecycle.sh: the lifecycle rules of an R2 bucket, from the JSON
# files beside it (plano-escala F5-28; infra/r2/lifecycle.md).
#
#   sh infra/r2/apply-lifecycle.sh uploads <bucket> [--dry-run] [--replace]
#   sh infra/r2/apply-lifecycle.sh archive <bucket> [--with-history-expiration]
#                                                   [--dry-run] [--replace]
#
# One mode per kind of bucket:
#
#   uploads  infra/r2/lifecycle.json. The proofs, the delivery, checklist
#            and odometer photos and the chat's attachments move to
#            Infrequent Access at 60 days; the avatars (read on every
#            screen) and the spreadsheets (deleted by their job) stay
#            Standard. NOTHING expires: the proofs are kept for the legal
#            term, and deliveryProofs/ is under a Bucket Lock anyway. An
#            unfinished multipart upload is aborted after 7 days.
#   archive  infra/r2/archive-lifecycle.json. `trail/` (the GPS trail,
#            F2-11) expires at 180 days, TRAIL_ARCHIVE_RETENTION_DAYS.
#            `archive/` (the delivery history, F5-16) expires at the legal
#            term ONLY with --with-history-expiration, after the lawyer's
#            opinion: without it, that rule is left out and the history is
#            kept. The archive's objects are written in STANDARD_IA.
#
# A PUT replaces a bucket's lifecycle configuration as a whole. So the
# rules in place are read first, and one this script does not know (made
# by hand in the panel, say) stops it unless --replace says it may go; and
# the rules are read back after the PUT, which fails the run when they are
# not the ones sent. The bucket's name is checked against the mode: the
# archive's Expirations must never reach the uploads bucket.
#
# Environment:
#   R2_LIFECYCLE_ENDPOINT    https://<ACCOUNT_ID>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID,
#   AWS_SECRET_ACCESS_KEY    an R2 API token with Admin Read & Write on
#                            THAT bucket only, read by the aws CLI from its
#                            own environment; never printed.
#
# Needs the AWS CLI v2 (`aws`) and Node (`node`, which shapes the JSON).
# POSIX sh.
#
# Exit status: 0 ok (or a dry run); 1 usage or configuration; 2 refused
# (rules in place this script does not know); 3 the read or the PUT
# failed; 4 the rules read back are not the ones sent.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
HISTORY_RULE="trajetto-expire-history"
SECRET_NAMES="AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN"

usage() {
  echo "uso: apply-lifecycle.sh uploads|archive <bucket> [--with-history-expiration] [--dry-run] [--replace]" >&2
  exit 1
}

# Blanks every secret out of stdin. awk index(), not sed: a key may hold
# any of sed's special characters.
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

MODE=${1:-}
BUCKET=${2:-}

[ -n "$MODE" ] && [ -n "$BUCKET" ] || usage
shift 2

DRY_RUN=no
REPLACE=no
WITH_HISTORY=no

for flag in "$@"; do
  case $flag in
    --dry-run) DRY_RUN=yes ;;
    --replace) REPLACE=yes ;;
    --with-history-expiration) WITH_HISTORY=yes ;;
    *) usage ;;
  esac
done

case $MODE in
  uploads)
    SOURCE="$HERE/lifecycle.json"

    # The uploads bucket holds the proofs: never a bucket of another kind,
    # whose rules (and whose objects) are not these.
    case $BUCKET in
      *archive* | *backup* | *pitr* | *offsite*)
        echo "bucket-mismatch: '$BUCKET' não parece o bucket de uploads; o modo uploads é só para ele" >&2
        exit 1
        ;;
    esac

    if [ "$WITH_HISTORY" = yes ]; then
      echo "usage: --with-history-expiration é só do modo archive" >&2
      exit 1
    fi
    ;;
  archive)
    SOURCE="$HERE/archive-lifecycle.json"

    # The archive's rules expire objects: only on a bucket named as one.
    case $BUCKET in
      *archive*) ;;
      *)
        echo "bucket-mismatch: '$BUCKET' não é um bucket de arquivo (trajetto-archive-*); as Expirations do arquivo apagariam comprovantes" >&2
        exit 1
        ;;
    esac
    ;;
  *) usage ;;
esac

if [ -z "${R2_LIFECYCLE_ENDPOINT:-}" ]; then
  echo "config: defina R2_LIFECYCLE_ENDPOINT (https://<ACCOUNT_ID>.r2.cloudflarestorage.com)" >&2
  exit 1
fi

for tool in aws node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "config: '$tool' não encontrado no PATH" >&2
    exit 1
  fi
done

CONFIG=$(mktemp)
CURRENT=$(mktemp)
ERRORS=$(mktemp)
trap 'rm -f "$CONFIG" "$CURRENT" "$ERRORS"' EXIT

# The configuration to send (the history's Expiration only when asked),
# and its rule IDs, one per line, sorted.
node -e '
  const fs = require("fs");
  const [file, withHistory, historyRule] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (withHistory !== "yes") {
    config.Rules = config.Rules.filter((rule) => rule.ID !== historyRule);
  }
  process.stdout.write(JSON.stringify(config));
' "$SOURCE" "$WITH_HISTORY" "$HISTORY_RULE" >"$CONFIG"

EXPECTED=$(node -e '
  const fs = require("fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(config.Rules.map((rule) => rule.ID).sort().join("\n"));
' "$CONFIG")

# The rule IDs in place, one per line, sorted; none for a bucket that has
# no configuration yet.
read_rules() {
  if aws --endpoint-url "$R2_LIFECYCLE_ENDPOINT" --region auto \
    s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --query 'Rules[].ID' --output text >"$CURRENT" 2>"$ERRORS"; then
    tr -d '\r' <"$CURRENT" | tr '\t' '\n' | grep -v -x -e '' -e 'None' | sort || true
    return 0
  fi

  if grep -q 'NoSuchLifecycleConfiguration' "$ERRORS"; then
    return 0
  fi

  echo "read-failed: a leitura das regras de '$BUCKET' falhou" >&2
  redact <"$ERRORS" >&2
  exit 3
}

# A failed read exits 3 inside the substitution; `|| exit` carries it.
IN_PLACE=$(read_rules) || exit $?

UNKNOWN=$(printf '%s\n' "$IN_PLACE" | grep -v -x -e '' | grep -v -x -F "$EXPECTED" || true)

echo "bucket: $BUCKET (modo $MODE)"
echo "regras hoje: $(printf '%s' "$IN_PLACE" | tr '\n' ' ')"
echo "regras novas: $(printf '%s' "$EXPECTED" | tr '\n' ' ')"

if [ -n "$UNKNOWN" ] && [ "$REPLACE" != yes ]; then
  echo "unknown-rules: o bucket tem regras que este script não conhece e que o PUT apagaria:" >&2
  printf '%s\n' "$UNKNOWN" >&2
  echo "Confira no painel; rode de novo com --replace se elas podem sair." >&2
  exit 2
fi

if [ "$DRY_RUN" = yes ]; then
  echo "dry-run: nada foi enviado. A configuração seria:"
  cat "$CONFIG"
  echo
  exit 0
fi

# Inline, not file://: a Windows aws.exe under Git Bash does not read a
# POSIX temp path.
if ! aws --endpoint-url "$R2_LIFECYCLE_ENDPOINT" --region auto \
  s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "$(cat "$CONFIG")" >/dev/null 2>"$ERRORS"; then
  echo "put-failed: o PUT das regras de '$BUCKET' falhou" >&2
  redact <"$ERRORS" >&2
  exit 3
fi

AFTER=$(read_rules) || exit $?

if [ "$AFTER" != "$EXPECTED" ]; then
  echo "readback-mismatch: as regras lidas de volta não são as enviadas" >&2
  echo "lidas: $(printf '%s' "$AFTER" | tr '\n' ' ')" >&2
  exit 4
fi

printf '{"result":"ok","mode":"%s","bucket":"%s","history_expiration":"%s","rules":%s}\n' \
  "$MODE" "$BUCKET" "$WITH_HISTORY" \
  "$(printf '%s' "$EXPECTED" | awk 'BEGIN { printf "[" } { printf "%s\"%s\"", (NR > 1 ? "," : ""), $0 } END { printf "]" }')"
