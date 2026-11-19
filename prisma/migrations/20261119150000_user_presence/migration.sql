-- ----------------------------------------------------------------------------
-- user_presence: who has a socket open right now (plano-escala U-05, F4.6)
-- ----------------------------------------------------------------------------
-- The chat's thread list colours each driver online or offline. It used to
-- ask every replica for its sockets through the Socket.IO adapter
-- (fetchSockets), which a process without sockets cannot do once the
-- realtime role holds them all, and which turned every driver's signal drop
-- into "offline" and a new "visto por último". The process that holds a
-- socket now writes the login's beat here (on connect, every 60 s, and once
-- more when the socket goes), and the row leaves when no socket came back
-- within PRESENCE_GRACE_MS; online = a beat younger than 90 s
-- (src/shared/socket/presence.ts).
--
-- One row per login, cascaded with it; the runtime roles get it with the
-- other tables (infra/sql/20-runtime-roles.sql, the trajetto_app group).
-- The index serves the sweep of the rows a process that died left behind.
--
-- Expand only: a new table the serving image never reads. The foreign key
-- takes a short SHARE ROW EXCLUSIVE lock on "user", bounded below.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_presence" (
    "user_id" TEXT NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_presence_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_presence_heartbeat_at_idx" ON "user_presence"("heartbeat_at");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_presence_user_id_fkey'
  ) THEN
    ALTER TABLE "user_presence"
      ADD CONSTRAINT "user_presence_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
