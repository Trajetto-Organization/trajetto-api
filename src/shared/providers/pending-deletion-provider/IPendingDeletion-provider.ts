import {
  CreatePendingDeletionProps,
  FindPendingDeletionProps,
  PendingDeletion,
} from "./dtos/pending-deletion-provider-dto";

interface IPendingDeletionProvider {
  upsertPendingDeletion: (
    data: CreatePendingDeletionProps,
  ) => Promise<PendingDeletion>;
  findPendingDeletion: (
    props: FindPendingDeletionProps,
  ) => Promise<PendingDeletion | null>;
  deletePendingDeletion: (id: string) => Promise<void>;
  deleteExpired: () => Promise<number>;
}

export { IPendingDeletionProvider };
