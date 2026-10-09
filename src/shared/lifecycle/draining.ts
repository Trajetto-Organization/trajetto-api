/**
 * Whether this replica is on its way out.
 *
 * Set once, at the start of the graceful shutdown, and read by the readiness
 * probe: a replica that is draining must stop receiving new traffic while it
 * finishes what it already has.
 */
let draining = false;

function markDraining(): void {
  draining = true;
}

function isDraining(): boolean {
  return draining;
}

export { isDraining, markDraining };
