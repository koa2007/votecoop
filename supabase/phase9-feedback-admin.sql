-- =====================================================================
-- PHASE 9 — Feedback table + admin helpers (2026-04-26)
-- 1. feedback table (any user can submit, only admin can read).
-- 2. is_admin() helper using the env-pinned admin email koa2007@gmail.com.
-- 3. get_admin_stats() RPC — single call returning aggregated counts.
-- =====================================================================

-- 0. Admin check ------------------------------------------------------
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
DECLARE
    v_email TEXT;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    RETURN v_email = 'koa2007@gmail.com';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;


-- 1. Feedback table ---------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    text TEXT NOT NULL CHECK (length(text) BETWEEN 5 AND 2000),
    user_email TEXT,
    user_name TEXT,
    user_agent TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','done')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Insert own feedback" ON feedback;
CREATE POLICY "Insert own feedback" ON feedback
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

DROP POLICY IF EXISTS "Admin reads feedback" ON feedback;
CREATE POLICY "Admin reads feedback" ON feedback
    FOR SELECT TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admin updates feedback status" ON feedback;
CREATE POLICY "Admin updates feedback status" ON feedback
    FOR UPDATE TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at DESC);


-- 2. Admin stats RPC --------------------------------------------------
-- Returns aggregated counts in one call so the admin dashboard can render
-- without N round-trips. Caller MUST be admin or RPC raises.
CREATE OR REPLACE FUNCTION get_admin_stats()
RETURNS JSONB AS $$
DECLARE
    result JSONB;
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'forbidden';
    END IF;

    SELECT jsonb_build_object(
        'users_total',         (SELECT count(*) FROM profiles),
        'users_completed',     (SELECT count(*) FROM profiles WHERE profile_completed = true),
        'users_last_24h',      (SELECT count(*) FROM profiles WHERE created_at > now() - interval '24 hours'),
        'users_last_7d',       (SELECT count(*) FROM profiles WHERE created_at > now() - interval '7 days'),
        'groups_total',        (SELECT count(*) FROM groups),
        'groups_last_7d',      (SELECT count(*) FROM groups WHERE created_at > now() - interval '7 days'),
        'votings_total',       (SELECT count(*) FROM votings WHERE status != 'deleted'),
        'votings_active',      (SELECT count(*) FROM votings WHERE status = 'active'),
        'votings_completed',   (SELECT count(*) FROM votings WHERE status = 'completed'),
        'votings_accepted',    (SELECT count(*) FROM votings WHERE status = 'completed' AND result = 'accepted'),
        'votings_rejected',    (SELECT count(*) FROM votings WHERE status = 'completed' AND result = 'rejected'),
        'votes_total',         (SELECT count(*) FROM votes),
        'feedback_total',      (SELECT count(*) FROM feedback),
        'feedback_new',        (SELECT count(*) FROM feedback WHERE status = 'new'),
        'memberships_total',   (SELECT count(*) FROM group_members)
    ) INTO result;

    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION get_admin_stats() TO authenticated;


-- 3. Admin: recent users -----------------------------------------------
CREATE OR REPLACE FUNCTION get_admin_recent_users(p_limit INT DEFAULT 50)
RETURNS TABLE (
    id UUID,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    apartment TEXT,
    profile_completed BOOLEAN,
    created_at TIMESTAMPTZ,
    groups_count BIGINT
) AS $$
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'forbidden';
    END IF;
    RETURN QUERY
    SELECT
        p.id, p.first_name, p.last_name,
        au.email::TEXT, p.apartment, p.profile_completed, p.created_at,
        (SELECT count(*) FROM group_members gm WHERE gm.user_id = p.id) AS groups_count
    FROM profiles p
    LEFT JOIN auth.users au ON au.id = p.id
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION get_admin_recent_users(INT) TO authenticated;


-- 4. Admin: recent groups ----------------------------------------------
CREATE OR REPLACE FUNCTION get_admin_recent_groups(p_limit INT DEFAULT 50)
RETURNS TABLE (
    id UUID,
    name TEXT,
    group_code CHAR(6),
    created_at TIMESTAMPTZ,
    members_count BIGINT,
    votings_count BIGINT,
    creator_email TEXT
) AS $$
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'forbidden';
    END IF;
    RETURN QUERY
    SELECT
        g.id, g.name, g.group_code, g.created_at,
        (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id) AS members_count,
        (SELECT count(*) FROM votings v WHERE v.group_id = g.id AND v.status != 'deleted') AS votings_count,
        au.email::TEXT
    FROM groups g
    LEFT JOIN auth.users au ON au.id = g.created_by
    ORDER BY g.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION get_admin_recent_groups(INT) TO authenticated;


-- 5. Admin: recent feedback --------------------------------------------
-- (Plain SELECT also works, but this RPC enriches with profile name.)
CREATE OR REPLACE FUNCTION get_admin_feedback(p_limit INT DEFAULT 100)
RETURNS TABLE (
    id UUID,
    text TEXT,
    user_id UUID,
    user_email TEXT,
    user_name TEXT,
    status TEXT,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'forbidden';
    END IF;
    RETURN QUERY
    SELECT f.id, f.text, f.user_id, f.user_email, f.user_name, f.status, f.created_at
    FROM feedback f
    ORDER BY f.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

GRANT EXECUTE ON FUNCTION get_admin_feedback(INT) TO authenticated;
