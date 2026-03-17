-- ============================================
-- Phase 2 Database Patches
-- Run in Supabase SQL Editor BEFORE deploying client code
-- ============================================

-- 1. Auto-generate group_code on INSERT
CREATE OR REPLACE FUNCTION set_group_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.group_code IS NULL OR NEW.group_code = '' THEN
        NEW.group_code := generate_group_code();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_group_code
    BEFORE INSERT ON groups
    FOR EACH ROW EXECUTE FUNCTION set_group_code();

-- 2. RPC: Create group + first admin member atomically
CREATE OR REPLACE FUNCTION create_group_with_member(
    p_name TEXT,
    p_description TEXT DEFAULT ''
)
RETURNS TABLE(
    group_id UUID,
    group_code CHAR(6)
) AS $$
DECLARE
    v_group_id UUID;
    v_group_code CHAR(6);
BEGIN
    INSERT INTO groups (name, description, created_by, group_code)
    VALUES (p_name, p_description, auth.uid(), generate_group_code())
    RETURNING id, groups.group_code INTO v_group_id, v_group_code;

    INSERT INTO group_members (group_id, user_id, role)
    VALUES (v_group_id, auth.uid(), 'admin');

    RETURN QUERY SELECT v_group_id, v_group_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. RPC: Approve join request + add member atomically
CREATE OR REPLACE FUNCTION approve_join_request(
    p_request_id UUID
)
RETURNS VOID AS $$
DECLARE
    v_request RECORD;
BEGIN
    SELECT jr.* INTO v_request
    FROM join_requests jr
    JOIN group_members gm ON gm.group_id = jr.group_id
    WHERE jr.id = p_request_id
      AND jr.status = 'pending'
      AND gm.user_id = auth.uid()
      AND gm.role = 'admin';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request not found or you are not admin';
    END IF;

    UPDATE join_requests
    SET status = 'approved', resolved_at = now(), resolved_by = auth.uid()
    WHERE id = p_request_id;

    INSERT INTO group_members (group_id, user_id, role)
    VALUES (v_request.group_id, v_request.user_id, 'member');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RPC: Find group by code (bypasses RLS for non-members)
CREATE OR REPLACE FUNCTION find_group_by_code(p_code TEXT)
RETURNS TABLE(
    id UUID,
    name TEXT,
    description TEXT,
    group_code CHAR(6),
    members_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT g.id, g.name, g.description, g.group_code,
           (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS members_count
    FROM groups g
    WHERE g.group_code = p_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. RPC: Check expired votings wrapper
CREATE OR REPLACE FUNCTION check_my_expired_votings()
RETURNS VOID AS $$
BEGIN
    PERFORM complete_expired_votings();
    PERFORM unfreeze_expired_members();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Helper: Notify all group members
CREATE OR REPLACE FUNCTION notify_group_members(
    p_group_id UUID,
    p_type TEXT,
    p_text TEXT,
    p_exclude_user UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO notifications (user_id, type, text)
    SELECT gm.user_id, p_type, p_text
    FROM group_members gm
    WHERE gm.group_id = p_group_id
      AND (p_exclude_user IS NULL OR gm.user_id != p_exclude_user);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Missing RLS INSERT policies

-- freeze_targets: voting creators can add freeze targets
CREATE POLICY "Voting creators can add freeze targets"
    ON freeze_targets FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM votings v
            WHERE v.id = freeze_targets.voting_id
              AND v.created_by = auth.uid()
              AND v.type = 'freeze'
        )
    );

-- notifications: authenticated users can insert
CREATE POLICY "Authenticated users can create notifications"
    ON notifications FOR INSERT TO authenticated
    WITH CHECK (TRUE);

-- group_history: group members can insert history
CREATE POLICY "Members can add group history"
    ON group_history FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM group_members gm
            WHERE gm.group_id = group_history.group_id
              AND gm.user_id = auth.uid()
        )
    );
