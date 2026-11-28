import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HTTP_MAX_REQUESTS_PER_SOCKET_DEFAULT } from "@/config/http-server";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The rolling rehearsal (tests/load/swarm-rolling.sh, plano-escala LOAD-06)
 * is only worth its verdict if the service it rolls is the one Dokploy
 * runs: start-first with rollback, one replica at a time, a 30 s monitor,
 * the 40 s Stop Grace Period and the image's liveness healthcheck. Those
 * live as JSON in docs/deploy.md §7.7 (the guide the owner pastes into the
 * Swarm Settings) and as HEALTHCHECK in the Dockerfile; a rehearsal with
 * flags of its own would pass against a service nobody runs.
 *
 * It also must never run where it could do harm: a node already in a Swarm
 * with services is what a Dokploy server looks like, production's included.
 *
 * Executed for real, with docker, npx and sleep replaced by stubs; the run
 * against a real Swarm is the script's own job (tests/load/README.md).
 */
const ROOT = process.cwd();
const SCRIPT = repoFile("tests", "load", "swarm-rolling.sh");
const bash = hasShell("bash");

const read = (...path: string[]) =>
  readFileSync(resolve(ROOT, ...path), "utf8").replace(/\r\n/g, "\n");

/** The text of docs/deploy.md §7.7, the API Application. */
function apiSection(): string {
  const deploy = read("docs", "deploy.md");
  const start = deploy.indexOf("### 7.7 `trajetto-api` (Application)");
  const end = deploy.indexOf("\n### ", start + 1);

  expect(start).toBeGreaterThan(0);

  return deploy.slice(start, end);
}

/** The first ```json block after `label` in §7.7. */
function guideBlock(label: string): Record<string, unknown> {
  const section = apiSection();
  const at = section.indexOf(label);

  expect(at, label).toBeGreaterThan(0);

  const json = section.slice(at).match(/```json\n([\s\S]*?)```/)?.[1];

  expect(json, label).toBeTruthy();

  return JSON.parse(json!.replace(/^\s+/gm, "")) as Record<string, unknown>;
}

/** Docker's nanoseconds as the CLI's duration: 5000000000 → "5s". */
const seconds = (ns: unknown) => `${Number(ns) / 1e9}s`;

const PREFIX = "t-rolling";

/**
 * Answers what the script asks Docker. State lives in files of the sandbox:
 * swarm-state, services, replicas, k6-status, exit-<container> and
 * count-<container>.
 */
function dockerStub(root: string): string {
  return `
root="${root}"
for last; do :; done
case "$1" in
  info)
    case "$*" in
      *LocalNodeState*) cat "$root/swarm-state" ;;
      *ControlAvailable*) cat "$root/control" 2>/dev/null || echo true ;;
    esac ;;
  image) exit 0 ;;
  network)
    [ "$2" = inspect ] && { [ -f "$root/gwbridge" ] && exit 0; exit 1; }
    exit 0 ;;
  config)
    [ "$2" = create ] && cat > "$root/routes.yml"
    exit 0 ;;
  service)
    case "$2" in
      ls) cat "$root/services" 2>/dev/null ;;
      inspect) cat "$root/update-state" 2>/dev/null || echo completed ;;
      update)
        next=""
        for arg in "$@"; do
          [ "$next" = 1 ] && { echo "$arg" > "$root/replicas"; next=""; }
          [ "$arg" = --replicas ] && next=1
        done ;;
    esac
    exit 0 ;;
  ps)
    case "$*" in
      *-aq*) exit 0 ;;
      *service.name=${PREFIX}-api*)
        n=$(cat "$root/replicas" 2>/dev/null || echo 3)
        i=1
        while [ "$i" -le "$n" ]; do echo "c$i"; i=$((i + 1)); done ;;
      *) echo "x1" ;;
    esac ;;
  exec)
    case "$*" in *redis-cli*) echo PONG ;; esac
    exit 0 ;;
  inspect)
    case "$*" in
      *Health*) echo healthy ;;
      *ExitCode*) cat "$root/exit-$last" 2>/dev/null || echo 0 ;;
    esac ;;
  logs)
    case "$*" in
      *--since*)
        n=$(cat "$root/count-$last" 2>/dev/null || echo 0)
        i=0
        while [ "$i" -lt "$n" ]; do echo '{"msg":"request completed"}'; i=$((i + 1)); done ;;
      *) [ -f "$root/killed-$last" ] || echo '{"durationMs":4210,"msg":"shutdown complete"}' ;;
    esac ;;
  run)
    case "$*" in
      *k6*) cat > /dev/null; exit "$(cat "$root/k6-status" 2>/dev/null || echo 0)" ;;
    esac
    exit 0 ;;
esac
exit 0
`;
}

describe.skipIf(!bash)(
  "swarm-rolling.sh (LOAD-06)",
  { timeout: 60_000 },
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      box.file("swarm-state", "inactive\n");
      box.stub("docker", dockerStub(box.root));
      box.stub(
        "npx",
        `printf '%s' '{"businessId":"b","managerTokens":["m"],"driverTokens":["d"]}' > "$LOAD_CONTEXT_OUT"`,
      );
      box.stub("sleep", "exit 0");
    });

    afterEach(() => box.dispose());

    const rehearse = (env: Record<string, string> = {}) =>
      run("bash", SCRIPT, [], {
        bin: box.bin,
        env: {
          ROLLING_PREFIX: PREFIX,
          ROLLING_IMAGE: "trajetto-api:test",
          ROLLING_MIGRATE_IMAGE: "trajetto-api-migrate:test",
          ROLLING_STEPS: "",
          ROLLING_BALANCE_WINDOW: "0",
          TMPDIR: box.root,
          ...env,
        },
      });

    const apiCreate = () => {
      const call = box
        .calls("docker")
        .find((line) =>
          /^docker service create .*--name t-rolling-api /.test(line),
        );

      expect(call).toBeTruthy();

      return call!;
    };

    const flag = (call: string, name: string) =>
      call.match(new RegExp(`${name} (\\S+)`))?.[1];

    describe("where it refuses to run", () => {
      it("refuses a node already in a Swarm with services, touching nothing", () => {
        box.file("swarm-state", "active\n");
        box.file("services", "abc123\n");

        const result = rehearse();

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("já está num Swarm com serviços");

        const calls = box.calls("docker").join("\n");

        expect(calls).not.toMatch(/service create|swarm init|swarm leave/);
        expect(calls).not.toMatch(/network create|service rm/);
      });

      it("refuses a worker node", () => {
        box.file("swarm-state", "active\n");
        box.file("control", "false\n");

        const result = rehearse();

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("worker");
      });

      it("refuses without the images to roll", () => {
        const result = rehearse({ ROLLING_IMAGE: "" });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain("ROLLING_IMAGE");
        expect(box.calls("docker").join("\n")).not.toContain("swarm init");
      });
    });

    describe("the service it rolls is the one the guide configures", () => {
      it("creates the API with the Update, Rollback and Restart config of §7.7", () => {
        expect(rehearse().status).toBe(0);

        const call = apiCreate();
        const update = guideBlock("_Update Config_ (uma réplica por vez");
        const rollback = guideBlock("_Rollback Config_");
        const restart = guideBlock("_Restart Policy_");

        expect(flag(call, "--update-parallelism")).toBe(
          String(update.Parallelism),
        );
        expect(flag(call, "--update-delay")).toBe(seconds(update.Delay));
        expect(flag(call, "--update-failure-action")).toBe(
          update.FailureAction,
        );
        expect(flag(call, "--update-monitor")).toBe(seconds(update.Monitor));
        expect(flag(call, "--update-order")).toBe(update.Order);

        expect(flag(call, "--rollback-parallelism")).toBe(
          String(rollback.Parallelism),
        );
        expect(flag(call, "--rollback-delay")).toBe(seconds(rollback.Delay));
        expect(flag(call, "--rollback-monitor")).toBe(
          seconds(rollback.Monitor),
        );
        expect(flag(call, "--rollback-order")).toBe(rollback.Order);

        expect(flag(call, "--restart-condition")).toBe(restart.Condition);
        expect(flag(call, "--restart-delay")).toBe(seconds(restart.Delay));
        expect(flag(call, "--restart-max-attempts")).toBe(
          String(restart.MaxAttempts),
        );
        expect(flag(call, "--replicas")).toBe("3");
      });

      it("gives it the guide's Stop Grace Period, and the API the same deadline", () => {
        expect(rehearse().status).toBe(0);

        const grace = apiSection().match(
          /_Stop Grace Period_ \(se existir na sua versão\): `(\d+)`/,
        )?.[1];

        expect(grace).toBeTruthy();
        expect(flag(apiCreate(), "--stop-grace-period")).toBe(seconds(grace));
        expect(apiCreate()).toContain(
          `-e STOP_GRACE_PERIOD_MS=${Number(grace) / 1e6} `,
        );
      });

      it("rehearses Dokploy without the field when asked: 10 s and the default plan", () => {
        expect(rehearse({ ROLLING_STOP_GRACE: "10s" }).status).toBe(0);

        expect(flag(apiCreate(), "--stop-grace-period")).toBe("10s");
        expect(apiCreate()).toContain("-e STOP_GRACE_PERIOD_MS=10000 ");
      });

      it("keeps the image's healthcheck, which runs the guide's test", () => {
        expect(rehearse().status).toBe(0);

        // No override: what the Swarm waits for is the HEALTHCHECK baked in.
        expect(apiCreate()).not.toMatch(/--health-|--no-healthcheck/);

        const dockerfile = read("Dockerfile");
        const healthcheck = dockerfile.match(
          /HEALTHCHECK (--interval=\S+) (--timeout=\S+) (--start-period=\S+) --retries=\d+ \\\n\s+CMD (.*liveness)\n/,
        );

        expect(healthcheck).toBeTruthy();

        const guide = guideBlock("_Health Check_ — **liveness**");

        expect(healthcheck![4]).toBe(
          (guide.Test as string[]).slice(1).join(" "),
        );
        expect(healthcheck![1]).toBe(`--interval=${seconds(guide.Interval)}`);
        expect(healthcheck![2]).toBe(`--timeout=${seconds(guide.Timeout)}`);
        expect(healthcheck![3]).toBe(
          `--start-period=${seconds(guide.StartPeriod)}`,
        );
        // Retries differ on purpose (image 3, guide 5): the rehearsal gives up
        // on a sick replica sooner than production, never later.
      });

      it("gives the replicas an environment the production schema accepts", () => {
        expect(rehearse().status).toBe(0);

        const env = Object.fromEntries(
          [...apiCreate().matchAll(/ -e (\w+)=(\S*)/g)].map((m) => [
            m[1],
            m[2],
          ]),
        );

        expect(env.NODE_ENV).toBe("production");
        expect(env.WORKERS_ENABLED).toBe("true");

        const parsed = envSchema.safeParse(definedEnv(env));

        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      });

      /**
       * The scale question is about the configuration that ships. The
       * replicas ran with 100 requests per connection, not production's
       * 1000, so "max/avg 1.00" said nothing about the default, and a
       * regression that only shows at the shipped value would pass. Now the
       * variable is left unset, as on the Dokploy Application, and the
       * window is sized for that cap instead.
       */
      it("runs the replicas with production's cap: the variable unset, as on the Application", () => {
        expect(rehearse().status).toBe(0);
        expect(apiCreate()).not.toContain("HTTP_MAX_REQUESTS_PER_SOCKET");

        // The figure the script sizes the window with is the image's own.
        expect(read("tests", "load", "swarm-rolling.sh")).toContain(
          `PRODUCTION_SOCKET_REQUESTS=${HTTP_MAX_REQUESTS_PER_SOCKET_DEFAULT}\n`,
        );
      });

      it("measures the spread over at least 60 connection renewals at that cap: 1200 s at 50 req/s", () => {
        // 15 renewals (the old 5-minute window at 1000 per connection)
        // measured how they fell, 1.48 with the cap working.
        for (let id = 1; id <= 6; id += 1) box.file(`count-c${id}`, "500\n");

        const result = rehearse({
          ROLLING_STEPS: "scale",
          ROLLING_BALANCE_WINDOW: "",
        });

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain("em 1200 s");
        expect(result.stdout).toContain("o da produção");

        const k6 = box
          .calls("docker")
          .find((line) => line.includes("--name t-rolling-k6-scale "));

        // 20 s before the scale, 180 s to turn healthy, the window, 20 s.
        expect(k6).toContain("-e ROLLING_DURATION=1420s ");
      });

      it("takes a smaller cap by hand as a check of the mechanism only, and says so", () => {
        for (let id = 1; id <= 6; id += 1) box.file(`count-c${id}`, "500\n");

        const result = rehearse({
          ROLLING_STEPS: "scale",
          ROLLING_BALANCE_WINDOW: "",
          ROLLING_MAX_REQUESTS_PER_SOCKET: "100",
        });

        expect(result.status, result.stdout).toBe(0);
        expect(apiCreate()).toContain("-e HTTP_MAX_REQUESTS_PER_SOCKET=100 ");
        expect(result.stdout).toContain("em 300 s");
        expect(result.stdout).toContain(
          "não o da produção (1000): só o mecanismo",
        );
      });

      it("routes Traefik to the service's virtual address, as Dokploy writes it", () => {
        expect(rehearse().status).toBe(0);

        const routes = readFileSync(`${box.root}/routes.yml`, "utf8");

        expect(routes).toContain(`- url: "http://${PREFIX}-api:3333"`);
        expect(routes).toContain("passHostHeader: true");

        // The harness's pins, so both benches run the same edge and generator.
        const compose = read("tests", "load", "compose.load.yaml");
        const script = read("tests", "load", "swarm-rolling.sh");

        for (const image of [
          /traefik:v[\d.]+@sha256:\w+/,
          /grafana\/k6:[\d.]+@sha256:\w+/,
        ]) {
          expect(script.match(image)?.[0]).toBe(compose.match(image)?.[0]);
        }
      });

      it("never asks a registry for the local image", () => {
        expect(rehearse().status).toBe(0);

        for (const call of box.calls("docker")) {
          if (/^docker service (create|update)/.test(call)) {
            expect(call).toContain("--no-resolve-image");
          }
        }
      });
    });

    describe("it leaves the machine as it found it", () => {
      it("leaves the Swarm, and the bridge init made, only when it created them", () => {
        expect(rehearse().status).toBe(0);

        const calls = box.calls("docker").join("\n");

        expect(calls).toContain(
          "docker swarm init --advertise-addr 127.0.0.1 --listen-addr 127.0.0.1:2377",
        );
        expect(calls).toContain("docker swarm leave --force");
        expect(calls).toContain("docker network rm docker_gwbridge");

        for (const service of ["api", "edge", "redis", "pg"]) {
          expect(calls).toContain(`docker service rm ${PREFIX}-${service}`);
        }
        expect(calls).toContain(`docker config rm ${PREFIX}-edge-routes`);
        expect(calls).toContain(`docker network rm ${PREFIX}-net`);
      });

      it("uses an empty Swarm it was given and does not leave it", () => {
        box.file("swarm-state", "active\n");
        box.file("gwbridge", "");

        expect(rehearse().status).toBe(0);

        const calls = box.calls("docker").join("\n");

        expect(calls).not.toContain("swarm init");
        expect(calls).not.toContain("swarm leave");
        expect(calls).not.toContain("network rm docker_gwbridge");
      });
    });

    describe("the verdicts", () => {
      it("passes a rolling with no 5xx and every old replica shut down cleanly", () => {
        const result = rehearse({ ROLLING_STEPS: "rolling" });

        expect(result.status, result.stdout).toBe(0);
        expect(box.calls("docker").join("\n")).toContain(
          `docker service update --detach --force ${PREFIX}-api`,
        );
        expect(result.stdout).toContain("desligamento 4210 ms");
      });

      it("fails a rolling when the load saw a 5xx", () => {
        box.file("k6-status", "99\n");

        const result = rehearse({ ROLLING_STEPS: "rolling" });

        expect(result.status).toBe(1);
        expect(result.stdout).toContain("a carga (rolling) reprovou");
      });

      it("fails a rolling when a replica was killed at the end of the grace", () => {
        box.file("exit-c2", "137\n");
        box.file("killed-c2", "");

        const result = rehearse({ ROLLING_STEPS: "rolling" });

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          "a réplica c2 não terminou o desligamento dentro do grace de 40s",
        );
      });

      it("fails a rolling the Swarm rolled back", () => {
        box.file("update-state", "rollback_completed\n");

        const result = rehearse({ ROLLING_STEPS: "rolling" });

        expect(result.status).toBe(1);
        expect(result.stdout).toContain("rollback_completed");
      });

      it("fails the scale when the new replicas sit idle", () => {
        for (const id of ["c1", "c2", "c3"]) box.file(`count-${id}`, "900\n");

        const result = rehearse({ ROLLING_STEPS: "scale" });

        expect(result.status).toBe(1);
        expect(result.stdout).toContain("não se espalhou");
        expect(box.calls("docker").join("\n")).toContain(
          `docker service update --detach --replicas 6 ${PREFIX}-api`,
        );
      });

      it("fails the scale above 1.3 times the average, passes within it", () => {
        const counts = (values: number[]) =>
          values.forEach((value, index) =>
            box.file(`count-c${index + 1}`, `${value}\n`),
          );

        counts([700, 500, 500, 400, 400, 500]);
        expect(rehearse({ ROLLING_STEPS: "scale" }).stdout).toContain(
          "máximo/média = 1.40",
        );

        counts([520, 500, 480, 510, 490, 500]);
        // The first run scaled the stub to 6; the second starts from 3 again.
        box.file("replicas", "3\n");

        const result = rehearse({ ROLLING_STEPS: "scale" });

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain("máximo/média = 1.04");
      });
    });
  },
);

describe("rolling.js (LOAD-06)", () => {
  const source = read("tests", "load", "rolling.js");

  it("judges a rolling by zero 5xx and zero unanswered requests, never a rate", () => {
    expect(source).toContain('rolling_5xx: ["count==0"]');
    expect(source).toContain('rolling_transport_errors: ["count==0"]');
  });

  it("is self-contained, so it runs from stdin on a host without the repository", () => {
    expect(source).not.toMatch(/\bopen\(/);
    expect(source).not.toMatch(/from "\.\//);
    expect(source).toContain("__ENV.ROLLING_CONTEXT_JSON");
  });

  it("defaults to the 50 req/s the plan rehearses", () => {
    expect(source).toContain("Number(__ENV.ROLLING_RATE || 50)");
  });
});
