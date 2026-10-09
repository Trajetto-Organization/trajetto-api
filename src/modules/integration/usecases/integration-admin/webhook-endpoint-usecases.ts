import { inject, injectable } from "tsyringe";

import type { Prisma } from "@prisma/client";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type {
  IWebhookEndpointRepository,
  WebhookEndpointSummary,
} from "../../repositories/IWebhook-endpoint-repository";
import type { IWebhookDeliveryRepository } from "../../repositories/IWebhook-delivery-repository";

import { AppError } from "@/shared/errors/AppError";
import {
  WEBHOOK_SECRET_ROTATION_GRACE_MS,
  newWebhookSecret,
} from "@/shared/integration/webhook-signature";
import { isSealed, sealHeaders, sealSecret } from "@/shared/integration/secret-box";
import {
  MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
  REPLAY_WINDOW_DAYS,
} from "@/shared/integration/webhook-dispatch-rules";

import { audit, scopedBusiness, type ActivityRecorder } from "./integration-admin-access";

function endpointNotFound(): AppError {
  // Another company's endpoint answers exactly like a missing one.
  return new AppError("Endpoint não encontrado.", 404, "WEBHOOK_ENDPOINT_NOT_FOUND");
}

interface SaveWebhookEndpointRequest {
  userId: string;
  businessId: string;
  /** Present on an edit. */
  id?: string;
  name: string;
  url: string;
  topics: string[];
  /** Undefined keeps what is stored on an edit; null clears. */
  headers?: Record<string, string> | null;
  is_active: boolean;
}

/**
 * Registers or edits an endpoint. A new one gets its signing secret, shown
 * once; an edit clears our breaker and releases what the endpoint held.
 */
@injectable()
class SaveWebhookEndpointUseCase {
  constructor(
    @inject("WebhookEndpointRepository")
    private endpoints: IWebhookEndpointRepository,
    @inject("WebhookDeliveryRepository")
    private deliveries: IWebhookDeliveryRepository,
    @inject("UserRepository") private users: IUserRepository,
    @inject("NotificationService") private activity: ActivityRecorder,
  ) {}

  async execute(
    request: SaveWebhookEndpointRequest,
  ): Promise<{ id: string; secret: string | null; created: boolean }> {
    const { userId, businessId } = request;

    await scopedBusiness(this.users, userId, businessId);

    // Sealed at rest: they are the customer's credentials for their gateway.
    const sealedHeaders = (headers: Record<string, string>) =>
      sealHeaders(headers) as Prisma.InputJsonValue;

    if (request.id) {
      const updated = await this.endpoints.update(request.id, businessId, {
        name: request.name,
        url: request.url,
        topics: request.topics,
        ...(request.headers !== undefined && {
          headers: request.headers === null ? null : sealedHeaders(request.headers),
        }),
        is_active: request.is_active,
      });

      if (!updated) throw endpointNotFound();

      // After the save committed, not inside it: a month of held rows
      // outlasted the transaction's timeout and failed the save on retry.
      if (request.is_active) await this.deliveries.releaseParked(request.id);

      audit(this.activity, {
        action: "update",
        entityId: request.id,
        description:
          `Webhook "${request.name}" apontado para ${request.url} ` +
          `nos eventos ${request.topics.join(", ")}` +
          (request.is_active ? "" : " (desativado)"),
        status: request.is_active ? "Ativo" : "Desativado",
        performedBy: userId,
        businessId,
      });

      return { id: request.id, secret: null, created: false };
    }

    const secret = newWebhookSecret();

    const created = await this.endpoints.createWithinQuota(
      businessId,
      {
        name: request.name,
        url: request.url,
        secret: sealSecret(secret),
        topics: request.topics,
        headers: request.headers ? sealedHeaders(request.headers) : null,
        is_active: request.is_active,
      },
      MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS,
    );

    if (!created) {
      throw new AppError(
        `Esta empresa já tem ${MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS} endpoints de webhook. Remova um que não é mais usado antes de cadastrar outro.`,
        409,
        "WEBHOOK_ENDPOINT_LIMIT_REACHED",
      );
    }

    audit(this.activity, {
      action: "create",
      entityId: created.id,
      description:
        `Webhook "${request.name}" criado para ${request.url} ` +
        `nos eventos ${request.topics.join(", ")}`,
      status: request.is_active ? "Ativo" : "Desativado",
      performedBy: userId,
      businessId,
    });

    return { id: created.id, secret, created: true };
  }
}

/**
 * Turns our breaker back on, and nothing else: no name, URL or topics sent,
 * so a list loaded minutes ago cannot overwrite an edit made since. The
 * customer's own switch is left alone — a paused endpoint stays paused.
 */
@injectable()
class ReactivateWebhookEndpointUseCase {
  constructor(
    @inject("WebhookEndpointRepository")
    private endpoints: IWebhookEndpointRepository,
    @inject("WebhookDeliveryRepository")
    private deliveries: IWebhookDeliveryRepository,
    @inject("UserRepository") private users: IUserRepository,
    @inject("NotificationService") private activity: ActivityRecorder,
  ) {}

  async execute(
    userId: string,
    businessId: string,
    id: string,
  ): Promise<{ message: string; data: { id: string; reactivated: boolean; released: number } }> {
    await scopedBusiness(this.users, userId, businessId);

    const endpoint = await this.endpoints.find(id, businessId);

    if (!endpoint) throw endpointNotFound();

    // A second click, or a stale screen, finds nothing to do and says so.
    if (!(await this.endpoints.resetBreaker(id, businessId))) {
      return {
        message: endpoint.is_active
          ? "Este endpoint já estava recebendo eventos."
          : "O envio automático já estava liberado, mas o endpoint está pausado: ative-o na edição para voltar a receber eventos.",
        data: { id, reactivated: false, released: 0 },
      };
    }

    const released = endpoint.is_active
      ? await this.deliveries.releaseParked(id)
      : 0;

    audit(this.activity, {
      action: "update",
      entityId: id,
      description: `Webhook "${endpoint.name}" reativado depois de ser desligado por falhas — os eventos retidos voltam a ser enviados`,
      status: endpoint.is_active ? "Ativo" : "Pausado",
      performedBy: userId,
      businessId,
    });

    return {
      message: endpoint.is_active
        ? `Endpoint reativado. Os eventos retidos nos últimos ${REPLAY_WINDOW_DAYS} dias começam a ser enviados agora.`
        : "Contagem de falhas zerada. O endpoint continua pausado: ative-o na edição para voltar a receber eventos.",
      data: { id, reactivated: true, released },
    };
  }
}

/**
 * A new signing secret, with the one it replaces still signing for a grace
 * period, so the receiver switches keys when ready and no event arrives
 * unverifiable meanwhile. Rotating again inside the window drops the oldest.
 */
@injectable()
class RotateWebhookSecretUseCase {
  constructor(
    @inject("WebhookEndpointRepository")
    private endpoints: IWebhookEndpointRepository,
    @inject("UserRepository") private users: IUserRepository,
    @inject("NotificationService") private activity: ActivityRecorder,
  ) {}

  async execute(userId: string, businessId: string, id: string): Promise<string> {
    await scopedBusiness(this.users, userId, businessId);

    const secret = newWebhookSecret();

    const rotated = await this.endpoints.rotateSecret(id, businessId, {
      secret: sealSecret(secret),

      // Kept as stored when already sealed — never opened here, so a
      // rotation still works when the old value cannot be read, which is
      // exactly when one is needed. A row written in clear is sealed.
      previousOf: (current) => (isSealed(current) ? current : sealSecret(current)),
      previousExpiresAt: new Date(Date.now() + WEBHOOK_SECRET_ROTATION_GRACE_MS),
    });

    if (!rotated) throw endpointNotFound();

    audit(this.activity, {
      action: "update",
      entityId: id,
      description:
        "Segredo do webhook trocado — o anterior continua assinando junto por 24 horas",
      status: "Segredo trocado",
      performedBy: userId,
      businessId,
    });

    return secret;
  }
}

@injectable()
class ListWebhookEndpointsUseCase {
  constructor(
    @inject("WebhookEndpointRepository")
    private endpoints: IWebhookEndpointRepository,
    @inject("UserRepository") private users: IUserRepository,
  ) {}

  async execute(userId: string, businessId: string): Promise<WebhookEndpointSummary[]> {
    await scopedBusiness(this.users, userId, businessId);

    return this.endpoints.listByBusiness(businessId);
  }
}

@injectable()
class DeleteWebhookEndpointUseCase {
  constructor(
    @inject("WebhookEndpointRepository")
    private endpoints: IWebhookEndpointRepository,
    @inject("UserRepository") private users: IUserRepository,
    @inject("NotificationService") private activity: ActivityRecorder,
  ) {}

  async execute(userId: string, businessId: string, id: string): Promise<void> {
    await scopedBusiness(this.users, userId, businessId);

    if (!(await this.endpoints.delete(id, businessId))) throw endpointNotFound();

    audit(this.activity, {
      action: "delete",
      entityId: id,
      description:
        "Webhook removido — o sistema do cliente deixa de receber os eventos da operação",
      status: "Removido",
      performedBy: userId,
      businessId,
    });
  }
}

export {
  DeleteWebhookEndpointUseCase,
  ListWebhookEndpointsUseCase,
  ReactivateWebhookEndpointUseCase,
  RotateWebhookSecretUseCase,
  SaveWebhookEndpointUseCase,
};
export type { SaveWebhookEndpointRequest };
