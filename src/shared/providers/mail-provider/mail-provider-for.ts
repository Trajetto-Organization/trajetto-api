import { IMailProvider } from "./IMail-provider";

import { EtherealMailProvider } from "./implementations/ethereal-mail-provider";
import { ResendMailProvider } from "./implementations/resend-mail-provider";
import { TestInboxMailProvider } from "./implementations/test-inbox-mail-provider";

type MailProviderClass = new () => IMailProvider;

/**
 * The e-mail transport for a NODE_ENV:
 *
 *  - production: Resend (staging too — the image inlines NODE_ENV=production);
 *  - test: the in-process test inbox, so the E2E suite and the web's browser
 *    suites never reach a mail server (decision D7, 30/10/2026);
 *  - anything else (development): Ethereal, whose preview link is how a
 *    developer reads what was sent.
 *
 * tests/unitaires/mail/mail-provider-for.test.ts pins each branch, including
 * that the test inbox is chosen for "test" and nothing else.
 */
function mailProviderFor(nodeEnv: string): MailProviderClass {
  if (nodeEnv === "production") return ResendMailProvider;
  if (nodeEnv === "test") return TestInboxMailProvider;

  return EtherealMailProvider;
}

export { mailProviderFor };
export type { MailProviderClass };
