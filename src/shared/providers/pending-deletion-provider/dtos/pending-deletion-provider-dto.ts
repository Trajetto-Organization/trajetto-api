type PendingDeletionEntityType = "branch" | "business";

interface PendingDeletion {
  id: string;
  entity_type: PendingDeletionEntityType;
  entity_id: string;
  userId: string;
  code_hash: string;
  expires: Date;
  created_at: Date;
}

interface CreatePendingDeletionProps {
  entity_type: PendingDeletionEntityType;
  entity_id: string;
  userId: string;
  code_hash: string;
  expires: Date;
}

interface FindPendingDeletionProps {
  entity_type: PendingDeletionEntityType;
  entity_id: string;
  userId: string;
}

export {
  PendingDeletionEntityType,
  CreatePendingDeletionProps,
  FindPendingDeletionProps,
  PendingDeletion,
};
