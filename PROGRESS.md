# PROGRESS — VoteCoop

Append-only journal of significant work. Newest at top under INDEX.

## 📑 INDEX (latest 10)

- 2026-04-25 — Project cleanup: foundation files, dark theme, mobile polish, security fixes
- 2026-04-24 — Slow loading + mobile flicker fix (commit 02f6d75)
- 2026-04-23 — Notify admin on join request (commit 1d1d723)
- 2026-04-22 — Fix group member count + profile groups count (commit 0ebece9)
- 2026-04-21 — Leave-group + delete-group voting types (commit e92688e)
- 2026-04-20 — Group menu admin-check fix (commit a31eb4a)

**Next step:** Verify in browser, push to GitHub.

---

## 2026-04-25 — Project cleanup pass

**Goal:** Bring project up to Playbook standard (foundation, dark theme, mobile UX, security).

**Done:**
- Removed `github login.txt` from disk (contained plaintext GitHub password — user must rotate)
- Created `CLAUDE.md` per Playbook with `⚡ CURRENT STATE` block
- Created this `PROGRESS.md` with INDEX
- Fixed XSS holes: unescaped group/voting names in notification text (app.js)
- Fixed `<\div>` HTML typo in app.js
- Modal `showModal/hideModal` now lock/unlock body scroll
- Converted ~15 hardcoded color values in style.css to CSS variables
- Added dark theme: `prefers-color-scheme` + manual toggle in profile, persisted in localStorage
- Mobile polish: tap targets ≥ 44px on `.btn-info` / `.btn-icon` / member avatars; dynamic `<meta name="theme-color">`
- Updated `.gitignore` to exclude credentials patterns

**Status:** done

**Notes:** Did NOT do full ES module refactor of app.js — risk of regression on working 3800-line code outweighed benefit. Code is well-organized as a single object literal; refactor deferred to a dedicated phase if/when a major feature requires it.
