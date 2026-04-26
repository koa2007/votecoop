-- =====================================================================
-- PHASE 10 — Enable Supabase Realtime for tables the app subscribes to
-- (2026-04-26)
--
-- The client subscribes to INSERT / UPDATE / DELETE on these tables
-- (see js/app.js -> subscribeToRealtime). Without them being in the
-- `supabase_realtime` publication, postgres-changes events are NEVER
-- emitted and the user sees stale data until they manually reload.
--
-- Symptom that prompted this fix: an admin received a join request from
-- another user but no notification appeared in their open app — because
-- the notifications table was not in the publication.
--
-- Adding to publication is idempotent? No — second add raises. So we
-- DROP first if member, then re-add. Safe to re-run.
-- =====================================================================

DO $$
DECLARE
    t TEXT;
    tbl_in_pub BOOL;
BEGIN
    FOREACH t IN ARRAY ARRAY['notifications', 'votes', 'votings'] LOOP
        SELECT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
        ) INTO tbl_in_pub;
        IF NOT tbl_in_pub THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            RAISE NOTICE 'added % to supabase_realtime', t;
        ELSE
            RAISE NOTICE '% already in supabase_realtime', t;
        END IF;
    END LOOP;
END$$;

-- Verify
SELECT tablename FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
ORDER BY tablename;
