import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The capacity gate (tests/load/gate.sh, plano-escala LOAD-08).
 *
 * A gate measured with the load generated on the target itself proves only
 * the contention between k6 and the server (D71), and a gate pointed at
 * production loads the customers in use. So the script refuses, before it
 * touches docker or SSH: production's hosts, staging's, a TARGET_HOST_IP
 * that is an address of this machine (loopback, an interface, a name that
 * resolves to one), and a target URL that names another IP. Run for real,
 * with docker, ssh, curl, ip, hostname, nproc and sleep stubbed: the
 * report it writes must carry what the docs test asks for.
 */
const SCRIPT = repoFile("tests", "load", "gate.sh");
const bash = hasShell("bash");

const DIGEST = `sha256:${"c".repeat(64)}`;

const CONTEXT = JSON.stringify({
  baseUrl: "http://10.0.0.5",
  businessId: "b",
  managerTokens: ["manager-token-of-the-test"],
  driverTokens: ["driver-token-of-the-test"],
});

const VMSTAT = `procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0      0 812345  12345 456789    0    0     5    10  100  200  5  2 90  3  9
 1  0      0 812345  12345 456789    0    0     5    10  100  200  6  2 89  1  2
`;

const TARGET = [
  "### hostname",
  "alvo-1",
  "### nproc",
  "6",
  "### memory",
  "12582912",
  "### images",
  `trajetto-api ghcr.io/trajetto-organization/trajetto-api:staging@${DIGEST}`,
].join("\n");

type Checker = {
  reportProblems: (text: string, fileName?: string) => string[];
};

const checker = () =>
  import(
    pathToFileURL(
      resolve(process.cwd(), "tests", "load", "lib", "gate-report.mjs"),
    ).href
  ) as Promise<Checker>;

describe.skipIf(!bash)("gate.sh (LOAD-08)", { timeout: 60_000 }, () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    box.file("stub/vmstat.txt", VMSTAT);
    box.file("stub/target.txt", `${TARGET}\n`);
    box.file(
      "stub/rolling.json",
      JSON.stringify({
        metrics: { http_reqs: { count: 15_000, rate: 50 }, rolling_5xx: {} },
      }),
    );
    box.file("context.json", CONTEXT);

    box.stub(
      "ip",
      `case "$*" in
  "-o addr show") printf '1: lo    inet 127.0.0.1/8 scope host lo\\n2: eth0    inet 10.0.0.9/24 brd 10.0.0.255 scope global eth0\\n' ;;
  "route get "*) printf '%s via 10.0.0.1 dev eth0 src 10.0.0.9 uid 0\\n' "$3" ;;
esac`,
    );
    box.stub(
      "hostname",
      `case "$1" in -I) echo 10.0.0.9 ;; *) echo gerador-1 ;; esac`,
    );
    box.stub("nproc", "echo 2");
    box.stub("sleep", "exit 0");
    box.stub(
      "curl",
      `printf '%s' '{"status":"ok","version":"1.4.0","commit":"0123456789abcdef0123456789abcdef01234567"}'`,
    );
    box.stub(
      "ssh",
      `case "$*" in
  *"vmstat 5"*) cat "${box.root}/stub/vmstat.txt" ;;
  *"docker stats"*) printf 'trajetto-api.1.abc 42.50%% 310MiB / 1GiB\\n' ;;
  *"sh -s"*)
    script="$(cat)"
    case "$script" in
      *"### hostname"*) cat "${box.root}/stub/target.txt" ;;
      *"ORDER BY total_exec_time"*) printf '1234.5 | 9000 | 0.14 | SELECT 1\\n' ;;
    esac ;;
esac
exit 0`,
    );
    // k6 and the fleet: the summary the scene would export, into the
    // folder mounted on /results.
    box.stub(
      "docker",
      `case "$1" in
  run)
    results=""; summary=""; prev=""
    for arg in "$@"; do
      case "$prev" in
        -v) case "$arg" in *:/results) results="\${arg%:/results}" ;; esac ;;
        --summary-export) summary="$arg" ;;
        -e) case "$arg" in FLEET_SUMMARY=*) summary="\${arg#FLEET_SUMMARY=}" ;; esac ;;
      esac
      prev="$arg"
    done
    name="$(basename "$summary")"
    if [ -n "$results" ] && [ -f "${box.root}/stub/$name" ]; then cp "${box.root}/stub/$name" "$results/$name"; fi
    exit 0 ;;
esac
exit 0`,
    );
  });

  afterEach(() => box.dispose());

  const gate = (step: string, env: Record<string, string> = {}) =>
    run("bash", SCRIPT, step ? [step] : [], {
      bin: box.bin,
      env: {
        TARGET_HOST_IP: "10.0.0.5",
        GATE_TARGET_URL: "http://10.0.0.5",
        GATE_TARGET_SSH: "root@10.0.0.5",
        GATE_SCENES: "rolling",
        GATE_CONTEXT_FILE: `${box.root}/context.json`,
        GATE_REPORT_DIR: `${box.root}/desempenho`,
        GATE_WORK: `${box.root}/work`,
        ...env,
      },
    });

  const touched = () => [...box.calls("docker"), ...box.calls("ssh")];

  const reports = () =>
    existsSync(`${box.root}/desempenho`)
      ? readdirSync(`${box.root}/desempenho`)
      : [];

  describe("the target", () => {
    it.each([
      "https://api.intrajetto.com",
      "https://API.intrajetto.com",
      "https://www.intrajetto.com",
      "https://intrajetto.com/health",
    ])("refuses production (%s), touching nothing", (url) => {
      const result = gate("B", { GATE_TARGET_URL: url });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("é a produção em uso");
      expect(touched()).toEqual([]);
    });

    it("refuses staging", () => {
      const result = gate("100k", {
        GATE_TARGET_URL: "https://api-staging.intrajetto.com",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("é a staging");
      expect(touched()).toEqual([]);
    });

    it("refuses an unknown gate", () => {
      const result = gate("2m");

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("uso: gate.sh B|100k|1m|5m");
    });
  });

  describe("the generator is another machine", () => {
    it("refuses a TARGET_HOST_IP of this machine's interfaces, touching nothing", () => {
      const result = gate("B", {
        TARGET_HOST_IP: "10.0.0.9",
        GATE_TARGET_URL: "http://10.0.0.9",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "TARGET_HOST_IP=10.0.0.9 é um IP desta máquina",
      );
      expect(touched()).toEqual([]);
      expect(reports()).toEqual([]);
    });

    it.each(["127.0.0.1", "127.0.1.1", "::1"])(
      "refuses the loopback %s",
      (address) => {
        const result = gate("B", {
          TARGET_HOST_IP: address,
          GATE_TARGET_URL: `http://${address.includes(":") ? `[${address}]` : address}`,
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("é esta máquina");
        expect(touched()).toEqual([]);
      },
    );

    it("refuses a target name that resolves to this machine", () => {
      box.stub("getent", "echo '10.0.0.9   STREAM bancada.example.com'");

      const result = gate("B", {
        GATE_TARGET_URL: "http://bancada.example.com",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "bancada.example.com resolve para 10.0.0.9, um IP desta máquina",
      );
      expect(touched()).toEqual([]);
    });

    it("refuses a target URL that names another IP than TARGET_HOST_IP", () => {
      const result = gate("B", { GATE_TARGET_URL: "http://10.0.0.6" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("os dois precisam ser o alvo");
    });

    it("asks for TARGET_HOST_IP, an IP", () => {
      expect(gate("B", { TARGET_HOST_IP: "" }).stderr).toContain(
        "Defina TARGET_HOST_IP",
      );
      expect(gate("B", { TARGET_HOST_IP: "alvo" }).stderr).toContain(
        "não é um endereço IP",
      );
      expect(touched()).toEqual([]);
    });
  });

  describe("the run", () => {
    it("writes a report with the commit, the digest and the generator, pending only what no scene measures", async () => {
      const result = gate("B");

      expect(result.status, result.stderr).toBe(3);

      const [name] = reports();

      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-B\.md$/);

      const text = readFileSync(`${box.root}/desempenho/${name}`, "utf8");

      expect(text).toContain("| IP | 10.0.0.9 |");
      expect(text).toContain("| `nproc` | 2 |");
      expect(text).toContain(`trajetto-api:staging@${DIGEST}`);
      expect(text).toContain("0123456789abcdef0123456789abcdef01234567");
      expect(text).toContain("| respostas 5xx (rolling) | 0 | 0 | sim |");
      expect(text).toContain("SELECT 1");

      // Only the result and the pending rows stand between it and the repo.
      const problems = (await checker()).reportProblems(text, name);

      expect(
        problems.filter(
          (problem) => !/está 'pendente'|resultado 'incompleto'/.test(problem),
        ),
      ).toEqual([]);
    });

    it("drives k6 from this machine, the tokens by name, and reads the target over SSH", () => {
      gate("B");

      const k6 = box
        .calls("docker")
        .find((call) => call.includes("grafana/k6"));

      expect(k6).toContain("--network host");
      expect(k6).toContain("-e LOAD_BASE_URL=http://10.0.0.5");
      expect(k6).toContain("-e ROLLING_CONTEXT_JSON ");
      expect(k6).toContain("-e ROLLING_RATE=50");
      expect(k6).toContain(
        "--summary-export /results/rolling.json /load/rolling.js",
      );
      expect(box.calls().join("\n")).not.toContain("driver-token-of-the-test");

      const ssh = box.calls("ssh");

      expect(ssh.some((call) => call.endsWith("root@10.0.0.5 vmstat 5"))).toBe(
        true,
      );
      expect(
        ssh.some((call) => call.includes("docker stats --no-stream")),
      ).toBe(true);
    });

    it("fails the gate on a 5xx in the rolling", () => {
      box.file(
        "stub/rolling.json",
        JSON.stringify({
          metrics: {
            http_reqs: { count: 15_000, rate: 50 },
            rolling_5xx: { count: 4 },
          },
        }),
      );

      const result = gate("B");

      expect(result.status).toBe(1);

      const [name] = reports();

      expect(readFileSync(`${box.root}/desempenho/${name}`, "utf8")).toContain(
        "| Resultado | reprovado |",
      );
    });

    it("never overwrites a report: a gate run again is a new file", () => {
      gate("B");
      gate("B", { GATE_WORK: `${box.root}/work-2` });

      expect(reports().sort()).toEqual([
        expect.stringMatching(/-B-2\.md$/),
        expect.stringMatching(/-B\.md$/),
      ]);
    });

    it("stops when the target does not answer over SSH", () => {
      box.stub("ssh", "cat > /dev/null; exit 255");

      const result = gate("B");

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("O alvo não respondeu pelo SSH");
      expect(box.calls("docker")).toEqual([]);
    });
  });
});
