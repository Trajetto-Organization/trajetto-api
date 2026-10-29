import database from "@/../infra/database";

import { webhookSecretsKey } from "@/shared/integration/secret-box";
import { sealStoredWebhookSecrets } from "@/shared/integration/seal-stored-webhook-secrets";

/**
 * Seals the webhook credentials written before WEBHOOK_SECRETS_KEY was set.
 *
 * Run once, after setting the key in the API's environment and deploying:
 *
 *   production container:  node build/seal-webhook-secrets.js
 *   development:           yarn webhooks:seal
 *
 * Idempotent — a sealed value is left alone — so a re-run is always safe.
 * Refuses to run without a configured key: there would be nothing to seal
 * with (in production the absence of the key means "store in clear").
 */
async function main(): Promise<void> {
  const key = webhookSecretsKey();

  if (!key) {
    console.error(
      "[seal-webhook-secrets] WEBHOOK_SECRETS_KEY não está configurada: nada a fazer.",
    );

    process.exitCode = 1;
    return;
  }

  const { scanned, sealed } = await sealStoredWebhookSecrets(database, key);

  console.log(
    `[seal-webhook-secrets] ${scanned} endpoint(s) lido(s), ${sealed} cifrado(s) agora.`,
  );
}

main()
  .catch((error) => {
    console.error("[seal-webhook-secrets] Falhou:", error);
    process.exitCode = 1;
  })
  .finally(() => database.$disconnect());
