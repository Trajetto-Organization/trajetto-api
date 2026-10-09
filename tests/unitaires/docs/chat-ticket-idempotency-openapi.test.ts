import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * POST /chat/tickets refuses a request without Idempotency-Key (400
 * IDEMPOTENCY_KEY_REQUIRED), but the document said the header was optional
 * ("Opcional: sem ela, cada envio cria um registro"). A client generated from
 * the document would leave it out and be refused every time.
 */
type Parameter = { in: string; name: string; required?: boolean; description?: string };
type Document = { paths: Record<string, Record<string, { parameters?: Parameter[] }>> };

let document: Document;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = app.swagger() as unknown as Document;
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const headerOf = (path: string, method: string) =>
  document.paths[path]?.[method]?.parameters?.find(
    (parameter) => parameter.in === "header" && parameter.name === "idempotency-key",
  );

describe("the Idempotency-Key of the chat writes", () => {
  it("is required where the route refuses a request without it", () => {
    const header = headerOf("/chat/tickets", "post");

    expect(header?.required).toBe(true);
    expect(header?.description).toContain("IDEMPOTENCY_KEY_REQUIRED");
    expect(header?.description).not.toMatch(/Opcional/);
  });

  it("stays optional on the writes that accept a request without it", () => {
    expect(headerOf("/chat/send-message", "post")?.required ?? false).toBe(false);
    expect(headerOf("/chat/tickets/{ticketId}/messages", "post")?.required ?? false).toBe(false);
  });
});
