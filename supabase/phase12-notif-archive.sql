-- =====================================================================
-- PHASE 12 — Notifications archive (2026-04-26)
--
-- Adds archived_at column. The "Архів" button on notifications screen
-- sets archived_at = now() for all currently visible (non-archived)
-- notifications. Archived rows stay in DB forever (never auto-deleted).
-- =====================================================================

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS notifications_user_archived_idx
    ON notifications(user_id, archived_at) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_archived_idx
    ON notifications(user_id, archived_at) WHERE archived_at IS NOT NULL;
