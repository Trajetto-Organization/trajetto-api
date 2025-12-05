/**
 * Determines the correct redirect page based on user role and driver status
 * @param role - User role (MASTER, BUSINESS_ADMIN, BUSINESS_USER)
 * @param driverId - Optional driver ID (if user is a driver)
 * @returns The base path for redirection ("driver", "dashboard", or "admin")
 */
function redirectPage(role: any, driverId?: string | null): string {
  // 🚗 DRIVER: BUSINESS_USER with driverId → redirect to /driver/*
  if (role === "BUSINESS_USER" && driverId) {
    return "driver";
  }

  // 📊 BUSINESS_USER/BUSINESS_ADMIN → redirect to /dashboard/*
  if (role === "BUSINESS_USER" || role === "BUSINESS_ADMIN") {
    return "dashboard";
  }

  // 👑 MASTER → redirect to /admin/*
  return "admin";
}

interface BuildServiceOrderLinkProps {
  baseUrl: string;
  role: any;
  driverId: string | null | undefined;
  vehicleId: string;
  serviceOrderId: string;
}

/**
 * Generates the correct notification link for service-order based on user role and driver status
 * @param baseUrl - The HTTP base URL (e.g., "https://example.com")
 * @param role - User role (MASTER, BUSINESS_ADMIN, BUSINESS_USER)
 * @param driverId - Optional driver ID (if user is a driver)
 * @param vehicleId - The vehicle ID associated with the service order
 * @param serviceOrderId - The service order ID
 * @returns The complete notification link
 */
function buildServiceOrderLink({
  role,
  baseUrl,
  driverId,
  serviceOrderId,
  vehicleId,
}: BuildServiceOrderLinkProps): string {
  // 🚗 DRIVER: Use /driver/vehicles/{vehicleId}/service-orders route
  if (role === "BUSINESS_USER" && driverId) {
    return `${baseUrl}/driver/vehicles/${vehicleId}/service-orders`;
  }

  // 📊 BUSINESS_USER/BUSINESS_ADMIN/MASTER: Use search query param
  const basePath = redirectPage(role, driverId);
  return `${baseUrl}/${basePath}/service-order?search=${serviceOrderId}&page=1`;
}

interface BuildAccountPayableLinkProps {
  baseUrl: string;
  role: any;
  driverId: string | null | undefined;
  accountPayableId: string;
}

/**
 * Generates the correct notification link for account-payable based on user role and driver status
 * @param baseUrl - The HTTP base URL (e.g., "https://example.com")
 * @param role - User role (MASTER, BUSINESS_ADMIN, BUSINESS_USER)
 * @param driverId - Optional driver ID (if user is a driver)
 * @param accountPayableId - The account payable ID
 * @returns The complete notification link
 */
function buildAccountPayableLink({
  role,
  baseUrl,
  driverId,
  accountPayableId,
}: BuildAccountPayableLinkProps): string {
  // 🚗 DRIVER: Use /driver/account-payables route (no search params)
  if (role === "BUSINESS_USER" && driverId) {
    return `${baseUrl}/driver/account-payable`;
  }

  // 📊 BUSINESS_USER/BUSINESS_ADMIN/MASTER: Use search query param
  const basePath = redirectPage(role, driverId);
  return `${baseUrl}/${basePath}/account-payable?search=${accountPayableId}&page=1`;
}

export { redirectPage, buildServiceOrderLink, buildAccountPayableLink };
