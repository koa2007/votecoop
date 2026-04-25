-- =====================================================================
-- PHASE 7 FIXES (2026-04-25)
-- 1. Fix `complete_expired_votings`:
--    Local variable `result` shadowed table column `votings.result`,
--    causing: column reference "result" is ambiguous.
--    Rename local var → `v_result`.
-- 2. Add `get_group_member_votes` RPC: returns per-user vote counts
--    so the client can render per-member participation correctly
--    (previously the client checked `comments` which were never loaded).
-- =====================================================================

-- 1. ----- Fix complete_expired_votings -------------------------------
CREATE OR REPLACE FUNCTION complete_expired_votings()
RETURNS void AS $$
DECLARE
    v RECORD;
    yes_count INTEGER;
    no_count INTEGER;
    total_members INTEGER;
    v_result TEXT;          -- renamed from `result` to avoid column clash
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
            v_result := 'accepted';
        ELSE
            v_result := 'rejected';
        END IF;

        UPDATE votings
        SET status = 'completed',
            result = v_result,
            completed_at = now()
        WHERE id = v.id;

        IF v_result = 'accepted' THEN
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
                    SELECT name INTO v_group_name FROM groups WHERE id = v.group_id;

                    INSERT INTO notifications (user_id, type, text)
                    SELECT gm.user_id, 'system',
                        'Групу "' || COALESCE(v_group_name, '') || '" видалено за результатами голосування'
                    FROM group_members gm
                    WHERE gm.group_id = v.group_id;

                    DELETE FROM groups WHERE id = v.group_id;

                ELSE
                    -- 'simple' / 'secret' / fallback — no side-effects beyond status
                    NULL;
            END CASE;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;


-- 2. ----- Per-member vote counts for a group -------------------------
-- Returns: rows of (user_id, voted_count) so the client can compute
-- "X out of Y votings" per group member without separate queries.
CREATE OR REPLACE FUNCTION get_group_member_votes(p_group_id UUID)
RETURNS TABLE (user_id UUID, voted_count BIGINT) AS $$
BEGIN
    -- Caller must be a member of the group
    IF NOT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = p_group_id AND group_members.user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Not a member of this group';
    END IF;

    RETURN QUERY
    SELECT vt.user_id, COUNT(*)::BIGINT AS voted_count
    FROM votes vt
    JOIN votings v ON v.id = vt.voting_id
    WHERE v.group_id = p_group_id
      AND v.status != 'deleted'
    GROUP BY vt.user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION get_group_member_votes(UUID) TO authenticated;


-- 3. ----- Force-run expiry once so the UI clears existing stuck rows -
SELECT complete_expired_votings();
