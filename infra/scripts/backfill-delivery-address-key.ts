import database from "@/../infra/database";

import { backfillDeliveryAddressKeys } from "@/shared/delivery/address-key-backfill";

/**
 * The address key of the deliveries written before it, and the point of a
 * door given once to the open deliveries there still without one (owner's
 * report of 14/11/2026; decision D-25; src/shared/delivery/address-key-backfill.ts).
 *
 * Run once, after the API with migration 20261114120000_delivery_address_key
 * serves — first on staging, then on production, off peak:
 *
 *   production container:  node build/backfill-delivery-address-key.js
 *   development:           yarn deliveries:address-key
 *
 * Batches of 1,000 rows, each under lock_timeout = 5s. Idempotent — a keyed
 * row and a located delivery are left alone — so a re-run (after a lock
 * timeout, say) is always safe and finishes the rest.
 */
async function main(): Promise<void> {
  const report = await backfillDeliveryAddressKeys(database, {
    onBatch: ({ scanned, keyed }) =>
      console.log(
        `[backfill-delivery-address-key] ${scanned} entrega(s) lida(s), ${keyed} chave(s) gravada(s).`,
      ),
  });

  console.log(
    `[backfill-delivery-address-key] Pronto: ${report.keyed} chave(s) gravada(s) em ${report.scanned} entrega(s); ${report.propagated} entrega(s) aberta(s) receberam o ponto de ${report.doors} endereço(s).`,
  );
}

main()
  .catch((error) => {
    console.error("[backfill-delivery-address-key] Falhou:", error);
    process.exitCode = 1;
  })
  .finally(() => database.$disconnect());
