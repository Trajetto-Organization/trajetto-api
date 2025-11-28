/**
 * Geolocation Utilities
 *
 * Functions for calculating distance and validating geographic
 * coordinates using the Haversine formula for accuracy at short distances.
 */

/**
 * Calculate the distance between two geographic points using the Haversine formula.
 *
 * The Haversine formula is an important equation in navigation, providing
 * great-circle distances between two points on a sphere from their
 * longitudes and latitudes.
 *
 * @param lat1 - Latitude of point 1 (in decimal degrees, e.g., -23.550520)
 * @param lon1 - Longitude of point 1 (in decimal degrees, e.g., -46.633308)
 * @param lat2 - Latitude of point 2 (in decimal degrees)
 * @param lon2 - Longitude of point 2 (in decimal degrees)
 * @returns Distance in meters between the two points
 *
 * @example
 * // Calculate the distance between two points in São Paulo.
 * const distance = calculateDistance(-23.550520, -46.633308, -23.561414, -46.655881);
 * console.log(`Distância: ${distance.toFixed(2)} meters`);
 * // Output: Distância: 2547.89 meters
 */
function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371e3; // Earth's radius in meters (6,371 km)

  // Converts degrees to radians.
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;

  // Calculates differences in radians.
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  // Haversine formula
  // a = sin²(Δφ/2) + cos φ1 * cos φ2 * sin²(Δλ/2)
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  // c = 2 * atan2(√a, √(1−a))
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // d = R * c (distance in meters)
  const distance = R * c;

  return distance;
}

/**
 * Checks if the distance between two points is within the allowed limit.
 *
 * Useful for validating manual GPS settings, ensuring that the edit is correct.
 * Don't be too far from the original location where it was captured.
 *
 * @param originalLat - Original Latitude (Auto GPS)
 * @param originalLon - Original longitude (automatic GPS)
 * @param editedLat - Edited latitude (manual GPS)
 * @param editedLon - Edited longitude (manual GPS)
 * @param maxDistanceMeters - Maximum permitted distance in meters (standard: 500m)
 * @returns True if the distance is within the limit, false otherwise.
 *
 * @example
 * // Checks if the manual adjustment is within 500m.
 * const isValid = isWithinAllowedDistance(
 *   -23.550520, -46.633308, // Original location (GPS)
 *   -23.550950, -46.633850, // Edited location (manual adjustment)
 *   500 // Maximum 500 meters
 * );
 * console.log(`Ajuste válido: ${isValid}`);
 * // Output: Ajuste válido: true (distância ~70m)
 */
function isWithinAllowedDistance(
  originalLat: number,
  originalLon: number,
  editedLat: number,
  editedLon: number,
  maxDistanceMeters: number = 500,
): boolean {
  const distance = calculateDistance(
    originalLat,
    originalLon,
    editedLat,
    editedLon,
  );

  return distance <= maxDistanceMeters;
}

/**
 * Check if the geographic coordinates are within valid limits.
 *
 * @param latitude - Latitude to be validated.
 * @param longitude - Longitude to be validated
 * @returns True if the coordinates are valid, false otherwise.
 *
 * @example
 * isValidCoordinates(-23.550520, -46.633308); // true
 * isValidCoordinates(100, -46.633308); // false (latitude out of range)
 * isValidCoordinates(-23.550520, 200); // false (longitude out of range)
 */
function isValidCoordinates(latitude: number, longitude: number): boolean {
  // Latitude should be between -90 and 90.
  if (latitude < -90 || latitude > 90) {
    return false;
  }

  // Longitude should be between -180 and 180.
  if (longitude < -180 || longitude > 180) {
    return false;
  }

  return true;
}

/**
 * Format coordinates for user-friendly display.
 *
 * @param latitude - Latitude
 * @param longitude - Longitude
 * @param precision - Number of decimal places (default: 6)
 * @returns Formatted string with coordinates
 *
 * @example
 * formatCoordinates(-23.550520, -46.633308);
 * // Output: "-23.550520, -46.633308"
 *
 * formatCoordinates(-23.550520, -46.633308, 4);
 * // Output: "-23.5505, -46.6333"
 */
function formatCoordinates(
  latitude: number,
  longitude: number,
  precision: number = 6,
): string {
  return `${latitude.toFixed(precision)}, ${longitude.toFixed(precision)}`;
}

export {
  calculateDistance,
  isWithinAllowedDistance,
  isValidCoordinates,
  formatCoordinates,
};
