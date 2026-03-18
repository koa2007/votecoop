-- ============================================
-- Phase 3: Critical Fixes
-- Run in Supabase SQL Editor
-- ============================================

-- =====================
-- 1. SECURITY DEFINER helper functions for RLS
-- These bypass RLS to check membership without recursion
-- =====================

CREATE OR REPLACE FUNCTION is_group_member(p_group_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = p_group_id AND user_id = p_user_id
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION is_group_admin(p_group_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = p_group_id AND user_id = p_user_id AND role = 'admin'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- =====================
-- 2. Fix self-referencing RLS on group_members
-- Drop old policies, create new ones using helper functions
-- =====================

DROP POLICY IF EXISTS "Members visible to group members" ON group_members;
DROP POLICY IF EXISTS "Admins can manage members" ON group_members;

-- Members can see their own membership rows
CREATE POLICY "Members can see own memberships"
    ON group_members FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Members can see other members of their groups (via helper)
CREATE POLICY "Members can see fellow group members"
    ON group_members FOR SELECT TO authenticated
    USING (is_group_member(group_id, auth.uid()));

-- Admins can insert/update/delete members
CREATE POLICY "Admins can insert members"
    ON group_members FOR INSERT TO authenticated
    WITH CHECK (is_group_admin(group_id, auth.uid()));

CREATE POLICY "Admins can update members"
    ON group_members FOR UPDATE TO authenticated
    USING (is_group_admin(group_id, auth.uid()));

CREATE POLICY "Admins can delete members"
    ON group_members FOR DELETE TO authenticated
    USING (is_group_admin(group_id, auth.uid()));

-- =====================
-- 3. Fix groups SELECT policy (also referenced group_members directly)
-- =====================

DROP POLICY IF EXISTS "Groups visible to members" ON groups;

CREATE POLICY "Groups visible to members"
    ON groups FOR SELECT TO authenticated
    USING (is_group_member(id, auth.uid()));

-- =====================
-- 4. Fix join_requests policies (referenced group_members directly)
-- =====================

DROP POLICY IF EXISTS "Join requests visible to admins and requester" ON join_requests;
DROP POLICY IF EXISTS "Admins can update join requests" ON join_requests;

CREATE POLICY "Join requests visible to admins and requester"
    ON join_requests FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR is_group_admin(group_id, auth.uid())
    );

CREATE POLICY "Admins can update join requests"
    ON join_requests FOR UPDATE TO authenticated
    USING (is_group_admin(group_id, auth.uid()));

-- =====================
-- 5. Fix votings policies (referenced group_members directly)
-- =====================

DROP POLICY IF EXISTS "Votings visible to group members" ON votings;
DROP POLICY IF EXISTS "Group members can create votings" ON votings;

CREATE POLICY "Votings visible to group members"
    ON votings FOR SELECT TO authenticated
    USING (is_group_member(group_id, auth.uid()));

CREATE POLICY "Group members can create votings"
    ON votings FOR INSERT TO authenticated
    WITH CHECK (
        created_by = auth.uid()
        AND is_group_member(group_id, auth.uid())
    );

-- =====================
-- 6. Fix votes policies
-- =====================

DROP POLICY IF EXISTS "Members can cast votes" ON votes;
DROP POLICY IF EXISTS "Vote visibility based on voting type" ON votes;

CREATE POLICY "Members can cast votes"
    ON votes FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM votings v
            WHERE v.id = votes.voting_id
              AND v.status = 'active'
              AND is_group_member(v.group_id, auth.uid())
        )
    );

CREATE POLICY "Vote visibility based on voting type"
    ON votes FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM votings v
            WHERE v.id = votes.voting_id
              AND v.type != 'secret'
              AND is_group_member(v.group_id, auth.uid())
        )
    );

-- =====================
-- 7. Fix freeze policies
-- =====================

DROP POLICY IF EXISTS "Freeze targets visible to group members" ON freeze_targets;
DROP POLICY IF EXISTS "Freeze objections visible to group members" ON freeze_objections;
DROP POLICY IF EXISTS "Members can object to freeze" ON freeze_objections;

CREATE POLICY "Freeze targets visible to group members"
    ON freeze_targets FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM votings v
            WHERE v.id = freeze_targets.voting_id
              AND is_group_member(v.group_id, auth.uid())
        )
    );

CREATE POLICY "Freeze objections visible to group members"
    ON freeze_objections FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM votings v
            WHERE v.id = freeze_objections.voting_id
              AND is_group_member(v.group_id, auth.uid())
        )
    );

-- Fix: add group membership check to freeze objections INSERT
CREATE POLICY "Group members can object to freeze"
    ON freeze_objections FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM votings v
            WHERE v.id = freeze_objections.voting_id
              AND v.status = 'active'
              AND v.type = 'freeze'
              AND is_group_member(v.group_id, auth.uid())
        )
    );

-- =====================
-- 8. Fix group_history policy
-- =====================

DROP POLICY IF EXISTS "History visible to group members" ON group_history;
DROP POLICY IF EXISTS "Members can add group history" ON group_history;

CREATE POLICY "History visible to group members"
    ON group_history FOR SELECT TO authenticated
    USING (is_group_member(group_id, auth.uid()));

CREATE POLICY "Members can add group history"
    ON group_history FOR INSERT TO authenticated
    WITH CHECK (is_group_member(group_id, auth.uid()));

-- =====================
-- 9. Fix notifications INSERT policy (too permissive)
-- =====================

DROP POLICY IF EXISTS "Authenticated users can create notifications" ON notifications;

-- Only allow creating notifications for yourself (RPC handles group notifications)
CREATE POLICY "Users can create own notifications"
    ON notifications FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

-- =====================
-- 10. Fix notify_group_members to verify caller is a member
-- =====================

CREATE OR REPLACE FUNCTION notify_group_members(
    p_group_id UUID,
    p_type TEXT,
    p_text TEXT,
    p_exclude_user UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    -- Verify caller is a member of the group
    IF NOT is_group_member(p_group_id, auth.uid()) THEN
        RAISE EXCEPTION 'You are not a member of this group';
    END IF;

    INSERT INTO notifications (user_id, type, text)
    SELECT gm.user_id, p_type, p_text
    FROM group_members gm
    WHERE gm.group_id = p_group_id
      AND (p_exclude_user IS NULL OR gm.user_id != p_exclude_user);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- =====================
-- 11. Fix complete_expired_votings to use freeze_duration_days
-- =====================

CREATE OR REPLACE FUNCTION complete_expired_votings()
RETURNS void AS $$
DECLARE
    v RECORD;
    yes_count INTEGER;
    no_count INTEGER;
    total_members INTEGER;
    result TEXT;
BEGIN
    FOR v IN
        SELECT * FROM votings
        WHERE status = 'active' AND ends_at <= now()
    LOOP
        SELECT COUNT(*) INTO yes_count FROM votes
            WHERE voting_id = v.id AND choice = 'yes';
        SELECT COUNT(*) INTO no_count FROM votes
            WHERE voting_id = v.id AND choice = 'no';
        SELECT COUNT(*) INTO total_members
            FROM group_members WHERE group_id = v.group_id;

        IF yes_count > no_count THEN
            result := 'approved';
        ELSE
            result := 'rejected';
        END IF;

        UPDATE votings SET status = 'completed', result = result
            WHERE id = v.id;

        IF result = 'approved' THEN
            CASE v.type
                WHEN 'admin-change' THEN
                    UPDATE group_members SET role = 'member'
                        WHERE group_id = v.group_id AND role = 'admin';
                    UPDATE group_members SET role = 'admin'
                        WHERE group_id = v.group_id AND user_id = v.target_member_id;
                WHEN 'remove-member' THEN
                    DELETE FROM group_members
                        WHERE group_id = v.group_id AND user_id = v.target_member_id;
                WHEN 'freeze' THEN
                    UPDATE group_members
                        SET is_frozen = TRUE,
                            frozen_until = now() + ((COALESCE(v.freeze_duration_days, 7))::TEXT || ' days')::INTERVAL
                        WHERE group_id = v.group_id
                        AND user_id IN (SELECT user_id FROM freeze_targets WHERE voting_id = v.id);
            END CASE;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- =====================
-- 12. Add search_path to existing SECURITY DEFINER functions
-- =====================

-- Recreate handle_new_user with search_path
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, email, first_name, last_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
        COALESCE(NEW.raw_user_meta_data->>'last_name', '')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Recreate check_freeze_objections with search_path
CREATE OR REPLACE FUNCTION check_freeze_objections()
RETURNS TRIGGER AS $$
DECLARE
    v RECORD;
    objection_count INTEGER;
BEGIN
    SELECT * INTO v FROM votings WHERE id = NEW.voting_id;

    IF v.type = 'freeze' AND v.status = 'active' THEN
        SELECT COUNT(*) INTO objection_count
        FROM freeze_objections WHERE voting_id = v.id;

        IF objection_count >= 2 THEN
            UPDATE votings SET status = 'completed', result = 'rejected'
            WHERE id = v.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Recreate unfreeze_expired_members with search_path
CREATE OR REPLACE FUNCTION unfreeze_expired_members()
RETURNS void AS $$
BEGIN
    UPDATE group_members
    SET is_frozen = FALSE, frozen_until = NULL
    WHERE is_frozen = TRUE AND frozen_until <= now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Recreate create_group_with_member with search_path
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Recreate approve_join_request with search_path
CREATE OR REPLACE FUNCTION approve_join_request(
    p_request_id UUID
)
RETURNS VOID AS $$
DECLARE
    v_request RECORD;
BEGIN
    SELECT jr.* INTO v_request
    FROM join_requests jr
    WHERE jr.id = p_request_id
      AND jr.status = 'pending'
      AND is_group_admin(jr.group_id, auth.uid());

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request not found or you are not admin';
    END IF;

    UPDATE join_requests
    SET status = 'approved', resolved_at = now(), resolved_by = auth.uid()
    WHERE id = p_request_id;

    INSERT INTO group_members (group_id, user_id, role)
    VALUES (v_request.group_id, v_request.user_id, 'member')
    ON CONFLICT (group_id, user_id) DO NOTHING;

    RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Recreate find_group_by_code with search_path
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Recreate check_my_expired_votings with search_path
CREATE OR REPLACE FUNCTION check_my_expired_votings()
RETURNS VOID AS $$
BEGIN
    PERFORM complete_expired_votings();
    PERFORM unfreeze_expired_members();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
