/**
 * Quantos palpites um código de dois fatores aguenta.
 *
 * Cinco. O código é `randomInt(100_000, 1_000_000)` — seis dígitos, um milhão
 * de possibilidades — e vale quinze minutos. Sem teto, um palpite errado não
 * consumia nada e não contava para nada, e a única barreira era o rate limit
 * das rotas anônimas, que era contornável pelo cabeçalho que o cliente
 * escreve. Um milhão de possibilidades com tentativas ilimitadas é um código
 * que se adivinha.
 *
 * Cinco dá folga de sobra para quem digitou errado; para quem adivinha, o
 * espaço de busca deixa de ser um milhão e passa a ser cinco por código. Pedir
 * um código novo apaga o anterior, então reiniciar a contagem custa um e-mail
 * — que é visível para o dono da conta.
 */
const MAX_TWO_FACTOR_ATTEMPTS = 5;

export { MAX_TWO_FACTOR_ATTEMPTS };
