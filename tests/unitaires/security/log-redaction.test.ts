import { describe, expect, it } from "vitest";

import type { FastifyRequest } from "fastify";

import { requestLogSerializer } from "@/shared/logging/request-log-serializer";

/**
 * What a request line writes about WHERE the request went (OBS-05, GAP4-10).
 *
 * Fastify's serializer wrote `req.url` whole: query string and path included.
 * The password reset (`?token=`, valid for an hour), the e-mail confirmation
 * (`?token=`) and the recipient's tracking and receipt links (`/:token`, the
 * tracking one never expires) all travel in the URL, so every one of them was
 * in stdout — and from there in Dokploy's log viewer and in any aggregator —
 * before the handler even ran. Anybody reading the logs within the hour could
 * reset a MASTER's password.
 *
 * The line now carries the route PATTERN (`/public/track/:token`), which is
 * also what groups well; a path no route matched has its query dropped and
 * any long segment replaced, since a mistyped link still carries its token.
 */
const RESET_TOKEN = "7f3c2a10-1111-4222-8333-944445555666";
const TRACK_TOKEN = "ab".repeat(32);

function fakeRequest(url: string, routeUrl?: string): FastifyRequest {
  return {
    method: "GET",
    url,
    routeOptions: { url: routeUrl },
    headers: {},
    host: "api.trajetto.test",
    socket: { remoteAddress: "10.0.0.2", remotePort: 51234 },
  } as unknown as FastifyRequest;
}

describe("the request line of a matched route", () => {
  it("names the route pattern, never the query string", () => {
    const line = requestLogSerializer(
      fakeRequest(
        `/user/forgot-verification?token=${RESET_TOKEN}`,
        "/user/forgot-verification",
      ),
    );

    expect(JSON.stringify(line)).not.toContain(RESET_TOKEN);
    expect(line.url).toBe("/user/forgot-verification");
  });

  it("names the route pattern, never the token in the path", () => {
    const line = requestLogSerializer(
      fakeRequest(`/public/track/${TRACK_TOKEN}`, "/public/track/:token"),
    );

    expect(JSON.stringify(line)).not.toContain(TRACK_TOKEN);
    expect(line.url).toBe("/public/track/:token");
  });
});

describe("the request line of a path no route matched", () => {
  it("drops the query and blanks every segment long enough to be a secret", () => {
    const line = requestLogSerializer(
      fakeRequest(`/public/trak/${TRACK_TOKEN}?token=${RESET_TOKEN}`),
    );

    expect(JSON.stringify(line)).not.toContain(TRACK_TOKEN);
    expect(JSON.stringify(line)).not.toContain(RESET_TOKEN);
    expect(line.url).toBe("/public/trak/:redacted");
  });

  it("keeps short segments, which are what makes a 404 readable", () => {
    const line = requestLogSerializer(fakeRequest("/vehicle/listar?page=2"));

    expect(line.url).toBe("/vehicle/listar");
  });

  it("blanks an id-shaped segment too — a reset link pasted as a path is still a reset link", () => {
    const line = requestLogSerializer(fakeRequest(`/user/${RESET_TOKEN}`));

    expect(line.url).toBe("/user/:redacted");
  });
});

describe("the rest of the line", () => {
  it("keeps the fields Fastify's own serializer wrote", () => {
    const line = requestLogSerializer(fakeRequest("/health", "/health"));

    expect(line).toMatchObject({
      method: "GET",
      host: "api.trajetto.test",
      remotePort: 51234,
    });
    expect(line.remoteAddress).toBeTruthy();
  });
});
