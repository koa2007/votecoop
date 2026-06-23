# Migration Plan: Supabase → PocketBase (Spilka)

> Draft 2026-06-23. Parallel build on a fresh ukraine.com.ua VPS 2G
> (Ubuntu 24.04, 1 core / 2 GB / 20 GB). Old Supabase stays LIVE; domain is
> connected to PocketBase only after full testing. No data migration — current
> groups/votes are throwaway test data.

## 0. Why & ground rules

- **Why:** avoid future Supabase paid tier; cheap, self-hosted, consolidated with domain (adm.tools).
- **Hard rule — zero disruption:** spilka.top keeps pointing at the current GitHub Pages + Supabase stack until PocketBase is fully tested. Domain cutover is the LAST step.
- **No data migration:** rebuild schema fresh in PocketBase; re-create a couple of test groups by hand.
- **Biggest risk (read first):** we recently found & fixed security/logic bugs in the Postgres backend — RLS forgery on `votings`, observers counted in quorum, group left admin-less, `group_stats` cross-group leak, one-voter-per-apartment uniqueness. **All of that must be re-implemented in PocketBase and re-tested with the same attack scenarios.** Re-introducing these is the #1 danger of this migration.

## 1. What exists today (inventory)

**Tables (11) + 1 view:** profiles, groups, group_members, votings, votes, join_requests, notifications, group_history, freeze_objections, freeze_targets, feedback; view `group_stats`.

**Auth (Supabase Auth):** email+password, Google OAuth, password reset, session/refresh, `onAuthStateChange`. A DB trigger `handle_new_user` creates a `profiles` row on signup.

**Realtime (3 subscriptions):** notifications (insert for me), votings (insert/update in my groups), join_requests.

**Business logic (~16 RPCs called by the app):** create_group_with_member, find_group_by_code, get_my_groups_with_stats, get_group_member_votes, get_voter_count, get_voting_results, submit_join_request_v2, approve_join_request_v2, request_role_change, leave_group, complete_expired_votings (pg_cron, every minute), check_my_expired_votings, notify_group_members, notify_join_request, admin_broadcast_notification, get_admin_* (stats/feedback/recent).

**Access control:** Row-Level Security on every table (the security layer).

**Storage:** none. (Nothing to port.)

## 2. Target architecture on the VPS

- **PocketBase** (single Go binary) — DB (SQLite/WAL) + auth + realtime + REST + admin UI.
- **nginx** reverse proxy → PocketBase on 127.0.0.1:8090; TLS via Let's Encrypt (certbot) when domain is attached.
- **systemd** service (auto-restart, starts on boot).
- **Backups:** nightly `sqlite3 .backup` / file copy of `pb_data` + provider snapshot. Offsite copy (download or object store) — snapshots alone aren't enough.
- Frontend stays on GitHub Pages; only `js/config.js` endpoint changes at cutover.

## 3. Data model in PocketBase (collections)

- **users** (built-in auth collection) — EXTEND with profile fields: first_name, last_name, phone, address, apartment, default_role, profile_completed. This replaces the separate `profiles` table + `handle_new_user` trigger (the auth record IS the profile). Decision: merge profile into users (simpler) — confirm in critic.
- **groups** (name, description, group_code [unique, 6-digit], created_by→users).
- **group_members** (group→groups, user→users, role[admin|member], is_observer[bool], apartment[text], is_frozen, frozen_until). Index: unique partial (group, apartment) WHERE is_observer=false AND apartment!="" — PocketBase supports unique indexes; the partial condition goes via a custom index or a create/update hook check.
- **votings** (group, title, description, type, status, created_by, target_member, removal_reason, freeze_duration_days, ends_at, result, completed_at, deleted_at, deleted_reason, link).
- **votes** (voting, user, choice[yes|no|abstain], comment). Unique (voting, user).
- **join_requests** (group, user, apartment, requested_as_observer, is_role_change, status). Unique partial (group, user) WHERE status='pending'.
- **notifications** (user, type, text, is_read, metadata[json], archived_at).
- **group_history**, **freeze_objections**, **freeze_targets**, **feedback** — straightforward.

## 4. Access rules (security layer — port of RLS) — CRITICAL

Re-express each RLS policy as PocketBase collection API rules (listRule / viewRule / createRule / updateRule / deleteRule). Must reproduce, verbatim in behaviour:
- **votings.update**: author may ONLY soft-delete an active voting (status active→deleted); may NOT set result/status=completed/completed_at. (This was the RLS-forgery fix.)
- **votes.create**: only a non-observer member of the voting's group may insert. (Observer-block fix.)
- **group_stats / counts**: aggregates must be gated to group members only (no cross-group leak).
- **Membership-scoped reads** everywhere (you see only your groups' data).
Logic that rules can't express (atomic multi-step, conflict checks) goes into hooks (§5), NOT the client.

## 5. Business logic — PocketBase JS hooks / routes (`pb_hooks/`)

Re-implement each RPC server-side (so the client can't forge):
- **create_group_with_member** → custom route: create group (generate unique 6-digit code) + add creator as admin member, atomically.
- **submit_join_request_v2** → onRecordCreate hook on join_requests: validate apartment present; block if apartment already taken by a voter; notify admin.
- **approve_join_request_v2** → custom route (admin only): re-check apartment slot; add member or apply role change; notify requester; handle the apartment_taken_now race.
- **request_role_change** → route: create role-change request, apartment-slot check, notify admin.
- **leave_group** → route: block the last admin from leaving.
- **complete_expired_votings** → **cron job** (`cronAdd`, every minute): for each expired active voting, compute result using VOTER count only (observers excluded), apply side-effects (admin-change with admin-less guard, remove-member, freeze, delete-group), write history + notifications.
- **get_voting_results / get_voter_count / get_group_member_votes / get_my_groups_with_stats** → routes returning the same JSON shape the frontend already expects.
- **notify_group_members / notify_join_request / admin_broadcast_notification** → routes (member-gated; admin-gated for broadcast).
- **get_admin_*** → admin-only routes (gated to the single admin account).

## 6. Auth

- Email+password, password reset, sessions/refresh → native PocketBase. 1:1 mapping.
- **Google OAuth** → PocketBase supports OAuth2; needs Google client id/secret configured. Optional for cutover — can launch with email/password and add Google right after (no data to preserve anyway).
- Profile auto-creation → not needed (profile fields live on the users record); set profile_completed on first save.

## 7. Frontend changes (keep app.js almost untouched)

- **Rewrite `js/supabase.js`** as a thin wrapper over the PocketBase JS SDK, KEEPING the same public method names and return shapes (`{data, error}`) so `js/app.js` barely changes. This is the key tactic to limit blast radius.
- **Adapt direct client usage in app.js**: a few spots call `supabaseService.client.from(...)`, `.rpc(...)`, `.auth...`, and realtime `.channel().on('postgres_changes').subscribe()`. Map `.from().select()` → PB `collection.getList/getFullList`; `.rpc()` → `pb.send('/api/custom/...')`; realtime → `pb.collection(x).subscribe()`.
- **`js/config.js`**: PocketBase URL + (no anon key; PB uses per-collection rules + auth token).
- Service worker cache bump.

## 8. Sequence (parallel build; cutover last)

1. **Server base:** install PocketBase, systemd unit, nginx (IP-only for now, no domain), admin account.
2. **Model:** create the collections + indexes (§3).
3. **Rules:** port access rules (§4).
4. **Hooks/cron:** implement logic (§5) + the every-minute completion cron.
5. **Auth:** email/password + reset; Google later.
6. **Frontend wrapper:** rewrite supabase.js + adapt app.js direct calls + realtime.
7. **Test on the IP (no domain):** full UX walkthrough + re-run the security attack tests:
   - author can't forge a voting result;
   - observer can't vote and isn't counted in quorum;
   - admin-change can't leave group admin-less;
   - two voters can't share an apartment;
   - counts don't leak across groups;
   - join → approve → vote → auto-complete end-to-end.
8. **Backups** verified (nightly dump + offsite).
9. **Cutover:** point spilka.top DNS at the VPS, issue TLS cert, smoke test. Keep Supabase as instant rollback for a while.

## 9. What I need from Igor

- After OS install: SSH access (IP + root). I'll create: an SSH key for management, a non-root deploy user, the PocketBase admin account, and store creds locally (superbase-style secret file, never in repo).
- Decision later (not blocking): keep Google OAuth in v1 or email/password only first.

## 10. Honest risks

- **#1 Security re-implementation** — porting RLS+RPC correctness to PB rules+hooks without re-introducing the fixed bugs. Mitigation: re-run the exact attack tests (§8.7) before cutover.
- **Realtime parity** — PB realtime filters are simpler than Postgres changes; the 3 subscriptions must be verified to behave the same.
- **Single point of failure** — one 2 GB box, no managed failover (Supabase had managed infra). Mitigation: backups + provider snapshots; can resize/rebuild fast.
- **Effort** — this is a real rewrite of the backend + the data layer of the frontend, not a config change. Time cost accepted in exchange for €0→€7/mo and no vendor lock.

## 11. Cross-model critic verdict (2026-06-23) — IMPORTANT

Ran cross-critic.ps1 (OpenAI gpt-5.5-pro, Gemini 3.1-pro, Kimi k2.6). **All three pushed back.** Verdicts: Gemini REJECT, OpenAI REVISE, Kimi REVISE. They converged on the same recommendation: **don't rewrite into PocketBase — keep Postgres and self-host it.**

Concrete blockers they raised (the serious ones):
- **Goja JS engine (PocketBase hooks):** no async/await/Promises, no Node APIs — re-implementing the 16 RPCs is harder than "JS hooks" implies.
- **SQLite single-writer vs every-minute cron:** the completion cron doing cascading writes can collide with incoming votes on 1 core → "database is locked".
- **Partial unique index fragility:** PocketBase has no native partial unique index; raw-SQL index can be silently dropped on a collection rebuild, and a hook check races → the one-apartment-one-vote rule (a bug we already fixed) can come back.
- **Security re-implementation risk:** porting RLS+RPC to PB rules+hooks risks re-introducing the forgery/quorum/admin-less/leak bugs we just killed; ownership fields (vote.user==auth.id, created_by…) must be server-set or forgery returns.
- **My plan's own DNS contradiction:** "frontend on GitHub Pages" vs "point spilka.top at the VPS" — must use `api.spilka.top` subdomain, not move the apex.
- Gaps: CORS for GitHub Pages→API, hot-backup corruption (need `.backup`/WAL checkpoint, not file copy), no monitoring/firewall/restore drill, group_stats view not modelled in §3.

**Better path (all 3 critics' alternative):** self-host **lean Postgres + PostgREST + GoTrue** — keeps ALL our RLS/RPCs/security verbatim, supabase-js points at it with ~only a URL change, and the lean stack (unlike full Supabase's ~4 GB) **fits the 2 GB box we're already buying**. This keeps the cheap consolidated server AND avoids every PocketBase-specific blocker above.

**Decision pending Igor.** This doc is paused until he chooses: (A) pivot to self-hosted Postgres stack [recommended], or (B) proceed with PocketBase with the plan hardened against all blockers above.
