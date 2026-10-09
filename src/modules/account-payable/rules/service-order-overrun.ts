import { cents } from "./account-payable-status";

/**
 * FLEET-AP-5: several bills may point at one service order — a parts invoice
 * and a labour invoice — so a sum above the order's total is not refused.
 * It is SAID, though: nothing warned before, and a bill typed twice went
 * unnoticed until the month closed.
 */
function serviceOrderOverrunWarning(
  billsTotal: unknown,
  serviceOrderTotal: unknown,
): string | null {
  const bills = cents(billsTotal as number | string);
  const order = cents(serviceOrderTotal as number | string);

  if (order <= 0 || bills <= order) return null;

  const money = (value: number) =>
    (value / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return `As contas desta ordem de serviço somam ${money(bills)}, acima do total da ordem (${money(order)}). Confira se não há conta em duplicidade.`;
}

export { serviceOrderOverrunWarning };
