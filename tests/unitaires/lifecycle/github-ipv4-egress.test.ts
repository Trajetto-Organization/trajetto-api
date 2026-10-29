import { existsSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The staging VPS reaches GitHub over IPv4 (infra/scripts/github-ipv4-egress.sh).
 *
 * The layers of a ghcr.io image come from pkg-containers.githubusercontent.com,
 * which answers on IPv6 too, and the VPS's IPv6 path resets long downloads:
 * on 28/10/2026 the API deploy lost the 46 MB node layer 6 times out of 6
 * ("read tcp [2605:a140:…]->[2606:50c0:8002::154]:443: connection reset by
 * peer"). The script refuses new connections from the host to GitHub's IPv6
 * ranges, so every dual-stack client takes the IPv4 address at once, and
 * leaves the rest of IPv6 alone.
 *
 * It runs here for real, against an ip6tables stub that keeps its rules in a
 * file, so a test can read the table the script leaves behind.
 */
const SCRIPT = repoFile("infra", "scripts", "github-ipv4-egress.sh");
const CHAIN = "TRAJETTO-GITHUB-V4";
const RULE = (prefix: string) =>
  `-d ${prefix} -p tcp --syn -j REJECT --reject-with tcp-reset`;

const shell = hasShell("sh");

/** An ip6tables that keeps `chain <name>` and `rule <chain> <args>` lines. */
const IP6TABLES = `
state="$SANDBOX/ip6tables.state"
touch "$state"
[ "$1" = "-w" ] && shift
op=$1; chain=$2; shift 2
case "$op" in
  -N) grep -qx "chain $chain" "$state" && exit 1; echo "chain $chain" >> "$state" ;;
  -C) grep -qxF "rule $chain $*" "$state" ;;
  -A) echo "rule $chain $*" >> "$state" ;;
  -I) shift; { echo "rule $chain $*"; cat "$state"; } > "$state.new"; mv "$state.new" "$state" ;;
  -D) awk -v line="rule $chain $*" '!done && $0 == line { done = 1; next } { print }' "$state" > "$state.new"; mv "$state.new" "$state" ;;
  -F) grep -v "^rule $chain " "$state" > "$state.new" || true; mv "$state.new" "$state" ;;
  -X) grep -qx "chain $chain" "$state" || exit 1; grep -vx "chain $chain" "$state" > "$state.new" || true; mv "$state.new" "$state" ;;
  -S) grep "^rule $chain " "$state" | sed "s/^rule $chain /-A $chain /" ;;
esac
`;

describe.skipIf(!shell)("github-ipv4-egress.sh", () => {
  let box: Sandbox;
  let env: Record<string, string>;

  const state = () =>
    existsSync(`${box.root}/ip6tables.state`)
      ? readFileSync(`${box.root}/ip6tables.state`, "utf8")
          .split("\n")
          .filter(Boolean)
      : [];

  const exec = (...args: string[]) =>
    run("sh", SCRIPT, args, { bin: box.bin, env });

  beforeEach(() => {
    box = sandbox();
    env = {
      SANDBOX: box.root,
      GITHUB_EGRESS_SYSTEMD_DIR: `${box.root}/systemd`,
      GITHUB_EGRESS_SBIN: `${box.root}/sbin`,
      AS_UID: "0",
      PKG_REMOTE: "185.199.108.154",
      META_RANGES: "2606:50c0::/32 2a0a:a440::/29",
      FREE_KB: "20971520",
    };

    box.stub("ip6tables", IP6TABLES);
    box.stub("id", `[ "$1" = "-u" ] && echo "$AS_UID"`);
    box.stub("systemctl", "exit 0");
    box.stub(
      "curl",
      `case "$*" in
  *pkg-containers*) printf '%s' "$PKG_REMOTE" ;;
  *" -6 "*|"-6 "*) printf '%s' "2606:4700::6810:84e5" ;;
  *api.github.com/meta*) printf '{}' ;;
esac`,
    );
    box.stub("python3", `cat > /dev/null; echo "$META_RANGES"`);
    box.stub(
      "df",
      `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/sda1 100 50 %s 50%% /\\n' "$FREE_KB"`,
    );
  });

  afterEach(() => box.dispose());

  it("refuses only new connections to GitHub's two IPv6 ranges, from the top of OUTPUT", () => {
    const result = exec("apply");

    expect(result.status, result.stderr).toBe(0);
    expect(state()).toEqual([
      `rule OUTPUT -j ${CHAIN}`,
      `chain ${CHAIN}`,
      `rule ${CHAIN} ${RULE("2606:50c0::/32")}`,
      `rule ${CHAIN} ${RULE("2a0a:a440::/29")}`,
    ]);
  });

  it("is idempotent, and never flushes the chain to rebuild it", () => {
    exec("apply");
    const before = state();

    const again = exec("apply");

    expect(again.status, again.stderr).toBe(0);
    expect(state()).toEqual(before);
    // A flush would leave a moment in which a download starts over IPv6.
    expect(box.calls("ip6tables").some((call) => / -F /.test(call))).toBe(
      false,
    );
  });

  it("puts back a rule a firewall reload dropped, without duplicating the others", () => {
    exec("apply");
    const full = state();
    const dropped = full.filter((line) => !line.includes("2a0a:a440::/29"));
    box.file("ip6tables.state", `${dropped.join("\n")}\n`);

    expect(exec("apply").status).toBe(0);
    expect([...state()].sort()).toEqual([...full].sort());
  });

  it("installs a unit that applies the rules at boot and a timer that re-applies them", () => {
    const result = exec("install");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(`${box.root}/sbin/trajetto-github-ipv4-egress`)).toBe(
      true,
    );

    const unit = readFileSync(
      `${box.root}/systemd/trajetto-github-ipv4-egress.service`,
      "utf8",
    );
    const timer = readFileSync(
      `${box.root}/systemd/trajetto-github-ipv4-egress.timer`,
      "utf8",
    );

    expect(unit).toContain(
      `ExecStart=${box.root}/sbin/trajetto-github-ipv4-egress apply`,
    );
    expect(unit).toContain("After=network-online.target docker.service");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(timer).toContain("OnUnitActiveSec=15min");
    expect(box.calls("systemctl")).toEqual([
      "systemctl daemon-reload",
      "systemctl enable trajetto-github-ipv4-egress.service trajetto-github-ipv4-egress.timer",
      "systemctl start trajetto-github-ipv4-egress.timer",
    ]);
    expect(state()).toContain(`rule OUTPUT -j ${CHAIN}`);
  });

  it("removes rules, unit and timer, leaving the table as it found it", () => {
    box.file("ip6tables.state", "rule OUTPUT -j DOCKER-USER-LIKE\n");
    exec("install");

    const result = exec("remove");

    expect(result.status, result.stderr).toBe(0);
    expect(state()).toEqual(["rule OUTPUT -j DOCKER-USER-LIKE"]);
    expect(
      existsSync(`${box.root}/systemd/trajetto-github-ipv4-egress.service`),
    ).toBe(false);
    expect(
      existsSync(`${box.root}/systemd/trajetto-github-ipv4-egress.timer`),
    ).toBe(false);
    expect(existsSync(`${box.root}/sbin/trajetto-github-ipv4-egress`)).toBe(
      false,
    );
  });

  it("does nothing without root", () => {
    env.AS_UID = "1000";

    for (const mode of ["apply", "install", "remove", "check"]) {
      const result = exec(mode);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("rode como root");
    }

    expect(box.calls("ip6tables")).toEqual([]);
    expect(box.calls("systemctl")).toEqual([]);
  });

  describe("check", () => {
    it("passes when downloads leave over IPv4, IPv6 still works elsewhere and the ranges match GitHub's", () => {
      exec("apply");

      const result = exec("check");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("regras: ativas");
      expect(result.stdout).toContain(
        "download do GitHub: IPv4 (185.199.108.154)",
      );
      expect(result.stdout).toContain("IPv6 para o resto: ok");
      expect(result.stdout).toContain("iguais às de api.github.com/meta");
    });

    it("fails when the rules are missing", () => {
      const result = exec("check");

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("regras: AUSENTES");
    });

    it("fails when a download still leaves over IPv6", () => {
      exec("apply");
      env.PKG_REMOTE = "2606:50c0:8002::154";

      const result = exec("check");

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("as regras não estão valendo");
    });

    it("fails when GitHub publishes other IPv6 ranges", () => {
      exec("apply");
      env.META_RANGES = "2606:50c0::/32 2a0a:a440::/29 2001:db8::/32";

      const result = exec("check");

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("faixas do GitHub MUDARAM");
    });

    it("fails when the disk cannot take the next image", () => {
      exec("apply");
      env.FREE_KB = "1048576";

      const result = exec("check");

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("limpe imagens antigas");
    });
  });
});
