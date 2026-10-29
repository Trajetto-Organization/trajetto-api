import { PermissionKey } from "@/config/permissions";
import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  PermissionGroupCount,
  PermissionListFilters,
  PermissionSortKey,
} from "../usecases/list-permission/permission-list";

interface CreatePermissionProps {
  action: string;
  canRead: boolean;
  canWrite: boolean;
  businessId: string;
  profileAccessId: string;
  permissionKey: PermissionKey;
}

interface Permission {
  id: string;
  action: string;
  canRead: boolean;
  canWrite: boolean;
  businessId: string;
  profileAccessId: string;
  corporate_reason?: string;
  profile_name?: string;
  permissionKey?: string;
}

interface FindPermissionNameByProfile {
  action: string;
  businessId: string;
  profileAccessId: string;
}

/** A line of GET /permission/list-permission. */
interface PermissionListRow extends Permission {
  created_at: Date;
  updated_at: Date;
  profileAccess: { name: string };
}

interface ListPermission {
  data: PermissionListRow[];
  /** Permissions per faceted combination over search + tenant. */
  groups: PermissionGroupCount[];
  /** Names of the company's profiles present in the groups or selected. */
  profileNames: Map<string, string>;
}

interface ListPermissionProps extends PermissionListFilters {
  page: number;
  pageSize: number;
  sort?: PermissionSortKey;
  order?: SortOrder;
}

interface UpdatePermission {
  permissionId: string;
  businessId: string;
  profileAccessId: string;
  action?: string | null;
  canRead?: boolean | null;
  canWrite?: boolean | null;
  permissionKey?: PermissionKey;
}

/** What a client may send: the company is the permission's own. */
type UpdatePermissionInput = Omit<UpdatePermission, "businessId">;

interface FindPermissionKeyByProfile {
  permissionKey: string;
  profileAccessId: string;
  businessId: string;
}

interface BulkConfigurePermissionItem {
  permissionKey: PermissionKey;
  canRead: boolean;
  canWrite: boolean;
}

interface BulkConfigurePermissionsProps {
  businessId: string;
  profileAccessId: string;
  permissions: BulkConfigurePermissionItem[];
}

export {
  CreatePermissionProps,
  FindPermissionNameByProfile,
  FindPermissionKeyByProfile,
  UpdatePermission,
  UpdatePermissionInput,
  Permission,
  ListPermission,
  ListPermissionProps,
  PermissionListRow,
  BulkConfigurePermissionItem,
  BulkConfigurePermissionsProps,
};
