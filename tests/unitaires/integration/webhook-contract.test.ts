import { describe, expect, it } from "vitest";

import {
  ALL_TOPICS,
  DOCUMENT_TOPICS,
  ROUTE_TOPICS,
  TOPIC_DESCRIPTIONS,
  TOPIC_FAMILY,
  endpointWantsTopic,
  isWebhookTopic,
  topicMatches,
} from "@/shared/integration/webhook-catalogue";

import {
  SIGNATURE_TOLERANCE_SECONDS,
  newWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
} from "@/shared/integration/webhook-signature";

import {
  API_SCOPES,
  apiKeySecretMatches,
  generateApiKey,
  hasScope,
  isApiScope,
  parseApiKey,
} from "@/shared/integration/api-key-rules";

/**
 * The contract we publish, and the two pieces of cryptography holding it up.
 *
 * Everything here is a promise to somebody else's engineering team. A topic
 * renamed is an integration broken in production at a customer we cannot
 * deploy for; a signature scheme with a replay hole is a way for anybody who
 * once saw a valid call to keep making them forever.
 */
describe("the catalogue we publish", () => {
  it("has exactly two families, and every topic is in one", () => {
    // Two and not twenty. A topic per internal state change would be a
    // catalogue nobody can implement against — and every one of them a promise
    // we could never change again.
    expect(ALL_TOPICS).toHaveLength(
      ROUTE_TOPICS.length + DOCUMENT_TOPICS.length,
    );

    for (const topic of ALL_TOPICS) {
      expect(["route", "document"], topic).toContain(TOPIC_FAMILY[topic]);
    }
  });

  it("describes every topic, because the docs are generated from this", () => {
    for (const topic of ALL_TOPICS) {
      expect(TOPIC_DESCRIPTIONS[topic], topic).toBeTruthy();
      expect(TOPIC_DESCRIPTIONS[topic].length, topic).toBeGreaterThan(15);
    }
  });

  it("refuses a name that is not in the catalogue", () => {
    // A subscription to a topic that does not exist is a customer waiting
    // forever for an event nobody will ever send.
    expect(isWebhookTopic("delivery.delivered")).toBe(true);

    expect(isWebhookTopic("delivery.exploded")).toBe(false);
    expect(isWebhookTopic("")).toBe(false);
  });

  it("names topics in families, so a wildcard has something to mean", () => {
    for (const topic of ALL_TOPICS) {
      expect(topic, topic).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });
});

describe("what a subscription matches", () => {
  it("matches an exact name", () => {
    expect(topicMatches("delivery.delivered", "delivery.delivered")).toBe(true);
    expect(topicMatches("delivery.delivered", "delivery.failed")).toBe(false);
  });

  it("matches one family with a wildcard", () => {
    // An ERP that wants every document event should not be redeployed when we
    // add a status.
    expect(topicMatches("delivery.*", "delivery.failed")).toBe(true);
    expect(topicMatches("delivery.*", "route.started")).toBe(false);
  });

  it("does not let a bare star subscribe to everything", () => {
    // `*` would subscribe somebody to topics that did not exist when they
    // agreed to receive them.
    expect(topicMatches("*", "delivery.delivered")).toBe(false);
  });

  it("answers for a whole endpoint's subscriptions", () => {
    const subscriptions = ["route.started", "delivery.*"];

    expect(endpointWantsTopic(subscriptions, "delivery.failed")).toBe(true);
    expect(endpointWantsTopic(subscriptions, "route.started")).toBe(true);

    expect(endpointWantsTopic(subscriptions, "route.cancelled")).toBe(false);
    expect(endpointWantsTopic([], "delivery.delivered")).toBe(false);
  });
});

describe("proving a call came from us", () => {
  const secret = newWebhookSecret();
  const body = JSON.stringify({ topic: "delivery.delivered", id: "abc" });

  it("verifies its own signature", () => {
    const signed = signWebhookPayload(secret, body);

    expect(
      verifyWebhookSignature({ secret, body, header: signed.header }),
    ).toBe(true);
  });

  it("refuses a body that changed by one character", () => {
    const signed = signWebhookPayload(secret, body);

    expect(
      verifyWebhookSignature({
        secret,
        body: body.replace("abc", "abd"),
        header: signed.header,
      }),
    ).toBe(false);
  });

  it("refuses a signature made with another secret", () => {
    const signed = signWebhookPayload(newWebhookSecret(), body);

    expect(
      verifyWebhookSignature({ secret, body, header: signed.header }),
    ).toBe(false);
  });

  it("refuses a replay from outside the window", () => {
    // The whole reason the timestamp is inside the signed material. Without
    // it, anybody who once saw a valid call can repeat it forever.
    const old = new Date(
      Date.now() - (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000,
    );

    const signed = signWebhookPayload(secret, body, old);

    expect(
      verifyWebhookSignature({ secret, body, header: signed.header }),
    ).toBe(false);
  });

  it("accepts a call that is merely slow", () => {
    const recent = new Date(
      Date.now() - (SIGNATURE_TOLERANCE_SECONDS - 30) * 1000,
    );

    const signed = signWebhookPayload(secret, body, recent);

    expect(
      verifyWebhookSignature({ secret, body, header: signed.header }),
    ).toBe(true);
  });

  it("refuses a header that is not a header", () => {
    for (const header of ["", "garbage", "t=abc,v1=def", "v1=only"]) {
      expect(verifyWebhookSignature({ secret, body, header }), header).toBe(
        false,
      );
    }
  });

  it("carries the timestamp where a receiver can read it", () => {
    // The format every integrator already implemented for Stripe and GitHub.
    const signed = signWebhookPayload(secret, body);

    expect(signed.header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});

describe("the key an outside system uses", () => {
  it("never stores the secret half", () => {
    const key = generateApiKey();

    // The token is shown once; what is kept is a hash of the half after the
    // dot. A dump of the table must not hand the reader the operation.
    expect(key.token).toContain(key.prefix);
    expect(key.tokenHash).not.toContain(key.token.split(".")[1]);

    expect(key.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is recognisable in a log or a leaked file", () => {
    expect(generateApiKey().prefix.startsWith("tjk_live_")).toBe(true);
  });

  it("verifies a key it issued", () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.token);

    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe(key.prefix);

    expect(apiKeySecretMatches(parsed!.secret, key.tokenHash)).toBe(true);
  });

  it("refuses a secret that is one character off", () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.token)!;

    const tampered = `${parsed.secret.slice(0, -1)}${
      parsed.secret.endsWith("a") ? "b" : "a"
    }`;

    expect(apiKeySecretMatches(tampered, key.tokenHash)).toBe(false);
  });

  it("refuses anything that is not shaped like a key", () => {
    for (const token of [
      "",
      "garbage",
      "tjk_live_abc",
      "wrong_prefix.0123456789012345678901234567890123",
      "tjk_live_abc.short",
    ]) {
      expect(parseApiKey(token), token).toBeNull();
    }
  });
});

describe("what a key may do", () => {
  it("keeps read and write apart", () => {
    // Deliberately pedantic. A customer who granted write to a system that
    // only posts should not discover, after a leak, that it could also read
    // every delivery they have.
    expect(hasScope(["deliveries:write"], "deliveries:read")).toBe(false);
    expect(hasScope(["deliveries:read"], "deliveries:read")).toBe(true);
  });

  it("has no wildcard scope", () => {
    expect(hasScope(["*"], "deliveries:read")).toBe(false);
  });

  it("refuses a scope that does not exist", () => {
    for (const scope of API_SCOPES) {
      expect(isApiScope(scope), scope).toBe(true);
    }

    expect(isApiScope("deliveries:destroy")).toBe(false);
    expect(isApiScope("admin")).toBe(false);
  });
});
