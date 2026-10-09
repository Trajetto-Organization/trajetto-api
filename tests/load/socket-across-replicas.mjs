/**
 * Um evento emitido por UMA réplica chega a quem está conectado na OUTRA?
 *
 * É a pergunta que mais silenciosamente quebra ao escalar horizontalmente: sem
 * o adapter do Redis cada processo emite só para os sockets que ele mesmo
 * segura, e o sintoma é "às vezes o painel não atualiza" — que ninguém
 * reproduz, porque depende de em qual réplica o navegador caiu.
 *
 *   node tests/load/socket-across-replicas.mjs
 */
import { readFileSync } from "node:fs";

import { loadSocketClient } from "./lib/socket-client.mjs";

// O cliente vem do repositório web, ao lado (ver lib/socket-client.mjs).
const io = await loadSocketClient();

const context = JSON.parse(
  readFileSync(new URL("./fixtures/load-context.json", import.meta.url), "utf8"),
);

const [A, B] = process.env.LOAD_PORTS?.split(" ") ?? ["3341", "3342"];

const managerToken = context.managerTokens[0];
const driverToken = context.driverTokens[0];

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${port}`, {
      auth: { token: managerToken },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(
      () => reject(new Error(`Timeout conectando em ${port}`)),
      10_000,
    );

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  // O painel está na réplica A.
  const socket = await connect(A);

  console.log(`  painel conectado na réplica ${A}`);

  const received = new Promise((resolve) => {
    socket.on("driverPosition", resolve);

    setTimeout(() => resolve(null), 8000);
  });

  // O telefone descarrega posições contra a réplica B.
  const response = await fetch(`http://localhost:${B}/route/positions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${driverToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pings: [
        {
          latitude: -23.5505,
          longitude: -46.6333,
          accuracy: 9,
          recorded_at: new Date().toISOString(),
        },
      ],
    }),
  });

  const body = await response.json();

  console.log(
    `  telefone escreveu na réplica ${B}: ${response.status} ` +
      `(gravadas ${body?.data?.stored ?? "?"})`,
  );

  const event = await received;

  socket.disconnect();

  if (!event) {
    console.error(
      "\n  FALHOU: o evento emitido pela réplica B não chegou ao painel " +
        "conectado na réplica A.\n  Sem o adapter do Redis, cada processo " +
        "emite só para os sockets que ele mesmo segura.",
    );

    process.exit(1);
  }

  console.log(
    `\n  OK: o painel na réplica ${A} recebeu o evento emitido pela ` +
      `réplica ${B} (motorista ${event.driverId.slice(0, 8)}…).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
