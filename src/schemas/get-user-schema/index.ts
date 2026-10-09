import { z } from "zod";
import { EnumUserRole } from "@/modules/user/dtos/user-dto";

const profileAccessSchema = z
  .object({
    name: z.string(),
    permissions: z.array(
      z.object({
        id: z.string(),
        permissionKey: z.string(),
        action: z.string(),
        canRead: z.boolean(),
        canWrite: z.boolean(),
      }),
    ),
  })
  .nullable()
  .optional();

const driverSchema = z
  .object({
    id: z.string(),
    status: z.string(),
  })
  .nullable()
  .optional();

const getUserSchema = z.object({
  id: z.string(),
  role: z.nativeEnum(EnumUserRole),
  // A response, not an input: the address was validated when it was written.
  // Re-validating here turned one legacy value into a 500 on /user/me.
  email: z.string(),
  two_factor_enabled: z.boolean().optional(),
  email_notifications_enabled: z.boolean().optional(),
  activity_notifications_enabled: z.boolean().optional(),
  access_revoked: z.boolean(),
  name: z.string(),
  avatar: z.string().nullable().optional(),
  businessId: z.string().nullable().optional(),
  profileAccessId: z.string().nullable().optional(),
  driverId: z.string().nullable().optional(),
  driver: driverSchema,
  profileAccess: profileAccessSchema,
  /**
   * Sellable modules the session may use. Always present so the client can
   * enforce the gate without a nullable "unknown" state to reason about.
   */
  enabledModules: z.array(z.string()).default([]),
  /**
   * Decision 14.2: whether the app runs the offline pre-check of receipt and
   * odometer photos. Optional so a response without it reads as "off".
   */
  ai: z
    .object({
      precheck: z.boolean(),
      reason: z.enum(["not_contracted", "quota_exhausted", "unavailable"]).nullable(),
    })
    .optional()
    .describe(
      "Pré-checagem offline no celular (decisão 14.2): `precheck` liga a leitura no aparelho; ela só vale com a leitura automática contratada, ligada no servidor e com saldo no período. `reason` diz por que está desligada (só para diagnóstico).",
    ),
});

export { getUserSchema };
