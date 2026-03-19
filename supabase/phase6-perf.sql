-- ============================================
-- Phase 6: Performance — Combined RPC functions
-- ============================================

-- 1. Combined groups + stats in one query (replaces getMyGroups + getGroupsStats)
CREATE OR REPLACE FUNCTION get_my_groups_with_stats()
RETURNS TABLE(
    group_id UUID,
    name TEXT,
    description TEXT,
    group_code CHAR(6),
    created_by UUID,
    role TEXT,
    members_count BIGINT,
    active_votings_count BIGINT,
    total_votings_count BIGINT
) AS $$
    SELECT
        g.id,
        g.name,
        g.description,
        g.group_code,
        g.created_by,
        gm.role,
        (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id),
        (SELECT COUNT(*) FROM votings v WHERE v.group_id = g.id AND v.status = 'active'),
        (SELECT COUNT(*) FROM votings v WHERE v.group_id = g.id AND v.status != 'deleted')
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
