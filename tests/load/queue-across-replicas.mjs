/**
 * Duas réplicas varrendo a MESMA fila entregam cada evento uma vez?
 *
 * `FOR UPDATE SKIP LOCKED` diz que sim. Duas réplicas disputando de verdade é
 * a única prova — e a falha, se houvesse, seria silenciosa do nosso lado: o
 * banco ficaria consistente e o cliente é que receberia o mesmo webhook duas
 * vezes, faturando duas vezes por uma entrega.
 *
 * Precisa das duas réplicas de pé (tests/load/multi-replica.sh ou à mão).
 *
 *   node tests/load/queue-across-replicas.mjs
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

const context = JSON.parse(
  readFileSync(new URL("./fixtures/load-context.json", import.meta.url), "utf8"),
);

const EVENTS = Number(process.env.QUEUE_EVENTS ?? 60);

const prisma = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.LOAD_DATABASE_URL ??
        "postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public",
    },
  },
});

async function main() {
  /** Conta o que chega, por id de entrega. */
  const seen = new Map();

  const server = createServer((request, response) => {
    const id = request.headers["x-trajetto-delivery"];

    seen.set(id, (seen.get(id) ?? 0) + 1);

    response.writeHead(200);
    response.end("ok");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address();

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: `Receptor de réplica ${randomUUID().slice(0, 6)}`,
      url: `http://host.docker.internal:${port}/hook`.replace(
        "host.docker.internal",
        "127.0.0.1",
      ),
      secret: "whsec_teste_de_replica",
      topics: ["delivery.delivered"],
      businessId: context.businessId,
      is_active: true,
    },
  });

  console.log(`  receptor em 127.0.0.1:${port}, endpoint ${endpoint.id.slice(0, 8)}…`);

  // Enfileirado direto na tabela: o ponto é a DISPUTA entre réplicas, não o
  // caminho que criou as linhas.
  const body = JSON.stringify({
    topic: "delivery.delivered",
    created_at: new Date().toISOString(),
    data: { delivery_id: "carga" },
  });

  await prisma.webhookDelivery.createMany({
    data: Array.from({ length: EVENTS }, () => ({
      endpointId: endpoint.id,
      businessId: context.businessId,
      topic: "delivery.delivered",
      payload: JSON.parse(body),
      signed_body: body,
      signature: "t=0,v1=nao-verificado-aqui",
    })),
  });

  console.log(`  ${EVENTS} eventos enfileirados; as duas réplicas varrem a cada 5 s`);

  // Duas varreduras completas de folga.
  await new Promise((resolve) => setTimeout(resolve, 20_000));

  const delivered = await prisma.webhookDelivery.count({
    where: { endpointId: endpoint.id, status: "DELIVERED" },
  });

  const totalReceived = [...seen.values()].reduce((sum, n) => sum + n, 0);
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1);

  console.log(`\n  entregues (banco): ${delivered}/${EVENTS}`);
  console.log(`  POSTs recebidos:   ${totalReceived}`);
  console.log(`  duplicados:        ${duplicated.length}`);

  await prisma.webhookDelivery.deleteMany({
    where: { endpointId: endpoint.id },
  });

  await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });

  server.close();
  await prisma.$disconnect();

  if (duplicated.length > 0) {
    console.error(
      "\n  FALHOU: a mesma entrega saiu mais de uma vez. Duas réplicas " +
        "reivindicaram a mesma linha — o cliente recebe o webhook em " +
        "duplicata e fatura duas vezes pela mesma entrega.",
    );

    process.exit(1);
  }

  if (totalReceived < EVENTS) {
    console.error(
      `\n  FALHOU: ${EVENTS - totalReceived} evento(s) não chegaram. ` +
        "Uma fila que perde é pior que uma que duplica.",
    );

    process.exit(1);
  }

  console.log("\n  OK: cada evento saiu exatamente uma vez.");
}

main().catch(async (error) => {
  console.error(error);

  await prisma.$disconnect();
  process.exit(1);
});
