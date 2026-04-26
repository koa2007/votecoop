-- =====================================================================
-- PHASE 13 — Admin broadcast notifications (2026-04-26)
--
-- RPC, який дозволяє адміну (koa2007@gmail.com) надіслати одне повідомлення
-- всім користувачам зі списку. Use-case: "відповісти у нотифікаціях
-- всім, хто писав feedback про фічу X".
--
-- Returns: кількість створених notifications.
-- =====================================================================

CREATE OR REPLACE FUNCTION admin_broadcast_notification(
    p_user_ids UUID[],
    p_text TEXT
)
RETURNS INT AS $$
DECLARE
    v_count INT := 0;
    v_uid UUID;
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'forbidden';
    END IF;
    IF p_text IS NULL OR length(trim(p_text)) < 1 THEN
        RAISE EXCEPTION 'text required';
    END IF;
    IF p_user_ids IS NULL OR array_length(p_user_ids, 1) IS NULL THEN
        RETURN 0;
    END IF;

    FOREACH v_uid IN ARRAY p_user_ids LOOP
        INSERT INTO notifications (user_id, type, text, metadata)
        VALUES (
            v_uid,
            'admin_message',
            p_text,
            jsonb_build_object('from', 'admin', 'sent_at', now())
        );
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION admin_broadcast_notification(UUID[], TEXT) TO authenticated;
