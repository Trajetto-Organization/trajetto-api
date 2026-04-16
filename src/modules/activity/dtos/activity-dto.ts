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
}

interface Activity {
  id: string;
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

export {
  Activity,
  CreateActivityProps,
  ListActivityProps,
  ListRecentActivitiesProps,
};
