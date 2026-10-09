import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type {
  ApiKeySummary,
  IApiKeyRepository,
} from "../../repositories/IApi-key-repository";

import { AppError } from "@/shared/errors/AppError";
import {
  MAX_ACTIVE_API_KEYS_PER_BUSINESS,
  TENANT_API_KEY_RATE_CEILING,
  generateApiKey,
} from "@/shared/integration/api-key-rules";

import { audit, scopedBusiness, type ActivityRecorder } from "./integration-admin-access";

interface CreateApiKeyRequest {
  userId: string;
  businessId: string;
  name: string;
  scopes: string[];
  rate_limit_per_minute: number;
}

/** Issues a key; the token is in this answer and nowhere else, ever. */
@injectable()
class CreateApiKeyUseCase {
  constructor(
    @inject("ApiKeyRepository") private apiKeys: IApiKeyRepository,
    @inject("UserRepository") private users: IUserRepository,
    @inject("NotificationService") private activity: ActivityRecorder,
  ) {}

  async execute(
    request: CreateApiKeyRequest,
  ): Promise<{ id: string; prefix: string; token: string }> {
    const user = await scopedBusiness(this.users, request.userId, request.businessId);

    // The ceiling is the platform's to raise, not the tenant's.
    if (
      request.rate_limit_per_minute > TENANT_API_KEY_RATE_CEILING &&
      user.role !== "MASTER"
    ) {
      throw new AppError(
        `O limite por chave vai até ${TENANT_API_KEY_RATE_CEILING} requisições por minuto. Acima disso, fale com o suporte.`,
        403,
        "API_KEY_RATE_ABOVE_PLAN",
      );
    }

    const key = generateApiKey();

    const created = await this.apiKeys.createWithinQuota(
      {
        name: request.name,
        prefix: key.prefix,
        token_hash: key.tokenHash,
        scopes: request.scopes,
        rate_limit_per_minute: request.rate_limit_per_minute,
        businessId: request.businessId,
      },
      MAX_ACTIVE_API_KEYS_PER_BUSINESS,
    );

    if (!created) {
      throw new AppError(
        `Esta empresa já tem ${MAX_ACTIVE_API_KEYS_PER_BUSINESS} chaves ativas. Revogue uma que não é mais usada antes de emitir outra.`,
        409,
        "API_KEY_LIMIT_REACHED",
      );
    }

    audit(this.activity, {
      action: "create",
      entityId: created.id,
      description: `Chave de API "${request.name}" emitida (${created.prefix}) com os escopos ${request.scopes.join(", ")}`,
      status: "Ativa",
      performedBy: request.userId,
      businessId: request.businessId,
    });

    return { id: created.id, prefix: created.prefix, token: key.token };
  }
}

@injectable()
class ListApiKeysUseCase {
  constructor(
    @inject("ApiKeyRepository") private apiKeys: IApiKeyRepository,
    @inject("UserRepository") private users: IUserRepository,
  ) {}

  async execute(userId: string, businessId: string): Promise<ApiKeySummary[]> {
    await scopedBusiness(this.users, userId, businessId);

    return this.apiKeys.listByBusiness(businessId);
  }
}

/** Revoked, never deleted: a key that made calls is part of the trail. */
@injectable()
class RevokeApiKeyUseCase {
  constructor(
    @inject("ApiKeyRepository") private apiKeys: IApiKeyRepository,
    @inject("UserRepository") private users: IUserRepository,
    @inject("NotificationService") private activity: ActivityRecorder,
  ) {}

  async execute(userId: string, businessId: string, id: string): Promise<void> {
    await scopedBusiness(this.users, userId, businessId);

    // Another company's key, a made-up id and an already revoked key answer
    // alike: none of them changes anything here.
    if (!(await this.apiKeys.revoke(id, businessId, new Date()))) {
      throw new AppError(
        "Chave não encontrada ou já revogada.",
        404,
        "API_KEY_NOT_FOUND",
      );
    }

    audit(this.activity, {
      action: "delete",
      entityId: id,
      description:
        "Chave de API revogada — o sistema que a usava perde o acesso imediatamente",
      status: "Revogada",
      performedBy: userId,
      businessId,
    });
  }
}

export { CreateApiKeyUseCase, ListApiKeysUseCase, RevokeApiKeyUseCase };
export type { CreateApiKeyRequest };
