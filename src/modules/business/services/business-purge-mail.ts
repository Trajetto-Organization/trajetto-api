import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { withMailbox } from "@/modules/user/services/user-mailbox";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";
import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { resolveTimeZone } from "@/shared/time/business-day";

import type { Business } from "../dtos/business-dto";

/**
 * The two e-mails of a scheduled purge (plano-escala F3-25), to the
 * company's administrators: when it is scheduled, and 7 days before the
 * data goes (remind-business-purge). The purge is irreversible, so these go
 * to every administrator with a mailbox whatever their notification
 * preference, as a security notice does. The days are told on the
 * company's clock.
 */
function dayOf(value: Date | string | null | undefined, timeZone: string) {
  return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone }) : "";
}

async function mailBusinessPurge(
  kind: "scheduled" | "reminder",
  business: Business,
  users: Pick<IUserRepository, "findBusinessAdminsByBusinessId">,
): Promise<number> {
  const admins = withMailbox(
    await users.findBusinessAdminsByBusinessId(business.id!),
  );
  const timeZone = resolveTimeZone(business.timezone);
  const businessName = business.corporate_reason;
  const deactivatedOn = dayOf(business.deactivated_at, timeZone);
  const purgeOn = dayOf(business.purge_after, timeZone);
  const logo = emailLogoUrl();

  await Promise.allSettled(
    admins.map((admin) =>
      kind === "scheduled"
        ? sendTransactionalMail({
            email: admin.email,
            name: admin.name,
            subject: `[Trajetto] A empresa "${businessName}" foi desativada e os dados serão apagados em ${purgeOn}`,
            templateName: "business-purge-scheduled.hbs",
            moduleName: "business",
            additionalVariablesProperties: {
              businessName,
              deactivatedOn,
              purgeOn,
              logo,
            },
          })
        : sendTransactionalMail({
            email: admin.email,
            name: admin.name,
            subject: `[Trajetto] Os dados da empresa "${businessName}" serão apagados em ${purgeOn}`,
            templateName: "business-purge-reminder.hbs",
            moduleName: "business",
            additionalVariablesProperties: {
              businessName,
              deactivatedOn,
              purgeOn,
              logo,
            },
          }),
    ),
  );

  return admins.length;
}

export { mailBusinessPurge };
