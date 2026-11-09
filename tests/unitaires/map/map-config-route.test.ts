import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";
import {
  introspectRoutes,
  type IntrospectedRoute,
} from "../contract/support/introspect-routes";

import { env } from "@/env";
import {
  GetMapConfigController,
  MAP_CONFIG_CACHE_CONTROL,
} from "@/modules/config/usecases/get-map-config/get-map-config-controller";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { mapTileSettingsFrom, resolveMapTiles } from "@/shared/map/map-tiles";

/**
 * GET /config/map (wave 5) as it is wired: a session and nothing else (the
 * platform's provider is no company's data), a private, short cache (the URL
 * may carry the provider's key), and the published shape the app parses.
 * The HTTP path with a real session is in tests/E2E/config-map-http.test.ts.
 */
let route: IntrospectedRoute | undefined;
let close: () => Promise<void>;

beforeAll(async () => {
  const introspected = await introspectRoutes();

  route = introspected.routes.find((entry) => entry.id === "GET /config/map");
  close = introspected.close;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("GET /config/map", () => {
  it("asks for a session and adds no module, permission or role gate of its own", () => {
    expect(route).toBeDefined();
    expect(route!.onRequest).toContain(ensureAuthenticated);
    expect(route!.preHandler).toEqual([]);
    expect(route!.operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(route!.operation?.tags).toEqual(["config"]);
  });

  it("publishes the shape the app parses: tiles, nullable, with an optional dark style", () => {
    const schema = route!.operation?.responses["200"]?.content?.[
      "application/json"
    ]?.schema as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };

    expect(schema.required).toEqual(["tiles"]);

    const tiles = JSON.stringify(schema.properties.tiles);

    expect(tiles).toContain('"nullable":true');
    expect(tiles).toContain('"url"');
    expect(tiles).toContain('"attribution"');
    expect(tiles).toContain('"dark"');
  });

  it("answers the resolved tiles with a private, short cache", async () => {
    const reply = {
      header: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await new GetMapConfigController().handle(
      {} as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    expect(MAP_CONFIG_CACHE_CONTROL).toBe("private, max-age=300");
    expect(reply.header).toHaveBeenCalledWith(
      "Cache-Control",
      MAP_CONFIG_CACHE_CONTROL,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      tiles: resolveMapTiles(mapTileSettingsFrom(env)),
    });
  });
});
