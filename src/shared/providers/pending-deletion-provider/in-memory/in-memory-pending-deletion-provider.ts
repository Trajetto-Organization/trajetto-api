import { v7 as uuidV7 } from "uuid";

import { IPendingDeletionProvider } from "../IPendingDeletion-provider";
import {
  CreatePendingDeletionProps,
  FindPendingDeletionProps,
  PendingDeletion,
} from "../dtos/pending-deletion-provider-dto";

class InMemoryPendingDeletionProvider implements IPendingDeletionProvider {
  public pendingDeletions: PendingDeletion[] = [];

  async upsertPendingDeletion(
    data: CreatePendingDeletionProps,
  ): Promise<PendingDeletion> {
    const existingIndex = this.pendingDeletions.findIndex(
      (p) =>
        p.entity_type === data.entity_type &&
        p.entity_id === data.entity_id &&
        p.userId === data.userId,
    );

    if (existingIndex !== -1) {
      this.pendingDeletions[existingIndex] = {
        ...this.pendingDeletions[existingIndex],
        code_hash: data.code_hash,
        expires: data.expires,
      };

      return this.pendingDeletions[existingIndex];
    }

    const pending: PendingDeletion = {
      id: uuidV7(),
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      userId: data.userId,
      code_hash: data.code_hash,
      expires: data.expires,
      created_at: new Date(),
    };

    this.pendingDeletions.push(pending);
    return pending;
  }

  async findPendingDeletion(
    props: FindPendingDeletionProps,
  ): Promise<PendingDeletion | null> {
    return (
      this.pendingDeletions.find(
        (p) =>
          p.entity_type === props.entity_type &&
          p.entity_id === props.entity_id &&
          p.userId === props.userId,
      ) ?? null
    );
  }

  async deletePendingDeletion(id: string): Promise<void> {
    this.pendingDeletions = this.pendingDeletions.filter((p) => p.id !== id);
  }

  async deleteExpired(): Promise<number> {
    const before = this.pendingDeletions.length;
    const now = new Date();

    this.pendingDeletions = this.pendingDeletions.filter(
      (p) => p.expires >= now,
    );

    return before - this.pendingDeletions.length;
  }
}

export { InMemoryPendingDeletionProvider };
