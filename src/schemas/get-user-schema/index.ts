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

const getUserSchema = z.object({
  id: z.string(),
  role: z.nativeEnum(EnumUserRole),
  email: z.string().email(),
  two_factor_enabled: z.boolean().optional(),
  email_notifications_enabled: z.boolean().optional(),
  activity_notifications_enabled: z.boolean().optional(),
  access_revoked: z.boolean(),
  name: z.string(),
  avatar: z.string().nullable().optional(),
  businessId: z.string().nullable().optional(),
  profileAccessId: z.string().nullable().optional(),
  driverId: z.string().nullable().optional(),
  profileAccess: profileAccessSchema,
});

export { getUserSchema };
