import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The staging burn-in (tests/load/staging-burn-in.sh, plano-escala LOAD-09)
 * loads the VPS production runs on. What keeps production's users out of it
 * are the caps (30 req/s, 10 minutes, 200 sockets), the window (06:00–08:00
 * UTC, never the 1st nor a Sunday), the refusal of production's hosts and
 * two probes that abort everything: production's readiness getting slower
 * or failing, and the host's iowait or steal climbing.
 *
 * Executed for real, with docker, curl, vmstat, date and sleep replaced by
 * stubs: a probe that worsens must stop k6, not be reported at the end.
 */
const SCRIPT = repoFile("tests", "load", "staging-burn-in.sh");
const bash = hasShell("bash");

const read = (...path: string[]) =>
  readFileSync(resolve(process.cwd(), ...path), "utf8").replace(/\r\n/g, "\n");

const CONTEXT = '{"businessId":"b","managerTokens":["m"],"driverTokens":["d"]}';

const VMSTAT_CALM = `procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1  0      0 812345  12345 456789    0    0     5    10  100  200  5  2 90  3  0
 1  0      0 812345  12345 456789    0    0     5    10  100  200  6  2 89  3  0
`;

describe.skipIf(!bash)(
  "staging-burn-in.sh (LOAD-09)",
  { timeout: 60_000 },
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      // Tuesday the 17th, 06:10 UTC: inside the window.
      box.file("now", "2 17 06 10\n");
      box.file("vmstat.txt", VMSTAT_CALM);

      box.stub(
        "date",
        `case "$*" in *%u*) cat "${box.root}/now" ;; *) command -p date "$@" ;; esac`,
      );
      box.stub("sleep", "exit 0");
      box.stub("vmstat", `cat "${box.root}/vmstat.txt"`);
      // The first six calls are the base; after them, the mode file decides.
      box.stub(
        "curl",
        `n=$(cat "${box.root}/curl-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${box.root}/curl-count"
mode=$(cat "${box.root}/curl-mode" 2>/dev/null || echo calm)
if [ "$n" -le 6 ]; then printf '200 0.004'; exit 0; fi
case "$mode" in
  slow) printf '200 0.400' ;;
  fail) printf '000 5.000' ;;
  *) printf '200 0.005' ;;
esac`,
      );
      box.stub(
        "docker",
        `case "$1" in
  network) exit 0 ;;
  inspect) echo 10.0.1.5 ;;
  stop) : > "${box.root}/stopped" ;;
  run)
    case "$*" in
      *node*) cat > /dev/null; printf '%s' '${CONTEXT}'; exit "$(cat "${box.root}/fixture-status" 2>/dev/null || echo 0)" ;;
      *k6*)
        cat > /dev/null
        i=0
        while [ ! -f "${box.root}/stopped" ] && [ "$i" -lt 30 ]; do command -p sleep 0.1; i=$((i + 1)); done
        exit "$(cat "${box.root}/k6-status" 2>/dev/null || echo 0)" ;;
    esac ;;
esac
exit 0`,
      );
    });

    afterEach(() => box.dispose());

    const burnIn = (env: Record<string, string> = {}) =>
      run("bash", SCRIPT, [], {
        bin: box.bin,
        env: {
          FIXTURE_ADMIN_EMAIL: "carga-admin@example.com",
          FIXTURE_ADMIN_PASSWORD: "secret-of-the-test",
          TMPDIR: box.root,
          ...env,
        },
      });

    const dockerCalls = () => box.calls("docker").join("\n");

    describe("the caps", () => {
      it("refuses 31 req/s, touching nothing", () => {
        const result = burnIn({ BURN_IN_RATE: "31" });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("o teto é 30 req/s");
        expect(box.calls("docker")).toEqual([]);
      });

      it("refuses more than 200 sockets and more than 10 minutes", () => {
        expect(burnIn({ BURN_IN_MAX_VUS: "201" }).status).toBe(2);
        expect(burnIn({ BURN_IN_DURATION: "11m" }).status).toBe(2);
        expect(burnIn({ BURN_IN_DURATION: "601s" }).status).toBe(2);
        expect(box.calls("docker")).toEqual([]);
      });

      it("accepts the ceilings themselves", () => {
        const result = burnIn({
          BURN_IN_RATE: "30",
          BURN_IN_MAX_VUS: "200",
          BURN_IN_DURATION: "10m",
        });

        expect(result.status, result.stderr).toBe(0);
      });
    });

    describe("the target", () => {
      it.each([
        "api.intrajetto.com",
        "API.intrajetto.com",
        "www.intrajetto.com",
      ])("refuses the production host %s", (host) => {
        const result = burnIn({ BURN_IN_HOST: host });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("é a produção");
        expect(box.calls("docker")).toEqual([]);
      });

      it("refuses a host that is not staging's", () => {
        const result = burnIn({ BURN_IN_HOST: "api.example.com" });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("não é um host de staging");
      });
    });

    describe("the window (docs/operacao/jobs.md, load-window)", () => {
      it.each([
        ["7 15 06 10", "Domingo"],
        ["3 01 06 10", "dia 1"],
        ["2 17 05 59", "Fora da janela"],
        ["2 17 07 55", "Fora da janela"],
        ["2 17 08 00", "Fora da janela"],
      ])("refuses %s", (now, reason) => {
        box.file("now", `${now}\n`);

        const result = burnIn();

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(reason);
        expect(box.calls("docker")).toEqual([]);
      });

      it("is the window the schedule map reserves", () => {
        const row = read("docs", "operacao", "jobs.md")
          .split("\n")
          .find((line) => line.startsWith("| `load-window`"));

        expect(row).toContain("seg–sáb, exceto dia 1");
        expect(row).toContain("06:00–08:00");

        const script = read("tests", "load", "staging-burn-in.sh");

        expect(script).toContain("WINDOW_FROM=360\n");
        expect(script).toContain("WINDOW_TO=480\n");
      });
    });

    describe("the run", () => {
      it("prepares the fixture and drives the load inside dokploy-network, capped", () => {
        const result = burnIn();

        expect(result.status, result.stderr).toBe(0);

        const k6 = box
          .calls("docker")
          .find((call) => call.includes("grafana/k6"))!;

        expect(k6).toContain("--cpus 0.5 --memory 256m");
        expect(k6).toContain("--network dokploy-network");
        expect(k6).toContain("--add-host api-staging.intrajetto.com:10.0.1.5");
        expect(k6).toContain(
          "-e ROLLING_BASE_URL=https://api-staging.intrajetto.com",
        );
        expect(k6).toContain("-e ROLLING_RATE=20");

        // The password reaches the fixture by name, never on a command line.
        const fixture = box
          .calls("docker")
          .find((call) => call.includes("node --input-type=module"))!;

        expect(fixture).toContain("-e FIXTURE_ADMIN_PASSWORD ");
        expect(dockerCalls()).not.toContain("secret-of-the-test");
      });

      it("measures production's readiness through the host's own Traefik", () => {
        burnIn();

        const probe = box.calls("curl")[0];

        expect(probe).toContain("--resolve api.intrajetto.com:443:127.0.0.1");
        expect(probe).toContain("https://api.intrajetto.com/health/readiness");
      });

      it("stops when the fixture refuses", () => {
        box.file("fixture-status", "2\n");

        const result = burnIn();

        expect(result.status).toBe(2);
        expect(dockerCalls()).not.toContain("grafana/k6");
      });

      it("fails when the load saw a 5xx", () => {
        box.file("k6-status", "99\n");

        const result = burnIn();

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("REPROVADO");
      });
    });

    describe("the probes abort everything", () => {
      it("when production's readiness passes twice the base", () => {
        box.file("curl-mode", "slow\n");

        const result = burnIn();

        expect(result.status).toBe(3);
        expect(result.stderr).toContain(
          "ABORTADO: a readiness da produção subiu",
        );
        expect(
          box.calls("docker").some((call) => call.startsWith("docker stop")),
        ).toBe(true);
      });

      it("when production's readiness fails three times", () => {
        box.file("curl-mode", "fail\n");

        const result = burnIn();

        expect(result.status).toBe(3);
        expect(result.stderr).toContain("falhou 3 vezes");
      });

      it("when the host's iowait passes 20%", () => {
        box.file(
          "vmstat.txt",
          VMSTAT_CALM.replace(/ 6 {2}2 89 {2}3 {2}0\n$/, " 6  2 59 35  0\n"),
        );

        const result = burnIn();

        expect(result.status).toBe(3);
        expect(result.stderr).toContain("iowait do host em 35%");
      });

      it("when the host's steal passes 10%", () => {
        box.file(
          "vmstat.txt",
          VMSTAT_CALM.replace(/ 6 {2}2 89 {2}3 {2}0\n$/, " 6  2 77  3 12\n"),
        );

        const result = burnIn();

        expect(result.status).toBe(3);
        expect(result.stderr).toContain("steal do host em 12%");
      });

      it("but not on the since-boot line vmstat prints first", () => {
        box.file(
          "vmstat.txt",
          VMSTAT_CALM.replace(/ 5 {2}2 90 {2}3 {2}0\n/, " 5  2 40 55  0\n"),
        );

        expect(burnIn().status).toBe(0);
      });

      it("refuses to start when production already fails before the load", () => {
        box.stub("curl", "printf '503 0.004'");

        const result = burnIn();

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("já falha antes da carga");
        expect(dockerCalls()).not.toContain("grafana/k6");
      });
    });
  },
);
