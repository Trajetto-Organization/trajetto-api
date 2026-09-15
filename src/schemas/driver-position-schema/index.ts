import { z } from "zod";

import { MAX_PINGS_PER_BATCH } from "@/shared/route/driver-position-rules";

/**
 * What the app flushes.
 *
 * Deliberately permissive about the CONTENT of a ping and strict only about
 * its shape: the app is offline-first and resends, so refusing a batch because
 * one point has a bad accuracy reading would have the phone retry the same bad
 * point forever. `acceptPings` decides what is usable, one point at a time.
 *
 * No driverId. It comes from the session, always — a body-supplied one on this
 * route would let any phone write anybody's trail, and the trail is what a
 * dispute is settled with.
 */
const pingSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),

  accuracy: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),

  battery: z.number().nullable().optional(),

  recorded_at: z
    .string({ required_error: "Cada ponto precisa da hora em que foi medido." })
    .datetime({ message: "A hora do ponto deve ser uma data ISO 8601." }),
});

const recordDriverPositionsSchema = z.object({
  pings: z
    .array(pingSchema)
    .min(1, "Envie ao menos um ponto.")
    .max(
      MAX_PINGS_PER_BATCH,
      `Envie no máximo ${MAX_PINGS_PER_BATCH} pontos por vez.`,
    ),
});

const controlTowerSchema = z.object({
  businessId: z.string().uuid("ID da empresa é inválido.").optional(),
});

const driverTrailParamSchema = z.object({
  driverId: z.string().uuid("ID do motorista é inválido."),
});

const driverTrailQuerySchema = z.object({
  businessId: z.string().uuid("ID da empresa é inválido.").optional(),

  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "A data deve estar no formato AAAA-MM-DD.")
    .optional(),
});

export {
  controlTowerSchema,
  driverTrailParamSchema,
  driverTrailQuerySchema,
  recordDriverPositionsSchema,
};
