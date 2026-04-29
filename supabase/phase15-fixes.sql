-- =====================================================================
-- PHASE 15 FIXES (2026-04-29)
--
-- Fix #1 (CRITICAL — RLS forgery):
--   Policy "Authors can delete own votings" had USING but no WITH CHECK.
--   An author could UPDATE result, status='completed', completed_at,
--   target_member_id, etc. — i.e. forge the outcome of their own voting.
--   This phase replaces it with a strict policy that only allows the one
--   legitimate user-side UPDATE: soft-delete an active voting.
--
-- Fix #3 (PROD BUG — observers counted in quorum denominator):
--   `complete_expired_votings` counted ALL group_members (including
--   observers introduced in phase 14) as `total_members`, so the
--   majority threshold was inflated by non-voters. With observers in a
--   group, a passing voting could flip to `rejected` even when every
--   eligible voter said yes. Recalc denominator using only voters
--   (is_observer = FALSE).
--
-- Side-effects logic preserved verbatim from phase7-fixes.sql; only the
-- denominator changes plus a defensive guard for total_voters = 0.
-- =====================================================================


-- 1. ----- Lock down votings UPDATE policy ---------------------------
DROP POLICY IF EXISTS "Authors can delete own votings" ON votings;

CREATE POLICY "Authors can soft-delete own active votings"
    ON votings FOR UPDATE TO authenticated
    USING (
        created_by = auth.uid()
        AND status = 'active'
    )
    WITH CHECK (
        created_by = auth.uid()
        AND status = 'deleted'
        AND result IS NULL
        AND completed_at IS NULL
    );

-- Notes on the fix:
--   USING       — only the author of an *active* voting matches the row
--                 (a completed/deleted voting is no longer updatable).
--   WITH CHECK  — the only allowed transition is active → deleted with
--                 result/completed_at left NULL. The author cannot set
--                 status='completed' or fill `result` themselves.
--
-- System functions (`complete_expired_votings`, `check_freeze_objections`)
-- run SECURITY DEFINER as the table owner and bypass RLS, so they remain
-- free to set status='completed' / result / completed_at.


-- 2. ----- complete_expired_votings: voters-only denominator ---------
CREATE OR REPLACE FUNCTION complete_expired_votings()
RETURNS void AS $$
DECLARE
    v RECORD;
    yes_count INTEGER;
    no_count INTEGER;
    total_voters INTEGER;
    v_result TEXT;
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

        -- PHASE 15 FIX: count only eligible voters, not observers.
        SELECT COUNT(*) INTO total_voters
            FROM group_members
            WHERE group_id = v.group_id
              AND is_observer = FALSE;

        -- Defensive: a group with zero voters cannot accept anything.
        IF total_voters > 0 AND yes_count > total_voters / 2 THEN
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


-- 3. ----- Force-run once so any active votings stuck on the broken
--          observer-inflated denominator get re-evaluated immediately.
SELECT complete_expired_votings();


-- 4. ----- Verification ---------------------------------------------
-- Confirm the policy now has WITH CHECK and the function references is_observer.
SELECT
    'votings UPDATE policies' AS what,
    string_agg(policyname || ' [' || cmd || ']', ', ') AS detail
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'votings' AND cmd = 'UPDATE'
UNION ALL
SELECT
    'complete_expired_votings excludes observers',
    CASE WHEN pg_get_functiondef(oid) ILIKE '%is_observer = FALSE%'
         THEN 'OK' ELSE 'FAIL' END
FROM pg_proc WHERE proname = 'complete_expired_votings';
