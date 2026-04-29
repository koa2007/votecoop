-- Phase 16: Security & integrity fixes (additive — zero-downtime)
-- Date: 2026-04-29
-- Issues addressed (from log.md TODOs):
--   #5: voting_results view bypasses RLS (no security_invoker, leaks vote counts cross-group)
--   #9: full UNIQUE(group_id,user_id) on join_requests blocks re-applying after rejection
--
-- Deploy order (zero-downtime):
--   1. Apply this migration (function added, view kept)
--   2. Deploy JS that uses rpc('get_voting_results')      ← service worker ships new bundle
--   3. After UI fully migrated → apply phase16b-drop-view.sql

-- =============================================================================
-- FIX #5 (additive): SECURITY DEFINER function with group-membership gate
-- =============================================================================
-- Problem: PG views default to security-definer-style execution. The owner of
--          public.voting_results can read all rows of public.votes, so the
--          aggregated counts leak across group boundaries (anyone authenticated
--          could SELECT * FROM voting_results WHERE voting_id = '<any>').
-- Solution: Expose the same shape via an RPC that checks group membership
--           inside SECURITY DEFINER. UI keeps showing live counts for both
--           secret and non-secret votings (same product behavior), but only
--           members of the relevant group see them.
-- Frontend impact: js/supabase.js getVotingResults() switches from
--           .from('voting_results').select(...).in('voting_id', ids)
--        to .rpc('get_voting_results', { p_voting_ids: ids })
-- The legacy view stays in place during the rollout; phase16b drops it.

CREATE OR REPLACE FUNCTION public.get_voting_results(p_voting_ids uuid[])
RETURNS TABLE(
    voting_id uuid,
    yes_votes bigint,
    no_votes bigint,
    abstain_votes bigint,
    total_votes bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
    SELECT
        v.voting_id,
        count(*) FILTER (WHERE v.choice = 'yes')     AS yes_votes,
        count(*) FILTER (WHERE v.choice = 'no')      AS no_votes,
        count(*) FILTER (WHERE v.choice = 'abstain') AS abstain_votes,
        count(*)                                     AS total_votes
    FROM public.votes v
    JOIN public.votings vt ON vt.id = v.voting_id
    WHERE v.voting_id = ANY(p_voting_ids)
      AND public.is_group_member(vt.group_id, auth.uid())
    GROUP BY v.voting_id;
$function$;

REVOKE ALL ON FUNCTION public.get_voting_results(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_voting_results(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_voting_results(uuid[]) IS
'Aggregate vote counts per voting_id. SECURITY DEFINER + is_group_member() gate prevents cross-group leakage that the legacy voting_results view exposed.';

-- =============================================================================
-- FIX #9: Convert full UNIQUE(group_id,user_id) to partial UNIQUE WHERE pending
-- =============================================================================
-- Problem: Current constraint join_requests_group_id_user_id_key blocks any
--          re-application — once a user is rejected, they can never request
--          to join the same group again.
-- Solution: Drop the full unique, keep a partial unique on pending status only.
--           Users can re-apply after rejection; idempotency guard remains for
--           multiple simultaneous pending requests.

ALTER TABLE public.join_requests
    DROP CONSTRAINT IF EXISTS join_requests_group_id_user_id_key;

DROP INDEX IF EXISTS public.idx_join_requests_pending;

CREATE UNIQUE INDEX join_requests_pending_uniq
    ON public.join_requests (group_id, user_id)
    WHERE status = 'pending';

COMMENT ON INDEX public.join_requests_pending_uniq IS
'Partial UNIQUE: prevents duplicate pending requests but allows re-applying after rejection (replaces old full UNIQUE constraint).';
