-- =====================================================================
-- PHASE 11 — Notification metadata + actionable join-request notifs
-- (2026-04-26)
--
-- Why: when a new user requested to join a group, the admin saw a toast
-- but couldn't act on it directly — and on the group page, the request
-- only appeared after a hard refresh. Add structured metadata to
-- notifications so the client can render Approve/Reject buttons inside
-- the notification and route to the right group on tap, AND enable
-- realtime on join_requests so the admin's open group view live-updates.
-- =====================================================================

-- 1. metadata column ---------------------------------------------------
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS notifications_metadata_idx
    ON notifications USING gin (metadata);


-- 2. Update notify_join_request to populate metadata --------------------
CREATE OR REPLACE FUNCTION notify_join_request(p_group_id UUID)
RETURNS VOID AS $$
DECLARE
    v_user_id UUID;
    v_user_name TEXT;
    v_group_name TEXT;
    v_admin_id UUID;
    v_request_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
    INTO v_user_name
    FROM profiles WHERE id = v_user_id;
    IF v_user_name = '' OR v_user_name IS NULL THEN
        v_user_name := 'User';
    END IF;

    SELECT name INTO v_group_name FROM groups WHERE id = p_group_id;
    IF v_group_name IS NULL THEN
        RAISE EXCEPTION 'Group not found';
    END IF;

    -- Find newest pending request from this user for this group
    SELECT id INTO v_request_id
    FROM join_requests
    WHERE group_id = p_group_id AND user_id = v_user_id AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1;

    SELECT user_id INTO v_admin_id
    FROM group_members
    WHERE group_id = p_group_id AND role = 'admin'
    LIMIT 1;

    IF v_admin_id IS NOT NULL THEN
        INSERT INTO notifications (user_id, type, text, metadata)
        VALUES (
            v_admin_id,
            'join_request',
            v_user_name || ' хоче приєднатися до групи "' || v_group_name || '"',
            jsonb_build_object(
                'group_id', p_group_id,
                'request_id', v_request_id,
                'requester_id', v_user_id,
                'requester_name', v_user_name,
                'group_name', v_group_name
            )
        );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- 3. Add join_requests to realtime publication --------------------------
DO $$
DECLARE in_pub BOOL;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'join_requests'
    ) INTO in_pub;
    IF NOT in_pub THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.join_requests;
        RAISE NOTICE 'added join_requests to supabase_realtime';
    END IF;
END$$;


-- 4. Backfill metadata for old 'member'-type join-request notifications -
-- (best effort — match by text suffix, leave others alone)
UPDATE notifications n
SET metadata = jsonb_build_object('group_id', g.id, 'group_name', g.name)
FROM groups g
WHERE n.type IN ('member', 'join_request')
  AND n.metadata IS NULL
  AND n.text LIKE '%"' || g.name || '"%';
