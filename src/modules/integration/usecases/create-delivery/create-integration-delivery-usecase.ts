import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import type { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import {
  ShipperInactiveError,
  ShipperNotFoundError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import { DeliveryNotFoundError } from "@/modules/delivery/usecases/errors/delivery-errors";

import type { IIntegrationRepository } from "../../repositories/IIntegration-repository";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { NotificationService } from "@/shared/services/notification-service";
import { deliveryEventPayload } from "@/shared/integration/announce";
import type { PublicDelivery } from "@/shared/integration/public-shapes";

import { isUniqueViolation } from "@/shared/http/idempotency-key";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";

import type { CreateIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";

import {
  IdempotencyKeyReusedError,
  IntegrationInvoiceKeyExistsError,
} from "./create-integration-delivery-errors";
import {
  isSameSubmission,
  itemAtColumnScale,
  type DeliveryDraft,
} from "./replay-fingerprint";

interface CreateIntegrationDeliveryInput {
  /** From the API key, never from the request. */
  businessId: string;
  apiKeyId: string;

  /** The key's name, for the audit trail: the key is who acted. */
  apiKeyName: string;

  idempotencyKey: string;
  body: CreateIntegrationDeliveryBody;
}

interface CreateIntegrationDeliveryResult {
  /** True when the key had already created it: the answer is 200, not 201. */
  replayed: boolean;
  delivery: PublicDelivery;
}

/**
 * POST /integration/v1/deliveries: the manual create's rules, for a machine.
 *
 * The panel's CreateDeliveryUseCase is a person's action — it starts from a
 * user and the dispatcher check, and writes the audit entry under that user.
 * A key has neither, and the public answer needs what the panel's does not:
 * the delivery in its public shape, 200 on a replay, and the id of whatever
 * is in the way of a 409. So this is its own use case over the SAME pieces:
 * the manual schema's field rules, the shipper rule (another company's
 * shipper reads as absent, an inactive one is refused), the NF-e key dedupe
 * with the panel's error, the replay on the (businessId, client_submission_id)
 * index (of what an API key created, never of a panel submission), and the
 * row and its `delivery.created` in one transaction.
 *
 * What marks the origin is the row's `apiKeyId`. The panel's create writes
 * no DeliveryEvent (there is no "created" event type), and neither does this:
 * a NOTE would surface in the event feed as `delivery.note`, a fact that did
 * not happen.
 */
@injectable()
class CreateIntegrationDeliveryUseCase {
  constructor(
    @inject("ShipperRepository")
    private shippers: IShipperRepository,
    @inject("DeliveryRepository")
    private deliveries: IDeliveryRepository,
    @inject("IntegrationRepository")
    private integration: IIntegrationRepository,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    input: CreateIntegrationDeliveryInput,
  ): Promise<CreateIntegrationDeliveryResult> {
    const { businessId, apiKeyId, apiKeyName, idempotencyKey, body } = input;

    const { shipper_id, shipper_cnpj, items, ...rest } = body;

    // Written at the columns' scale, so the replay below compares against
    // exactly what was written (a float like 3 * 1.115 would otherwise be
    // rounded one way by the database and another by the comparison).
    const fields = { ...rest, items: items?.map(itemAtColumnScale) };

    const shipper = await this.findShipper(
      businessId,
      shipper_id,
      shipper_cnpj,
    );

    const draft: DeliveryDraft = { ...fields, shipperId: shipper?.id ?? null };

    // Before the shipper and NF-e checks, as on the panel: a retry of a
    // delivery that exists must get that delivery, even if its shipper was
    // deactivated since or its NF-e key now "already exists" (it is this one).
    const replay = await this.replay(businessId, idempotencyKey, draft);

    if (replay) return replay;

    // Another company's id reads as absent (decision 11.3): a separate "not
    // yours" would tell a key which ids exist at other carriers.
    if (!shipper?.id) throw new ShipperNotFoundError();

    if (shipper.is_active === false) throw new ShipperInactiveError();

    if (fields.invoice_key) {
      const holder = await this.deliveries.findDeliveryByInvoiceKey(
        businessId,
        fields.invoice_key,
      );

      if (holder) throw new IntegrationInvoiceKeyExistsError(holder.id ?? null);
    }

    // `apiKeyId` is the origin INTEGRATION (and which integration). The E2E
    // reads it back from the row so a narrowed spread cannot drop it quietly.
    const data: CreateDeliveryProps = {
      ...fields,
      shipperId: shipper.id,
      businessId,
      client_submission_id: idempotencyKey,
      apiKeyId,
    };

    let created: { id: string; recipient_name: string };

    try {
      // The row and the event that announces it commit together, as on the
      // panel: an ERP that pushed a document must never be the one system
      // that does not hear it was created.
      created = await database.$transaction(async (tx) => {
        const row = await this.deliveries.createDelivery(data, tx);

        await this.webhooks.announce(
          "delivery.created",
          businessId,
          deliveryEventPayload({ ...row, id: row.id! }),
          tx,
        );

        return { id: row.id!, recipient_name: row.recipient_name };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // A twin request with the same key committed after the lookup above:
      // the unique index decided, and the twin's delivery is the answer (or
      // the 409, when the twin carried another body).
      const twin = await this.replay(businessId, idempotencyKey, draft);

      if (twin) return twin;

      // Two different requests with the same NF-e key raced past the check.
      if (violatesUniqueOn(error, "invoice_key") && fields.invoice_key) {
        const holder = await this.deliveries.findDeliveryByInvoiceKey(
          businessId,
          fields.invoice_key,
        );

        throw new IntegrationInvoiceKeyExistsError(holder?.id ?? null);
      }

      throw error;
    }

    // The same entry the panel writes, with the key as the actor: no user
    // acted, so performedBy stays null and the description names the key.
    // After the commit and never awaited, like the panel's: an audit write
    // that fails must not cost the integrator the created delivery.
    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "create",
      entityId: created.id,
      description: `Entrega para ${created.recipient_name} criada pela integração «${apiKeyName}» | ID: ${created.id}`,
      status: "Pendente",
      performedBy: null,
      businessId,
    });

    return {
      replayed: false,
      delivery: await this.published(businessId, created.id),
    };
  }

  /** Scoped to the key's company: another tenant's shipper is null. */
  private async findShipper(
    businessId: string,
    shipperId: string | null | undefined,
    shipperCnpj: string | null | undefined,
  ): Promise<Shipper | null> {
    if (shipperCnpj) {
      return this.shippers.findShipperByCnpj(businessId, shipperCnpj);
    }

    if (!shipperId) return null;

    const found = await this.shippers.findShipperById(shipperId);

    return found && found.businessId === businessId ? found : null;
  }

  private async replay(
    businessId: string,
    idempotencyKey: string,
    draft: DeliveryDraft,
  ): Promise<CreateIntegrationDeliveryResult | null> {
    const stored = await this.integration.findSubmission(
      businessId,
      idempotencyKey,
    );

    if (!stored) return null;

    // Only what an API key created is replayed. The panel's form writes the
    // same column; a public key equal to one of its keys is not that
    // submission, whatever the body says.
    if (stored.apiKeyId === null) {
      throw new IdempotencyKeyReusedError(stored.id, "panel");
    }

    if (!isSameSubmission(draft, stored)) {
      throw new IdempotencyKeyReusedError(stored.id);
    }

    return {
      replayed: true,
      delivery: await this.published(businessId, stored.id),
    };
  }

  /** The delivery as GET /integration/v1/deliveries/:id shows it. */
  private async published(
    businessId: string,
    deliveryId: string,
  ): Promise<PublicDelivery> {
    const found = await this.integration.findDelivery(businessId, deliveryId);

    if (!found) throw new DeliveryNotFoundError();

    return found;
  }
}

export { CreateIntegrationDeliveryUseCase };
export type { CreateIntegrationDeliveryInput, CreateIntegrationDeliveryResult };
