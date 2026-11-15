import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { notificationPolicies } from "@/shared/notifications/notification-policy";
import { recipientsBesidesActor } from "@/shared/notifications/pipeline-rules";

import type {
  ActorNotice,
  NotificationPolicyEntry,
  NotificationTopic,
} from "@/shared/notifications/notification-types";

/**
 * Nobody is notified of what they just did (14/11/2026).
 *
 * The owner saw "success" twice for one save. Most of it was the dialogs
 * (the web's toast-once fixes), and the rest was this: an admin who created
 * a fine was among the admins the fine notifies, so the bell row's realtime
 * toast landed right after the form's own; the same for an order, a bill or
 * a card one assigns to oneself, and for the push of a route plan the driver
 * changed with their own report. The pipeline now leaves the event's actor
 * out of every topic but the few listed here, each with its reason.
 */

type AnyPolicy = NotificationPolicyEntry<unknown>;

const policies = Object.entries(notificationPolicies) as Array<
  [NotificationTopic, AnyPolicy]
>;

/**
 * The topics whose notice still reaches the person who caused it. Adding one
 * here is a product decision, not a fix for a red test: say why on the
 * policy (`notifiesActor`) and in docs/arquitetura.md.
 */
const NOTIFIES_ACTOR: Partial<Record<NotificationTopic, ActorNotice>> = {
  // The record of a privileged account the reader created or changed
  // (decision D-49 keeps these confirmations).
  "master-user.created": "security",
  "master-user.updated": "security",
  // About the reader's own account.
  "master-user.account-updated": "security",
  // The AI's reading of the receipt the driver sent, for that driver: the
  // event's actor is them, as the reading's requester.
  "delivery-proof.ai-flagged": "verdict",
};

const ACTOR = { id: "actor", name: "Quem fez" };
const COLLEAGUE = { id: "colleague", name: "Colega" };
const OTHER = { id: "other", name: "Outra pessoa" };

describe("recipientsBesidesActor", () => {
  it("leaves the actor out and keeps everybody else, in order", () => {
    expect(
      recipientsBesidesActor([COLLEAGUE, ACTOR, OTHER], ACTOR.id, undefined),
    ).toEqual([COLLEAGUE, OTHER]);
  });

  it("leaves them out however many times a policy listed them", () => {
    expect(
      recipientsBesidesActor([ACTOR, COLLEAGUE, ACTOR], ACTOR.id, undefined),
    ).toEqual([COLLEAGUE]);
  });

  it("leaves nobody when the actor was the only one (an order assigned to oneself)", () => {
    expect(recipientsBesidesActor([ACTOR], ACTOR.id, undefined)).toEqual([]);
  });

  it("keeps everybody when the actor is not among them", () => {
    const recipients = [COLLEAGUE, OTHER];

    expect(recipientsBesidesActor(recipients, ACTOR.id, undefined)).toEqual(
      recipients,
    );
  });

  it("keeps everybody when nobody acted (a sweep, a worker, an integration's key)", () => {
    expect(recipientsBesidesActor([ACTOR, COLLEAGUE], null, undefined)).toEqual(
      [ACTOR, COLLEAGUE],
    );
    expect(
      recipientsBesidesActor([ACTOR, COLLEAGUE], undefined, undefined),
    ).toEqual([ACTOR, COLLEAGUE]);
  });

  it.each<ActorNotice>(["security", "verdict"])(
    "keeps the actor on a topic that tells them (%s)",
    (reason) => {
      expect(recipientsBesidesActor([ACTOR, OTHER], ACTOR.id, reason)).toEqual([
        ACTOR,
        OTHER,
      ]);
    },
  );
});

describe("the catalogue", () => {
  it("tells the actor only on the listed topics, each with its reason", () => {
    const declared = Object.fromEntries(
      policies
        .filter(([, policy]) => policy.notifiesActor !== undefined)
        .map(([topic, policy]) => [topic, policy.notifiesActor]),
    );

    expect(declared).toEqual(NOTIFIES_ACTOR);
  });

  it.each(policies.map(([topic]) => topic))(
    "%s: an event that resolved its own actor reaches them only if listed",
    (topic) => {
      const policy = notificationPolicies[topic] as AnyPolicy;
      const reached = recipientsBesidesActor(
        [ACTOR, OTHER],
        ACTOR.id,
        policy.notifiesActor,
      ).map((recipient) => recipient.id);

      expect(reached.includes(ACTOR.id)).toBe(topic in NOTIFIES_ACTOR);
      expect(reached).toContain(OTHER.id);
    },
  );
});

/**
 * The rule needs the actor on the event: a publish without `actorId` leaves
 * whoever did it among the recipients. Read from the sources, so a new
 * publish site that forgets it fails here.
 */
const SRC = join(process.cwd(), "src");

/**
 * Publishes nobody's action causes, by file: the tower's unanswered request
 * escalated by the minute sweep, a route left open found by the hourly
 * sweep, and a customer's webhook endpoint switched off by our breaker.
 */
const WITHOUT_ACTOR = new Set([
  "modules/delivery/usecases/authorize-occurrence/escalate-occurrence-authorizations-usecase.ts",
  "modules/route/usecases/alert-routes-left-open/alert-routes-left-open-usecase.ts",
  "shared/integration/webhook-dispatch-service.ts",
]);

const PUBLISH_CALL =
  /(?:\boutbox\??|<OutboxService>\("OutboxService"\))\.(?:publish|publishAfterCommit|publishOnce|publishMerged)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return name.endsWith(".ts") ? [path] : [];
  });
}

/** The text from `open` (a bracket) to the bracket that closes it. */
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];

  for (let index = open; index < text.length; index += 1) {
    const char = text[index];

    if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack[stack.length - 1]) {
      stack.pop();

      if (stack.length === 0) return text.slice(open, index + 1);
    }
  }

  throw new Error("unbalanced publish call");
}

/**
 * The keys written at the top level of an object literal: what is nested
 * (the payload) is blanked first, so a payload's own `actorId` would not
 * count. Shorthand keys (`{ actorId }`) count too.
 */
function topLevelKeys(literal: string): string[] {
  let depth = 0;
  let top = "";

  for (const char of literal) {
    if ("({[".includes(char)) depth += 1;

    top += depth <= 1 ? char : " ";

    if (")}]".includes(char)) depth -= 1;
  }

  return [...top.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?=[:,}])/g)].map(
    (key) => key[1],
  );
}

interface PublishSite {
  file: string;
  line: number;
  keys: string[];
}

function publishSites(): PublishSite[] {
  const sites: PublishSite[] = [];

  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).replace(/\\/g, "/");

    // The outbox itself, forwarding its caller's input.
    if (file === "shared/notifications/outbox-service.ts") continue;

    const text = readFileSync(path, "utf8");

    for (const match of text.matchAll(PUBLISH_CALL)) {
      const call = balanced(text, match.index! + match[0].length - 1);
      const objectStart = call.indexOf("{");

      sites.push({
        file,
        line: text.slice(0, match.index).split("\n").length,
        keys:
          objectStart === -1 ? [] : topLevelKeys(balanced(call, objectStart)),
      });
    }
  }

  return sites;
}

describe("every publish a person causes", () => {
  const sites = publishSites();

  it("finds the publish sites it checks", () => {
    // Fewer than this means the pattern stopped matching, not that the
    // product stopped notifying.
    expect(sites.length).toBeGreaterThanOrEqual(35);
    expect(sites.every((site) => site.keys.includes("topic"))).toBe(true);
  });

  it("carries the actor on the event", () => {
    const missing = sites
      .filter((site) => !WITHOUT_ACTOR.has(site.file))
      .filter((site) => !site.keys.includes("actorId"))
      .map((site) => `${site.file}:${site.line}`);

    expect(missing).toEqual([]);
  });

  it("lists only publishers that still publish without one", () => {
    for (const file of WITHOUT_ACTOR) {
      const own = sites.filter((site) => site.file === file);

      expect(own.length, file).toBeGreaterThan(0);
      expect(
        own.some((site) => !site.keys.includes("actorId")),
        file,
      ).toBe(true);
    }
  });
});
