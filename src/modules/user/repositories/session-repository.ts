import database from "@/../infra/database";

import { Prisma } from "@prisma/client";

import { utcInstant } from "@/shared/database/utc-instant";
import { rememberRow } from "@/shared/http/request-context";

import type { User } from "../dtos/user-dto";

import type { ISessionRepository, SessionLookup } from "./ISession-repository";
import { userRequestKey } from "./user-repository";

/**
 * Every scalar column of the user model, in the model's order.
 *
 * findUserById's include reads them all, and the raw SELECT below reads
 * only what it names: a column added to the model and left out here would
 * be in the use case's user and missing from the middleware's. The unit
 * test holds this list to Prisma.UserScalarFieldEnum.
 */
const SESSION_USER_COLUMNS = [
  "id",
  "name",
  "email",
  "email_verified",
  "password",
  "avatar",
  "role",
  "businessId",
  "profileAccessId",
  "driverId",
  "two_factor_enabled",
  "access_revoked",
  "session_version",
  "failed_login_attempts",
  "failed_login_at",
  "login_locked_until",
  "must_change_password",
  "whatsapp_notifications_enabled",
  "whatsapp_phone",
  "email_notifications_enabled",
  "activity_notifications_enabled",
  "ops_alert_sound_enabled",
  "last_seen_at",
  "anonymized_at",
  "created_at",
  "updated_at",
] as const;

/**
 * The enum goes out as text: an explicit cast, so the value is a string
 * whatever the driver makes of a type it has no parser for.
 */
const CAST: Partial<Record<(typeof SESSION_USER_COLUMNS)[number], string>> = {
  role: "text",
};

const USER_SELECT = Prisma.raw(
  SESSION_USER_COLUMNS.map((column) =>
    CAST[column]
      ? `u."${column}"::${CAST[column]} AS "${column}"`
      : `u."${column}"`,
  ).join(", "),
);

type SessionRow = User & { hasActiveFamily: boolean };

/**
 * The session lookup in one statement (plano-escala F4-04): the user with
 * everything findUserById loads, and whether the refresh-token family is
 * still active, in one round trip.
 *
 * Today that is up to five statements on every authenticated request (the
 * user with its company and entitlements, the profile, the driver, the
 * branch, the family), paid before the request does any work of its own;
 * the 1M step's target of 6 ms of CPU per request starts here
 * (plano-escala.md, F4). Each relation is a LATERAL that finds nothing when
 * its key is null, so a master or a user without a driver costs nothing
 * more; the relations come back as `json`
 * (never `jsonb`, which reorders keys) with the shapes and key order of the
 * include: a missing relation is null, an empty list is [].
 *
 * What the include does not fix, this does: permissions by id and hired
 * modules by name (byte order, COLLATE "C"), where Prisma reads them in
 * whatever order the heap has them.
 *
 * `relationJoins` stays off: it is a Preview in Prisma 7 and, switched on,
 * changes every query with an include (docs/adr/0011-orm-prisma-6-7-8.md).
 * Parameters are cast to text because Prisma 7 binds raw parameters with no
 * type (the same ADR), and the expiry is compared with the app's clock, as
 * hasActiveRefreshTokenFamily compares it.
 *
 * The user is left in the request's memory under findUserById's key: the
 * use case of the same request asks for it again, and that read is half of
 * what this saves. Never across requests.
 */
class SessionRepository implements ISessionRepository {
  constructor(private prisma = database) {}

  async loadSession(userId: string, familyId: string): Promise<SessionLookup> {
    const rows = await this.prisma.$queryRaw<SessionRow[]>(Prisma.sql`
      SELECT
        ${USER_SELECT},
        b."business",
        pa."profileAccess",
        d."driver",
        EXISTS (
          SELECT 1
          FROM "refresh_token" t
          WHERE t."userId" = u."id"
            AND t."family_id" = ${familyId}::text
            AND t."revoked_at" IS NULL
            AND t."expires_in" > ${utcInstant(new Date())}
        ) AS "hasActiveFamily"
      FROM "user" u
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'is_active', bu."is_active",
          'entitlements', COALESCE((
            SELECT json_agg(
              json_build_object('module', e."module", 'enabled', e."enabled")
              ORDER BY e."module"::text COLLATE "C"
            )
            FROM "business_entitlement" e
            WHERE e."businessId" = bu."id"
          ), '[]'::json)
        ) AS "business"
        FROM "business" bu
        WHERE bu."id" = u."businessId"
      ) b ON true
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'name', p."name",
          'permissions', COALESCE((
            SELECT json_agg(
              json_build_object(
                'id', pe."id",
                'permissionKey', pe."permissionKey",
                'action', pe."action",
                'canRead', pe."canRead",
                'canWrite', pe."canWrite"
              )
              ORDER BY pe."id" COLLATE "C"
            )
            FROM "permission" pe
            WHERE pe."profileAccessId" = p."id"
          ), '[]'::json)
        ) AS "profileAccess"
        FROM "profile_access" p
        WHERE p."id" = u."profileAccessId"
      ) pa ON true
      LEFT JOIN LATERAL (
        SELECT json_build_object(
          'id', dr."id",
          'status', dr."status",
          'businessId', dr."businessId",
          'branchId', dr."branchId",
          'branch', (
            SELECT json_build_object('is_active', br."is_active")
            FROM "branch" br
            WHERE br."id" = dr."branchId"
          )
        ) AS "driver"
        FROM "driver" dr
        WHERE dr."id" = u."driverId"
      ) d ON true
      WHERE u."id" = ${userId}::text
    `);

    const row = rows[0];

    if (!row) {
      // findUserById remembers "no such user" too: the probing caller is
      // the one that asks twice.
      rememberRow(userRequestKey(userId), null);

      return { user: null, hasActiveFamily: false };
    }

    const { hasActiveFamily, ...user } = row;

    rememberRow(userRequestKey(userId), user);

    return { user, hasActiveFamily: hasActiveFamily === true };
  }
}

export { SESSION_USER_COLUMNS, SessionRepository };
