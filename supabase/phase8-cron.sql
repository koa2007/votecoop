-- =====================================================================
-- PHASE 8 — Auto-expiry via pg_cron (2026-04-25)
-- Runs `complete_expired_votings` every minute server-side so votings
-- close even if no client is online to call the RPC.
-- =====================================================================

-- 1. Enable pg_cron (idempotent, no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Drop any prior schedule of the same name to avoid duplicates
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('votecoop-complete-expired', 'votecoop-unfreeze');

-- 3. Schedule: complete expired votings every minute
SELECT cron.schedule(
    'votecoop-complete-expired',
    '* * * * *',
    $$ SELECT public.complete_expired_votings(); $$
);

-- 4. Schedule: unfreeze members who passed their freeze deadline (every hour)
SELECT cron.schedule(
    'votecoop-unfreeze',
    '0 * * * *',
    $$ SELECT public.unfreeze_expired_members(); $$
);

-- 5. Verify
SELECT jobid, jobname, schedule, command FROM cron.job
WHERE jobname LIKE 'votecoop-%';
