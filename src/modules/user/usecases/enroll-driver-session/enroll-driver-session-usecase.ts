import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { AppError } from "@/shared/errors/AppError";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { NotificationService } from "@/shared/services/notification-service";

import { DriverEnrollmentToken } from "../../dtos/driver-enrollment-dto";
import { IDriverEnrollmentRepository } from "../../repositories/IDriver-enrollment-repository";
import { IDriverTrustedDeviceRepository } from "../../repositories/IDriver-trusted-device-repository";
import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import {
  ENROLLMENT_MAX_ATTEMPTS,
  normalizeAccessCode,
} from "../../services/driver-enrollment";
import { assertSessionEligible } from "../../services/session-eligibility";
import {
  createUserSession,
  hashDeviceId,
} from "../../services/session-service";

interface EnrollDriverSessionProps {
  /** The QR code's opaque token, or… */
  qrToken?: string;
  /** …the short code read out instead (any case, hyphen or not). */
  accessCode?: string;
  /** The phone, already normalized: the session is bound to it (D4). */
  deviceId: string;
}

interface EnrolledDriverSession {
  token: string;
  refresh_token: string;
  role: string;

  /** The manager set this login's password (wave 2): the app asks for one. */
  mustChangePassword: boolean;
}

/**
 * One answer for every code that does not open a session — unknown, expired,
 * already used, spent by refusals — so the route cannot be used to tell them
 * apart. The driver asks the manager for a new one either way.
 */
function invalidEnrollment(): AppError {
  return new AppError(
    "QR Code ou código de acesso inválido ou expirado. Peça um novo ao gestor.",
    401,
    "AUTH_ENROLLMENT_INVALID",
  );
}

/**
 * The driver's phone opens a session with the manager's QR code or its short
 * code (plan of 02/11/2026, D3/D4; decision D01).
 *
 * The code is spent atomically, once: of two phones racing on the same QR
 * code exactly one gets a session (DriverEnrollmentRepository.consume). The
 * driver must be able to sign in right now — the same check as every login
 * and every request (assertSessionEligible) — and a refusal for that reason
 * is counted against the code, which is spent after a few. The session is
 * the phone-bound one: 30 idle days, 180 in all, renewed only from this
 * phone. No e-mail verification and no second factor: the manager, signed
 * in, issued the code for this login and showed it in person.
 *
 * The phone becomes trusted for this login (wave 2, 06/11/2026): from then on
 * it may also sign in by CPF and password. A phone the login did not trust
 * before is told to the company's admins — all but the manager who issued
 * the code — in the same transaction as the trust, and recorded in the
 * login's activity: a code read out over the phone to somebody posing as the
 * driver ends up on a phone nobody expected.
 */
@injectable()
class EnrollDriverSessionUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DriverEnrollmentRepository")
    private enrollment: IDriverEnrollmentRepository,
    @inject("DriverTrustedDeviceRepository")
    private trustedDevices: IDriverTrustedDeviceRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  private async find(
    qrToken: string | undefined,
    accessCode: string | undefined,
  ): Promise<DriverEnrollmentToken | null> {
    if (qrToken) return this.enrollment.findByToken(qrToken);

    const code = accessCode ? normalizeAccessCode(accessCode) : null;

    return code ? this.enrollment.findByCode(code) : null;
  }

  async execute({
    qrToken,
    accessCode,
    deviceId,
  }: EnrollDriverSessionProps): Promise<EnrolledDriverSession> {
    const enrollment = await this.find(qrToken, accessCode);
    const now = new Date();

    if (
      !enrollment ||
      enrollment.consumed_at !== null ||
      enrollment.expires_at.getTime() <= now.getTime() ||
      enrollment.attempts >= ENROLLMENT_MAX_ATTEMPTS
    ) {
      throw invalidEnrollment();
    }

    const user = await this.user.findUserById(enrollment.userId);

    // Still the driver's login of the company that issued it: nothing else
    // may be opened with this code.
    if (
      !user ||
      user.businessId !== enrollment.businessId ||
      user.role !== "BUSINESS_USER" ||
      !user.driverId
    ) {
      await this.enrollment.recordFailedAttempt(
        enrollment.id,
        enrollment.token_hash,
      );

      throw invalidEnrollment();
    }

    try {
      await assertSessionEligible(user, this.driver);
    } catch (error) {
      // The driver inactive, the access revoked, the company or branch off:
      // said as such (the app has a message for each), and counted.
      await this.enrollment.recordFailedAttempt(
        enrollment.id,
        enrollment.token_hash,
      );

      throw error;
    }

    // Spent only while it is still the code that was read: a "gerar outro"
    // in the meantime rewrote the row, and the replaced code is dead.
    const consumed = await this.enrollment.consume(enrollment.id, {
      tokenHash: enrollment.token_hash,
      deviceId,
      now,
      maxAttempts: ENROLLMENT_MAX_ATTEMPTS,
    });

    // Another phone spent it a moment ago, it lapsed, or the manager
    // replaced it in between.
    if (!consumed) throw invalidEnrollment();

    // Trusted before the session exists: no session ever runs on a phone
    // its login does not trust.
    const newPhone = await database.$transaction(async (tx) => {
      const { created } = await this.trustedDevices.trust(
        {
          userId: user.id,
          deviceHash: hashDeviceId(deviceId),
          source: "qr",
          now,
        },
        tx,
      );

      if (created && user.businessId) {
        await this.outbox.publish(tx, {
          topic: "driver-access.new_device",
          aggregateType: "user",
          aggregateId: user.id,
          businessId: user.businessId,
          actorId: user.id,
          payload: {
            businessId: user.businessId,
            driverUserId: user.id,
            driverName: user.name,
            issuedById: enrollment.createdById,
            at: now.toISOString(),
          },
        });
      }

      return created;
    });

    if (newPhone) {
      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "update",
        entityId: user.id,
        description: `Motorista ${user.name} entrou em um aparelho novo pelo QR Code de acesso`,
        status: "Atualizado",
        performedBy: user.id,
        businessId: user.businessId ?? null,
      });
    }

    const session = await createUserSession(
      user,
      this.usersTokens,
      "driver_device",
      deviceId,
    );

    return {
      ...session,
      role: user.role,
      mustChangePassword: user.must_change_password ?? false,
    };
  }
}

export { EnrollDriverSessionUseCase };
export type { EnrolledDriverSession };
