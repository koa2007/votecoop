# VoteCoop — Project Bootstrap (read first every session)

> Mobile-first web app for voting in housing co-ops / HOAs. Vanilla JS + PocketBase backend.

## ⚡ CURRENT STATE (last updated: 2026-08-27)

**Live & working:**
- Auth (email + password) via PocketBase. Google sign-in is deferred, not wired up.
- Groups: create / join by 6-digit code / approve requests / leave / delete-via-voting
- Votings: 6 types (simple, secret, admin-change, remove-member, freeze=«exclude-from-count», delete-group)
  - Freeze reworked 2026-06-29 → "Виключення з підрахунку": removes ghost members (sold flat / gone) from the quorum denominator. Admin-only; fixed 5-day objection window; 2 distinct objections OR the target objecting = instant cancel; self-restore "Я тут" + admin restore; per-voting quorum snapshot; floor guard (≥2 active); new owner replaces ghost. Full backend in pb_hooks (was a no-op stub before). Memory: `freeze-exclude-redesign`.
- Voting: yes / no / abstain + comments
- Notifications (in-app; realtime subscribes to `notifications` only — membership rules break the other subscriptions)
- i18n: UK / EN / RU
- CSV export of group history (admin)
- Printable voting protocol (PDF/print) — "Протокол" button on any completed non-freeze voting, available to every member; window.print() + @media print; secret votes show counts only
- PWA: manifest + service worker (basic)
- **Dark theme** (system preference + manual toggle in profile)
- Mobile: safe-area-inset, 44px tap targets, locked body-scroll on modals

**Deploy:** manual. There is no CI — `.github/workflows/` does not exist. Static files
go to `/opt/spilka-web`, hooks to `/opt/pocketbase/pb_hooks` + restart `pocketbase.service`.
Bump `service-worker.js` every time, or browsers keep serving the old code.

**Audited twice (26-27.08.2026), full-audit skill.** Round one: voting was impossible
since 18.07 (a `json` field reaches a JS hook as bytes) plus 19 other findings. Round
two asked whether a decision the house takes is actually executed, and often it was
not: a voting could read "ПРИЙНЯТО" while nothing happened, the sitting admin could
make a vote to replace him unwinnable by demoting neighbours mid-vote, an exclusion
proposal could go live with nobody on it, every line of the group history was dated
"Invalid Date", and protocols of older votings printed impossible arithmetic. Fixed on
this branch; ledger in `D:\claudeprojects\_audit\spilka\`.

**In progress:** —

**Deferred (do NOT propose unless asked):**
- Push notifications (Firebase FCM) — needs backend keys
- Native mobile app (React Native) — when web is battle-tested
- Telegram bot / email digests
- Real-time presence
- Re-proposal cooldown after a cancelled exclusion (time-based) — only concurrent-duplicate guard is in; full cooldown deemed low-value since self-restore/instant-cancel already defang harassment

## 🛠 Stack

- **Frontend:** vanilla JS (no framework), HTML5, CSS3 with `var(--color-*)` variables
- **Icons:** Phosphor Icons (CDN)
- **Backend:** PocketBase 0.39.4 (Go + SQLite) on a VPS. Server-side logic lives in `pb_hooks/*.js`;
  access rules live in the collections themselves (dumped to `tests/fixtures/collections.json`).
- **Hosting:** any static host (currently local; future: Vercel / Netlify / Cloudflare Pages)
- **Files:**
  - `index.html` — all screens + modals (single page)
  - `js/app.js` — main app logic (~3800 lines, single object literal `app`)
  - `js/supabase.js` — backend adapter (single object `supabaseService`). Name is historical: it talks to PocketBase.
  - `js/config.js` — just `POCKETBASE_URL = window.location.origin`. No key, nothing secret.
  - `css/style.css` — all styles, CSS variables for theming
  - `pb_hooks/` — the server: 25 routes, the voting/vote/freeze hooks, the minute cron
  - `pb_migrations/` — schema migrations applied on the server
  - `tests/` — 39 regression tests against a real PocketBase (see `tests/README.md`)
  - `supabase/*.sql` — history only; the Supabase backend is gone

## 🔑 Configuration

- `js/config.js` is committed and holds no secret (just the same-origin URL)
- `js/config.example.js` is the template if the backend ever moves off the app's own host
- **Never commit:** `.env`, files with passwords, OAuth client secrets

## 🚀 Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

No build step. No npm install needed for runtime (only for icon generation script).

## ✅ Self-test checklist (before saying "done")

- [ ] App loads without console errors
- [ ] Auth screen → email login works
- [ ] After login, voting list renders (cached or fresh)
- [ ] Bottom nav switches between 4 tabs
- [ ] Group detail opens, members list shows
- [ ] Modal opens, body scroll is locked, ✕ closes it
- [ ] Dark theme toggles in profile, persists across reload
- [ ] No hardcoded color values in CSS — only `var(--color-*)`
- [ ] All user-supplied strings escaped via `app.escapeHTML()` before innerHTML
- [ ] Mobile viewport: nothing overflows, tap targets ≥ 44px

## 🎯 Coding rules (project-specific)

1. **No frameworks** — keep vanilla. The app is small enough.
2. **CSS variables only** — never hardcode colors / radii / shadows. Use `var(--*)`.
3. **Always `escapeHTML()` user data** before `innerHTML`. The method exists on `app`.
4. **Cache-first render** — `loadMy*()` shows localStorage cache instantly, then fetches.
5. **Mobile-first** — design for 360px width, scale up. App container caps at 480px.
6. **Modals lock body scroll** via `app.showModal()` / `hideModal()`.
7. **i18n every user-facing string** — `t.key` from `app.translations[currentLanguage]`.

## 📂 Companion docs

- `PROGRESS.md` — chronological journal (append-only)
- `PROJECT_OVERVIEW.md` — long-form description (may be stale; this file is source of truth)
- `FEATURES_CHECKLIST.md` — what's done / what's left
- `design-system.md`, `ux-structure.md` — design notes

## 🧠 Two-agent coordination (claude-laptop ↔ brain-vps)

Це проєкт на якому одночасно можуть працювати два агенти: я (Claude на ноуті Ігоря) і `autonomus-brain` (Claude на VPS Hetzner, доступний через Telegram). У мозку є прямий DB-доступ через psql (`$VOTECOOP_DB`) — він може накатувати міграції самостійно.

**Shared state** = `D:\claudeprojects\Obsidian\autonomus-memory\projects\votecoop\` (синкається GitHub-ом, мозок auto-pulls що 5 хв):
- `profile.md` — стабільні факти проєкту (стек, креди, конвенції, phase-міграції)
- `log.md` — append-only журнал що зробили обидва агенти + користувач

**Мій протокол на старті сесії votecoop:**
```bash
cd D:\claudeprojects\Obsidian\autonomus-memory && git pull --quiet
# Прочитати останні 3-5 записів у projects/votecoop/log.md
```

**Перед кінцем сесії якщо була значуща робота:**
- Додати запис у `log.md` форматом `### YYYY-MM-DD HH:MM — [claude-laptop]` + bullet'и
- `git add projects/votecoop/log.md && git commit -m 'log: votecoop ...' && git push`

**Не редагувати чужі записи** — лише додавати свої. Користувач може писати від `[user]` для координації.

## ⚠️ Known traps

- `js/config.js` is committed intentionally — after the PocketBase migration it holds no secret (just `POCKETBASE_URL = window.location.origin`). Never put a real key or token there.
- `index.html` is monolithic (~860 lines, all screens). Edits should preserve `id` attributes used by `app.js`.
- `app.js` uses `onclick="app.foo()"` inline handlers extensively — when adding new buttons, expose the method on `app` object.
