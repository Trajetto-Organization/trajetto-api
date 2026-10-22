import { container } from "tsyringe";

import type { IApiKeyRepository } from "./repositories/IApi-key-repository";
import { ApiKeyRepository } from "./repositories/api-key-repository";
import type { IWebhookEndpointRepository } from "./repositories/IWebhook-endpoint-repository";
import { WebhookEndpointRepository } from "./repositories/webhook-endpoint-repository";
import type { IWebhookDeliveryRepository } from "./repositories/IWebhook-delivery-repository";
import { WebhookDeliveryRepository } from "./repositories/webhook-delivery-repository";

/**
 * The integration screens' repositories, registered by the module itself
 * (imported by its routes) so the shared registry needs no edit to add them.
 * Idempotent: a second import registers nothing new.
 */
if (!container.isRegistered("ApiKeyRepository")) {
  container.registerSingleton<IApiKeyRepository>(
    "ApiKeyRepository",
    ApiKeyRepository,
  );
}

if (!container.isRegistered("WebhookEndpointRepository")) {
  container.registerSingleton<IWebhookEndpointRepository>(
    "WebhookEndpointRepository",
    WebhookEndpointRepository,
  );
}

if (!container.isRegistered("WebhookDeliveryRepository")) {
  container.registerSingleton<IWebhookDeliveryRepository>(
    "WebhookDeliveryRepository",
    WebhookDeliveryRepository,
  );
}
