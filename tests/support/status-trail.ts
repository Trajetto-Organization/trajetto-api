/**
 * A delivery's trail without its creation line (plano-escala F2-06).
 *
 * Every delivery made through the repository starts with a STATUS_CHANGE
 * from nothing ("Entrega criada"), in the twin as in Postgres. A test about
 * what one action wrote reads what came after it; the creation line itself
 * is tested where it is written.
 */
function withoutCreationLine<
  T extends {
    type: string;
    status_from?: string | null;
    status_to?: string | null;
  },
>(events: T[]): T[] {
  return events.filter(
    (event) =>
      !(
        event.type === "STATUS_CHANGE" &&
        event.status_from === null &&
        event.status_to === "PENDING"
      ),
  );
}

export { withoutCreationLine };
