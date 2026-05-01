import database from "@/../infra/database";
import { IPendingDeletionProvider } from "./IPendingDeletion-provider";

import {
  CreatePendingDeletionProps,
  FindPendingDeletionProps,
  PendingDeletionEntityType,
  PendingDeletion,
} from "./dtos/pending-deletion-provider-dto";

class PendingDeletionProvider implements IPendingDeletionProvider {
  constructor(private prisma = database) {}

  async upsertPendingDeletion(
    data: CreatePendingDeletionProps,
  ): Promise<PendingDeletion> {
    const result = await this.prisma.pendingDeletion.upsert({
      where: {
        entity_type_entity_id_userId: {
          entity_type: data.entity_type,
          entity_id: data.entity_id,
          userId: data.userId,
        },
      },
      update: {
        code_hash: data.code_hash,
        expires: data.expires,
      },
      create: {
        entity_type: data.entity_type,
        entity_id: data.entity_id,
        userId: data.userId,
        code_hash: data.code_hash,
        expires: data.expires,
      },
    });

    return {
      ...result,
      entity_type: result.entity_type as PendingDeletionEntityType,
    };
  }

  async findPendingDeletion(
    props: FindPendingDeletionProps,
  ): Promise<PendingDeletion | null> {
    const result = await this.prisma.pendingDeletion.findUnique({
      where: {
        entity_type_entity_id_userId: {
          entity_type: props.entity_type,
          entity_id: props.entity_id,
          userId: props.userId,
        },
      },
    });

    if (!result) return null;

    return {
      ...result,
      entity_type: result.entity_type as PendingDeletionEntityType,
    };
  }

  async deletePendingDeletion(id: string): Promise<void> {
    await this.prisma.pendingDeletion.delete({
      where: { id },
    });
  }

  async deleteExpired(): Promise<number> {
    const result = await this.prisma.pendingDeletion.deleteMany({
      where: { expires: { lt: new Date() } },
    });

    return result.count;
  }
}

export { PendingDeletionProvider };
