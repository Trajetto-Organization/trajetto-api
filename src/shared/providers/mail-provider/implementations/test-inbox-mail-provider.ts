import { env } from "@/env";
import { logger } from "@/shared/logging/logger";

import { MailProviderProps, MailSendResult } from "../dtos/mail-provider-dto";
import { IMailProvider } from "../IMail-provider";

import { buildMessageId } from "../message-id";
import { renderMailTemplate } from "../template-renderer";

const log = logger.child({ component: "mail-provider", provider: "test" });

/** The newest messages kept; a long browser suite must not grow it forever. */
const TEST_INBOX_LIMIT = 200;

interface TestInboxMessage {
  to: string;
  subject: string;
  html: string;
  referenceId?: string;
  messageId?: string;
}

/**
 * Where e-mail goes when NODE_ENV=test: nowhere outside this process.
 *
 * The E2E suite and the web's browser suites run this API with NODE_ENV=test,
 * and every message used to go through Ethereal — a test account created at
 * api.nodemailer.com and an SMTP session with smtp.ethereal.email on every
 * run. A pipeline then depended on a third party being up (decision D7 of the
 * CI audit, 30/10/2026: no outside network in the CI's tests). Development
 * keeps Ethereal, where the preview link is the point.
 *
 * It renders the template like the real providers do, so a broken template
 * fails here as it would in production, and keeps the identity the pipeline
 * relies on (the deterministic Message-ID). It refuses to exist under any
 * other NODE_ENV: a production stack that registered it by mistake would lose
 * every e-mail in silence.
 *
 * Two checks, because `env.NODE_ENV` is read from the container's
 * environment at run time: a NODE_ENV=test set on a deployed Application
 * would pass the first one. The second reads `process.env.NODE_ENV` written
 * out, which tsup replaces with the BUILD's NODE_ENV (tsup.config.ts: the
 * image is built as "production"). In a built API it is a constant, and the
 * inbox refuses to exist whatever the container says; from the source (tsx,
 * vitest) it is the process's own value.
 */
class TestInboxMailProvider implements IMailProvider {
  private readonly inbox: TestInboxMessage[] = [];

  constructor(
    nodeEnv: string = env.NODE_ENV,
    builtFor: string | undefined = process.env.NODE_ENV,
  ) {
    if (nodeEnv !== "test" || builtFor !== "test") {
      throw new Error(
        `TestInboxMailProvider only exists with NODE_ENV=test (got ${nodeEnv}, built for ${builtFor ?? "unset"})`,
      );
    }
  }

  async sendMail({
    to,
    subject,
    variables,
    path,
    referenceId,
  }: MailProviderProps): Promise<MailSendResult> {
    const html = renderMailTemplate(path, variables);

    const messageId = referenceId
      ? buildMessageId(referenceId, "intrajetto.com")
      : undefined;

    this.inbox.push({ to, subject, html, referenceId, messageId });

    if (this.inbox.length > TEST_INBOX_LIMIT) this.inbox.shift();

    // No recipient (OBS-15), as in the real providers. Debug: a suite sends
    // hundreds, and nobody reads them.
    log.debug({ referenceId }, "e-mail kept in the test inbox");

    return { messageId };
  }

  /** What was sent, newest last. For a test holding this instance. */
  messages(): readonly TestInboxMessage[] {
    return this.inbox;
  }
}

export { TEST_INBOX_LIMIT, TestInboxMailProvider };
export type { TestInboxMessage };
