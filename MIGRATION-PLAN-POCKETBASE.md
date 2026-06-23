# Migration Plan: Supabase → PocketBase (Spilka) — v2 (hardened)

> 2026-06-23. Decision: **B — go PocketBase** (strategic: validate PocketBase as a
> reusable backend for future projects, not just to save €). v1 was pushed back by
> 3/3 cross-model critics; this v2 closes every blocker they raised before any build.
>
> Server: ukraine.com.ua VPS 2G, Ubuntu 24.04, 1 core / 2 GB / 20 GB, host 173.242.50.141.
> Parallel build: old Supabase stays LIVE; cutover (DNS) is the LAST step. No data migration.

## A. Inventory (what we re-create)
11 tables + `group_stats` view; Supabase Auth (email/pw, Google OAuth, reset, sessions); 3 realtime subscriptions (notifications, votings, join_requests); ~16 RPCs (business logic); RLS on every table; no file storage.

## B. Target stack on the VPS
PocketBase (Go binary; SQLite/WAL) behind **nginx** (TLS via certbot) as a systemd service. Frontend stays on GitHub Pages. **API gets its own subdomain `api.spilka.top`** — the apex `spilka.top` is NOT moved (fixes v1 DNS contradiction).

---

## C. How each critic blocker is closed (the core of v2)

### C1. Goja JS engine — no async/await/Promises/Node
- All `pb_hooks` written as **synchronous** JS using `$app`, `$apis`, `$http` bindings. Our logic is plain DB reads/writes + arithmetic — synchronous fits naturally. No external calls inside hooks.
- If anything ever needs more than Goja allows → compile a small **Go extension** of PocketBase (it's designed for this), not fight Goja. Not expected for our logic.

### C2. SQLite single-writer vs every-minute cron → "database is locked"
- WAL mode (PocketBase default) + **`busy_timeout`** set high (e.g. 10 s) so writers queue instead of erroring.
- The completion cron processes **one voting per short transaction** (not one big lock), with a **retry-on-locked** wrapper. Our write volume is tiny (a vote = one insert), so real contention is near-zero; this is belt-and-suspenders.
- Cron cadence: every 60 s is fine; each run only touches votings whose `ends_at <= now AND status='active'` (usually zero rows).

### C3. "One apartment — one vote" uniqueness (fragile in PocketBase)
- Create the partial unique index via a **versioned `pb_migrations/` migration** (re-applied on start; survives restarts) — `UNIQUE(group, apartment) WHERE is_observer=0 AND apartment!=''`.
- **Defense-in-depth:** the approve-join and role-change hooks re-check the slot **inside `$app.runInTransaction()`** (check + insert atomic) so a race can't seat two voters.
- **Operational guard:** documented rule — never edit these collections via the Admin UI (it can rebuild the table and drop raw indexes); schema changes go through migrations only. Add a startup check that the index still exists; log loudly if missing.

### C4. Security / forgery (don't re-introduce the fixed bugs)
- **Server-set ownership fields** in `onRecordCreate` hooks (override anything the client sends): `vote.user = auth.id`, `voting.created_by = auth.id`, `join_request.user = auth.id`, notification targets set server-side. Reject mismatches.
- **votings update rule:** author may ONLY move an active voting → deleted; `result`/`status=completed`/`completed_at` cannot be set by client (ported WITH-CHECK). Completion fields are written only by the cron (admin context).
- **votes create rule:** `@request.auth.id != "" && vote.user = @request.auth.id` AND requester is a **non-observer** member of the voting's group AND voting is active.
- **Counts/aggregates** (quorum, voter count, group_stats) come from **server routes gated to group members** — never computed client-side, never leaking across groups.
- Re-run the exact attack tests before cutover (§F).

### C5. DNS / hosting
- `spilka.top` stays on GitHub Pages. PocketBase = **`api.spilka.top`** (A-record to 173.242.50.141), TLS via certbot. Frontend change at cutover = just the API base URL in `js/config.js`.
- Lower the `api.spilka.top` TTL before cutover; apex unaffected so no split-brain of the app shell.

### C6. CORS
- Configure PocketBase/nginx to allow origin `https://spilka.top` (and the GitHub Pages preview origin during testing). Verify preflight on every endpoint type (REST, auth, realtime, custom routes).

### C7. Backups (no hot-copy corruption)
- Use PocketBase's **built-in backup** (`./pocketbase backup` / Admin API) or `sqlite3 .backup` (online-safe) — never raw `cp` of a live `pb_data`.
- Nightly via cron → **offsite copy** (rclone to object storage or pull to laptop). Provider snapshot as a second layer. Documented **restore drill** + measured RTO.

### C8. Transactions / idempotency
- All multi-step logic (create_group+member, approve, role-change, completion side-effects) wrapped in `$app.runInTransaction()`.
- Completion is **idempotent**: it flips `status` to completed in the same txn as side-effects and only ever selects `status='active'`, so a restart/overlap can't double-apply.

### C9. group_stats
- Modelled as a **server route** (computed on demand, member-gated), not a stored collection. Returns the same JSON shape the frontend expects.

### C10. Realtime parity
- Map the 3 subscriptions to PocketBase realtime (`pb.collection(x).subscribe(filter)`). For any case PB filters can't express exactly, fall back to a short poll for THAT subscription only. Each of the 3 verified against current behaviour before cutover.

### C11. Auth specifics
- Email/password + reset + sessions: native PB. **SMTP** configured (Resend) for reset/verify emails — deliverability tested.
- Profile fields live on the `users` auth collection. **Field-level care:** member-list endpoints expose only public fields (name, role, apartment) — never phone/address of others (PB field visibility handled via a member-gated route, not raw collection list).
- Google OAuth: added after email/password works (needs Google client id/secret). Not a cutover blocker.

### C12. Ops / hardening (was missing in v1)
- **SSH:** key-only auth, disable root password login after key set up, non-root deploy user, `ufw` (allow 22, 80, 443), `fail2ban`.
- **Admin UI** protected (strong creds, optionally IP-restricted).
- systemd auto-restart; nginx; certbot auto-renew; logrotate.
- **Monitoring:** UptimeRobot on `api.spilka.top` health endpoint; alert on down.
- **Updates:** documented patch routine for PocketBase / Ubuntu / nginx.

---

## D. Frontend strategy (limit blast radius)
- Rewrite `js/supabase.js` as a wrapper over the **PocketBase JS SDK**, keeping the same public method names + `{data, error}` return shapes so `js/app.js` changes minimally.
- Honest note (critic was right): it's NOT a "thin" 1:1 wrapper — Supabase's chained query builder, `.rpc()`, realtime payloads and error shapes differ. The wrapper translates each used pattern explicitly (we enumerated all 50 service methods + direct `.from()/.rpc()/.auth/.channel()` uses). Bounded, but real work.
- `js/config.js` → `api.spilka.top`. SW cache bump.

## E. Build sequence (parallel; cutover last)
1. Server base: SSH hardening, deploy user, ufw/fail2ban, nginx, PocketBase + systemd (IP-only first).
2. Collections + versioned migrations (incl. partial unique index).
3. Access rules (C4) + ownership hooks.
4. Business-logic hooks/routes + completion cron (C1/C2/C8).
5. Auth (email/pw + reset via Resend SMTP); Google later.
6. Frontend wrapper + app.js adaptations + realtime (D).
7. Test on IP/temp domain (F).
8. Backups + restore drill verified (C7).
9. `api.spilka.top` DNS + TLS; smoke; cutover; keep Supabase as rollback.

## F. Pre-cutover security regression tests (must all pass)
- author CANNOT forge a voting result (update result/status/completed_at → rejected);
- observer CANNOT vote and is NOT counted in quorum;
- admin-change CANNOT leave a group admin-less (NULL/left target guard);
- two voters CANNOT share an apartment (concurrent attempt → one fails);
- counts do NOT leak across groups;
- ownership can't be forged (vote.user/created_by spoof → ignored/rejected);
- join → approve → vote → auto-complete end-to-end; role change; leave; delete-group.

## G. Honest residual risks
- Effort: real backend + frontend-data-layer rewrite (accepted — strategic investment in PocketBase).
- 1 core/2 GB single box, no managed failover (mitigated by backups/snapshots/monitoring; can resize).
- Realtime expressiveness — may degrade 1-2 subscriptions to polling.
- This is a learning bet on PocketBase for future reuse; if it proves painful, the lean-Postgres alternative remains on the table.

## H. What I need from Igor
- ✅ Server access (have it). After OS is up: I create an SSH management key, deploy user, PocketBase admin; store creds in a local secret file (never in repo).
- Later (non-blocking): keep Google OAuth in v1 or email/pw only first; confirm Resend for auth emails.

## I. v3 corrections (2nd cross-critic round, 2026-06-23)

Round 2 (OpenAI/Gemini/Kimi) again leaned "use Postgres", but surfaced REAL PocketBase facts I had wrong. Folded in:

**Corrected (my v2 was wrong / incomplete):**
- **PB migrations run ONCE** (tracked in `_migrations`) — they do NOT re-apply on start. So the partial unique index can't rely on "migration re-runs". FIX: assert it in an **`OnBootstrap` hook** that runs `CREATE UNIQUE INDEX IF NOT EXISTS … WHERE is_observer=0 AND apartment!=''` on **every startup** (idempotent) → if an Admin-UI edit ever drops it, a restart self-heals. Combined with the in-transaction slot re-check at approve time, the one-apartment-one-vote invariant holds even under the Admin-UI footgun. (Replaces the weak "documented rule".)
- **Anti-double-vote:** add explicit `UNIQUE(voting, user)` index on `votes` + create-rule — was implied, now explicit (Supabase had it).
- **Pin the PocketBase version** and write hooks against THAT version's JSVM API (binding names changed across PB releases). Verify the exact hook API from the pinned version's docs before writing logic — don't assume.
- **Realtime behind nginx:** SSE needs `proxy_buffering off`, long `proxy_read_timeout`, upgrade headers; raise `worker_connections` + `ulimit -n`. Membership-scoped subscriptions (votings, join_requests) likely **degrade to short-poll** if PB view-rules can't express the group-membership join — accept that for those two.
- **Backups → Litestream** (streaming SQLite → object storage, near-zero RPO) instead of nightly-only; nightly `.backup` + snapshot as secondary.
- **Rate limiting:** nginx `limit_req` on auth / password-reset / join-request / voting-create endpoints (anti-abuse on 1 core).

**Dismissed as non-issues for OUR context (critics lacked context):**
- "Existing users/Google accounts stranded by no-migration" — **there are NO real users yet**; all current groups/votes/accounts are throwaway test data (confirmed by Igor). Re-onboarding is moot now. Caveat: Google OAuth must be working **before** we acquire any real users.
- "Frontend needs a massive Supabase→PB AST translator" — overstated. We are NOT building a generic translator; we hand-translate the **enumerated ~50 service methods + the specific direct `.from()/.rpc()/.auth/.channel()` call sites**. Bounded, explicit work.

**Acknowledged but decided:** all 3 critics still prefer self-hosted Postgres. Igor chose PocketBase deliberately to validate it for reuse in future projects (a strategic learning bet, not a cost decision). Decision stands; residual platform risk is accepted and documented in §G.

**Status:** plan hardened over 2 critic rounds; remaining objections are either folded-in fixes, context-non-issues, or the already-made Postgres-vs-PB decision. Proceeding to build.
