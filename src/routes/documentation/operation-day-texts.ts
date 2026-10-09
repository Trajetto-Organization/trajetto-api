/**
 * What the day's operation counters mean, written once (decision 7.1).
 *
 * The dashboard's "Operação de hoje" and GET /delivery/operation-summary read
 * the same counts (read-operation-summary.ts), so their documents say the
 * same thing: "Designadas" is the tower's day load, not "with a driver, of
 * any date", which it used to be.
 */
const OPERATION_COUNTER_TEXT = {
  designated:
    "Pendentes com motorista em rota do dia (programada para hoje ou ainda em andamento), a mesma contagem do funil da torre de controle (decisão 7.1); rota de outro dia (amanhã, ou de ontem que não saiu) e entrega com motorista sem rota não contam",
  inRoute: "Em rota agora (na rua neste momento)",
  deliveredToday:
    "Entregues no dia de negócio da empresa (por delivered_at), ou entregues em rota do dia",
  failedToday:
    "Em insucesso cujo último fato de falha (mudança para Insucesso, ocorrência impeditiva aplicada ou parada encerrada como insucesso) foi no dia de negócio da empresa, ou em insucesso em rota do dia",
} as const;

export { OPERATION_COUNTER_TEXT };
