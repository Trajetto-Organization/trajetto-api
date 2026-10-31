import "reflect-metadata";

import { afterAll } from "vitest";

import {
  installOutboundNetworkGuard,
  takeBlockedConnections,
} from "./tests/support/outbound-network-guard";

// No test leaves this machine (decision D7, docs/testes.md): a connection to
// anything but the loopback and the configured databases is refused, and the
// file that tried fails here, even when nothing else noticed.
installOutboundNetworkGuard();

afterAll(() => {
  const refused = [...new Set(takeBlockedConnections())];

  if (refused.length > 0) {
    throw new Error(
      `Este arquivo tentou conectar fora da máquina (${refused.join(", ")}). ` +
        "Os testes usam dublês locais para todo terceiro: decisão D7, docs/testes.md.",
    );
  }
});
