import { inject, injectable } from "tsyringe";

import { env } from "@/env";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { AppError } from "@/shared/errors/AppError";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { NotificationService } from "@/shared/services/notification-service";

import { IDriverEnrollmentRepository } from "../../repositories/IDriver-enrollment-repository";
import { IUserRepository } from "../../repositories/IUser-repository";
import {
  ENROLLMENT_TTL_MS,
  enrollmentQrContent,
  formatAccessCode,
  generateAccessCode,
  generateQrToken,
} from "../../services/driver-enrollment";
import { resolveManagedDriverLogin } from "../../services/managed-driver-login";

interface IssueDriverEnrollmentProps {
  /** Who asks (the session's user). */
  actorId: string;
  /** The driver's login. */
  userId: string;
}

interface IssuedDriverEnrollment {
  /** The opaque token, for the app to send (also inside `qrContent`). */
  qrToken: string;
  /** What the QR code encodes: prefix, version, environment and token. */
  qrContent: string;
  /** The short code to read out instead, as shown ("ABCD-EFGH"). */
  accessCode: string;
  expiresAt: Date;
  /** Seconds until it expires: the screen's countdown. */
  expiresIn: number;
}

/** A collision of a fresh 40-bit code with a live one is rare; 3 is plenty. */
const MAX_DRAWS = 3;

/**
 * The manager issues the access QR code of a driver's login (plan of
 * 02/11/2026, D3; decision D01).
 *
 * Only for a driver who may sign in right now — active, access not revoked —
 * so a code on a screen never fails at the driver's phone for a reason the
 * manager could have seen. Issuing again replaces the previous code (one row
 * per login), which is how "gerar outro" invalidates a screenshot that went
 * where it should not. The raw token and code are returned once, to this
 * answer, and stored only as hashes; the activity records who issued it and
 * nothing of the code.
 */
@injectable()
class IssueDriverEnrollmentUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DriverEnrollmentRepository")
    private enrollment: IDriverEnrollmentRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    actorId,
    userId,
  }: IssueDriverEnrollmentProps): Promise<IssuedDriverEnrollment> {
    const { actor, target } = await resolveManagedDriverLogin(
      this.user,
      actorId,
      userId,
    );

    if (target.access_revoked) {
      throw new AppError(
        "O acesso deste usuário está revogado. Restaure o acesso antes de gerar o QR Code.",
        409,
        "USER_ACCESS_REVOKED",
      );
    }

    const driver =
      target.driver ?? (await this.driver.findDriverById(target.driverId!));

    if (!driver || driver.status !== "ACTIVE") {
      throw new AppError(
        "O motorista está inativo. Ative o cadastro antes de gerar o QR Code.",
        409,
        "DRIVER_INACTIVE",
      );
    }

    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);

    for (let draw = 1; ; draw += 1) {
      const qrToken = generateQrToken();
      const code = generateAccessCode();

      try {
        await this.enrollment.issue({
          userId: target.id,
          businessId: target.businessId!,
          token: qrToken,
          code,
          expiresAt,
          createdById: actor.id,
        });
      } catch (error) {
        // Another live code drew the same value (the hashes are unique):
        // draw again rather than fail the manager's click.
        const collided =
          violatesUniqueOn(error, "code_hash") ||
          violatesUniqueOn(error, "token_hash");

        if (collided && draw < MAX_DRAWS) continue;

        throw error;
      }

      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "update",
        entityId: target.id,
        description: `Acesso por QR Code gerado para o motorista ${target.name}`,
        // A status of the activity catalog (and of the web's mirror of it):
        // the activity filter only offers what the catalog knows.
        status: "Criado",
        performedBy: actor.id,
        businessId: target.businessId ?? null,
      });

      return {
        qrToken,
        qrContent: enrollmentQrContent(qrToken, env.APP_ENV ?? "development"),
        accessCode: formatAccessCode(code),
        expiresAt,
        expiresIn: Math.round(ENROLLMENT_TTL_MS / 1000),
      };
    }
  }
}

export { IssueDriverEnrollmentUseCase };
export type { IssuedDriverEnrollment };
