interface CreateActivityProps {
  type: string; // "vehicle", "user", "service-order", etc.
  action: string; // "create", "update", "delete", etc.
  entityId: string; // Related entity ID
  description: string; // Readable description of the action
  status: string; // Action-related status
  performedBy: string; // ID of the user who performed the action
  businessId: string | null; // Company ID
  tenantName?: string | null; // Business name snapshot — pass explicitly when businessId is null (e.g. delete)
  visibilityLevel?: string; // "SYSTEM", "COMPANY", "USER" - controls who can see this activity
  performingUserRole?: string; // Role of the user who performed the action

  /**
   * Set only by the notification pipeline, where it is the id of the delivery
   * being executed. It makes the write idempotent: a redelivery of the same
   * item — a crash between the provider call and the DELIVERED mark, a lease
   * expiring under a slow send, a deploy mid-batch — records the activity
   * once. Absent for every activity a use case writes directly.
   */
  deliveryId?: string | null;
}

interface Activity {
  id: string;
  deliveryId?: string | null;
  type: string;
  action: string;
  entityId: string;
  description: string;
  status: string;
  performedBy: string | null;
  businessId: string | null;
  tenantName?: string | null;
  visibilityLevel?: string | null;
  performingUserRole?: string | null;
  userEmail?: string;
  userName?: string;
  userRole?: string;
  business_name?: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ListRecentActivitiesProps {
  page: number;
  pageSize: number;
  currentUserRole: string;
  businessId?: string;
  search?: string;
  userId: string;
}

interface ListActivityProps {
  data: Activity[];
  total: number;
}

/**
 * Keyset page of the timeline feed. `cursor` is the id of the last row the
 * client already has — ids are uuid v7, so ordering by id descending is the
 * same as by creation time, with a unique tiebreaker built in.
 */
interface ListActivitiesCursorProps {
  currentUserRole: string;
  businessId?: string;
  userId: string;
  limit: number;
  cursor?: string;
  search?: string;
  /** Days back from now; the panel offers 7 and 30. */
  periodDays: number;
}

interface CursorPaginatedActivities {
  data: Activity[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ActivitySummaryProps {
  currentUserRole: string;
  businessId?: string;
  userId: string;
  /** Days back from now — the panel offers 7 and 30. */
  periodDays: number;
}

interface ActivitySummary {
  total: number;
  created: number;
  updated: number;
  deleted: number;
  activeUsers: number;
  /** Busiest module in the period, e.g. "Entrega". */
  topType: string | null;
  topTypeCount: number;
  periodDays: number;
}

export {
  Activity,
  ListActivitiesCursorProps,
  CursorPaginatedActivities,
  ActivitySummary,
  ActivitySummaryProps,
  CreateActivityProps,
  ListActivityProps,
  ListRecentActivitiesProps,
};
