-- Quantas vezes já tentaram este código.
--
-- O código de dois fatores é `randomInt(100_000, 1_000_000)` — seis dígitos, um
-- milhão de possibilidades — e vale quinze minutos. Sem contador, um palpite
-- errado não consumia nada e não contava para nada: a única barreira era o
-- rate limit, que era contornável pelo cabeçalho que o cliente escreve.
--
-- Com contador, o espaço de busca deixa de ser um milhão de tentativas e passa
-- a ser cinco por código, e pedir um código novo apaga o anterior.
ALTER TABLE "two_factor_token"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
