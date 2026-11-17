-- AI chat schema for PostgreSQL, matching src/models/aiChat.ts.
-- Run against the PIM database before starting the updated server.
-- Objects are created in the current schema (normally public, according to search_path).
-- Safe to rerun: existing tables/data are not deleted or altered.
-- IF NOT EXISTS does not repair an existing table/index with an incompatible definition.
-- UUIDs and timestamps are supplied by Sequelize/application code; no extensions required.

BEGIN;

CREATE TABLE IF NOT EXISTS "aiChats" (
    "id" UUID NOT NULL PRIMARY KEY,
    "tenantId" VARCHAR(250) NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" VARCHAR(250) NOT NULL DEFAULT 'Новый чат',
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE IF NOT EXISTS "aiChatMessages" (
    "id" UUID NOT NULL PRIMARY KEY,
    "chatId" UUID NOT NULL REFERENCES "aiChats" ("id") ON DELETE CASCADE,
    "tenantId" VARCHAR(250) NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(20) NOT NULL,
    "requestId" UUID,
    "replyToId" UUID,
    "runId" UUID,
    "leaseUntil" TIMESTAMP WITH TIME ZONE,
    "error" VARCHAR(500),
    "trace" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "contextTruncated" BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Index names match Sequelize, preventing duplicate indexes at sequelize.sync().
CREATE INDEX IF NOT EXISTS "ai_chats_tenant_id_user_id_updated_at"
    ON "aiChats" ("tenantId", "userId", "updatedAt");

CREATE INDEX IF NOT EXISTS "ai_chat_messages_chat_id_created_at_id"
    ON "aiChatMessages" ("chatId", "createdAt", "id");

-- NULL requestId is intentional for assistant messages; PostgreSQL permits multiple NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS "ai_chat_messages_tenant_id_user_id_request_id"
    ON "aiChatMessages" ("tenantId", "userId", "requestId");

CREATE UNIQUE INDEX IF NOT EXISTS "ai_chat_messages_reply_to_id"
    ON "aiChatMessages" ("replyToId");

CREATE INDEX IF NOT EXISTS "ai_chat_messages_status_lease_until"
    ON "aiChatMessages" ("status", "leaseUntil");

COMMIT;
