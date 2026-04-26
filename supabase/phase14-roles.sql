-- =====================================================================
-- PHASE 14 — Voter / Observer roles + per-group apartment (2026-04-27)
--
-- - Adds default_role to profiles (voter/observer hint for join form).
-- - Adds is_observer + apartment to group_members.
-- - Adds requested_as_observer + apartment + is_role_change to join_requests.
-- - Unique partial index: only one VOTER per (group_id, apartment).
-- - submit_join_request_v2 RPC with apartment-conflict check at submit.
-- - request_role_change RPC for existing members switching role
--   (both directions go through admin per user decision B).
-- - approve_join_request_v2 RPC handles new joins + role changes,
--   with optional p_force_observer for the race-collision case.
-- - Backfill: existing members become voters with apartment from profiles.
-- =====================================================================

-- 1. Profile default role -------------------------------------------------
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS default_role TEXT NOT NULL DEFAULT 'voter'
        CHECK (default_role IN ('voter', 'observer'));


-- 2. Group members role + apartment --------------------------------------
ALTER TABLE group_members
    ADD COLUMN IF NOT EXISTS is_observer BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE group_members
    ADD COLUMN IF NOT EXISTS apartment TEXT;

-- Backfill apartment from profiles for existing members
UPDATE group_members gm
SET apartment = p.apartment
FROM profiles p
WHERE gm.user_id = p.id
  AND gm.apartment IS NULL
  AND p.apartment IS NOT NULL
  AND length(trim(p.apartment)) > 0;

-- Unique constraint: only one VOTER per apartment per group
CREATE UNIQUE INDEX IF NOT EXISTS group_members_voter_apartment_uniq
    ON group_members(group_id, apartment)
    WHERE is_observer = FALSE AND apartment IS NOT NULL;


-- 3. Join requests extension ---------------------------------------------
ALTER TABLE join_requests
    ADD COLUMN IF NOT EXISTS apartment TEXT;

ALTER TABLE join_requests
    ADD COLUMN IF NOT EXISTS requested_as_observer BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE join_requests
    ADD COLUMN IF NOT EXISTS is_role_change BOOLEAN NOT NULL DEFAULT FALSE;


-- 4. Submit join request RPC (with apartment conflict check) -------------
-- Returns request_id, or raises with code 'apartment_taken' on conflict.
DROP FUNCTION IF EXISTS submit_join_request_v2(UUID, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION submit_join_request_v2(
    p_group_id UUID,
    p_apartment TEXT,
    p_as_observer BOOLEAN
)
RETURNS UUID AS $$
DECLARE
    v_user_id UUID;
    v_request_id UUID;
    v_existing_voter_name TEXT;
    v_user_name TEXT;
    v_group_name TEXT;
    v_admin_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'not_authenticated';
    END IF;

    IF p_apartment IS NULL OR length(trim(p_apartment)) = 0 THEN
        RAISE EXCEPTION 'apartment_required';
    END IF;

    -- Already a member?
    IF EXISTS (SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = v_user_id) THEN
        RAISE EXCEPTION 'already_member';
    END IF;

    -- Already pending request?
    IF EXISTS (
        SELECT 1 FROM join_requests
        WHERE group_id = p_group_id AND user_id = v_user_id AND status = 'pending'
    ) THEN
        RAISE EXCEPTION 'already_pending';
    END IF;

    -- Voter conflict check (only for voter role)
    IF NOT p_as_observer THEN
        SELECT TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, ''))
        INTO v_existing_voter_name
        FROM group_members gm
        LEFT JOIN profiles p ON p.id = gm.user_id
        WHERE gm.group_id = p_group_id
          AND gm.is_observer = FALSE
          AND gm.apartment = trim(p_apartment)
        LIMIT 1;

        IF v_existing_voter_name IS NOT NULL THEN
            -- Encoded so client can parse: "apartment_taken:<name>"
            RAISE EXCEPTION 'apartment_taken:%', COALESCE(NULLIF(v_existing_voter_name, ''), 'інший учасник');
        END IF;
    END IF;

    -- All clear — insert
    INSERT INTO join_requests (group_id, user_id, apartment, requested_as_observer, is_role_change)
    VALUES (p_group_id, v_user_id, trim(p_apartment), p_as_observer, FALSE)
    RETURNING id INTO v_request_id;

    -- Notify admin
    SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
    INTO v_user_name FROM profiles WHERE id = v_user_id;
    IF v_user_name = '' OR v_user_name IS NULL THEN v_user_name := 'User'; END IF;

    SELECT name INTO v_group_name FROM groups WHERE id = p_group_id;

    SELECT user_id INTO v_admin_id
    FROM group_members
    WHERE group_id = p_group_id AND role = 'admin'
    LIMIT 1;

    IF v_admin_id IS NOT NULL THEN
        INSERT INTO notifications (user_id, type, text, metadata)
        VALUES (
            v_admin_id,
            'join_request',
            v_user_name || ' хоче приєднатися до групи "' || v_group_name || '" (кв.' || trim(p_apartment) ||
                CASE WHEN p_as_observer THEN ', спостерігач)' ELSE ', голосуючий)' END,
            jsonb_build_object(
                'group_id', p_group_id,
                'request_id', v_request_id,
                'requester_id', v_user_id,
                'requester_name', v_user_name,
                'group_name', v_group_name,
                'apartment', trim(p_apartment),
                'as_observer', p_as_observer
            )
        );
    END IF;

    RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION submit_join_request_v2(UUID, TEXT, BOOLEAN) TO authenticated;


-- 5. Request role change (existing member voter↔observer via admin) ------
-- voter→observer: pending request, admin approves (per decision B)
-- observer→voter: same flow, but submit-time check on apartment slot
DROP FUNCTION IF EXISTS request_role_change(UUID, BOOLEAN);
CREATE OR REPLACE FUNCTION request_role_change(
    p_group_id UUID,
    p_become_observer BOOLEAN
)
RETURNS UUID AS $$
DECLARE
    v_user_id UUID;
    v_member RECORD;
    v_request_id UUID;
    v_existing_voter_name TEXT;
    v_user_name TEXT;
    v_group_name TEXT;
    v_admin_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'not_authenticated';
    END IF;

    -- Must be a member
    SELECT * INTO v_member
    FROM group_members
    WHERE group_id = p_group_id AND user_id = v_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'not_member';
    END IF;

    -- No-op?
    IF v_member.is_observer = p_become_observer THEN
        RAISE EXCEPTION 'already_in_role';
    END IF;

    -- Apartment must exist on the membership for any role change
    IF v_member.apartment IS NULL OR length(trim(v_member.apartment)) = 0 THEN
        RAISE EXCEPTION 'apartment_missing_on_membership';
    END IF;

    -- Admin cannot become observer
    IF v_member.role = 'admin' AND p_become_observer THEN
        RAISE EXCEPTION 'admin_cannot_be_observer';
    END IF;

    -- No duplicate pending request
    IF EXISTS (
        SELECT 1 FROM join_requests
        WHERE group_id = p_group_id AND user_id = v_user_id AND status = 'pending'
    ) THEN
        RAISE EXCEPTION 'already_pending';
    END IF;

    -- For observer→voter: check apartment slot at submit
    IF NOT p_become_observer THEN
        SELECT TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, ''))
        INTO v_existing_voter_name
        FROM group_members gm
        LEFT JOIN profiles p ON p.id = gm.user_id
        WHERE gm.group_id = p_group_id
          AND gm.is_observer = FALSE
          AND gm.apartment = v_member.apartment
          AND gm.user_id <> v_user_id
        LIMIT 1;

        IF v_existing_voter_name IS NOT NULL THEN
            RAISE EXCEPTION 'apartment_taken:%', COALESCE(NULLIF(v_existing_voter_name, ''), 'інший учасник');
        END IF;
    END IF;

    -- Create role-change request
    INSERT INTO join_requests (group_id, user_id, apartment, requested_as_observer, is_role_change, status)
    VALUES (p_group_id, v_user_id, v_member.apartment, p_become_observer, TRUE, 'pending')
    RETURNING id INTO v_request_id;

    -- Notify admin
    SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
    INTO v_user_name FROM profiles WHERE id = v_user_id;
    IF v_user_name = '' OR v_user_name IS NULL THEN v_user_name := 'User'; END IF;

    SELECT name INTO v_group_name FROM groups WHERE id = p_group_id;

    SELECT user_id INTO v_admin_id
    FROM group_members
    WHERE group_id = p_group_id AND role = 'admin'
    LIMIT 1;

    IF v_admin_id IS NOT NULL AND v_admin_id <> v_user_id THEN
        INSERT INTO notifications (user_id, type, text, metadata)
        VALUES (
            v_admin_id,
            'role_change_request',
            v_user_name || ' просить змінити роль у групі "' || v_group_name || '" (кв.' || v_member.apartment || ' → ' ||
                CASE WHEN p_become_observer THEN 'спостерігач)' ELSE 'голосуючий)' END,
            jsonb_build_object(
                'group_id', p_group_id,
                'request_id', v_request_id,
                'requester_id', v_user_id,
                'requester_name', v_user_name,
                'group_name', v_group_name,
                'apartment', v_member.apartment,
                'as_observer', p_become_observer,
                'is_role_change', TRUE
            )
        );
    END IF;

    RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION request_role_change(UUID, BOOLEAN) TO authenticated;


-- 6. Approve join request (v2 — handles new joins + role changes) --------
-- p_force_observer: admin override for race-collision scenario.
DROP FUNCTION IF EXISTS approve_join_request_v2(UUID, BOOLEAN);
CREATE OR REPLACE FUNCTION approve_join_request_v2(
    p_request_id UUID,
    p_force_observer BOOLEAN DEFAULT FALSE
)
RETURNS VOID AS $$
DECLARE
    v_request RECORD;
    v_final_observer BOOLEAN;
    v_existing_voter_id UUID;
BEGIN
    -- Authorize: admin of the group
    SELECT jr.* INTO v_request
    FROM join_requests jr
    JOIN group_members gm ON gm.group_id = jr.group_id
    WHERE jr.id = p_request_id AND jr.status = 'pending'
      AND gm.user_id = auth.uid() AND gm.role = 'admin';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_not_found_or_not_admin';
    END IF;

    -- Decide final role
    v_final_observer := v_request.requested_as_observer OR p_force_observer;

    -- Voter slot still free? (re-check at approval time)
    IF NOT v_final_observer AND v_request.apartment IS NOT NULL THEN
        SELECT user_id INTO v_existing_voter_id
        FROM group_members
        WHERE group_id = v_request.group_id
          AND is_observer = FALSE
          AND apartment = v_request.apartment
          AND user_id <> v_request.user_id
        LIMIT 1;

        IF v_existing_voter_id IS NOT NULL THEN
            RAISE EXCEPTION 'apartment_taken_now';
        END IF;
    END IF;

    -- Apply
    UPDATE join_requests
    SET status = 'approved', resolved_at = now(), resolved_by = auth.uid()
    WHERE id = p_request_id;

    IF v_request.is_role_change THEN
        UPDATE group_members
        SET is_observer = v_final_observer
        WHERE group_id = v_request.group_id AND user_id = v_request.user_id;
    ELSE
        INSERT INTO group_members (group_id, user_id, role, is_observer, apartment)
        VALUES (
            v_request.group_id, v_request.user_id, 'member',
            v_final_observer, v_request.apartment
        );
    END IF;

    -- Notify the requester
    INSERT INTO notifications (user_id, type, text, metadata)
    VALUES (
        v_request.user_id,
        CASE WHEN v_request.is_role_change THEN 'role_change_approved' ELSE 'join_approved' END,
        CASE
            WHEN v_request.is_role_change THEN
                'Адмін затвердив зміну ролі: ви тепер ' ||
                CASE WHEN v_final_observer THEN 'спостерігач' ELSE 'голосуючий' END
            ELSE
                'Заявку на приєднання прийнято' ||
                CASE WHEN v_final_observer AND NOT v_request.requested_as_observer
                     THEN ' (як спостерігач — кв. вже зайнята)'
                     ELSE ''
                END
        END,
        jsonb_build_object('group_id', v_request.group_id, 'as_observer', v_final_observer)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION approve_join_request_v2(UUID, BOOLEAN) TO authenticated;


-- 7. Helper RPC: count voters in a group (for client-side quorum) --------
DROP FUNCTION IF EXISTS get_voter_count(UUID);
CREATE OR REPLACE FUNCTION get_voter_count(p_group_id UUID)
RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
    SELECT count(*) INTO v_count
    FROM group_members
    WHERE group_id = p_group_id AND is_observer = FALSE;
    RETURN COALESCE(v_count, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION get_voter_count(UUID) TO authenticated;


-- 8. Block observers from voting (RLS update) ----------------------------
-- Existing votes INSERT policy probably checks membership only. Add observer block.
DROP POLICY IF EXISTS "Members can vote" ON votes;
CREATE POLICY "Members (voters only) can vote" ON votes
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM votings v
            JOIN group_members gm ON gm.group_id = v.group_id
            WHERE v.id = votes.voting_id
              AND gm.user_id = auth.uid()
              AND gm.is_observer = FALSE
              AND v.status = 'active'
        )
    );


-- 9. Verification --------------------------------------------------------
-- Show post-migration state
SELECT 'profiles.default_role' AS what, count(*)::text AS detail
    FROM profiles WHERE default_role IS NOT NULL
UNION ALL
SELECT 'group_members.is_observer = false (voters)', count(*)::text
    FROM group_members WHERE is_observer = FALSE
UNION ALL
SELECT 'group_members.is_observer = true (observers)', count(*)::text
    FROM group_members WHERE is_observer = TRUE
UNION ALL
SELECT 'group_members with apartment', count(*)::text
    FROM group_members WHERE apartment IS NOT NULL
UNION ALL
SELECT 'group_members WITHOUT apartment (legacy)', count(*)::text
    FROM group_members WHERE apartment IS NULL;
