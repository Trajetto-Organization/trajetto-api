import {
  floorOf,
  lockOrder,
  type IProviderQuotaRepository,
  type QuotaTake,
  type QuotaUnit,
} from "./provider-quota-repository";

/**
 * The twin of ProviderQuotaRepository: the same counts, the same limit
 * re-checked on every unit, the same floor and the same all-or-none over
 * rows the tests seed. One process, so the row lock has nothing to model;
 * a take is synchronous between its awaits, which is the serialization
 * the lock gives the SQL.
 */
class InMemoryProviderQuotaRepository implements IProviderQuotaRepository {
  /** `${provider}|${scope}|${day}` → used. */
  public rows = new Map<string, number>();

  private key(provider: string, scope: string, day: string): string {
    return `${provider}|${scope}|${day}`;
  }

  async used(
    provider: string,
    day: string,
    scopes: readonly string[],
  ): Promise<Record<string, number>> {
    return Object.fromEntries(
      scopes.map((scope) => [
        scope,
        this.rows.get(this.key(provider, scope, day)) ?? 0,
      ]),
    );
  }

  async take(
    provider: string,
    day: string,
    units: readonly QuotaUnit[],
  ): Promise<QuotaTake> {
    const after: number[] = new Array(units.length);

    // Every unit checked before any is counted: all or none.
    for (const index of lockOrder(units)) {
      const unit = units[index];
      const current = Math.max(
        this.rows.get(this.key(provider, unit.scope, day)) ?? 0,
        floorOf(unit),
      );

      if (unit.limit <= 0 || current >= unit.limit) {
        return { granted: false, refused: unit.scope };
      }

      after[index] = current + 1;
    }

    units.forEach((unit, index) => {
      this.rows.set(this.key(provider, unit.scope, day), after[index]);
    });

    return { granted: true, used: after };
  }
}

export { InMemoryProviderQuotaRepository };
