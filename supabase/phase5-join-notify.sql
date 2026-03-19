-- ============================================
-- Phase 5: Notify admin when join request is submitted
-- ============================================

CREATE OR REPLACE FUNCTION notify_join_request(p_group_id UUID)
RETURNS VOID AS $$
DECLARE
    v_user_id UUID;
    v_user_name TEXT;
    v_group_name TEXT;
    v_admin_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Get requester name
    SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
    INTO v_user_name
    FROM profiles WHERE id = v_user_id;

    IF v_user_name = '' OR v_user_name IS NULL THEN
        v_user_name := 'User';
    END IF;

    -- Get group name
    SELECT name INTO v_group_name
    FROM groups WHERE id = p_group_id;

    IF v_group_name IS NULL THEN
        RAISE EXCEPTION 'Group not found';
    END IF;

    -- Find group admin
    SELECT user_id INTO v_admin_id
    FROM group_members
    WHERE group_id = p_group_id AND role = 'admin'
    LIMIT 1;

    -- Notify admin
    IF v_admin_id IS NOT NULL THEN
        INSERT INTO notifications (user_id, type, text)
        VALUES (
            v_admin_id,
            'member',
            v_user_name || ' хоче приєднатися до групи "' || v_group_name || '"'
        );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
