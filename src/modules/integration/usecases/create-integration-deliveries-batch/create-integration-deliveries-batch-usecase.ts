import { inject, injectable } from "tsyringe";
import { ZodError } from "zod";

import { AppError } from "@/shared/errors/AppError";
import {
  validationErrorMessage,
  validationIssueSentences,
} from "@/shared/validation/zod-pt-br";
import { parseIntegrationDeliveryBody } from "@/schemas/create-integration-delivery-schema";

import { CreateIntegrationDeliveryUseCase } from "../create-delivery/create-integration-delivery-usecase";
import { pointsAtDelivery } from "../create-delivery/create-integration-delivery-errors";
import { INTEGRATION_IDEMPOTENCY_KEY_PATTERN } from "../create-delivery/integration-idempotency-key";

interface CreateIntegrationDeliveriesBatchInput {
  /** From the API key, never from the request. */
  businessId: string;
  apiKeyId: string;
  apiKeyName: string;

  /** The envelope's elements, each still to be parsed. */
  deliveries: unknown[];
}

/** What happened to one delivery of the batch, at its position. */
interface BatchDeliveryResult {
  index: number;

  /** The element's key as sent, or null when it had none worth echoing. */
  idempotency_key: string | null;

  /** 201 created now, 200 already created by this key, or the refusal's. */
  status: number;

  /** The delivery created, replayed or in the way of a 409. */
  delivery_id?: string | null;

  /** Only on a refusal: the same code and sentence as the single create. */
  code?: string;
  message?: string;
  issues?: string[];
}

/**
 * POST /integration/v1/deliveries/batch (plano-escala U-04, F4.5): up to
 * 100 deliveries in one call, each exactly as the single create.
 *
 * An ERP pushing a day of documents made one call per delivery, each
 * through the key's and the company's minute and its own round trip. The
 * batch keeps every rule of the single create by running it, delivery by
 * delivery, in the order sent: the same parser and messages, the shipper
 * of the key's company only, the NF-e dedupe, the replay by the
 * delivery's own `idempotency_key` (the header of the single create),
 * and one transaction per delivery with its `delivery.created`. So:
 *
 *  - a refused delivery is that delivery's result (its status, code and
 *    sentence), and the others still go: partial success, by design;
 *  - the same batch sent again answers the same results, the created ones
 *    as 200 with the same ids, and creates nothing twice;
 *  - a failure that is not the delivery's (the database going away) stops
 *    the batch and answers as the single create would (500 or 503): every
 *    delivery committed before it is replayed by the retry, never doubled.
 *
 * The company comes from the key; nothing in the body can name another,
 * and another company's shipper reads as absent, as in the single create.
 */
@injectable()
class CreateIntegrationDeliveriesBatchUseCase {
  // By its class: esbuild (the test runner) emits no decorator metadata
  // for tsyringe to infer the type from.
  constructor(
    @inject(CreateIntegrationDeliveryUseCase)
    private create: CreateIntegrationDeliveryUseCase,
  ) {}

  async execute(
    input: CreateIntegrationDeliveriesBatchInput,
  ): Promise<BatchDeliveryResult[]> {
    const results: BatchDeliveryResult[] = [];

    // One at a time, in order: two elements with the same key are the
    // single create's retry, the second a replay of the first (or its 409).
    for (const [index, element] of input.deliveries.entries()) {
      results.push(await this.one(input, index, element));
    }

    return results;
  }

  private async one(
    input: CreateIntegrationDeliveriesBatchInput,
    index: number,
    element: unknown,
  ): Promise<BatchDeliveryResult> {
    const fields =
      typeof element === "object" && element !== null && !Array.isArray(element)
        ? { ...(element as Record<string, unknown>) }
        : null;

    // Echoed only when it is a key: a refused value is not repeated back.
    const sentKey =
      typeof fields?.idempotency_key === "string" &&
      INTEGRATION_IDEMPOTENCY_KEY_PATTERN.test(fields.idempotency_key)
        ? fields.idempotency_key
        : null;

    try {
      if (!fields) {
        return refused(index, null, {
          status: 400,
          code: "VALIDATION_ERROR",
          message: "corpo: cada entrega do lote deve ser um objeto.",
          issues: ["corpo: cada entrega do lote deve ser um objeto."],
        });
      }

      // The single create's header rules and codes, as a field of the
      // element: required, and in the same format.
      const idempotencyKey = fields.idempotency_key;

      if (idempotencyKey === undefined || idempotencyKey === "") {
        return refused(index, null, {
          status: 400,
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message:
            "idempotency_key: obrigatória em cada entrega do lote, um valor único por entrega, repetido em cada novo envio dela.",
        });
      }

      if (
        typeof idempotencyKey !== "string" ||
        !INTEGRATION_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
      ) {
        return refused(index, null, {
          status: 400,
          code: "IDEMPOTENCY_KEY_INVALID",
          message:
            "idempotency_key: use de 8 a 128 caracteres entre letras, números e . _ : - (um UUID serve).",
        });
      }

      delete fields.idempotency_key;

      const body = parseIntegrationDeliveryBody(fields);

      const result = await this.create.execute({
        businessId: input.businessId,
        apiKeyId: input.apiKeyId,
        apiKeyName: input.apiKeyName,
        idempotencyKey,
        body,
      });

      return {
        index,
        idempotency_key: idempotencyKey,
        status: result.replayed ? 200 : 201,
        delivery_id: result.delivery.id,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = validationIssueSentences(
          error.issues.map(({ code, path, message }) => ({
            code,
            path: path.map(String).join("/"),
            message,
          })),
        );

        return refused(index, sentKey, {
          status: 400,
          code: "VALIDATION_ERROR",
          message: validationErrorMessage(issues),
          issues,
        });
      }

      if (error instanceof AppError) {
        return refused(index, sentKey, {
          status: error.statusCode,
          code: error.code,
          message: error.message,
          ...(pointsAtDelivery(error)
            ? { delivery_id: error.deliveryId ?? null }
            : {}),
        });
      }

      // Not this delivery's: the whole call fails, and the retry replays
      // what was committed.
      throw error;
    }
  }
}

function refused(
  index: number,
  idempotencyKey: string | null,
  refusal: Omit<BatchDeliveryResult, "index" | "idempotency_key">,
): BatchDeliveryResult {
  return { index, idempotency_key: idempotencyKey, ...refusal };
}

export { CreateIntegrationDeliveriesBatchUseCase };
export type { BatchDeliveryResult, CreateIntegrationDeliveriesBatchInput };
