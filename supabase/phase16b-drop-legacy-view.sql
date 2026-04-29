-- Phase 16b: Drop legacy voting_results view (apply AFTER UI fully uses rpc)
-- Date: 2026-04-29
-- Prerequisite: phase16 applied + JS using supabase.rpc('get_voting_results') deployed
--               and SW cache rotated past spilka-v17.

DROP VIEW IF EXISTS public.voting_results;
