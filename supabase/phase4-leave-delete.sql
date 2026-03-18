-- ============================================
-- Phase 4: Leave Group + Delete-Group Voting
-- ============================================
-- 1. Add 'delete-group' to voting type CHECK constraint
-- 2. RLS policy for members to leave group
-- 3. RPC function leave_group()
-- 4. Update complete_expired_votings() with delete-group branch

-- =====================
-- 1. Extend voting type CHECK constraint
-- =====================
ALTER TABLE votings DROP CONSTRAINT IF EXISTS votings_type_check;
ALTER TABLE votings ADD CONSTRAINT votings_type_check
    CHECK (type IN ('simple', 'secret', 'admin-change', 'remove-member', 'freeze', 'delete-group'));

-- =====================
-- 2. RLS policy: members can leave group (self-delete, non-admin only)
-- =====================
DROP POLICY IF EXISTS "Members can leave group" ON group_members;
CREATE POLICY "Members can leave group"
    ON group_members FOR DELETE TO authenticated
    USING (user_id = auth.uid() AND role != 'admin');

-- =====================
-- 3. RPC function: leave_group
-- =====================
CREATE OR REPLACE FUNCTION leave_group(p_group_id UUID)
RETURNS VOID AS $$
DECLARE
    v_user_id UUID;
    v_role TEXT;
    v_user_name TEXT;
    v_admin_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Check membership and role
    SELECT role INTO v_role
    FROM group_members
    WHERE group_id = p_group_id AND user_id = v_user_id;

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'You are not a member of this group';
    END IF;

    IF v_role = 'admin' THEN
        RAISE EXCEPTION 'Admin cannot leave group. Transfer admin role first.';
    END IF;

    -- Get user name for notification
    SELECT COALESCE(first_name || ' ' || last_name, 'User')
    INTO v_user_name
    FROM profiles WHERE id = v_user_id;

    -- Get admin ID for notification
    SELECT user_id INTO v_admin_id
    FROM group_members
    WHERE group_id = p_group_id AND role = 'admin'
    LIMIT 1;

    -- Delete membership
    DELETE FROM group_members
    WHERE group_id = p_group_id AND user_id = v_user_id;

    -- Write to group history
    INSERT INTO group_history (group_id, action, details, initiated_by)
    VALUES (
        p_group_id,
        'member_left',
        jsonb_build_object('user_id', v_user_id, 'user_name', v_user_name),
        v_user_id
    );

    -- Notify admin that member left
    IF v_admin_id IS NOT NULL THEN
        INSERT INTO notifications (user_id, type, text)
        VALUES (
            v_admin_id,
            'member',
            v_user_name || ' покинув(ла) групу'
        );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- =====================
-- 4. Update complete_expired_votings with delete-group branch
-- =====================
CREATE OR REPLACE FUNCTION complete_expired_votings()
RETURNS void AS $$
DECLARE
    v RECORD;
    yes_count INTEGER;
    no_count INTEGER;
    total_members INTEGER;
    result TEXT;
    v_group_name TEXT;
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

        IF yes_count > total_members / 2 THEN
            result := 'accepted';
        ELSE
            result := 'rejected';
        END IF;

        UPDATE votings SET status = 'completed', result = result, completed_at = now()
            WHERE id = v.id;

        IF result = 'accepted' THEN
            CASE v.type
                WHEN 'admin-change' THEN
                    UPDATE group_members SET role = 'member'
                        WHERE group_id = v.group_id AND role = 'admin';
                    UPDATE group_members SET role = 'admin'
                        WHERE group_id = v.group_id AND user_id = v.target_member_id;

                    INSERT INTO group_history (group_id, action, details, voting_id)
                    VALUES (v.group_id, 'admin_change',
                        jsonb_build_object('new_admin', v.target_member_id), v.id);

                WHEN 'remove-member' THEN
                    DELETE FROM group_members
                        WHERE group_id = v.group_id AND user_id = v.target_member_id;

                    INSERT INTO group_history (group_id, action, details, voting_id)
                    VALUES (v.group_id, 'member_removed',
                        jsonb_build_object('removed_user', v.target_member_id,
                            'reason', v.removal_reason), v.id);

                WHEN 'freeze' THEN
                    UPDATE group_members
                        SET is_frozen = TRUE,
                            frozen_until = now() + ((COALESCE(v.freeze_duration_days, 7))::TEXT || ' days')::INTERVAL
                        WHERE group_id = v.group_id
                        AND user_id IN (SELECT user_id FROM freeze_targets WHERE voting_id = v.id);

                    INSERT INTO group_history (group_id, action, details, voting_id)
                    VALUES (v.group_id, 'members_frozen',
                        jsonb_build_object('voting_id', v.id), v.id);

                WHEN 'delete-group' THEN
                    -- Get group name BEFORE deletion
                    SELECT name INTO v_group_name
                    FROM groups WHERE id = v.group_id;

                    -- Notify ALL members BEFORE cascade deletion
                    INSERT INTO notifications (user_id, type, text)
                    SELECT gm.user_id, 'system',
                        'Групу "' || COALESCE(v_group_name, '') || '" видалено за результатами голосування'
                    FROM group_members gm
                    WHERE gm.group_id = v.group_id;

                    -- Delete group (CASCADE removes group_members, votings, join_requests, group_history)
                    DELETE FROM groups WHERE id = v.group_id;

            END CASE;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
