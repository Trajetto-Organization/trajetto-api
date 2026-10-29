#!/bin/sh
#
# Makes this host reach GitHub over IPv4, and leaves every other use of IPv6
# untouched. Runs on the Dokploy host (the staging VPS), as root.
#
# Why: the layers of a ghcr.io image are served by
# pkg-containers.githubusercontent.com, which also answers on IPv6
# (2606:50c0:800x::154). From the staging VPS that path drops long downloads
# mid-way. On 28/10/2026 the API deploy failed 6 times out of 6 on the 46 MB
# node layer:
#   failed to copy: read tcp [2605:a140:…]:53884->[2606:50c0:8002::154]:443:
#   read: connection reset by peer
# The AI image had failed the same way twice on 27/10. ghcr.io itself
# (login, manifests) has no AAAA record, which is why only the layer
# downloads broke; over IPv4 the same downloads have never failed. Retrying
# (dokploy-deploy.mjs) and smaller layers only make the odds better: a big
# new layer can still lose every attempt.
#
# What: new TCP connections that THIS host opens to GitHub's IPv6 ranges are
# refused on the spot (OUTPUT, SYN only, answered with a TCP reset: the
# caller sees ECONNREFUSED at once, where icmp6-adm-prohibited made Linux
# retransmit the SYN for a second first). The caller gets an immediate error
# instead of a connection that dies later, and a
# dual-stack client tries the next address of the same name, the IPv4 one,
# right away: the Docker daemon's Go dialer (net.Dialer moves to the
# fallback family as soon as the primary fails), curl, apt and git.
# Untouched: inbound IPv6 (Cloudflare to the API, the panel), replies to
# connections someone else opened (SYN only), traffic from containers
# (FORWARD), and IPv6 to every other network.
#
# The ranges are GitHub's own (https://api.github.com/meta: `web`, `api` and
# `git` list exactly these two IPv6 blocks; pkg-containers is inside
# 2606:50c0::/32). `check` compares them with the live list.
#
# Usage, as root on the host:
#   github-ipv4-egress.sh install  copies itself to /usr/local/sbin, applies
#                                  the rules, and installs a systemd unit that
#                                  applies them at boot plus a timer that
#                                  re-applies them every 15 min (a firewall
#                                  reload that drops them is undone)
#   github-ipv4-egress.sh apply    the rules only, idempotent (what the unit runs)
#   github-ipv4-egress.sh check    the rules, the address a GitHub download
#                                  uses, IPv6 to the rest, the live ranges and
#                                  the disk left for images; non-zero when
#                                  something needs attention
#   github-ipv4-egress.sh remove   rules, unit and timer out: back to before
#
# Paths can be moved for tests: GITHUB_EGRESS_SYSTEMD_DIR, GITHUB_EGRESS_SBIN.

set -eu

CHAIN="TRAJETTO-GITHUB-V4"
PREFIXES="2606:50c0::/32 2a0a:a440::/29"
NAME="trajetto-github-ipv4-egress"
SYSTEMD_DIR="${GITHUB_EGRESS_SYSTEMD_DIR:-/etc/systemd/system}"
SBIN="${GITHUB_EGRESS_SBIN:-/usr/local/sbin}"
# Below this, the next image pull can run out of room (a new base pulls
# every layer, and Docker keeps the old image until the swap).
MIN_FREE_KB=5242880

log() { echo "[github-ipv4-egress] $*"; }
fail() { echo "[github-ipv4-egress] ERRO: $*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || fail "rode como root (sudo $0 $1)."
}

require_ip6tables() {
  command -v ip6tables >/dev/null 2>&1 ||
    fail "ip6tables não encontrado (o Docker usa o mesmo pacote: iptables)."
}

# -w waits for the xtables lock: the Docker daemon edits its own chains too.
rule_args() {
  printf '%s' "-d $1 -p tcp --syn -j REJECT --reject-with tcp-reset"
}

apply_rules() {
  ip6tables -w -N "$CHAIN" 2>/dev/null || true

  # Checked one by one, never flushed and rebuilt: a flush would leave a
  # moment in which a download could still start over IPv6.
  for prefix in $PREFIXES; do
    # shellcheck disable=SC2046 # the rule is several words on purpose
    ip6tables -w -C "$CHAIN" $(rule_args "$prefix") 2>/dev/null ||
      ip6tables -w -A "$CHAIN" $(rule_args "$prefix")
  done

  ip6tables -w -C OUTPUT -j "$CHAIN" 2>/dev/null ||
    ip6tables -w -I OUTPUT 1 -j "$CHAIN"
}

remove_rules() {
  while ip6tables -w -C OUTPUT -j "$CHAIN" 2>/dev/null; do
    ip6tables -w -D OUTPUT -j "$CHAIN"
  done

  ip6tables -w -F "$CHAIN" 2>/dev/null || true
  ip6tables -w -X "$CHAIN" 2>/dev/null || true
}

write_units() {
  mkdir -p "$SYSTEMD_DIR"

  cat > "$SYSTEMD_DIR/$NAME.service" <<EOF
[Unit]
Description=Trajetto: GitHub over IPv4 (the IPv6 path drops ghcr.io layer downloads)
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=$SBIN/$NAME apply

[Install]
WantedBy=multi-user.target
EOF

  cat > "$SYSTEMD_DIR/$NAME.timer" <<EOF
[Unit]
Description=Trajetto: re-apply the GitHub over IPv4 rules

[Timer]
OnBootSec=1min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
EOF
}

install() {
  require_root install
  require_ip6tables

  mkdir -p "$SBIN"
  cp "$0" "$SBIN/$NAME"
  chmod 755 "$SBIN/$NAME"

  apply_rules
  write_units

  systemctl daemon-reload
  systemctl enable "$NAME.service" "$NAME.timer"
  systemctl start "$NAME.timer"

  log "regras aplicadas; o systemd as reaplica no boot e a cada 15 min."
  log "confira com: $NAME check"
}

uninstall() {
  require_root remove
  require_ip6tables

  if [ -f "$SYSTEMD_DIR/$NAME.timer" ] || [ -f "$SYSTEMD_DIR/$NAME.service" ]; then
    systemctl disable --now "$NAME.timer" "$NAME.service" 2>/dev/null || true
    rm -f "$SYSTEMD_DIR/$NAME.timer" "$SYSTEMD_DIR/$NAME.service"
    systemctl daemon-reload
  fi

  remove_rules
  rm -f "$SBIN/$NAME"

  log "removido: as conexões ao GitHub voltam a usar o IPv6."
}

check() {
  attention=0

  if ip6tables -w -C OUTPUT -j "$CHAIN" 2>/dev/null; then
    log "regras: ativas"
    ip6tables -w -S "$CHAIN" | sed 's/^/  /'
  else
    log "regras: AUSENTES (rode: $0 apply)"
    attention=1
  fi

  # The address a layer download would use right now.
  remote=$(curl -sS -o /dev/null -m 20 -w '%{remote_ip}' \
    https://pkg-containers.githubusercontent.com/ 2>/dev/null || true)
  case "$remote" in
    *:*)
      log "download do GitHub: IPv6 ($remote) — as regras não estão valendo"
      attention=1
      ;;
    "") log "download do GitHub: sem resposta (rede?)"; attention=1 ;;
    *) log "download do GitHub: IPv4 ($remote)" ;;
  esac

  # IPv6 to everything else must keep working: this is a detour, not an off
  # switch.
  other=$(curl -6 -sS -o /dev/null -m 20 -w '%{remote_ip}' \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null || true)
  if [ -n "$other" ]; then
    log "IPv6 para o resto: ok ($other)"
  else
    log "IPv6 para o resto: sem resposta (não é causado por estas regras)"
  fi

  if command -v python3 >/dev/null 2>&1; then
    live=$(curl -sS -m 20 https://api.github.com/meta 2>/dev/null |
      python3 -c 'import json,sys
m=json.load(sys.stdin)
print(" ".join(sorted({c for k in ("web","api","git") for c in m.get(k,[]) if ":" in c})))' \
      2>/dev/null || true)
    expected=$(printf '%s\n' $PREFIXES | sort | tr '\n' ' ' | sed 's/ $//')
    if [ -z "$live" ]; then
      log "faixas do GitHub: não foi possível ler api.github.com/meta"
    elif [ "$live" = "$expected" ]; then
      log "faixas do GitHub: iguais às de api.github.com/meta ($live)"
    else
      log "faixas do GitHub MUDARAM: api.github.com/meta diz '$live', o script tem '$expected'"
      attention=1
    fi
  fi

  free_kb=$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$free_kb" ]; then
    if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
      log "disco: só $((free_kb / 1024)) MB livres em /var/lib/docker — limpe imagens antigas antes do próximo deploy"
      attention=1
    else
      log "disco: $((free_kb / 1024)) MB livres em /var/lib/docker"
    fi
  fi

  return "$attention"
}

case "${1:-}" in
  install) install ;;
  apply)
    require_root apply
    require_ip6tables
    apply_rules
    log "regras aplicadas."
    ;;
  check)
    # Reading the rules needs root too: without it ip6tables fails and the
    # rules would read as missing.
    require_root check
    require_ip6tables
    check
    ;;
  remove) uninstall ;;
  *)
    echo "uso: $0 install|apply|check|remove" >&2
    exit 2
    ;;
esac
