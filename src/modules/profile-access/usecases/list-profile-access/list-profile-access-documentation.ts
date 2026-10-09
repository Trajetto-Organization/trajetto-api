import { z } from "zod";

import { catalogLeaderDoc } from "@/shared/pagination/catalog-usage";

/** The listing's `meta.searchMeta`, as summarizeProfileList builds it. */
const profileAccessListSearchMetaDoc = z.object({
  total: z.number().int().describe("Perfis da busca (o mesmo total do paginador)."),
  linkedUsers: z
    .number()
    .int()
    .describe("Usuários vinculados a esses perfis (a soma da coluna Usuários)."),
  withoutUsers: z.number().int().describe("Desses perfis, os que nenhum usuário usa."),
  mostUsed: catalogLeaderDoc("Usuários vinculados ao perfil.").describe(
    "O perfil com mais usuários (empate: ordem alfabética); null se nenhum perfil tem usuário.",
  ),
});

export { profileAccessListSearchMetaDoc };
