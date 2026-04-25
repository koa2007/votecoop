# VoteCoop — Project Bootstrap (read first every session)

> Mobile-first web app for voting in housing co-ops / HOAs. Vanilla JS + Supabase backend.

## ⚡ CURRENT STATE (last updated: 2026-04-25)

**Live & working:**
- Auth (Google OAuth + email/password) via Supabase
- Groups: create / join by 6-digit code / approve requests / leave / delete-via-voting
- Votings: 6 types (simple, secret, admin-change, remove-member, freeze, delete-group)
- Voting: yes / no / abstain + comments
- Notifications (in-app, real-time via Supabase)
- i18n: UK / EN / RU
- CSV export of group history
- PWA: manifest + service worker (basic)
- **Dark theme** (system preference + manual toggle in profile)
- Mobile: safe-area-inset, 44px tap targets, locked body-scroll on modals

**In progress:** —

**Deferred (do NOT propose unless asked):**
- Push notifications (Firebase FCM) — needs backend keys
- Native mobile app (React Native) — when web is battle-tested
- Telegram bot / email digests
- Real-time presence
- Advanced freeze flow: daily reminders to frozen members, auto-removal

## 🛠 Stack

- **Frontend:** vanilla JS (no framework), HTML5, CSS3 with `var(--color-*)` variables
- **Icons:** Phosphor Icons (CDN)
- **Backend:** Supabase (Postgres + Auth + Realtime + RLS)
- **Hosting:** any static host (currently local; future: Vercel / Netlify / Cloudflare Pages)
- **Files:**
  - `index.html` — all screens + modals (single page)
  - `js/app.js` — main app logic (~3800 lines, single object literal `app`)
  - `js/supabase.js` — Supabase service wrapper (single object `supabaseService`)
  - `js/config.js` — Supabase URL + anon key (anon key is **safe to commit** — RLS protects data)
  - `css/style.css` — all styles, CSS variables for theming
  - `supabase/*.sql` — schema + migrations (phase2 → phase6)

## 🔑 Configuration

- `js/config.js` is committed and contains the public Supabase anon key (correct: anon keys are designed to be public, RLS enforces auth)
- `js/config.example.js` is the template if rotating projects
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

## ⚠️ Known traps

- `js/config.js` is in `.gitignore` BUT it was committed before the rule was added. The current anon key is public-safe; if rotated, ensure new key isn't committed accidentally.
- `index.html` is monolithic (~860 lines, all screens). Edits should preserve `id` attributes used by `app.js`.
- `app.js` uses `onclick="app.foo()"` inline handlers extensively — when adding new buttons, expose the method on `app` object.
