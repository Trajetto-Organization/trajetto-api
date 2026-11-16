#!/usr/bin/env bash
#
# Entrypoint of the trajetto-postgres image (plano-escala F1-01).
#
# The parameters production runs live here, versioned with the image, and
# not in the Dokploy Database: a value typed by ALTER SYSTEM lands in
# postgresql.auto.conf, which sits on the volume and outlives a rollback of
# the image (an archive_command pointing at a pgbackrest binary the old image
# does not have would fill pg_wal). Everything below goes in as `-c` flags,
# which win over postgresql.conf AND postgresql.auto.conf, so rolling the
# digest back rolls the configuration back with it.
#
# The flags, in this order (for a repeated name the LAST `-c` wins):
#   1. the static ones of /etc/trajetto/postgres.params;
#   2. the memory, derived from POSTGRES_MEMORY_LIMIT_MB (the container's
#      cap): a reserve R = min(256, L/4) MiB for pgBackRest and the system,
#      U = L - R for Postgres; shared_buffers 25% of U, effective_cache_size
#      70%, maintenance_work_mem U/8 (at most 1 GiB), autovacuum_work_mem
#      U/16 (at most 256 MiB), 3 autovacuum workers below 2048 MiB and 5 from
#      it, work_mem 30% of U over twice the expected active connections,
#      between 4 and 64 MiB. A fixed maintenance_work_mem of 1 GiB with five
#      autovacuum workers would blow a 768 MiB cap on its own, and a killed
#      backend takes the whole cluster into crash recovery;
#   3. max_connections, max_wal_size and max_slot_wal_keep_size (never
#      unlimited: a forgotten slot must not fill the disk both productions
#      share);
#   4. commit_delay/commit_siblings, the safe lever if the WAL ever becomes
#      the bottleneck (synchronous_commit stays on: a 2xx means committed);
#   5. archiving: on only with PITR_ARCHIVE=on AND a complete repo1;
#      archive_mode=off, explicitly, in every other case;
#   6. trajetto.image_revision, the commit the image was built from;
#   7. whatever the container was started with (the Database's Args), last,
#      so an extra flag wins over the default and keeps every other one.
#
# Bad or missing environment never stops the database: the value falls back
# to its default and a line on stderr says so. Only a broken params file
# (a build defect, which the image's test stage would have caught) refuses.
#
# Any first argument other than `postgres` or a flag runs as given (bash,
# pgbackrest, trajetto-restore-drill...).
set -Eeuo pipefail

PARAMS_FILE=${TRAJETTO_POSTGRES_PARAMS:-/etc/trajetto/postgres.params}
PGBACKREST_CONF_DIR=${TRAJETTO_PGBACKREST_CONF_DIR:-/etc/pgbackrest/conf.d}
CGROUP_ROOT=${TRAJETTO_CGROUP_ROOT:-/sys/fs/cgroup}

if [ "$#" -gt 0 ] && [ "$1" != "postgres" ] && [ "${1:0:1}" != "-" ]; then
  exec "$@"
fi
if [ "${1:-}" = "postgres" ]; then shift; fi

say() { printf 'trajetto-postgres: %s\n' "$*" >&2; }
warn() { printf 'trajetto-postgres: AVISO: %s\n' "$*" >&2; }

flags=()
add() { flags+=(-c "$1"); }

# A non-negative integer within [min, max], or empty.
int_in() {
  local value=$1 min=$2 max=$3
  [[ "$value" =~ ^[0-9]{1,9}$ ]] || return 1
  value=$((10#$value))
  [ "$value" -ge "$min" ] && [ "$value" -le "$max" ] || return 1
  printf '%s' "$value"
}

# A Postgres size with a unit Postgres and pgBackRest both read (MB, GB, TB).
size_ok() { [[ "$1" =~ ^[1-9][0-9]{0,6}(MB|GB|TB)$ ]]; }

# --- 1. the static parameters ------------------------------------------------

if [ ! -r "$PARAMS_FILE" ]; then
  echo "trajetto-postgres: ${PARAMS_FILE} não existe: imagem quebrada." >&2
  exit 64
fi
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  line=${line%%#*}
  line=${line%"${line##*[![:space:]]}"}
  line=${line#"${line%%[![:space:]]*}"}
  [ -n "$line" ] || continue
  if ! [[ "$line" =~ ^[a-z_][a-z0-9_.]*=[^[:space:]]+$ ]]; then
    echo "trajetto-postgres: ${PARAMS_FILE}:${line_no} não é nome=valor: imagem quebrada." >&2
    exit 64
  fi
  add "$line"
done < "$PARAMS_FILE"

# auto_explain prints the plans with their constants, which can be a CPF or
# an e-mail: only for an investigation, switched on by hand.
if [ "${POSTGRES_AUTO_EXPLAIN:-}" = "on" ]; then
  add "shared_preload_libraries=pg_stat_statements,auto_explain"
  add "auto_explain.log_min_duration=2s"
  warn "POSTGRES_AUTO_EXPLAIN=on: planos lentos vão para o log com as constantes; desligue ao fim da investigação."
fi

# --- 2. memory from the container's cap ---------------------------------------

# The cap the kernel enforces, in MiB, or empty (no cap, or no cgroup here).
cgroup_cap_mb() {
  local raw=""
  if [ -r "${CGROUP_ROOT}/memory.max" ]; then
    raw=$(cat "${CGROUP_ROOT}/memory.max")
  elif [ -r "${CGROUP_ROOT}/memory/memory.limit_in_bytes" ]; then
    raw=$(cat "${CGROUP_ROOT}/memory/memory.limit_in_bytes")
  fi
  # cgroup v1 reports "no limit" as a huge number.
  if [[ "$raw" =~ ^[0-9]{1,15}$ ]] && [ "$raw" -lt 1125899906842624 ]; then
    printf '%s' $((raw / 1048576))
  fi
}

limit=""
if [ -n "${POSTGRES_MEMORY_LIMIT_MB:-}" ]; then
  if ! limit=$(int_in "$POSTGRES_MEMORY_LIMIT_MB" 256 1048576); then
    limit=""
    warn "POSTGRES_MEMORY_LIMIT_MB='${POSTGRES_MEMORY_LIMIT_MB}' não é um inteiro entre 256 e 1048576: a memória fica nos padrões do Postgres."
  fi
fi

if [ -n "$limit" ]; then
  cap=$(cgroup_cap_mb)
  if [ -n "$cap" ] && [ "$cap" -lt "$limit" ]; then
    warn "POSTGRES_MEMORY_LIMIT_MB=${limit} passa do Memory Limit do contêiner (${cap} MiB): a conta usa ${cap}. Iguale os dois."
    limit=$cap
  fi

  active=20
  if [ -n "${POSTGRES_EXPECTED_ACTIVE_CONNECTIONS:-}" ]; then
    active=$(int_in "$POSTGRES_EXPECTED_ACTIVE_CONNECTIONS" 1 10000) || {
      active=20
      warn "POSTGRES_EXPECTED_ACTIVE_CONNECTIONS='${POSTGRES_EXPECTED_ACTIVE_CONNECTIONS}' inválido: usa 20."
    }
  fi

  reserve=$((limit / 4))
  [ "$reserve" -le 256 ] || reserve=256
  usable=$((limit - reserve))

  shared_buffers=$((usable / 4))
  effective_cache=$((usable * 70 / 100))
  maintenance=$((usable / 8))
  [ "$maintenance" -le 1024 ] || maintenance=1024
  autovacuum_mem=$((usable / 16))
  [ "$autovacuum_mem" -le 256 ] || autovacuum_mem=256
  autovacuum_workers=3
  [ "$limit" -lt 2048 ] || autovacuum_workers=5
  # 30% of U shared by twice the active connections (a sort and a hash each).
  work_mem=$((usable * 3 / (20 * active)))
  [ "$work_mem" -ge 4 ] || work_mem=4
  [ "$work_mem" -le 64 ] || work_mem=64

  add "shared_buffers=${shared_buffers}MB"
  add "effective_cache_size=${effective_cache}MB"
  add "maintenance_work_mem=${maintenance}MB"
  add "autovacuum_work_mem=${autovacuum_mem}MB"
  add "autovacuum_max_workers=${autovacuum_workers}"
  add "work_mem=${work_mem}MB"
  say "memória de ${limit} MiB (reserva ${reserve}): shared_buffers=${shared_buffers}MB effective_cache_size=${effective_cache}MB maintenance_work_mem=${maintenance}MB autovacuum_work_mem=${autovacuum_mem}MB autovacuum_max_workers=${autovacuum_workers} work_mem=${work_mem}MB."
else
  say "sem POSTGRES_MEMORY_LIMIT_MB: a memória fica nos padrões do Postgres (shared_buffers 128MB). Defina-o igual ao Memory Limit do Database."
fi

# --- 3. connections, WAL size and the slot cap --------------------------------

max_connections=200
if [ -n "${POSTGRES_MAX_CONNECTIONS:-}" ]; then
  max_connections=$(int_in "$POSTGRES_MAX_CONNECTIONS" 20 5000) || {
    max_connections=200
    warn "POSTGRES_MAX_CONNECTIONS='${POSTGRES_MAX_CONNECTIONS}' inválido (20 a 5000): usa 200."
  }
fi
add "max_connections=${max_connections}"

max_wal=${POSTGRES_MAX_WAL_SIZE:-8GB}
if ! size_ok "$max_wal"; then
  warn "POSTGRES_MAX_WAL_SIZE='${max_wal}' não é um tamanho como 1GB: usa 8GB."
  max_wal=8GB
fi
add "max_wal_size=${max_wal}"

# Never -1 (unlimited): that is exactly the forgotten slot filling the disk.
slot_keep=${POSTGRES_MAX_SLOT_WAL_KEEP_SIZE:-4GB}
if ! size_ok "$slot_keep"; then
  warn "POSTGRES_MAX_SLOT_WAL_KEEP_SIZE='${slot_keep}' não é um tamanho como 4GB (ilimitado não vale): usa 4GB."
  slot_keep=4GB
fi
add "max_slot_wal_keep_size=${slot_keep}"

# --- 4. commit grouping (off by default) -------------------------------------

commit_delay=0
if [ -n "${POSTGRES_COMMIT_DELAY_US:-}" ]; then
  commit_delay=$(int_in "$POSTGRES_COMMIT_DELAY_US" 0 100000) || {
    commit_delay=0
    warn "POSTGRES_COMMIT_DELAY_US='${POSTGRES_COMMIT_DELAY_US}' inválido (0 a 100000): usa 0."
  }
fi
commit_siblings=5
if [ -n "${POSTGRES_COMMIT_SIBLINGS:-}" ]; then
  commit_siblings=$(int_in "$POSTGRES_COMMIT_SIBLINGS" 0 1000) || {
    commit_siblings=5
    warn "POSTGRES_COMMIT_SIBLINGS='${POSTGRES_COMMIT_SIBLINGS}' inválido (0 a 1000): usa 5."
  }
fi
add "commit_delay=${commit_delay}"
add "commit_siblings=${commit_siblings}"

# --- 5. archiving and pgBackRest's per-start configuration -------------------

# The names a repository needs, by type. Values are never printed: the keys
# and the cipher passphrase are secrets, read by pgBackRest from the
# environment itself.
repo_missing() {
  local n=$1 type var missing=()
  type=$(eval "printf '%s' \"\${PGBACKREST_REPO${n}_TYPE:-}\"")
  if [ "$n" = 1 ]; then type=${type:-s3}; fi
  case "$type" in
    s3) set -- S3_ENDPOINT S3_BUCKET S3_KEY S3_KEY_SECRET CIPHER_PASS ;;
    posix) set -- PATH CIPHER_PASS ;;
    "") set -- TYPE ;;
    *)
      printf 'TYPE(%s não suportado: s3 ou posix)' "$type"
      return 0
      ;;
  esac
  # The cipher is not optional: an unencrypted copy of the database in a
  # bucket is a leak waiting for a key. repo1's type is in pgbackrest.conf;
  # repo2 comes whole from the environment.
  if [ "$n" != 1 ]; then set -- "$@" CIPHER_TYPE; fi
  for var in "$@"; do
    if [ -z "$(eval "printf '%s' \"\${PGBACKREST_REPO${n}_${var}:-}\"")" ]; then
      missing+=("PGBACKREST_REPO${n}_${var}")
    fi
  done
  if [ "$(eval "printf '%s' \"\${PGBACKREST_REPO${n}_CIPHER_TYPE:-}\"")" = "none" ]; then
    missing+=("PGBACKREST_REPO${n}_CIPHER_TYPE(none não vale)")
  fi
  printf '%s' "${missing[*]:-}"
}

# Whether any PGBACKREST_REPO<n>_* is set and not empty (empty = absent).
any_repo_var() {
  local name names=()
  eval "names=(\"\${!PGBACKREST_REPO${1}_@}\")"
  for name in "${names[@]}"; do
    if [ -n "${!name:-}" ]; then return 0; fi
  done
  return 1
}

repo1_ready=false
repo1_missing=$(repo_missing 1)
if [ -z "$repo1_missing" ]; then
  repo1_ready=true
elif any_repo_var 1; then
  warn "repo1 do pgBackRest incompleto, faltam: ${repo1_missing}."
fi

if any_repo_var 2; then
  repo2_missing=$(repo_missing 2)
  if [ -n "$repo2_missing" ]; then
    warn "repo2 do pgBackRest incompleto, faltam: ${repo2_missing}. O archive-push falharia nele."
  fi
fi

queue_max=${PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX:-4GB}
if ! size_ok "$queue_max"; then
  warn "PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX='${queue_max}' não é um tamanho como 4GB: usa 4GB."
  queue_max=4GB
  # pgBackRest reads it from the environment too, and would refuse it.
  unset PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX
fi

runtime_conf="${PGBACKREST_CONF_DIR}/runtime.conf"
if [ "$repo1_ready" = true ]; then
  # Written whenever repo1 is complete, archiving on or not: stanza-create
  # runs before PITR_ARCHIVE=on (docs/deploy.md, the F1a order). Above the
  # queue cap pgBackRest reports the WAL archived and DROPS it, with a
  # warning: the PITR window is lost until the next full (trajetto-backup
  # sees the gap), the disk is not.
  mkdir -p "$PGBACKREST_CONF_DIR"
  {
    echo "# Written by trajetto-entrypoint.sh at every start; edits here are lost."
    echo "[global]"
    echo "archive-push-queue-max=${queue_max}"
    echo "process-max=1"
    echo "buffer-size=1MiB"
    echo ""
    echo "[trajetto]"
    echo "pg1-path=${PGDATA:-/var/lib/postgresql/data}"
    echo "pg1-user=${POSTGRES_USER:-postgres}"
  } > "${runtime_conf}.tmp"
  chmod 0644 "${runtime_conf}.tmp"
  mv -f "${runtime_conf}.tmp" "$runtime_conf"
else
  rm -f "$runtime_conf"
fi

if [ "${PITR_ARCHIVE:-}" = "on" ] && [ "$repo1_ready" = true ]; then
  add "archive_mode=on"
  add "archive_command=pgbackrest --stanza=trajetto archive-push %p"
  add "archive_timeout=60s"
  say "arquivamento ligado (repo1 ${PGBACKREST_REPO1_TYPE:-s3}, fila de até ${queue_max})."
else
  add "archive_mode=off"
  if [ "${PITR_ARCHIVE:-}" = "on" ]; then
    warn "PITR_ARCHIVE=on, mas o repo1 está incompleto: arquivamento DESLIGADO."
  elif [ -n "${PITR_ARCHIVE:-}" ]; then
    warn "PITR_ARCHIVE='${PITR_ARCHIVE}' não é 'on': arquivamento desligado."
  else
    say "arquivamento desligado (sem PITR_ARCHIVE=on)."
  fi
fi

# --- 6. the image's commit, then the container's own args ---------------------

revision=${APP_COMMIT_SHA:-dev}
[[ "$revision" =~ ^[0-9A-Za-z._-]{1,64}$ ]] || revision=dev
add "trajetto.image_revision=${revision}"

exec docker-entrypoint.sh postgres "${flags[@]}" "$@"
