-- ============================================================================
-- Índices por tenant: os que faltavam, e os que não serviam a ninguém
--
-- Saldo líquido zero. Quinze índices entram, quinze saem — porque índice não é
-- de graça: cada um é reescrito em todo INSERT e todo UPDATE da coluna, e as
-- tabelas com mais índices aqui são também as mais escritas do sistema.
--
-- O QUE ENTRA
--
-- Seis tabelas não tinham índice NENHUM começando por businessId, e o Postgres
-- não indexa chave estrangeira sozinho: vehicle, driver, service_order,
-- account_payable, user e branch faziam sequential scan a cada listagem, mais
-- o count() paralelo. O caso mais caro não é nem uma tela: findUsersByBusiness
-- é chamado pelo pipeline de notificação para expandir destinatários a CADA
-- evento de domínio — um scan de 150 mil linhas no caminho quente do outbox.
--
-- O resto são compostos que substituem índices de coluna única pelo MESMO
-- custo de escrita. Com 3.600 tenants, businessId sozinho seleciona ~0,03% da
-- tabela: seletivo o bastante para o planner preferir index scan, insuficiente
-- para evitar o ORDER BY created_at DESC de toda listagem. O índice resolvia o
-- filtro e deixava um top-N sort do histórico inteiro do tenant, por página, e
-- de novo no count(). Numa transportadora grande isso vai para disco.
--
-- O QUE SAI, e por quê cada um
--
--   delivery_businessId_scheduled_date_idx  scheduled_date não aparece em
--       `where` nenhum do código — só num orderBy cujo `where` este índice não
--       serve. Índice morto na tabela mais escrita do sistema.
--   notification_read_idx                   booleano, nunca consultado sem
--       userId, E é a coluna que markAsRead reescreve: todo clique numa
--       notificação reescrevia uma entrada num btree do histórico inteiro.
--   notification_businessId_idx             notification nunca é consultada
--       por empresa; todo acesso é por userId ou por id.
--   activity_visibilityLevel_idx            três valores possíveis, sem tenant
--       na frente, e só aparece como um ramo de OR dentro de query já escopada.
--   fine_due_date_idx                       não aparece em `where` nenhum.
--   fine_violation_date_idx                 único leitor é getFinesByDateRange,
--       declarado na interface e chamado por ninguém.
--   traffic_violation_code_code_idx         duplicata exata do @unique da mesma
--       coluna.
--   kanban_*_idx, fuel_vehicleId_idx, e os businessId de coluna única
--       virtaram prefixo dos compostos acima.
--
-- O QUE FICA, apesar de parecer redundante
--
--   delivery_driverId_idx  toda query do app do motorista é
--       (businessId, driverId, status), e driverId é muito mais seletivo que
--       businessId. É o melhor índice disponível para listDriverDeliveries.
--
-- NOTA SOBRE A GERAÇÃO DESTE ARQUIVO
--
-- O `prisma migrate dev` que o gerou incluiu também
-- `DROP INDEX "chat_message_body_trgm_idx"`, e essa linha foi removida à mão.
-- É o mesmo mecanismo que quebrou a cadeia de migrations em setembro: o índice
-- de trigrama é criado em SQL cru (20260910120000_chat_scale_indexes) porque o
-- schema do Prisma não consegue expressar gin_trgm_ops, então toda geração de
-- migration o enxerga como deriva e oferece removê-lo. Qualquer migration
-- gerada daqui para frente precisa ser lida com isso em mente.
--
-- EM PRODUÇÃO, com as tabelas já grandes: o Prisma envolve cada migration numa
-- transação e o Postgres recusa CREATE INDEX CONCURRENTLY dentro de uma. Crie
-- os índices de delivery, activity, notification e user à mão, com
-- CONCURRENTLY, antes do deploy, e marque esta migration como aplicada — o
-- mesmo procedimento já descrito em 20260908120000_harden_queue_tables.
-- ============================================================================

-- DropIndex
DROP INDEX "activity_businessId_idx";

-- DropIndex
DROP INDEX "activity_performedBy_idx";

-- DropIndex
DROP INDEX "activity_visibilityLevel_idx";

-- DropIndex
DROP INDEX "delivery_businessId_scheduled_date_idx";

-- DropIndex
DROP INDEX "delivery_businessId_status_idx";

-- DropIndex
DROP INDEX "fine_businessId_idx";

-- DropIndex
DROP INDEX "fine_due_date_idx";

-- DropIndex
DROP INDEX "fine_violation_date_idx";

-- DropIndex
DROP INDEX "fuel_businessId_idx";

-- DropIndex
DROP INDEX "fuel_refueling_date_idx";

-- DropIndex
DROP INDEX "fuel_vehicleId_idx";

-- DropIndex
DROP INDEX "kanban_card_columnId_idx";

-- DropIndex
DROP INDEX "kanban_column_businessId_idx";

-- DropIndex
DROP INDEX "notification_businessId_idx";

-- DropIndex
DROP INDEX "notification_read_idx";

-- DropIndex
DROP INDEX "notification_userId_idx";

-- DropIndex
DROP INDEX "traffic_violation_code_code_idx";

-- DropIndex
DROP INDEX "vehicle_checklist_businessId_idx";

-- CreateIndex
CREATE INDEX "account_payable_businessId_created_at_idx" ON "account_payable"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "activity_businessId_created_at_idx" ON "activity"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "activity_performedBy_created_at_idx" ON "activity"("performedBy", "created_at");

-- CreateIndex
CREATE INDEX "branch_businessId_created_at_idx" ON "branch"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "delivery_businessId_created_at_idx" ON "delivery"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "delivery_businessId_status_created_at_idx" ON "delivery"("businessId", "status", "created_at");

-- CreateIndex
CREATE INDEX "driver_businessId_created_at_idx" ON "driver"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "fine_businessId_created_at_idx" ON "fine"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "fuel_businessId_created_at_idx" ON "fuel"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "fuel_vehicleId_refueling_date_idx" ON "fuel"("vehicleId", "refueling_date");

-- CreateIndex
CREATE INDEX "notification_userId_created_at_idx" ON "notification"("userId", "created_at");

-- CreateIndex
CREATE INDEX "service_order_businessId_created_at_idx" ON "service_order"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "user_businessId_created_at_idx" ON "user"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "vehicle_businessId_created_at_idx" ON "vehicle"("businessId", "created_at");

-- CreateIndex
CREATE INDEX "vehicle_checklist_businessId_created_at_idx" ON "vehicle_checklist"("businessId", "created_at");
