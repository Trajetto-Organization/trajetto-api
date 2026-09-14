-- The per-user WhatsApp "instance" was a concept of the unofficial gateway
-- (Evolution API): each user paired a session via QR code and its liveness was
-- tracked here. The official Meta Cloud API sends from one registered business
-- number to any opted-in recipient, so there is no per-user connection state
-- left to store. Opt-in and phone number remain on the user row.
ALTER TABLE "user" DROP COLUMN "whatsapp_instance_connected";
