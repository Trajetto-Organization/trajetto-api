/**
 * The name the platform's own occurrence type takes when a company type
 * already carries the requested one (DLVP-OCC-3). Shared by the Prisma
 * repository and its in-memory twin so both pick the same row.
 */
function systemFallbackName(name: string): string {
  return `${name} (sistema)`;
}

export { systemFallbackName };
