# ADR 0009 — Comprovante público por token com prazo

- **Status:** aceito. ADR da fase final.
- **Escopo:** `trajetto-api` (geração e conferência) e a página `/verificar`
  da `trajetto-ui`.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados e os
  comentários do código já registravam (fontes no fim). Não acrescenta
  decisão nova; a numeração abaixo segue a citação "ADR 0009 §1" do código.

## Decisão

O PDF do comprovante traz um QR e um link `/verificar/<token>` que qualquer
pessoa abre **sem login**. O token é uma capacidade: quem o tem confere o
documento, e ele expira em `PROOF_VERIFICATION_TTL_DAYS` (padrão 1825 dias).
A API responde em `GET /public/verify-proof/:token`.

Como o comprovante é público por construção, o que ele expõe foi decidido
campo a campo:

1. **O documento de quem recebeu sai inteiro**: é a prova de quem recebeu
   (`src/shared/delivery/proof-document-fields.ts`).
2. **O CPF do entregador sai mascarado**, só com os seis dígitos do meio
   (`src/shared/delivery/proof-document.ts`). O modelo validado imprime o CPF
   inteiro; a máscara fica até o dono rever esta decisão.
3. **A assinatura é descrita de forma estreita**: se há assinatura ICP-Brasil
   e de quem, sem número de série nem CNPJ (o PDF já os tem;
   `src/modules/delivery/dtos/proof-document-dto.ts`).

## Fontes

- [`arquitetura.md` → Comprovante de entrega](../arquitetura.md#comprovante-de-entrega).
- Comentários que citam este ADR nos arquivos acima e em
  `tests/unitaires/delivery/proof-document.test.ts`.
