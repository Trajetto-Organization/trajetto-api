import { UserRole } from "@/modules/user/dtos/user-dto";
import { PermissionKey } from "@/config/permissions";

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

interface ListPermission {
  data: Permission[];
  total: number;
}

interface ListPermissionProps {
  page: number;
  pageSize: number;
  search?: string;
  currentUserRole: UserRole;
  businessId: string;
  profileAccessId: string;
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
  Permission,
  ListPermission,
  ListPermissionProps,
  BulkConfigurePermissionItem,
  BulkConfigurePermissionsProps,
};
