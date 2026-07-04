// Spilka App
const app = {
    state: {
        user: null,
        groups: [],
        votings: [],
        notifications: [],
        currentScreen: 'auth-screen',
        votingFilter: 'active',
        userVotingHistory: {},
        currentVotingToDelete: null,
        listenersAttached: false,
        // 'fetched' tracks whether a server fetch has *completed* for each list.
        // Used to decide between skeleton loaders and "empty" states.
        fetched: { groups: false, votings: false, notifications: false },
        archive: { items: [], query: '', offset: 0, hasMore: false, loading: false, debounceTimer: null, pageSize: 50 }
    },

    // Render N skeleton placeholder cards
    renderSkeleton(count = 3) {
        const cards = Array.from({ length: count })
            .map(() => '<div class="skeleton skeleton-card"></div>')
            .join('');
        return `<div class="skeleton-list">${cards}</div>`;
    },

    // Render a friendly empty state with optional CTA
    renderEmpty(iconClass, title, hint) {
        return `
            <div class="empty-cta">
                <div class="empty-icon"><i class="${iconClass}" aria-hidden="true"></i></div>
                <div class="empty-title">${this.escapeHTML(title || '')}</div>
                ${hint ? `<div class="empty-hint">${this.escapeHTML(hint)}</div>` : ''}
            </div>
        `;
    },

    // Escape HTML to prevent XSS injection
    escapeHTML(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    // Sanitize URL — allow only http(s) protocols
    sanitizeURL(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url, window.location.origin);
            if (['http:', 'https:'].includes(parsed.protocol)) {
                return this.escapeHTML(url);
            }
            return '';
        } catch {
            return '';
        }
    },

    // Initialize app
    async init() {
        // Apply saved theme before anything renders to prevent flash
        this.initTheme();

        // If iOS user — surface install hint button (no native prompt event on iOS)
        this.showIOSInstallHintIfNeeded();

        // Re-sync theme-color meta when system preference changes (only matters in 'auto' mode)
        if (window.matchMedia) {
            try {
                window.matchMedia('(prefers-color-scheme: dark)')
                    .addEventListener('change', () => this.updateThemeMeta());
            } catch (e) { /* legacy Safari */ }
        }

        // Load saved language preference first (for error messages)
        const savedLang = localStorage.getItem('votecoop-language') || 'uk';
        if (savedLang !== 'uk') {
            document.querySelectorAll('#language-select, #auth-language-select').forEach(sel => {
                sel.value = savedLang;
            });
            this.changeLanguage(savedLang);
        }

        // Initialize Supabase
        let supabaseReady = false;
        try {
            supabaseReady = supabaseService.init();
        } catch (err) {
            // Supabase initialization failed
        }

        if (supabaseReady) {
            await this.initWithSupabase();
        } else {
            // Supabase not configured — show auth screen with error
            this.setupEventListeners();
            this.showScreen('auth-screen');
            const t = this.translations[this.currentLanguage];
            this.showAuthError(t.auth_error_network || 'Service unavailable');
        }
    },

    // Initialize with Supabase — check session, handle auth redirects
    async initWithSupabase() {
        this.showScreen('loading-screen');

        // PocketBase password-reset: the email link brings the user back here with
        // ?pwreset=<token>. They are NOT logged in — identity is proven by the token.
        // Show the standalone reset screen and skip the normal session/main flow.
        const _pwResetToken = new URLSearchParams(window.location.search).get('pwreset');
        if (_pwResetToken) {
            this._pwResetToken = _pwResetToken;
            // If a session is still active (user clicked the link while logged in),
            // clear it SYNCHRONOUSLY so the reset screen isn't overridden by the main
            // app. An async signOut() here yields mid-boot and loses the screen.
            try { supabaseService.pb.authStore.clear(); } catch (e) {}
            // Strip the token from the address bar so it can't be bookmarked/shared.
            try { window.history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
            this.showResetPasswordScreen();
            return;
        }

        // Listen for auth state changes (handles OAuth redirect callback)
        supabaseService.onAuthStateChange(async (event, session) => {
            if (event === 'PASSWORD_RECOVERY') {
                // User clicked "reset password" link in their email — Supabase
                // gives a temporary session for the password update only.
                // Show the reset-password screen instead of the main app.
                this.showResetPasswordScreen();
                return;
            }
            if (event === 'SIGNED_IN' && session) {
                // If we're already on the reset screen (recovery flow), don't
                // bounce the user to the main app — let them set a new password.
                if (this.state.currentScreen === 'reset-password-screen') return;
                await this.handleAuthSession(session);
            } else if (event === 'SIGNED_OUT') {
                this.handleSignOut();
            }
        });

        // Check for existing session
        const { session, error } = await supabaseService.getSession();

        if (session) {
            await this.handleAuthSession(session);
        } else {
            // No session — show auth screen
            this.showScreen('auth-screen');
        }
    },

    // Handle authenticated session — load profile, decide which screen to show
    async handleAuthSession(session) {
        const userId = session.user.id;
        const userEmail = session.user.email;

        // Guard against duplicate runs: at boot the auth-state listener fires
        // immediately AND getSession() resolves; on login loginWithEmail() calls
        // this AND the listener fires. Running twice raced the realtime subscribe
        // (clientId clobbered → /api/realtime 404 loop) and flickered the screen.
        if (this._authHandledFor === userId) return;
        this._authHandledFor = userId;

        // Confirm the session still belongs to a real account. A leftover token
        // for a deleted user otherwise traps the person on an unfillable profile
        // form (or a half-broken main screen). Offline keeps the session.
        const sessionValid = await supabaseService.validateSession();
        if (!sessionValid) { this.handleSignOut(); return; }

        // Load profile from DB
        const { profile, error } = await supabaseService.getProfile(userId);

        // Transient failure ≠ "no profile": don't send a real user to the
        // profile-setup form because of a network blip. Offline PWA start
        // continues with the cached profile; otherwise let them retry login.
        let restoredUser = null;
        if (error) {
            try {
                const cached = JSON.parse(localStorage.getItem('vc_user') || 'null');
                if (cached && cached.id === userId) restoredUser = cached;
            } catch (e) { /* ignore */ }
            if (!restoredUser) {
                this._authHandledFor = null;
                const t = this.translations[this.currentLanguage] || {};
                this.toastError(t.load_failed || 'Не вдалося завантажити. Спробуйте ще раз.');
                this.showAuthScreen();
                return;
            }
        }

        if (restoredUser || (profile && profile.profile_completed)) {
            // Profile complete — show main app
            this.state.user = restoredUser || {
                id: profile.id,
                firstName: profile.first_name,
                lastName: profile.last_name,
                email: userEmail,
                phone: profile.phone || '',
                address: profile.address || '',
                apartment: profile.apartment || ''
            };
            // Cache for offline PWA starts (cleared on logout).
            try { localStorage.setItem('vc_user', JSON.stringify(this.state.user)); } catch (e) { /* ignore */ }

            this.setupEventListeners();
            this.updateProfileDisplay();

            // Load data BEFORE showing main screen (keep spinner visible).
            // Groups FIRST — loadMyVotings reads group member counts to compute
            // participation %; running them in parallel raced totalMembers to 1.
            try {
                await this.loadMyGroups();
                await Promise.all([
                    this.loadMyVotings(),
                    this.loadMyNotifications()
                ]);
            } catch (loadErr) {
                // Data load failed silently — groups/votings may be empty
            }

            // Show main screen only AFTER data is loaded
            this.showScreen('main-screens');

            // Inline UX helpers
            this.refreshProfileCTA();
            this.refreshAdminBadge();
            this.initPullToRefresh();

            // Check expired votings (non-blocking)
            this.checkExpiredVotingsServer();

            // Periodic check every 60 seconds
            if (this._expiryInterval) clearInterval(this._expiryInterval);
            this._expiryInterval = setInterval(() => this.checkExpiredVotingsServer(), 60000);

            // Subscribe to live updates (votes, votings, notifications)
            this.subscribeToRealtime();
        } else {
            // Profile not completed — show setup screen
            this.state.user = {
                id: userId,
                email: userEmail,
                firstName: profile?.first_name || '',
                lastName: profile?.last_name || '',
                phone: profile?.phone || '',
                address: profile?.address || '',
                apartment: profile?.apartment || ''
            };

            // Pre-fill email in profile-setup
            const emailField = document.getElementById('profile-email-display');
            if (emailField) {
                emailField.value = userEmail;
            }

            this.showScreen('profile-setup-screen');
        }
    },

    // Handle sign out — reset state, show auth screen
    handleSignOut() {
        if (this._expiryInterval) clearInterval(this._expiryInterval);
        this.unsubscribeFromRealtime();
        this._authHandledFor = null;
        this.state.user = null;
        this.state.groups = [];
        this.state.votings = [];
        this.state.notifications = [];
        this.state.fetched = { groups: false, votings: false, notifications: false };
        this.showScreen('auth-screen');
    },



    // Setup event listeners (only once)
    setupEventListeners() {
        if (this.state.listenersAttached) return;
        this.state.listenersAttached = true;

        // Bottom navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const screen = item.dataset.screen;
                this.showScreen(screen);
                this.updateNavActive(item);
            });
        });

        // Segmented control
        document.querySelectorAll('.segment').forEach(segment => {
            segment.addEventListener('click', () => {
                document.querySelectorAll('.segment').forEach(s => s.classList.remove('active'));
                segment.classList.add('active');
                this.state.votingFilter = segment.dataset.filter;
                this.renderVotings();
            });
        });
    },

    // Navigation — also hides the blocking global loader once we've
    // actually navigated somewhere "user-visible" (post sign-in landing).
    showScreen(screenId) {
        // Any of these screens means the user can finally see the app and
        // act on it — drop the global loader.
        const userVisibleScreens = ['main-screens', 'voting-screen',
            'groups-screen', 'notifications-screen', 'profile-screen',
            'profile-setup-screen', 'auth-screen', 'register-screen',
            'forgot-password-screen', 'reset-password-screen',
            'admin-panel-screen', 'group-detail-screen'];
        if (userVisibleScreens.includes(screenId)) {
            this.hideGlobalLoader();
        }
        return this._showScreenInternal(screenId);
    },

    _showScreenInternal(screenId) {
        const mainScreens = ['voting-screen', 'groups-screen', 'notifications-screen', 'profile-screen'];
        const topLevelScreens = ['loading-screen', 'auth-screen', 'register-screen',
            'forgot-password-screen', 'reset-password-screen', 'profile-setup-screen',
            'admin-panel-screen'];
        const detailScreens = ['group-detail-screen'];
        const mainContainer = document.getElementById('main-screens');

        // Always hide detail screens (they are outside main-screens container)
        detailScreens.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });

        if (topLevelScreens.includes(screenId) || screenId === 'main-screens') {
            // Top-level navigation: hide all top-level screens and main container
            topLevelScreens.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });
            if (mainContainer) mainContainer.classList.add('hidden');

            if (screenId === 'main-screens') {
                // Show main container and default to voting screen
                mainContainer.classList.remove('hidden');
                document.querySelectorAll('#main-screens > .screen').forEach(s => s.classList.add('hidden'));
                const votingScreen = document.getElementById('voting-screen');
                if (votingScreen) votingScreen.classList.remove('hidden');
                this.state.currentScreen = 'voting-screen';
            } else {
                const target = document.getElementById(screenId);
                if (target) {
                    target.classList.remove('hidden');
                    this.state.currentScreen = screenId;
                }
            }
        } else if (mainScreens.includes(screenId)) {
            // Switch between main screens (within main container)
            topLevelScreens.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });
            if (mainContainer) mainContainer.classList.remove('hidden');

            document.querySelectorAll('#main-screens > .screen').forEach(s => s.classList.add('hidden'));
            const target = document.getElementById(screenId);
            if (target) {
                target.classList.remove('hidden');
                this.state.currentScreen = screenId;
            }
        } else if (detailScreens.includes(screenId)) {
            // Detail screens (outside main-screens) — hide main container, show detail
            if (mainContainer) mainContainer.classList.add('hidden');
            const target = document.getElementById(screenId);
            if (target) {
                target.classList.remove('hidden');
                this.state.currentScreen = screenId;
            }
        } else {
            // Fallback for unknown screens
            document.querySelectorAll('#main-screens > .screen').forEach(s => s.classList.add('hidden'));
            const target = document.getElementById(screenId);
            if (target) {
                target.classList.remove('hidden');
                this.state.currentScreen = screenId;
            }
        }
    },

    updateNavActive(activeItem) {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        activeItem.classList.add('active');
    },

    // === AUTH METHODS ===

    // Toggle password visibility
    togglePasswordVisibility() {
        const input = document.getElementById('auth-password');
        const icon = document.getElementById('password-toggle-icon');
        if (input.type === 'password') {
            input.type = 'text';
            icon.className = 'ph ph-eye-slash';
        } else {
            input.type = 'password';
            icon.className = 'ph ph-eye';
        }
    },

    toggleRegisterPasswordVisibility() {
        const input = document.getElementById('register-password');
        const icon = document.getElementById('register-password-toggle-icon');
        if (!input || !icon) return;
        if (input.type === 'password') {
            input.type = 'text';
            icon.className = 'ph ph-eye-slash';
        } else {
            input.type = 'password';
            icon.className = 'ph ph-eye';
        }
    },

    // Switch between top-level auth screens
    showAuthScreen() {
        this._clearAuthMessages();
        // Drop any leftover password-reset token (e.g. user opened a reset link
        // but didn't finish) so a later "change password" doesn't wrongly take
        // the recovery branch. Also un-stick the login button.
        this._pwResetToken = null;
        this.setBtnLoading('auth-login-btn', false);
        this.showScreen('auth-screen');
    },

    showRegisterScreen() {
        this._clearAuthMessages();
        this.showScreen('register-screen');
    },

    showForgotPasswordScreen() {
        this._clearAuthMessages();
        // Pre-fill email from auth screen if user already typed it there
        const fromAuth = document.getElementById('auth-email')?.value.trim();
        const target = document.getElementById('forgot-email');
        if (target && fromAuth && !target.value) target.value = fromAuth;
        this.showScreen('forgot-password-screen');
    },

    // Reset-password screen — reachable both from email link
    // (PASSWORD_RECOVERY event) and from "Change password" in profile.
    showResetPasswordScreen() {
        this._clearAuthMessages();
        // Hide bottom nav + main screens; show standalone reset screen
        const main = document.getElementById('main-screens');
        if (main) main.classList.add('hidden');
        // Clear inputs in case of re-entry
        ['reset-password-1', 'reset-password-2'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        this.showScreen('reset-password-screen');
    },

    // Same screen, different label — used from profile when user is logged in
    // and wants to change their password manually.
    showChangePasswordScreen() {
        this.state._returnAfterPasswordChange = 'main-screens';
        this.showResetPasswordScreen();
    },

    _clearAuthMessages() {
        ['auth-error', 'auth-success', 'register-error', 'register-success',
         'forgot-error', 'forgot-success', 'reset-error', 'reset-success'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    },

    hideRegisterMessages() {
        ['register-error', 'register-success'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    },

    showRegisterError(msg) {
        const el = document.getElementById('register-error');
        if (!el) return this.showAuthError(msg);
        el.textContent = msg;
        el.classList.remove('hidden');
        const ok = document.getElementById('register-success');
        if (ok) ok.classList.add('hidden');
    },

    showRegisterSuccess(msg) {
        const el = document.getElementById('register-success');
        if (!el) return this.showAuthSuccess(msg);
        el.textContent = msg;
        el.classList.remove('hidden');
        const err = document.getElementById('register-error');
        if (err) err.classList.add('hidden');
    },

    _showInlineError(screenPrefix, msg) {
        const el = document.getElementById(`${screenPrefix}-error`);
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
        const ok = document.getElementById(`${screenPrefix}-success`);
        if (ok) ok.classList.add('hidden');
    },

    _showInlineSuccess(screenPrefix, msg) {
        const el = document.getElementById(`${screenPrefix}-success`);
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
        const err = document.getElementById(`${screenPrefix}-error`);
        if (err) err.classList.add('hidden');
    },

    toggleResetPasswordVisibility() {
        const input = document.getElementById('reset-password-1');
        const icon = document.getElementById('reset-password-toggle-icon');
        if (!input || !icon) return;
        if (input.type === 'password') {
            input.type = 'text';
            icon.className = 'ph ph-eye-slash';
        } else {
            input.type = 'password';
            icon.className = 'ph ph-eye';
        }
    },

    // Submit forgot-password form: send reset link to the entered email
    async submitForgotPassword() {
        const t = this.translations[this.currentLanguage] || {};
        const email = document.getElementById('forgot-email')?.value.trim();
        if (!email) {
            this._showInlineError('forgot', t.auth_error_enter_email);
            return;
        }
        if (!supabaseService.isReady()) {
            this._showInlineError('forgot', t.auth_error_network);
            return;
        }
        this._clearAuthMessages();
        this.setBtnLoading('forgot-submit-btn', true);
        const { error } = await supabaseService.resetPassword(email);
        this.setBtnLoading('forgot-submit-btn', false);
        if (error) {
            this._showInlineError('forgot', this.humanError(error));
            return;
        }
        this._showInlineSuccess('forgot', t.auth_reset_sent);
        // After 3s return to login (mirrors register flow)
        setTimeout(() => {
            this.showAuthScreen();
            const loginEmail = document.getElementById('auth-email');
            if (loginEmail) loginEmail.value = email;
            this.showAuthSuccess(t.auth_reset_sent);
        }, 3000);
    },

    // Submit new password (works both for password recovery and manual change)
    async submitNewPassword() {
        const t = this.translations[this.currentLanguage] || {};
        const p1 = document.getElementById('reset-password-1')?.value || '';
        const p2 = document.getElementById('reset-password-2')?.value || '';
        if (!p1 || p1.length < 8) {
            this._showInlineError('reset', t.auth_error_password_short);
            return;
        }
        if (p1 !== p2) {
            this._showInlineError('reset', t.reset_mismatch || 'Паролі не співпадають');
            return;
        }
        if (!supabaseService.isReady()) {
            this._showInlineError('reset', t.auth_error_network);
            return;
        }
        this._clearAuthMessages();
        this.setBtnLoading('reset-submit-btn', true);
        // Recovery flow proves identity via the email token (no session);
        // the manual "change password" flow uses the logged-in session.
        const { error } = this._pwResetToken
            ? await supabaseService.confirmPasswordReset(this._pwResetToken, p1)
            : await supabaseService.updatePassword(p1);
        this.setBtnLoading('reset-submit-btn', false);
        if (error) {
            const fields = (error.data && error.data.data) || {};
            this._showInlineError('reset', fields.password ? t.auth_error_password_short : this.humanError(error));
            return;
        }
        this.toastSuccess(t.reset_done || 'Пароль оновлено');
        // Recovery: drop the token + any stale session, send the user to log in fresh.
        if (this._pwResetToken) {
            this._pwResetToken = null;
            await supabaseService.signOut();
            this.showAuthScreen();
            return;
        }
        // Decide where to go next:
        //  • If session is fully authenticated and user state is loaded → main app
        //  • Otherwise (post-recovery without prior session) → login screen so they sign in fresh
        if (this.state.user && this.state.user.id) {
            const main = document.getElementById('main-screens');
            if (main) main.classList.remove('hidden');
            this.showScreen('voting-screen');
            this.refreshProfileCTA();
        } else {
            this.showAuthScreen();
        }
    },

    // Show auth error message
    showAuthError(msg) {
        const el = document.getElementById('auth-error');
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
        const successEl = document.getElementById('auth-success');
        if (successEl) successEl.classList.add('hidden');
    },

    // Show auth success message
    showAuthSuccess(msg) {
        const el = document.getElementById('auth-success');
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
        const errorEl = document.getElementById('auth-error');
        if (errorEl) errorEl.classList.add('hidden');
    },

    // Hide auth messages
    hideAuthMessages() {
        const errorEl = document.getElementById('auth-error');
        const successEl = document.getElementById('auth-success');
        if (errorEl) errorEl.classList.add('hidden');
        if (successEl) successEl.classList.add('hidden');
    },

    // Set button loading state
    setBtnLoading(btnId, loading) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        if (loading) {
            btn.classList.add('btn-loading');
            btn.disabled = true;
        } else {
            btn.classList.remove('btn-loading');
            btn.disabled = false;
        }
    },

    // Login with Google OAuth
    async loginWithGoogle() {
        if (!supabaseService.isReady()) {
            const t = this.translations[this.currentLanguage];
            this.showAuthError(t.auth_error_network || 'Service unavailable');
            return;
        }

        this.hideAuthMessages();
        const { data, error } = await supabaseService.signInWithGoogle();

        if (error) {
            const t = this.translations[this.currentLanguage];
            this.showAuthError(t.auth_error_network || error.message);
        }
        // If successful, browser will redirect to Google
    },

    // Login with email/password
    async loginWithEmail() {
        const t = this.translations[this.currentLanguage];
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;

        if (!email || !password) {
            this.showAuthError(t.auth_error_fill_fields);
            return;
        }

        if (!supabaseService.isReady()) {
            this.showAuthError(t.auth_error_network || 'Service unavailable');
            return;
        }

        this.hideAuthMessages();
        // Show full-screen blocking spinner IMMEDIATELY — before the network
        // request even starts — so users never click Login and see a frozen
        // page. The loader stays visible until the main app actually renders
        // (handleAuthSession -> showScreen('main-screens') hides it).
        this.showGlobalLoader('loader_signing_in');
        this.setBtnLoading('auth-login-btn', true);

        const { data, error } = await supabaseService.signInWithEmail(email, password);

        if (error) {
            this.hideGlobalLoader();
            this.setBtnLoading('auth-login-btn', false);
            if (error.message.includes('Invalid login credentials')) {
                this.showAuthError(t.auth_error_invalid);
            } else if (error.message.includes('Email not confirmed')) {
                this.showAuthError(t.auth_error_not_confirmed);
            } else {
                this.showAuthError(t.auth_error_network);
            }
            return;
        }

        // Success — global loader stays on until handleAuthSession finishes
        // loading data and switches to the main screen.
    },

    // Register with email/password — uses dedicated register screen if open,
    // falls back to login screen for backward compatibility.
    async registerWithEmail() {
        const t = this.translations[this.currentLanguage];
        const onRegScreen = this.state.currentScreen === 'register-screen';
        const emailEl = document.getElementById(onRegScreen ? 'register-email' : 'auth-email');
        const passEl  = document.getElementById(onRegScreen ? 'register-password' : 'auth-password');
        const btnId   = onRegScreen ? 'register-submit-btn' : 'auth-register-btn';
        const showErr = (m) => onRegScreen ? this.showRegisterError(m) : this.showAuthError(m);
        const showOk  = (m) => onRegScreen ? this.showRegisterSuccess(m) : this.showAuthSuccess(m);
        const hideMsg = () => onRegScreen ? this.hideRegisterMessages() : this.hideAuthMessages();

        const email = emailEl?.value.trim() || '';
        const password = passEl?.value || '';

        if (!email || !password) {
            showErr(t.auth_error_fill_fields);
            return;
        }

        // PocketBase requires min 8 chars — check locally so the user gets the
        // message instantly instead of a server round-trip.
        if (password.length < 8) {
            showErr(t.auth_error_password_short);
            return;
        }

        if (!supabaseService.isReady()) {
            showErr(t.auth_error_network || 'Service unavailable');
            return;
        }

        hideMsg();
        this.setBtnLoading(btnId, true);

        const { data, error } = await supabaseService.signUpWithEmail(email, password);

        this.setBtnLoading(btnId, false);

        if (error) {
            // PocketBase puts per-field validation errors in the response body
            // (error.data.data.email / .password) — map them to translated text
            // instead of showing the raw English "Failed to create record."
            const fields = (error.data && error.data.data) || {};
            if (fields.email?.code === 'validation_not_unique' || error.message.includes('already registered')) {
                showErr(t.auth_error_exists);
            } else if (fields.email) {
                showErr(t.auth_error_invalid_email);
            } else if (fields.password) {
                showErr(t.auth_error_password_short);
            } else {
                showErr(this.humanError(error));
            }
            return;
        }

        // PocketBase signs the user in immediately on registration — there is no
        // email-confirmation step. The auth-state listener (onAuthStateChange →
        // handleAuthSession) has already routed them to the profile-setup screen,
        // so we just let that continue. No "check your email", no bounce to login.
        hideMsg();
    },

    // Legacy entry point — now redirects to the dedicated forgot-password screen.
    resetPassword() { this.showForgotPasswordScreen(); },


    // Legacy login() for backward compatibility
    login() {
        this.loginWithGoogle();
    },

    async saveProfile() {
        const t = this.translations[this.currentLanguage];
        const firstName = document.getElementById('profile-firstname').value.trim();
        const lastName = document.getElementById('profile-lastname').value.trim();
        const phone = document.getElementById('profile-phone').value.trim();
        const address = document.getElementById('profile-address').value.trim();
        const apartment = document.getElementById('profile-apartment').value.trim();

        if (!firstName || !lastName) {
            this.toastError(t.fill_name_error);
            return;
        }

        // Check if this is first profile save
        const isFirstSave = !this.state.user || !this.state.user.apartment;

        // Update local state
        this.state.user = {
            ...this.state.user,
            firstName,
            lastName,
            phone,
            address,
            apartment
        };

        // Save to Supabase if connected
        if (supabaseService.isReady() && this.state.user.id) {
            this.setBtnLoading('profile-save-btn', true);

            const { profile, error } = await supabaseService.updateProfile(this.state.user.id, {
                first_name: firstName,
                last_name: lastName,
                phone: phone,
                address: address,
                apartment: apartment,
                profile_completed: true
            });

            this.setBtnLoading('profile-save-btn', false);

            if (error) {
                this.toastError(t.auth_error_network);
                return;
            }
        }

        // Show Terms on first save
        if (isFirstSave) {
            this.showTermsModal();
            return;
        }

        document.getElementById('profile-setup-screen').classList.add('hidden');
        document.getElementById('main-screens').classList.remove('hidden');
        this.showScreen('voting-screen');
        this.updateProfileDisplay();
        this.refreshProfileCTA();
    },

    showTermsModal() {
        document.getElementById('terms-agree').checked = false;
        this.showModal('terms-modal');
    },

    async acceptTerms() {
        const t = this.translations[this.currentLanguage];
        const agreed = document.getElementById('terms-agree').checked;

        if (!agreed) {
            this.toastError(t.terms_agree_text);
            return;
        }

        this.hideModal('terms-modal');
        document.getElementById('profile-setup-screen').classList.add('hidden');

        this.setupEventListeners();
        this.updateProfileDisplay();

        // Load data BEFORE showing main screen
        try {
            await Promise.all([
                this.loadMyGroups(),
                this.loadMyVotings(),
                this.loadMyNotifications()
            ]);
        } catch (loadErr) {
            // Data load failed silently
        }

        // Show main screen only AFTER data is loaded
        document.getElementById('main-screens').classList.remove('hidden');
        this.showScreen('voting-screen');

        // Inline UX helpers
        this.refreshProfileCTA();
        this.refreshAdminBadge();
        this.initPullToRefresh();

        // Start periodic check
        if (this._expiryInterval) clearInterval(this._expiryInterval);
        this._expiryInterval = setInterval(() => this.checkExpiredVotingsServer(), 60000);

        // Subscribe to realtime updates
        this.subscribeToRealtime();
    },

    async logout() {
        const t = this.translations[this.currentLanguage] || {};
        const ok = await this.confirm({
            title: t.logout || 'Вийти',
            message: t.logout_confirm || 'Вийти з акаунту? Доведеться увійти знову.',
            okText: t.logout || 'Вийти',
            danger: true
        });
        if (!ok) return;
        if (supabaseService.isReady()) {
            await supabaseService.signOut();
        }
        try {
            localStorage.removeItem('vc_groups');
            localStorage.removeItem('vc_notifications');
            localStorage.removeItem('vc_user');
        } catch (e) { /* ignore */ }
        // Wipe cached API responses (groups, votes, profiles, notifications) so the
        // next person on a shared device can't be served the previous user's data.
        try {
            if (window.caches) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
        } catch (e) { /* ignore */ }
        location.reload();
    },

    // === DATA LOADING FROM SUPABASE ===

    async loadMyGroups() {
        // Show cached data instantly
        try {
            const cached = localStorage.getItem('vc_groups');
            if (cached) {
                this.state.groups = JSON.parse(cached);
                this.renderGroups();
                this.updateProfileDisplay();
            }
        } catch (e) { /* ignore parse errors */ }

        // Fetch fresh data from server
        const { data, error } = await supabaseService.getMyGroupsWithStats();
        if (error || !data) {
            this.state.fetched.groups = true;
            // Surface a real load failure (instead of a silently empty screen)
            // when there's nothing cached to fall back to.
            if (error && !this.state.groups.length) {
                this.toastError((this.translations[this.currentLanguage] || {}).load_failed || 'Не вдалося завантажити. Потягніть вниз, щоб оновити.');
            }
            this.renderGroups();
            return;
        }

        this.state.groups = data.map(item => ({
            id: item.group_id,
            name: item.name,
            description: item.description,
            groupId: item.group_code,
            isAdmin: item.role === 'admin',
            membersCount: item.members_count || 0,
            votingsCount: item.total_votings_count || 0,
            members: [],
            requests: [],
            history: [],
            // Current user's own role in this group — needed on the votings
            // and profile screens, which never populate group.members.
            myIsObserver: false,
            myApartment: ''
        }));

        // Attach the current user's per-group role flags so the votings tab
        // and profile know who is an observer without opening group detail.
        try {
            const { data: memberships } = await supabaseService.getMyMemberships();
            const byGroup = {};
            (memberships || []).forEach(m => { byGroup[m.group_id] = m; });
            this.state.groups.forEach(g => {
                const m = byGroup[g.id];
                if (m) {
                    g.myIsObserver = m.is_observer === true;
                    g.myApartment = m.apartment || '';
                }
            });
        } catch (e) { /* non-fatal — defaults to voter */ }

        // Cache for next load
        try { localStorage.setItem('vc_groups', JSON.stringify(this.state.groups)); }
        catch (e) { /* storage full */ }

        this.state.fetched.groups = true;
        this.renderGroups();
        this.updateProfileDisplay();
    },

    async loadMyVotings() {
        const { data: votings, error } = await supabaseService.getMyVotings();
        if (error || !votings) {
            this.state.fetched.votings = true;
            if (error && !this.state.votings.length) {
                this.toastError((this.translations[this.currentLanguage] || {}).load_failed || 'Не вдалося завантажити. Потягніть вниз, щоб оновити.');
            }
            this.renderVotings();
            return;
        }

        const votingIds = votings.map(v => v.id);
        const { data: results } = await supabaseService.getVotingResults(votingIds);
        const resultsMap = {};
        (results || []).forEach(r => { resultsMap[r.voting_id] = r; });

        // Check which votings user has voted on
        const userId = this.state.user.id;
        let votedSet = new Set();
        if (votingIds.length > 0) {
            const { data: myVotes } = await supabaseService.getMyVotes();
            const ids = new Set(votingIds);
            votedSet = new Set((myVotes || []).map(mv => mv.voting_id).filter(id => ids.has(id)));
        }

        this.state.votings = votings.map(v => {
            const r = resultsMap[v.id] || { yes_votes: 0, no_votes: 0, abstain_votes: 0, total_votes: 0 };
            return {
                id: v.id,
                title: v.title,
                description: v.description,
                groupId: v.group_id,
                groupName: v.group?.name || '',
                type: v.type,
                status: v.status,
                result: v.result,
                createdAt: v.created_at,
                endsAt: new Date(v.ends_at),
                endedAt: v.completed_at,
                yesVotes: r.yes_votes,
                noVotes: r.no_votes,
                abstainVotes: r.abstain_votes,
                totalMembers: 0,
                link: v.link,
                hasVoted: votedSet.has(v.id),
                targetMemberId: v.target_member_id,
                targetMemberName: v.target ? `${v.target.first_name} ${v.target.last_name}`.trim() : null,
                removalReason: v.removal_reason,
                initiatorId: v.created_by,
                initiatorName: v.creator ? `${v.creator.first_name} ${v.creator.last_name}`.trim() : '',
                freezeMembers: [],
                objections: [],
                comments: []
            };
        });

        // Populate totalMembers from already-loaded groups (membersCount).
        const statsMap = {};
        (this.state.groups || []).forEach(g => { statsMap[g.id] = g.membersCount; });
        this.state.votings.forEach(v => {
            v.totalMembers = statsMap[v.groupId] || 1;
        });

        this.state.fetched.votings = true;
        this.renderVotings();
    },

    async loadMyNotifications() {
        // Show cached data instantly
        try {
            const cached = localStorage.getItem('vc_notifications');
            if (cached) {
                this.state.notifications = JSON.parse(cached);
                this.renderNotifications();
            }
        } catch (e) { /* ignore */ }

        // Fetch fresh data
        const { data, error } = await supabaseService.getMyNotifications();
        if (error || !data) {
            this.state.fetched.notifications = true;
            this.renderNotifications();
            return;
        }

        this.state.notifications = data.map(n => ({
            id: n.id,
            type: n.type,
            text: n.text,
            time: new Date(n.created_at).toLocaleString(),
            read: n.is_read,
            metadata: n.metadata || null
        }));

        try { localStorage.setItem('vc_notifications', JSON.stringify(this.state.notifications)); }
        catch (e) { /* storage full */ }

        this.state.fetched.notifications = true;
        this.renderNotifications();
    },

    // === REALTIME (PocketBase subscriptions) ===
    // PocketBase delivers events filtered by each collection's view-rule, so the
    // notifications stream only carries the current user's own records.
    subscribeToRealtime() {
        if (!supabaseService.isReady() || !this.state.user) return;
        if (this._rtSubscribed) return;   // already subscribed — don't thrash the SSE connection
        this.unsubscribeFromRealtime();

        const debouncedReload = () => {
            clearTimeout(this._votingReloadTimer);
            this._votingReloadTimer = setTimeout(() => this.loadMyVotings(), 600);
        };

        // Only the notifications stream is subscribed directly. The group-scoped
        // collections (votes/votings/join_requests) now carry membership access
        // rules that PocketBase realtime can't evaluate for a wildcard subscription
        // — subscribing to them hangs in a /api/realtime retry loop. Instead we
        // react to the notification TYPE: every meaningful event emits a
        // notification server-side, so this single working stream keeps the right
        // screen fresh. (Live per-vote tally updates are the only thing lost —
        // those refresh on navigation and the 60s expiry check.)
        supabaseService.realtimeSubscribe('notifications', (e) => {
            if (e.action !== 'create' || !e.record) return;
            const n = e.record;
            this.state.notifications.unshift({
                id: n.id, type: n.type, text: n.text,
                time: new Date(String(n.created).replace(' ', 'T')).toLocaleString(),
                read: n.is_read
            });
            this.renderNotifications();
            if (n.type !== 'system' || (n.text && !n.is_read)) this.toastInfo(n.text);

            // Refresh the relevant data based on what happened.
            if (n.type === 'new_voting' || n.type === 'voting_completed') {
                debouncedReload();
            } else if (n.type === 'join_request' || n.type === 'role_change_request') {
                if (this.state.currentScreen === 'group-detail-screen' && this.state.currentGroupId) {
                    this.showGroupDetail(this.state.currentGroupId);
                }
            }
        });

        this._rtSubscribed = true;
    },

    unsubscribeFromRealtime() {
        if (!supabaseService.isReady()) return;
        try {
            ['notifications', 'votes', 'votings', 'join_requests'].forEach(c => supabaseService.realtimeUnsubscribe(c));
        } catch (e) { /* ignore */ }
        if (this._votingReloadTimer) {
            clearTimeout(this._votingReloadTimer);
            this._votingReloadTimer = null;
        }
        this._rtSubscribed = false;
    },

    async checkExpiredVotingsServer() {
        try {
            await supabaseService.checkExpiredVotings();
            await this.loadMyVotings();
        } catch (err) {
            // Silently ignore — not critical
        }
    },

    // Render votings
    renderVotings() {
        const list = document.getElementById('voting-list');
        const t = this.translations[this.currentLanguage];
        const filter = this.state.votingFilter;
        
        const filtered = this.state.votings.filter(v => {
            if (filter === 'active') return v.status === 'active';
            if (filter === 'completed') return v.status === 'completed';
            return true;
        });

        if (filtered.length === 0) {
            if (!this.state.fetched.votings) {
                list.innerHTML = this.renderSkeleton(3);
            } else {
                list.innerHTML = this.renderEmpty('ph ph-scales', t.empty_votings, t.empty_votings_hint);
            }
            return;
        }

        list.innerHTML = filtered.map(voting => {
            const abstainVotes = voting.abstainVotes || 0;
            const totalVoted = voting.yesVotes + voting.noVotes + abstainVotes;
            const safeTotal = voting.totalMembers > 0 ? voting.totalMembers : 1;
            const progress = Math.round((totalVoted / safeTotal) * 100);
            const yesPercent = Math.round((voting.yesVotes / safeTotal) * 100);
            const timeLeft = this.getTimeLeft(voting.endsAt);
            
            // Format creation date
            const createdDate = new Date(voting.createdAt);
            const dateStr = createdDate.toLocaleDateString();
            const timeStr = createdDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Format end date for completed votings
            let dateRangeStr = '';
            if (voting.status === 'completed' && voting.endedAt) {
                const endDate = new Date(voting.endedAt);
                const endDateStr = endDate.toLocaleDateString();
                dateRangeStr = `${dateStr} ${timeStr} — ${endDateStr}`;
            } else {
                dateRangeStr = `${dateStr} ${timeStr}`;
            }
            
            let statusClass = 'pending';
            if (voting.status === 'completed') {
                statusClass = voting.result === 'accepted' ? 'accepted' : 'rejected';
            }
            
            // Get author info
            const authorName = voting.initiatorName || t.unknown_author;

            return `
                <div class="voting-card" role="button" tabindex="0" onclick="app.showVotingDetail('${voting.id}')" onkeydown="if(event.key==='Enter')app.showVotingDetail('${voting.id}')">
                    <div class="voting-header">
                        <div class="voting-title">${this.escapeHTML(voting.title)}</div>
                        <div class="voting-status ${statusClass}"></div>
                    </div>
                    <div class="voting-author">
                        <i class="ph ph-user" aria-hidden="true"></i> ${this.escapeHTML(authorName)}
                    </div>
                    <div class="voting-meta">
                        <span><i class="ph ph-users-three" aria-hidden="true"></i> ${this.escapeHTML(voting.groupName)}</span>
                        ${voting.status === 'active'
                            ? `<span><i class="ph ph-scales" aria-hidden="true"></i> ${voting.type === 'secret' ? t.secret_voting : t.open_voting}</span><span><i class="ph ph-clock" aria-hidden="true"></i> ${timeLeft}</span>`
                            : `<span>${voting.result === 'accepted' ? '<i class="ph-fill ph-check-circle text-success" aria-hidden="true"></i> ' + t.result_accepted : '<i class="ph-fill ph-x-circle text-danger" aria-hidden="true"></i> ' + t.result_rejected}</span>`
                        }
                    </div>
                    <div class="voting-date">
                        <i class="ph ph-calendar-blank" aria-hidden="true"></i> ${this.escapeHTML(dateRangeStr)}
                    </div>
                    <div class="voting-progress">
                        <div class="progress-bar" role="progressbar" aria-valuenow="${yesPercent}" aria-valuemin="0" aria-valuemax="100">
                            <div class="progress-fill ${statusClass}" style="width: ${yesPercent}%"></div>
                        </div>
                        <div class="progress-text">
                            <span>${t.yes}: ${voting.yesVotes} | ${t.no}: ${voting.noVotes}${abstainVotes > 0 ? ` | ${t.abstain_short || 'Утр'}: ${abstainVotes}` : ''}</span>
                            <span>${progress}% ${t.participation}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    getTimeLeft(endDate) {
        const t = this.translations[this.currentLanguage];
        const diff = endDate - new Date();
        if (isNaN(diff) || diff <= 0) return t.completed;
        
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days} ${t.days}`;
        return `${hours} ${t.hours}`;
    },

    // Render groups
    renderGroups() {
        const list = document.getElementById('groups-list');
        const t = this.translations[this.currentLanguage];
        
        if (this.state.groups.length === 0) {
            if (!this.state.fetched.groups) {
                list.innerHTML = this.renderSkeleton(2);
            } else {
                list.innerHTML = this.renderEmpty('ph ph-users-three', t.empty_groups, t.empty_groups_hint);
            }
            return;
        }

        list.innerHTML = this.state.groups.map(group => `
            <div class="group-card" role="button" tabindex="0" onclick="app.showGroupDetail('${group.id}')" onkeydown="if(event.key==='Enter')app.showGroupDetail('${group.id}')">
                <div class="group-card-header">
                    <div class="group-card-title">${this.escapeHTML(group.name)}</div>
                    <div class="group-card-role ${group.isAdmin ? '' : 'member'}">
                        ${group.isAdmin ? t.admin : t.member}
                    </div>
                </div>
                <div class="group-card-meta">
                    <i class="ph ph-users-three" aria-hidden="true"></i> ${group.membersCount} ${t.members} • <i class="ph ph-scales" aria-hidden="true"></i> ${group.votingsCount} ${t.votings}
                </div>
                <div class="group-id-badge">
                    <i class="ph ph-key" aria-hidden="true"></i> ${this.escapeHTML(group.groupId)}
                </div>
            </div>
        `).join('');
    },

    // Render notifications
    renderNotifications() {
        const list = document.getElementById('notifications-list');
        const t = this.translations[this.currentLanguage];
        const unreadCount = this.state.notifications.filter(n => !n.read).length;
        
        // Update nav label
        const navLabel = document.getElementById('nav-notifications');
        if (navLabel) navLabel.textContent = unreadCount > 0 ? `${t.notifications} (${unreadCount})` : t.notifications;

        if (this.state.notifications.length === 0) {
            if (!this.state.fetched.notifications) {
                list.innerHTML = this.renderSkeleton(3);
            } else {
                list.innerHTML = this.renderEmpty('ph ph-bell', t.empty_notifications, t.empty_notifications_hint);
            }
            return;
        }

        list.innerHTML = this.state.notifications.map(notif => {
            const icons = {
                voting: '<i class="ph ph-scales"></i>',
                member: '<i class="ph ph-user"></i>',
                join_request: '<i class="ph ph-user-plus"></i>',
                result: '<i class="ph ph-check-circle"></i>',
                system: '<i class="ph ph-bell"></i>'
            };

            // Actionable join-request notification: approve/reject inline
            const meta = notif.metadata || {};
            const isJoinRequest = (notif.type === 'join_request' || notif.type === 'member')
                && meta.request_id && meta.group_id;
            const approveLbl = t.approve || 'Прийняти';
            const rejectLbl = t.reject || 'Відхилити';
            const actions = isJoinRequest ? `
                <div class="notif-actions">
                    <button class="btn-notif-approve" title="${this.escapeHTML(approveLbl)}" aria-label="${this.escapeHTML(approveLbl)}"
                        onclick="event.stopPropagation(); app.approveFromNotification('${notif.id}', '${meta.group_id}', '${meta.request_id}')">
                        <i class="ph-fill ph-check" aria-hidden="true"></i>
                    </button>
                    <button class="btn-notif-reject" title="${this.escapeHTML(rejectLbl)}" aria-label="${this.escapeHTML(rejectLbl)}"
                        onclick="event.stopPropagation(); app.rejectFromNotification('${notif.id}', '${meta.group_id}', '${meta.request_id}')">
                        <i class="ph-fill ph-x" aria-hidden="true"></i>
                    </button>
                </div>` : '';

            // Tapping the body marks read AND navigates to the relevant group
            const targetGroupId = meta.group_id || '';
            const onClick = `app.handleNotificationTap('${notif.id}', '${this.escapeHTML(targetGroupId)}')`;

            return `
                <div class="notification-item ${notif.read ? 'read' : 'unread'}" role="button" tabindex="0"
                    onclick="${onClick}" onkeydown="if(event.key==='Enter')${onClick}">
                    <div class="notification-icon">${icons[notif.type] || '<i class="ph ph-bell"></i>'}</div>
                    <div class="notification-content">
                        <div class="notification-text">${this.escapeHTML(notif.text)}</div>
                        <div class="notification-time">${this.escapeHTML(notif.time)}</div>
                    </div>
                    ${actions}
                    ${!notif.read ? '<div class="notification-dot"></div>' : ''}
                </div>
            `;
        }).join('');
    },

    // Tap on notification body — mark read + route by metadata
    async handleNotificationTap(notifId, groupId) {
        await this.markRead(notifId);
        if (groupId && this.state.groups.find(g => g.id === groupId)) {
            this.showGroupDetail(groupId);
        }
    },

    async approveFromNotification(notifId, groupId, requestId, forceObserver = false) {
        const t = this.translations[this.currentLanguage] || {};
        // Use V2 RPC — honours requested role (voter/observer), copies the
        // apartment, re-checks the apartment slot, and handles role-change
        // requests. The legacy V1 ignored all of this (observer→voter,
        // NULL apartment, role-change became a silent no-op).
        const { error } = await supabaseService.approveJoinRequestV2(requestId, forceObserver);
        if (error) {
            const msg = error.message || '';
            if (msg.includes('apartment_taken_now')) {
                const confirmed = await this.confirm({
                    message: t.apartment_taken_now_confirm || 'Квартира вже зайнята. Затвердити як спостерігача?',
                    okText: t.confirm_ok || 'Підтвердити',
                    cancelText: t.cancel || 'Скасувати',
                    danger: false
                });
                if (confirmed) {
                    await this.approveFromNotification(notifId, groupId, requestId, true);
                }
                return;
            }
            this.toastError(this.humanError(error));
            return;
        }
        this.toastSuccess(t.request_approved || 'Запит схвалено');
        // Mark notification read + remove the action buttons by re-render
        this._removeNotifMetadata(notifId);
        await this.markRead(notifId);
        // Refresh group if open
        if (groupId && this.state.currentScreen === 'group-detail-screen') {
            this.showGroupDetail(groupId);
        }
        // Reload notifications + groups list (member count changed)
        this.loadMyNotifications();
        this.loadMyGroups();
    },

    async rejectFromNotification(notifId, groupId, requestId) {
        const t = this.translations[this.currentLanguage] || {};
        const { error } = await supabaseService.rejectJoinRequest(requestId);
        if (error) { this.toastError(this.humanError(error)); return; }
        this.toastSuccess(t.request_rejected || 'Запит відхилено');
        this._removeNotifMetadata(notifId);
        await this.markRead(notifId);
        if (groupId && this.state.currentScreen === 'group-detail-screen') {
            this.showGroupDetail(groupId);
        }
        this.loadMyNotifications();
    },

    // Remove the action-buttons trigger so the notification doesn't keep
    // them visible after the request was already handled.
    _removeNotifMetadata(notifId) {
        const n = this.state.notifications.find(x => String(x.id) === String(notifId));
        if (n && n.metadata) { delete n.metadata.request_id; }
    },

    async markRead(id) {
        const notif = this.state.notifications.find(n => String(n.id) === String(id));
        if (notif && !notif.read) {
            notif.read = true;
            this.renderNotifications();
            await supabaseService.markNotificationRead(id);
        }
    },

    async markAllRead() {
        this.state.notifications.forEach(n => n.read = true);
        this.renderNotifications();
        await supabaseService.markAllNotificationsRead();
    },

    // Move every currently shown notification into the archive.
    // Archive is permanent (never auto-deleted) — this is a "clear inbox"
    // action without losing history.
    async archiveAllNotifications() {
        const t = this.translations[this.currentLanguage] || {};
        const count = this.state.notifications.length;
        if (count === 0) {
            this.toastInfo(t.archive_empty || 'Список вже порожній');
            return;
        }
        const ok = await this.confirm({
            title: t.archive_confirm_title || 'В архів',
            message: t.archive_confirm_msg || `Перенести ${count} сповіщень в архів? Вони залишаться в історії, але список очиститься.`,
            okText: t.archive_all || 'В архів',
            danger: false
        });
        if (!ok) return;
        const { error } = await supabaseService.archiveAllNotifications();
        if (error) {
            // archived_at column likely missing — explain
            if (/archived_at/i.test(error.message || '')) {
                this.toastError(t.archive_needs_migration || 'Спочатку накатіть phase12-notif-archive.sql');
                return;
            }
            this.toastError(this.humanError(error));
            return;
        }
        this.state.notifications = [];
        this.renderNotifications();
        this.toastSuccess(t.archive_done || 'Перенесено в архів');
    },

    // === NOTIFICATIONS ARCHIVE VIEW ===
    async showNotificationsArchive() {
        const arch = this.state.archive;
        arch.items = [];
        arch.query = '';
        arch.offset = 0;
        arch.hasMore = false;
        const input = document.getElementById('archive-search-input');
        if (input) {
            input.value = '';
            // Attach listener once
            if (!input.dataset.listenerAttached) {
                input.addEventListener('input', () => this._scheduleArchiveSearch());
                input.dataset.listenerAttached = '1';
            }
        }
        document.getElementById('archive-search-clear')?.classList.add('hidden');
        this.showScreen('notifications-archive-screen');
        await this._fetchArchivePage(false);
    },

    _scheduleArchiveSearch() {
        const arch = this.state.archive;
        const input = document.getElementById('archive-search-input');
        const clearBtn = document.getElementById('archive-search-clear');
        const raw = input?.value || '';
        if (clearBtn) clearBtn.classList.toggle('hidden', raw.length === 0);
        if (arch.debounceTimer) clearTimeout(arch.debounceTimer);
        arch.debounceTimer = setTimeout(async () => {
            const q = raw.trim();
            // Empty or 1-2 chars → show recent archive (no filter)
            if (q.length > 0 && q.length < 3) return;
            arch.query = q;
            arch.offset = 0;
            arch.items = [];
            arch.hasMore = false;
            await this._fetchArchivePage(false);
        }, 300);
    },

    clearArchiveSearch() {
        const input = document.getElementById('archive-search-input');
        if (input) input.value = '';
        document.getElementById('archive-search-clear')?.classList.add('hidden');
        const arch = this.state.archive;
        arch.query = '';
        arch.offset = 0;
        arch.items = [];
        arch.hasMore = false;
        this._fetchArchivePage(false);
    },

    async loadMoreArchive() {
        const arch = this.state.archive;
        if (arch.loading || !arch.hasMore) return;
        arch.offset += arch.pageSize;
        const ok = await this._fetchArchivePage(true);
        // Roll back the page cursor if the fetch failed, so a retry doesn't skip a page.
        if (!ok) arch.offset = Math.max(0, arch.offset - arch.pageSize);
    },

    async _fetchArchivePage(append) {
        const arch = this.state.archive;
        const t = this.translations[this.currentLanguage] || {};
        const list = document.getElementById('archive-list');
        const moreBtn = document.getElementById('archive-load-more-btn');
        if (!list) return;
        arch.loading = true;

        if (!append) list.innerHTML = this.renderSkeleton(3);
        moreBtn?.classList.add('hidden');

        const { data, error } = await supabaseService.searchNotifications(arch.query, true, arch.pageSize, arch.offset);
        arch.loading = false;
        if (error) {
            list.innerHTML = `<div class="empty-state-inline">${this.escapeHTML(error.message || 'Error')}</div>`;
            return false;
        }
        const items = (data || []).map(n => ({
            id: n.id,
            type: n.type,
            text: n.text,
            read: n.is_read,
            time: new Date(n.created_at).toLocaleString(),
            archivedAt: n.archived_at
        }));
        arch.items = append ? arch.items.concat(items) : items;
        arch.hasMore = items.length === arch.pageSize;
        this._renderArchiveList();
        return true;
    },

    _renderArchiveList() {
        const arch = this.state.archive;
        const t = this.translations[this.currentLanguage] || {};
        const list = document.getElementById('archive-list');
        const moreBtn = document.getElementById('archive-load-more-btn');
        if (!list) return;

        if (arch.items.length === 0) {
            const empty = arch.query
                ? (t.archive_no_search_results || 'Нічого не знайдено')
                : (t.archive_empty_state || 'Архів порожній');
            list.innerHTML = `<div class="empty-state-inline">${this.escapeHTML(empty)}</div>`;
            moreBtn?.classList.add('hidden');
            return;
        }

        const icons = {
            voting: '<i class="ph ph-scales"></i>',
            member: '<i class="ph ph-user"></i>',
            join_request: '<i class="ph ph-user-plus"></i>',
            result: '<i class="ph ph-check-circle"></i>',
            system: '<i class="ph ph-bell"></i>'
        };

        list.innerHTML = arch.items.map(n => `
            <div class="notification-item read archived">
                <div class="notification-icon">${icons[n.type] || '<i class="ph ph-bell"></i>'}</div>
                <div class="notification-content">
                    <div class="notification-text">${this.escapeHTML(n.text)}</div>
                    <div class="notification-time">${this.escapeHTML(n.time)}</div>
                </div>
                <button class="btn-notif-unarchive" title="${t.unarchive || 'Розархівувати'}" aria-label="${t.unarchive || 'Розархівувати'}"
                    onclick="event.stopPropagation(); app.unarchiveNotification('${n.id}')">
                    <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i>
                </button>
            </div>
        `).join('');

        if (arch.hasMore) moreBtn?.classList.remove('hidden');
        else moreBtn?.classList.add('hidden');
    },

    async unarchiveNotification(id) {
        const t = this.translations[this.currentLanguage] || {};
        const ok = await this.confirm({
            title: t.unarchive || 'Розархівувати',
            message: t.unarchive_confirm || 'Повернути сповіщення до основного списку?',
            okText: t.unarchive || 'Розархівувати',
            danger: false
        });
        if (!ok) return;
        const { error } = await supabaseService.unarchiveNotification(id);
        if (error) { this.toastError(this.humanError(error)); return; }
        // Remove from local archive list
        const arch = this.state.archive;
        arch.items = arch.items.filter(n => n.id !== id);
        this._renderArchiveList();
        // Refresh active list so it appears there
        this.loadMyNotifications();
        this.toastSuccess(t.unarchive_done || 'Повернуто до основного списку');
    },

    // === GLOBAL LOADER ===
    // Full-screen blocking spinner. Used during sign-in/sign-up so the
    // user never sees a frozen UI between "Login" click and the main app.
    showGlobalLoader(textKey) {
        const el = document.getElementById('global-loader');
        if (!el) return;
        const t = this.translations[this.currentLanguage] || {};
        const txt = el.querySelector('.global-loader-text');
        if (txt && textKey && t[textKey]) txt.textContent = t[textKey];
        el.classList.remove('hidden');
    },

    hideGlobalLoader() {
        const el = document.getElementById('global-loader');
        if (el) el.classList.add('hidden');
    },

    // === TOAST NOTIFICATIONS ===
    // Replaces native this.toastError() across the app — non-blocking, themed, accessible.
    // Usage: app.toast('msg'), app.toast('msg', 'error'|'success'|'warning'|'info'), or shorthands.
    toast(message, type = 'info', durationMs = 3500) {
        const container = document.getElementById('toast-container');
        if (!container || !message) return;

        const icons = {
            error:   'ph-warning-circle',
            success: 'ph-check-circle',
            warning: 'ph-warning',
            info:    'ph-info'
        };
        const iconClass = icons[type] || icons.info;

        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');

        const safeMsg = this.escapeHTML(String(message));
        el.innerHTML = `
            <span class="toast-icon"><i class="ph-fill ${iconClass}" aria-hidden="true"></i></span>
            <span class="toast-text">${safeMsg}</span>
            <button class="toast-close" aria-label="Close">&times;</button>
        `;

        const remove = () => {
            el.classList.add('toast-leaving');
            setTimeout(() => el.remove(), 200);
        };
        el.querySelector('.toast-close').addEventListener('click', remove);

        container.appendChild(el);
        setTimeout(remove, durationMs);
    },

    toastError(msg)   { return this.toast(msg, 'error'); },

    // Turn a raw backend error into a translated, human message. Never show
    // technical/English server text ("Failed to create record.") to the user.
    humanError(error) {
        const t = this.translations[this.currentLanguage] || {};
        // Route errors carry the code in the response body ({error:"not_admin"}),
        // not in message — include both so the specific mappings actually fire.
        let raw = String(error?.message || '');
        try { raw += ' ' + JSON.stringify(error?.data || error?.response || ''); } catch (e) { /* ignore */ }
        const map = {
            apartment_taken: t.apartment_taken,
            not_admin: t.err_not_admin,
            request_not_found: t.err_request_not_found,
            not_member: t.not_member,
            admin_must_transfer_first: t.admin_cannot_leave,
            exclusion_only_via_voting: t.err_exclusion_only_via_voting
        };
        for (const k in map) { if (raw.includes(k) && map[k]) return map[k]; }
        return t.error_generic || t.auth_error_network || 'Сталася помилка. Спробуйте ще раз.';
    },
    toastSuccess(msg) { return this.toast(msg, 'success'); },
    toastWarning(msg) { return this.toast(msg, 'warning'); },
    toastInfo(msg)    { return this.toast(msg, 'info'); },

    // === CONFIRM DIALOG ===
    // Promise-based replacement for window.confirm. Use:
    //   if (await app.confirm({ title, message, okText, danger })) { ... }
    confirm({ title, message, okText, cancelText, danger = true } = {}) {
        return new Promise(resolve => {
            const t = this.translations[this.currentLanguage] || {};
            const titleEl = document.getElementById('confirm-title');
            const msgEl = document.getElementById('confirm-message');
            const okBtn = document.getElementById('confirm-ok-btn');
            const cancelBtn = document.getElementById('confirm-cancel-btn');
            if (!titleEl || !msgEl || !okBtn || !cancelBtn) {
                resolve(window.confirm(message || ''));
                return;
            }
            titleEl.textContent = title || t.confirm_title || 'Підтвердження';
            msgEl.textContent = message || '';
            okBtn.textContent = okText || t.confirm_ok || 'Підтвердити';
            cancelBtn.textContent = cancelText || t.cancel || 'Скасувати';
            okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

            this._confirmResolver = resolve;
            this.showModal('confirm-modal');
        });
    },

    confirmDialogConfirm() {
        const r = this._confirmResolver;
        this._confirmResolver = null;
        this.hideModal('confirm-modal');
        if (r) r(true);
    },

    confirmDialogCancel() {
        const r = this._confirmResolver;
        this._confirmResolver = null;
        this.hideModal('confirm-modal');
        if (r) r(false);
    },

    // === PROFILE-COMPLETION CTA ===
    // Show inline banner on the voting screen if the user can't vote yet
    // (apartment field is empty — required to cast votes per createVoting check).
    refreshProfileCTA() {
        const cta = document.getElementById('profile-incomplete-cta');
        if (!cta) return;
        const incomplete = !this.state.user || !this.state.user.apartment;
        cta.classList.toggle('hidden', !incomplete);
    },

    // === PULL-TO-REFRESH ===
    // Attached to .screen-content[data-ptr]; passive on the scroll container.
    // Threshold 60px; reload routes per data-ptr value.
    initPullToRefresh() {
        if (this._ptrInitialized) return;
        this._ptrInitialized = true;

        document.querySelectorAll('.screen-content[data-ptr]').forEach(container => {
            const route = container.getAttribute('data-ptr');
            const indicator = document.createElement('div');
            indicator.className = 'ptr-indicator';
            indicator.innerHTML = '<i class="ph ph-arrow-down"></i><span class="ptr-text"></span>';
            container.before(indicator);

            const t = () => this.translations[this.currentLanguage] || {};
            const labelPull   = () => t().ptr_pull   || 'Потягніть, щоб оновити';
            const labelArmed  = () => t().ptr_release|| 'Відпустіть, щоб оновити';
            const labelLoad   = () => t().ptr_loading|| 'Оновлюємо…';

            let startY = 0;
            let pulling = false;
            let armed = false;

            container.addEventListener('touchstart', (e) => {
                if (container.scrollTop > 0) { pulling = false; return; }
                startY = e.touches[0].clientY;
                pulling = true;
                armed = false;
            }, { passive: true });

            container.addEventListener('touchmove', (e) => {
                if (!pulling) return;
                const delta = e.touches[0].clientY - startY;
                if (delta <= 0) {
                    indicator.classList.remove('active', 'armed');
                    return;
                }
                indicator.classList.add('active');
                indicator.querySelector('.ptr-text').textContent = labelPull();
                if (delta > 60 && !armed) {
                    armed = true;
                    indicator.classList.add('armed');
                    indicator.querySelector('.ptr-text').textContent = labelArmed();
                } else if (delta <= 60 && armed) {
                    armed = false;
                    indicator.classList.remove('armed');
                    indicator.querySelector('.ptr-text').textContent = labelPull();
                }
            }, { passive: true });

            const finish = async () => {
                if (!pulling) return;
                pulling = false;
                if (armed) {
                    indicator.classList.add('refreshing');
                    indicator.querySelector('.ptr-text').textContent = labelLoad();
                    try {
                        if (route === 'voting')        await this.loadMyVotings();
                        else if (route === 'groups')   await this.loadMyGroups();
                        else if (route === 'notif')    await this.loadMyNotifications();
                    } catch (e) { /* ignore */ }
                }
                indicator.classList.remove('active', 'armed', 'refreshing');
                armed = false;
            };
            container.addEventListener('touchend', finish, { passive: true });
            container.addEventListener('touchcancel', finish, { passive: true });
        });
    },

    // === FEEDBACK ===
    showFeedbackModal() {
        const ta = document.getElementById('feedback-text');
        if (ta) ta.value = '';
        const c = document.getElementById('feedback-counter');
        if (c) c.textContent = '0';
        this.showModal('feedback-modal');
        // Live counter
        if (ta && !ta._counterBound) {
            ta._counterBound = true;
            ta.addEventListener('input', () => {
                if (c) c.textContent = String(ta.value.length);
            });
        }
    },

    async submitFeedback() {
        const t = this.translations[this.currentLanguage] || {};
        const ta = document.getElementById('feedback-text');
        const text = (ta?.value || '').trim();
        if (text.length < 5) {
            this.toastError(t.feedback_too_short || 'Напишіть більше деталей (мін. 5 символів)');
            return;
        }
        if (!supabaseService.isReady() || !this.state.user) {
            this.toastError(t.auth_error_network);
            return;
        }
        this.setBtnLoading('feedback-send-btn', true);
        const u = this.state.user;
        const userName = [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
        const { error } = await supabaseService.submitFeedback(text);
        this.setBtnLoading('feedback-send-btn', false);
        if (error) {
            this.toastError(this.humanError(error));
            return;
        }
        this.hideModal('feedback-modal');
        this.toastSuccess(t.feedback_thanks || 'Дякуємо! Ми отримали ваш відгук — найближчим часом розглянемо.');
    },

    // === ADMIN PANEL ===
    isAdmin() {
        return this.state.user && this.state.user.email === 'koa2007@gmail.com';
    },

    refreshAdminBadge() {
        const btn = document.getElementById('admin-panel-btn');
        if (btn) btn.classList.toggle('hidden', !this.isAdmin());
    },

    async showAdminPanel() {
        if (!this.isAdmin()) {
            this.toastError((this.translations[this.currentLanguage] || {}).err_not_admin || 'Доступ лише для адміністратора');
            return;
        }
        this.showScreen('admin-panel-screen');
        await this.refreshAdminPanel();
        this._setupAdminTabs();
    },

    _setupAdminTabs() {
        if (this._adminTabsBound) return;
        this._adminTabsBound = true;
        document.querySelectorAll('.segment[data-admin-tab]').forEach(seg => {
            seg.addEventListener('click', () => {
                const tab = seg.dataset.adminTab;
                document.querySelectorAll('.segment[data-admin-tab]').forEach(s => s.classList.remove('active'));
                seg.classList.add('active');
                ['users', 'groups', 'feedback'].forEach(id => {
                    const el = document.getElementById('admin-tab-' + id);
                    if (el) el.classList.toggle('hidden', id !== tab);
                });
            });
        });
    },

    async refreshAdminPanel() {
        if (!supabaseService.isReady() || !this.isAdmin()) return;
        const grid = document.getElementById('admin-stats-grid');
        const t = this.translations[this.currentLanguage] || {};
        if (grid) grid.innerHTML = `<div class="empty-state">${this.escapeHTML(t.loading || 'Loading…')}</div>`;

        const [statsRes, usersRes, groupsRes, fbRes] = await Promise.all([
            supabaseService.getAdminStats(),
            supabaseService.getAdminRecentUsers(),
            supabaseService.getAdminRecentGroups(),
            supabaseService.getAdminFeedback()
        ]);

        if (statsRes.error) {
            const code = statsRes.error.code ? ` (${statsRes.error.code})` : '';
            if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
                ${this.escapeHTML('Не вдалося завантажити статистику' + code + '.')}<br>
                <span style="font-size:13px;color:var(--color-text-tertiary)">Оновіть сторінку (Ctrl+Shift+R). Якщо не допомогло — вийдіть і увійдіть знову.</span>
            </div>`;
            // Do NOT stop here — the feedback / users / groups tabs may still load.
        } else {
            const s = statsRes.data || {};
            const tile = (label, value, sub) => `
                <div class="admin-stat-card">
                    <div class="label">${this.escapeHTML(label)}</div>
                    <div class="value">${this.escapeHTML(String(value ?? 0))}</div>
                    ${sub ? `<div class="sub">${this.escapeHTML(sub)}</div>` : ''}
                </div>`;
            if (grid) grid.innerHTML = [
                tile('Всього користувачів', s.users_total, `${s.users_completed || 0} завершили профіль`),
                tile('Нові за тиждень', s.users_last_7d, `${s.users_last_24h || 0} за добу`),
                tile('Груп', s.groups_total, `${s.groups_last_7d || 0} за тиждень`),
                tile('Учасників (всього)', s.memberships_total),
                tile('Голосувань', s.votings_total, `${s.votings_active || 0} активних`),
                tile('Завершені', s.votings_completed, `${s.votings_accepted || 0} прийнято / ${s.votings_rejected || 0} відхилено`),
                tile('Голосів подано', s.votes_total),
                tile('Відгуків', s.feedback_total, `${s.feedback_new || 0} нових`)
            ].join('');
        }

        // Users tab
        const usersList = (usersRes.data || []).map(u => `
            <div class="admin-row">
                <div class="row-title">${this.escapeHTML([u.first_name, u.last_name].filter(Boolean).join(' ') || '(без імені)')}${u.profile_completed ? '' : ' <span style="font-size:11px;color:var(--color-warning)">(не завершено)</span>'}</div>
                <div class="row-meta">${this.escapeHTML(u.email || '—')}</div>
                <div class="row-meta">${u.groups_count} груп · реєстрація ${new Date(u.created_at).toLocaleString()}</div>
            </div>`).join('');
        const ut = document.getElementById('admin-tab-users');
        if (ut) ut.innerHTML = usersList || '<div class="empty-state">Немає користувачів</div>';

        // Groups tab
        const groupsList = (groupsRes.data || []).map(g => `
            <div class="admin-row">
                <div class="row-title">${this.escapeHTML(g.name)} <span style="font-family:monospace;font-size:12px;color:var(--color-text-tertiary)">${this.escapeHTML(g.group_code)}</span></div>
                <div class="row-meta">${g.members_count} учасників · ${g.votings_count} голосувань</div>
                <div class="row-meta">Створив: ${this.escapeHTML(g.creator_email || '—')} · ${new Date(g.created_at).toLocaleString()}</div>
            </div>`).join('');
        const gt = document.getElementById('admin-tab-groups');
        if (gt) gt.innerHTML = groupsList || '<div class="empty-state">Немає груп</div>';

        // Feedback tab
        const fbList = (fbRes.data || []).map(f => `
            <div class="admin-row feedback-${this.escapeHTML(f.status)}">
                <div class="row-title">${this.escapeHTML(f.text)}</div>
                <div class="row-meta">${this.escapeHTML(f.user_name || f.user_email || '—')} · ${new Date(f.created_at).toLocaleString()}</div>
                ${f.reply ? `<div class="row-meta" style="color:var(--color-success);margin-top:4px"><b>Ваша відповідь:</b> ${this.escapeHTML(f.reply)}</div>` : ''}
                <div class="admin-row-actions">
                    <button onclick="app.toggleReplyBox('${f.id}')"><i class="ph ph-chat-circle-text" aria-hidden="true"></i> ${f.reply ? 'Змінити відповідь' : 'Відповісти'}</button>
                    ${f.status !== 'reviewed' ? `<button onclick="app.setFeedbackStatus('${f.id}', 'reviewed')">Переглянуто</button>` : ''}
                    ${f.status !== 'done' ? `<button onclick="app.setFeedbackStatus('${f.id}', 'done')">Виконано</button>` : ''}
                    ${f.status !== 'new' ? `<button onclick="app.setFeedbackStatus('${f.id}', 'new')">Новий</button>` : ''}
                </div>
                <div id="reply-box-${f.id}" class="hidden" style="margin-top:8px">
                    <textarea id="reply-text-${f.id}" rows="2" maxlength="500" placeholder="Ваша відповідь жителю — він побачить її як сповіщення в застосунку…" style="width:100%;box-sizing:border-box">${this.escapeHTML(f.reply || '')}</textarea>
                    <button class="btn-primary" style="margin-top:6px" onclick="app.sendFeedbackReply('${f.id}')"><i class="ph ph-paper-plane-tilt" aria-hidden="true"></i> Надіслати відповідь</button>
                </div>
            </div>`).join('');
        const ft = document.getElementById('admin-tab-feedback');
        if (ft) ft.innerHTML = fbList || '<div class="empty-state">Немає відгуків</div>';
    },

    toggleReplyBox(id) {
        const el = document.getElementById('reply-box-' + id);
        if (el) el.classList.toggle('hidden');
    },

    async sendFeedbackReply(id) {
        const ta = document.getElementById('reply-text-' + id);
        const reply = (ta?.value || '').trim();
        if (reply.length < 2) { this.toastError((this.translations[this.currentLanguage] || {}).reply_too_short || 'Напишіть відповідь'); return; }
        const { error } = await supabaseService.replyToFeedback(id, reply);
        if (error) { this.toastError(this.humanError(error)); return; }
        this.toastSuccess('Відповідь надіслано жителю');
        await this.refreshAdminPanel();
    },

    async setFeedbackStatus(id, status) {
        const { error } = await supabaseService.updateFeedbackStatus(id, status);
        if (error) { this.toastError(this.humanError(error)); return; }
        this.toastSuccess('Статус оновлено');
        await this.refreshAdminPanel();
    },

    // === PWA INSTALL ===
    // Triggered by index.html when 'beforeinstallprompt' fires (Chrome/Edge/Android).
    // iOS Safari does not support this event — for iOS we show manual hint instead.
    onInstallAvailable() {
        const btn = document.getElementById('install-app-btn');
        if (btn) btn.classList.remove('hidden');
    },

    onInstalled() {
        const btn = document.getElementById('install-app-btn');
        if (btn) btn.classList.add('hidden');
        const t = this.translations[this.currentLanguage] || {};
        this.toastSuccess(t.install_thanks || 'Дякуємо! Тепер Spilka на головному екрані.');
    },

    async installApp() {
        const t = this.translations[this.currentLanguage] || {};

        // iOS Safari path — show manual instruction
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;

        if (isStandalone) {
            this.toastInfo(t.install_already || 'Додаток уже встановлено');
            return;
        }

        if (isIOS) {
            this.toastInfo(t.install_ios_hint || 'На iOS: натисніть «Поділитися» → «На екран Домівка»', 6000);
            return;
        }

        const evt = window.__deferredInstallPrompt;
        if (!evt) {
            // Browser hasn't fired the prompt yet — likely not eligible (HTTP, missing criteria, already installed)
            this.toastInfo(t.install_not_ready || 'Опція встановлення зараз недоступна. Зайдіть пізніше або перевірте, що сторінка відкрита через HTTPS.', 5000);
            return;
        }

        evt.prompt();
        const { outcome } = await evt.userChoice;
        window.__deferredInstallPrompt = null;
        if (outcome !== 'accepted') {
            this.toastInfo(t.install_dismissed || 'Скасовано — можна встановити пізніше з цього ж екрана.');
        }
        // Hide button — either user accepted (appinstalled fires) or dismissed
        const btn = document.getElementById('install-app-btn');
        if (btn) btn.classList.add('hidden');
    },

    // Detect iOS users on initial load and surface install button so they can see the iOS hint
    showIOSInstallHintIfNeeded() {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
        if (isIOS && !isStandalone) {
            const btn = document.getElementById('install-app-btn');
            if (btn) btn.classList.remove('hidden');
        }
    },

    // Modals — also lock body scroll while any modal is open
    showModal(modalId) {
        const el = document.getElementById(modalId);
        if (!el) return;
        el.classList.remove('hidden');
        document.body.classList.add('modal-open');
    },

    hideModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.classList.add('hidden');
        // Unlock body scroll only when no modals are visible
        const anyOpen = Array.from(document.querySelectorAll('.modal'))
            .some(m => !m.classList.contains('hidden'));
        if (!anyOpen) document.body.classList.remove('modal-open');
    },

    // === THEME (light / dark / auto) ===
    // Modes: 'auto' (follows system), 'light', 'dark'. Persisted in localStorage.
    initTheme() {
        const saved = localStorage.getItem('votecoop-theme') || 'auto';
        this.applyTheme(saved);
    },

    applyTheme(mode) {
        const root = document.documentElement;
        if (mode === 'auto') {
            root.removeAttribute('data-theme');
        } else {
            root.setAttribute('data-theme', mode);
        }
        localStorage.setItem('votecoop-theme', mode);
        this.updateThemeMeta();
        this.updateThemeToggleUI(mode);
    },

    updateThemeMeta() {
        // Update <meta name="theme-color"> from CSS var so the OS UI matches
        const meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) return;
        const value = getComputedStyle(document.documentElement)
            .getPropertyValue('--color-theme-meta')
            .trim();
        if (value) meta.setAttribute('content', value);
    },

    updateThemeToggleUI(mode) {
        const btn = document.getElementById('theme-toggle-btn');
        if (!btn) return;
        const t = this.translations[this.currentLanguage] || {};
        const labels = {
            auto: t.theme_auto || 'Auto',
            light: t.theme_light || 'Light',
            dark: t.theme_dark || 'Dark'
        };
        const icons = { auto: 'ph-circle-half', light: 'ph-sun', dark: 'ph-moon' };
        const labelEl = btn.querySelector('.theme-label');
        const iconEl = btn.querySelector('.theme-icon i');
        if (labelEl) labelEl.textContent = `${t.theme || 'Theme'}: ${labels[mode] || labels.auto}`;
        if (iconEl) iconEl.className = `ph ${icons[mode] || icons.auto}`;
    },

    cycleTheme() {
        const current = localStorage.getItem('votecoop-theme') || 'auto';
        const order = ['auto', 'light', 'dark'];
        const next = order[(order.indexOf(current) + 1) % order.length];
        this.applyTheme(next);
    },

    showCreateGroup() {
        this.showModal('create-group-modal');
    },

    showCreateVoting() {
        const t = this.translations[this.currentLanguage];
        // Populate group select
        const select = document.getElementById('voting-group');
        select.innerHTML = `<option value="">${t.select_group}</option>` +
            this.state.groups.map(g => `<option value="${g.id}">${this.escapeHTML(g.name)}</option>`).join('');
        
        // Reset type-specific fields
        document.getElementById('target-member-group').classList.add('hidden');
        document.getElementById('removal-reason-group').classList.add('hidden');
        document.getElementById('duration-group').classList.remove('hidden');

        // Clear any leftover freeze selection from a previously cancelled session
        // (otherwise the array stays non-empty while the chips UI shows nothing).
        this.state.freezeSelectedMembers = [];
        this.renderFreezeMemberChips();
        const freezeGroup = document.getElementById('freeze-members-group');
        if (freezeGroup) freezeGroup.classList.add('hidden');

        this.showModal('create-voting-modal');
    },

    onVotingTypeChange() {
        const t = this.translations[this.currentLanguage];
        const type = document.getElementById('voting-type').value;
        const groupId = document.getElementById('voting-group').value;
        const targetGroup = document.getElementById('target-member-group');
        const reasonGroup = document.getElementById('removal-reason-group');
        const durationGroup = document.getElementById('duration-group');
        const freezeGroup = document.getElementById('freeze-members-group');
        const targetSelect = document.getElementById('target-member');
        
        // Reset fields
        targetGroup.classList.add('hidden');
        reasonGroup.classList.add('hidden');
        durationGroup.classList.remove('hidden');
        if (freezeGroup) freezeGroup.classList.add('hidden');
        
        if (type === 'admin-change' || type === 'remove-member') {
            // Fixed 72 hours for admin/member votes
            durationGroup.classList.add('hidden');
            document.getElementById('voting-duration').value = '72';

            // Show member selection
            targetGroup.classList.remove('hidden');

            // Update label
            const label = targetGroup.querySelector('label');
            label.textContent = type === 'admin-change' ? t.target_admin_candidate : t.target_member_remove;

            // Populate members
            if (groupId) {
                const group = this.state.groups.find(g => g.id === groupId);
                if (group) {
                    // Filter members (for admin-change: exclude current admin, for remove: exclude admin too)
                    const eligibleMembers = group.members.filter(m =>
                        type === 'admin-change' ? m.role !== 'admin' : m.role !== 'admin'
                    );

                    targetSelect.innerHTML = `<option value="">${t.select_member}</option>` +
                        eligibleMembers.map(m => `<option value="${m.id}">${this.escapeHTML(m.name)} (${this.escapeHTML(m.address)})</option>`).join('');
                }
            }

            // Show reason field for member removal
            if (type === 'remove-member') {
                reasonGroup.classList.remove('hidden');
            }
        } else if (type === 'freeze') {
            // Fixed 5-day objection window — the admin cannot shorten it (server enforces it too).
            durationGroup.classList.add('hidden');
            document.getElementById('voting-duration').value = '120';

            // Show freeze member selection
            if (freezeGroup) freezeGroup.classList.remove('hidden');

            // Store selected members for freeze
            this.state.freezeSelectedMembers = [];
            this.renderFreezeMemberChips();
        } else if (type === 'delete-group') {
            // Show duration selector (min 24 hours)
            durationGroup.classList.remove('hidden');
            document.getElementById('voting-duration').value = '24';
        }
    },

    onReasonChange() {
        const reasonSelect = document.getElementById('removal-reason-select');
        const reasonText = document.getElementById('removal-reason-text');
        
        if (reasonSelect.value === 'other') {
            reasonText.classList.remove('hidden');
        } else {
            reasonText.classList.add('hidden');
            reasonText.value = '';
        }
    },

    // Create actions
    async createGroup() {
        const t = this.translations[this.currentLanguage];
        const name = document.getElementById('group-name').value.trim();
        const description = document.getElementById('group-description').value.trim();

        if (!name) {
            this.toastError(t.fill_name_error || 'Введіть назву групи');
            return;
        }

        if (!this.state.user) {
            this.toastError(t.auth_error_network || 'User not authenticated');
            return;
        }

        const btn = document.querySelector('#create-group-modal .btn-primary');
        if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }

        try {
            const { data, error } = await supabaseService.createGroup(name, description);
            if (error) throw new Error(error.message);

            const userName = [this.state.user.firstName, this.state.user.lastName]
                .filter(Boolean).join(' ') || 'User';

            const newGroup = {
                id: data.group_id,
                name,
                description,
                groupId: data.group_code,
                isAdmin: true,
                membersCount: 1,
                votingsCount: 0,
                members: [{ id: this.state.user.id, name: userName, role: 'admin' }],
                requests: [],
                history: []
            };

            this.state.groups.push(newGroup);
            this.renderGroups();

            document.getElementById('group-name').value = '';
            document.getElementById('group-description').value = '';
            this.hideModal('create-group-modal');
        } catch (err) {
            this.toastError(this.humanError(err));
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
    },

    async createVoting() {
        const t = this.translations[this.currentLanguage];

        if (!this.state.user) {
            this.toastError(t.auth_error_network || 'User not authenticated');
            return;
        }

        if (!this.state.user.apartment) {
            this.toastError(t.apartment_required);
            return;
        }

        const title = document.getElementById('voting-title').value;
        const description = document.getElementById('voting-description').value;
        const groupId = document.getElementById('voting-group').value;
        const type = document.getElementById('voting-type').value;
        const duration = parseInt(document.getElementById('voting-duration').value);
        const link = document.getElementById('voting-link').value;
        const targetMemberId = document.getElementById('target-member').value;
        const reasonSelect = document.getElementById('removal-reason-select');
        const reasonText = document.getElementById('removal-reason-text');

        if (!title || !groupId) {
            this.toastError(t.fill_name_error);
            return;
        }

        // Guard against an empty/invalid duration — otherwise the endsAt math
        // below becomes new Date(NaN).toISOString() which throws and surfaces as
        // a confusing "network error".
        if (!duration || isNaN(duration) || duration < 1) {
            this.toastError(t.select_duration || 'Оберіть тривалість голосування');
            return;
        }

        const group = this.state.groups.find(g => g.id === groupId);

        // Check daily limit for non-admin users
        if (!group.isAdmin) {
            const lastVotingTime = this.state.userVotingHistory[groupId];
            if (lastVotingTime) {
                const hoursSinceLastVoting = (Date.now() - lastVotingTime) / (1000 * 60 * 60);
                if (hoursSinceLastVoting < 24) {
                    this.toastError(t.daily_limit_reached);
                    return;
                }
            }
        }

        if ((type === 'admin-change' || type === 'remove-member') && group.membersCount < 3) {
            this.toastError(t.min_3_members_required);
            return;
        }

        if ((type === 'admin-change' || type === 'remove-member') && !targetMemberId) {
            this.toastError(t.select_member);
            return;
        }

        let removalReason = '';
        if (type === 'remove-member') {
            if (!reasonSelect.value) {
                this.toastError(t.select_reason);
                return;
            }
            removalReason = reasonSelect.value === 'other' ? reasonText.value : t[`reason_${reasonSelect.value}`];
        }

        if (type === 'admin-change') {
            const existingAdminChange = this.state.votings.find(v =>
                v.groupId === groupId && v.type === 'admin-change' && v.status === 'active'
            );
            if (existingAdminChange) {
                this.toastError(t.one_admin_change_at_time);
                return;
            }
        }

        if (type === 'freeze') {
            if (!group.isAdmin) {
                this.toastError(t.only_admin_can_freeze);
                return;
            }
            if (!this.state.freezeSelectedMembers || this.state.freezeSelectedMembers.length === 0) {
                this.toastError(t.select_freeze_members);
                return;
            }
        }

        if (type === 'delete-group') {
            const existingDeleteGroup = this.state.votings.find(v =>
                v.groupId === groupId && v.type === 'delete-group' && v.status === 'active'
            );
            if (existingDeleteGroup) {
                this.toastError(t.one_delete_group_at_time);
                return;
            }
            if (duration < 24) {
                this.toastError(t.min_duration_24h);
                return;
            }
        }

        const btn = document.querySelector('#create-voting-modal .btn-primary');
        if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }

        try {
            const endsAt = new Date(Date.now() + duration * 3600000).toISOString();
            const { data: newVotingRow, error } = await supabaseService.createVoting({
                groupId,
                title,
                description,
                type,
                endsAt,
                link,
                targetMemberId: targetMemberId || null,
                removalReason,
                freezeDurationDays: type === 'freeze' ? 5 : null
            });

            if (error) throw new Error(error.message);

            // Insert freeze targets if freeze type
            if (type === 'freeze' && this.state.freezeSelectedMembers.length > 0) {
                const targetIds = this.state.freezeSelectedMembers.map(m => m.id);
                await supabaseService.addFreezeTargets(newVotingRow.id, targetIds);
            }

            const targetMember = targetMemberId ? group.members.find(m => m.id === targetMemberId) : null;
            const userName = [this.state.user.firstName, this.state.user.lastName]
                .filter(Boolean).join(' ') || 'User';

            const newVoting = {
                id: newVotingRow.id,
                title,
                description,
                groupId,
                groupName: group.name,
                type,
                status: 'active',
                createdAt: newVotingRow.created_at,
                endsAt: new Date(newVotingRow.ends_at),
                yesVotes: 0,
                noVotes: 0,
                totalMembers: group.membersCount,
                link,
                hasVoted: false,
                targetMemberId: targetMemberId || null,
                targetMemberName: targetMember ? targetMember.name : null,
                removalReason,
                initiatorId: this.state.user.id,
                initiatorName: userName,
                freezeMembers: type === 'freeze' ? this.state.freezeSelectedMembers.map(m => ({
                    id: m.id, name: m.name, address: m.address
                })) : [],
                objections: [],
                comments: []
            };

            this.state.votings.unshift(newVoting);

            if (!group.isAdmin) {
                this.state.userVotingHistory[groupId] = Date.now();
            }

            this.renderVotings();
            this.hideModal('create-voting-modal');

            // Notify group members
            await supabaseService.notifyGroupMembers(
                groupId, 'voting',
                `${t.new_voting || 'Нове голосування'}: "${title}"`
            );

            // Clear the form ONLY on success — otherwise the user keeps their input
            // after a network error and can retry without retyping.
            document.getElementById('voting-title').value = '';
            document.getElementById('voting-description').value = '';
            document.getElementById('description-counter').textContent = '0';
            document.getElementById('voting-link').value = '';
            document.getElementById('target-member').value = '';
            document.getElementById('removal-reason-select').value = '';
            document.getElementById('removal-reason-text').value = '';
            document.getElementById('target-member-group').classList.add('hidden');
            document.getElementById('removal-reason-group').classList.add('hidden');
            this.state.freezeSelectedMembers = [];
            this.renderFreezeMemberChips();
            const freezeGroup = document.getElementById('freeze-members-group');
            if (freezeGroup) freezeGroup.classList.add('hidden');
        } catch (err) {
            this.toastError(this.humanError(err));
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
    },

    // Collapse / expand the "Join a group" section (collapsed by default).
    toggleJoinGroup() {
        const section = document.getElementById('join-group-section');
        const toggle = document.getElementById('join-group-toggle');
        if (!section) return;
        const nowCollapsed = section.classList.toggle('collapsed');
        if (toggle) toggle.setAttribute('aria-expanded', String(!nowCollapsed));
    },

    async joinGroup() {
        const t = this.translations[this.currentLanguage];
        const code = document.getElementById('join-group-id').value.trim();
        if (!code || code.length !== 6) {
            this.toastError(t.enter_group_id_error || 'Введіть коректний ID групи (6 цифр)');
            return;
        }

        const apartment = (document.getElementById('join-apartment')?.value || '').trim();
        if (!apartment) {
            this.toastError(t.join_apartment_required || 'Введіть номер квартири');
            return;
        }

        const roleEl = document.querySelector('input[name="join-role"]:checked');
        if (!roleEl) {
            this.toastError(t.join_role_required || 'Оберіть роль');
            return;
        }
        const asObserver = roleEl.value === 'observer';

        // Check if already member locally
        const existing = this.state.groups.find(g => g.groupId === code);
        if (existing) {
            this.toastError(t.already_member || 'Ви вже є учасником цієї групи');
            return;
        }

        try {
            // Find group by code
            const { data: group, error: findErr } = await supabaseService.findGroupByCode(code);
            if (findErr || !group) {
                this.toastError(t.group_not_found || 'Групу не знайдено');
                return;
            }

            // Send join request v2
            const { data: requestId, error: reqErr } = await supabaseService.submitJoinRequestV2(group.id, apartment, asObserver);
            if (reqErr) {
                const msg = reqErr.message || '';
                if (msg.includes('already_member')) {
                    this.toastError(t.already_member || 'Ви вже є учасником цієї групи');
                } else if (msg.includes('already_pending')) {
                    this.toastError(t.already_requested || 'Запит вже надіслано');
                } else if (msg.includes('apartment_taken')) {
                    const takenName = msg.includes('apartment_taken:') ? (msg.split('apartment_taken:')[1] || '') : '';
                    const who = takenName ? `: ${this.escapeHTML(takenName)}` : '';
                    this.toastError(`${t.apartment_taken || 'Квартира зайнята голосуючим'}${who}. ${t.apartment_taken_hint || 'Оберіть роль "спостерігач" або введіть іншу квартиру.'}`);
                } else if (msg.includes('apartment_required')) {
                    this.toastError(t.join_apartment_required || 'Введіть номер квартири');
                } else {
                    throw new Error(msg);
                }
                return;
            }

            document.getElementById('join-group-id').value = '';
            document.getElementById('join-apartment').value = '';
            document.querySelectorAll('input[name="join-role"]').forEach(r => r.checked = false);

            // Notify group admin about the join request
            await supabaseService.notifyJoinRequest(group.id);

            // Create notification in DB for the requester
            await supabaseService.createNotification(
                this.state.user.id,
                'system',
                `${t.join_request_sent || 'Запит на приєднання надіслано'}: ${group.name}`
            );

            // Add notification locally for instant display
            this.state.notifications.unshift({
                id: requestId,
                type: 'system',
                text: `${t.join_request_sent || 'Запит на приєднання надіслано'}: ${group.name}`,
                time: new Date().toLocaleString(),
                read: false
            });
            this.renderNotifications();

            this.toastSuccess(t.join_request_sent || 'Запит на приєднання надіслано');
        } catch (err) {
            this.toastError(t.auth_error_network || 'Помилка мережі');
        }
    },

    // Voting detail
    async showVotingDetail(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting) return;

        // Re-entrancy guard: if the user opens voting B while A's fetch is still
        // in flight, A's late response must not overwrite B's modal content.
        const reqToken = (this._detailReq = (this._detailReq || 0) + 1);

        // Save current voting ID for delete modal
        this.state.currentVotingToDelete = votingId;

        // Fetch fresh vote data from DB
        try {
            const [votesRes, resultsRes] = await Promise.all([
                supabaseService.getVotingVotes(votingId),
                supabaseService.getVotingResults([votingId])
            ]);

            if (votesRes.data) {
                voting.comments = votesRes.data
                    .filter(() => voting.type !== 'secret')
                    .map(v => ({
                        userId: v.user_id,
                        userName: v.voter ? `${v.voter.first_name} ${v.voter.last_name}`.trim() : '',
                        apartment: v.voter?.apartment || '',
                        vote: v.choice,
                        comment: v.comment,
                        time: new Date(v.created_at).toLocaleString()
                    }));
                const myVote = votesRes.data.find(v => v.user_id === this.state.user.id);
                voting.hasVoted = !!myVote;
            }

            if (resultsRes.data && resultsRes.data.length > 0) {
                const r = resultsRes.data[0];
                voting.yesVotes = r.yes_votes;
                voting.noVotes = r.no_votes;
                voting.abstainVotes = r.abstain_votes;
            }

            // Fetch freeze data if applicable
            if (voting.type === 'freeze') {
                const [objRes, targetsRes] = await Promise.all([
                    supabaseService.getFreezeObjections(votingId),
                    supabaseService.getFreezeTargets(votingId)
                ]);
                if (objRes.data) {
                    voting.objections = objRes.data.map(o => ({
                        userId: o.user_id,
                        userName: o.user ? `${o.user.first_name} ${o.user.last_name}`.trim() : '',
                        time: o.time || null
                    }));
                }
                if (targetsRes.data) {
                    voting.freezeMembers = targetsRes.data.map(ft => ({
                        id: ft.user_id,
                        name: ft.user ? `${ft.user.first_name} ${ft.user.last_name}`.trim() : '',
                        address: ft.user ? `${ft.user.address || ''}, кв. ${ft.user.apartment || ''}` : ''
                    }));
                }
            }
        } catch (err) {
            // Continue with cached data if fetch fails
        }

        // A newer showVotingDetail call started while we were fetching — bail out.
        if (reqToken !== this._detailReq) return;

        const content = document.getElementById('voting-detail-content');
        const isActive = voting.status === 'active';
        const isAuthor = voting.initiatorId === this.state.user.id;
        const abstainVotes = voting.abstainVotes || 0;

        // Determine if current user is an observer in this group.
        // Prefer group.myIsObserver (loaded for every group on startup) and
        // fall back to the members array (only populated after opening group
        // detail). Without the fallback, observers opening a voting straight
        // from the votings tab would wrongly see the vote buttons.
        const dvGroup = this.state.groups.find(g => g.id === voting.groupId);
        const dvCurrentMember = dvGroup?.members?.find(m => m.id === this.state.user.id);
        const isObserver = (dvGroup?.myIsObserver === true) || (dvCurrentMember?.isObserver === true);

        // Use voter count (non-observers) as the quorum denominator
        let voterTotalCount = voting.totalMembers;
        try {
            const vcRes = await supabaseService.getVoterCount(voting.groupId);
            if (vcRes.data != null) voterTotalCount = vcRes.data;
        } catch (_) { /* keep totalMembers as fallback */ }

        const safeTotal = voterTotalCount > 0 ? voterTotalCount : 1;
        const yesPercent = Math.round((voting.yesVotes / safeTotal) * 100);
        const noPercent = Math.round((voting.noVotes / safeTotal) * 100);
        const abstainPercent = Math.round((abstainVotes / safeTotal) * 100);
        const totalVoted = voting.yesVotes + voting.noVotes + abstainVotes;
        const participation = Math.round((totalVoted / safeTotal) * 100);

        // Build target member info
        let targetInfo = '';
        if (voting.type === 'admin-change' && voting.targetMemberName) {
            targetInfo = `
                <div class="target-info">
                    <div class="target-info-label"><i class="ph ph-user" aria-hidden="true"></i> ${t.target_admin_candidate}</div>
                    <div class="target-info-value">${this.escapeHTML(voting.targetMemberName)}</div>
                </div>
            `;
        } else if (voting.type === 'remove-member' && voting.targetMemberName) {
            targetInfo = `
                <div class="target-info">
                    <div class="target-info-label"><i class="ph ph-user" aria-hidden="true"></i> ${t.target_member_remove}</div>
                    <div class="target-info-value">${this.escapeHTML(voting.targetMemberName)}</div>
                    ${voting.removalReason ? `<div class="removal-reason"><strong>${t.removal_reason_label}:</strong> ${this.escapeHTML(voting.removalReason)}</div>` : ''}
                </div>
            `;
        } else if (voting.type === 'delete-group') {
            targetInfo = `
                <div class="delete-group-warning">
                    <i class="ph ph-warning" aria-hidden="true"></i> ${t.delete_group_warning}
                </div>
            `;
        }

        // Build comments section
        let commentsSection = '';
        if (voting.comments && voting.comments.length > 0) {
            const commentsList = voting.comments.map(c => {
                const voteLabel = c.vote === 'yes' ? t.vote_yes : c.vote === 'no' ? t.vote_no : t.vote_abstain;
                const voteEmoji = c.vote === 'yes' ? '<i class="ph-fill ph-check-circle text-success" aria-hidden="true"></i>' : c.vote === 'no' ? '<i class="ph-fill ph-x-circle text-danger" aria-hidden="true"></i>' : '<i class="ph-fill ph-minus-circle text-muted" aria-hidden="true"></i>';
                return `
                    <div class="comment-item">
                        <div class="comment-header">
                            <span class="comment-author">${this.escapeHTML(c.userName)}</span>
                            <span class="comment-time">${this.escapeHTML(c.time)}</span>
                        </div>
                        <div class="comment-vote">${voteEmoji} ${voteLabel}</div>
                        ${c.comment ? `<div class="comment-text">${this.escapeHTML(c.comment)}</div>` : ''}
                    </div>
                `;
            }).join('');

            commentsSection = `
                <div class="comments-section">
                    <h4><i class="ph ph-chat-circle-text" aria-hidden="true"></i> ${t.comments}</h4>
                    <div class="comments-list">${commentsList}</div>
                </div>
            `;
        } else {
            commentsSection = `
                <div class="comments-section">
                    <h4><i class="ph ph-chat-circle-text" aria-hidden="true"></i> ${t.comments}</h4>
                    <div class="empty-state-inline">${t.no_comments}</div>
                </div>
            `;
        }

        // Format dates for detail view
        const createdDate = new Date(voting.createdAt);
        const createdDateStr = createdDate.toLocaleDateString();
        const createdTimeStr = createdDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        let dateRangeHtml = '';
        if (voting.status === 'completed' && voting.endedAt) {
            const endDate = new Date(voting.endedAt);
            const endDateStr = endDate.toLocaleDateString();
            dateRangeHtml = `<div class="date-range"><i class="ph ph-calendar-blank" aria-hidden="true"></i> ${this.escapeHTML(createdDateStr)} ${this.escapeHTML(createdTimeStr)} — ${this.escapeHTML(endDateStr)}</div>`;
        } else {
            const endsAt = new Date(voting.endsAt);
            const endsDateStr = endsAt.toLocaleDateString();
            dateRangeHtml = `<div class="date-range"><i class="ph ph-calendar-blank" aria-hidden="true"></i> ${this.escapeHTML(createdDateStr)} ${this.escapeHTML(createdTimeStr)} — ${this.escapeHTML(endsDateStr)} (${t.opened})</div>`;
        }
        
        const authorName = voting.initiatorName || t.unknown_author;
        
        // Special handling for freeze voting
        const isFreeze = voting.type === 'freeze';
        const hasObjected = voting.objections && voting.objections.some(o => o.userId === this.state.user.id);
        const objectionCount = voting.objections ? voting.objections.length : 0;
        const objectionThreshold = 2; // 2 objections = auto rejection
        
        // Build freeze-specific UI
        let freezeInfo = '';
        let freezeActions = '';
        let freezeResults = '';
        
        if (isFreeze) {
            // Freeze members chips
            const freezeMembersChips = voting.freezeMembers ? voting.freezeMembers.map(m =>
                `<span class="member-chip bg-info">${this.escapeHTML(m.name)} (${this.escapeHTML(m.address)})</span>`
            ).join('') : '';
            
            freezeInfo = `
                <div class="freeze-proposal-card">
                    <div class="freeze-heading">
                        <i class="ph ph-snowflake text-info" aria-hidden="true"></i> ${t.freeze_proposal}
                    </div>
                    <div class="member-chips">
                        ${freezeMembersChips}
                    </div>
                    <div class="freeze-subtext">
                        <i class="ph ph-info" aria-hidden="true"></i> ${t.freeze_duration_info}
                    </div>
                </div>
            `;
            
            // Objections section
            let objectionsList = '';
            if (voting.objections && voting.objections.length > 0) {
                objectionsList = voting.objections.map(o =>
                    `<div class="objection-item">
                        <i class="ph-fill ph-x-circle text-danger" aria-hidden="true"></i> ${this.escapeHTML(o.userName)}
                        <span class="objection-date">(${this.escapeHTML(new Date(o.time).toLocaleDateString())})</span>
                    </div>`
                ).join('');
            } else {
                objectionsList = `<div class="empty-state-inline small">${t.no_objections}</div>`;
            }

            freezeResults = `
                <div class="objections-panel">
                    <div class="objections-heading">
                        <i class="ph ph-users" aria-hidden="true"></i> ${t.objections_title}: ${objectionCount}/${objectionThreshold}
                        ${objectionCount >= objectionThreshold ? `<span class="text-danger auto-rejected-badge">(${t.auto_rejected})</span>` : ''}
                    </div>
                    <div>${objectionsList}</div>
                    ${objectionCount < objectionThreshold ? `
                        <div class="objections-needed">
                            ${t.objections_needed.replace('{count}', objectionThreshold - objectionCount)}
                        </div>
                    ` : ''}
                </div>
            `;
            
            // Freeze voting actions - "I disagree" button
            if (isActive && !hasObjected) {
                freezeActions = `
                    <div class="voting-actions-column">
                        <button class="btn btn-secondary btn-objection" onclick="app.objectToFreeze('${voting.id}')">
                            <i class="ph-fill ph-hand-palm" aria-hidden="true"></i> ${t.i_disagree}
                        </button>
                        <div class="disagree-info">
                            ${t.disagree_info}
                        </div>
                    </div>
                `;
            } else if (isActive && hasObjected) {
                freezeActions = `
                    <div class="voted-message">
                        <i class="ph ph-check text-success" aria-hidden="true"></i> ${t.you_objected}
                    </div>
                `;
            }
        }

        content.innerHTML = `
            <div class="voting-detail-header">
                <div class="voting-detail-status ${isActive ? 'active' : 'completed'}">
                    ${isActive ? `<i class="ph-fill ph-circle text-pending" aria-hidden="true"></i> ${t.active_votings}` : `<i class="ph-fill ph-check-circle text-success" aria-hidden="true"></i> ${t.completed}`}
                </div>
                <h2 class="voting-detail-title">${this.escapeHTML(voting.title)}</h2>
                ${voting.description ? `<div class="voting-description">${this.escapeHTML(voting.description)}</div>` : ''}
                <div class="voting-author-info">
                    <i class="ph ph-user" aria-hidden="true"></i> ${t.author}: ${this.escapeHTML(authorName)}
                </div>
                ${dateRangeHtml}
                <div class="voting-detail-meta">
                    <span><i class="ph ph-users-three" aria-hidden="true"></i> ${this.escapeHTML(voting.groupName)}</span>
                    ${isActive
                        ? `<span><i class="ph ph-scales" aria-hidden="true"></i> ${voting.type === 'secret' ? t.secret_voting : voting.type === 'freeze' ? t.freeze_voting : t.open_voting}</span><span><i class="ph ph-clock" aria-hidden="true"></i> ${this.getTimeLeft(voting.endsAt)}</span>`
                        : `<span>${voting.result === 'accepted' ? '<i class="ph-fill ph-check-circle text-success" aria-hidden="true"></i> ' + t.result_accepted : '<i class="ph-fill ph-x-circle text-danger" aria-hidden="true"></i> ' + t.result_rejected}</span>`
                    }
                </div>
                ${voting.link ? `<a href="${this.sanitizeURL(voting.link)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary materials-link"><i class="ph ph-paperclip" aria-hidden="true"></i> ${t.materials_link}</a>` : ''}
                ${isFreeze ? freezeInfo : targetInfo}
            </div>

            ${!isFreeze ? `
            <div class="voting-results" role="region" aria-label="${t.yes}: ${yesPercent}%, ${t.no}: ${noPercent}%">
                <div class="result-item">
                    <span class="result-label"><i class="ph-fill ph-check-circle text-success" aria-hidden="true"></i> ${t.yes}</span>
                    <span class="result-value">${voting.yesVotes} (${yesPercent}%)</span>
                </div>
                <div class="result-bar" role="progressbar" aria-valuenow="${yesPercent}" aria-valuemin="0" aria-valuemax="100" aria-label="${t.yes} ${yesPercent}%">
                    <div class="result-bar-fill yes" style="width: ${yesPercent}%"></div>
                </div>

                <div class="result-item">
                    <span class="result-label"><i class="ph-fill ph-x-circle text-danger" aria-hidden="true"></i> ${t.no}</span>
                    <span class="result-value">${voting.noVotes} (${noPercent}%)</span>
                </div>
                <div class="result-bar" role="progressbar" aria-valuenow="${noPercent}" aria-valuemin="0" aria-valuemax="100" aria-label="${t.no} ${noPercent}%">
                    <div class="result-bar-fill no" style="width: ${noPercent}%"></div>
                </div>

                <div class="result-item">
                    <span class="result-label"><i class="ph-fill ph-minus-circle text-muted" aria-hidden="true"></i> ${t.abstain}</span>
                    <span class="result-value">${abstainVotes} (${abstainPercent}%)</span>
                </div>

                <div class="participation-summary">
                    <span class="result-label">${t.participation_label}: ${participation}% (${totalVoted}/${voterTotalCount})</span>
                </div>
            </div>
            ` : freezeResults}

            ${!isFreeze && isObserver ? `
                <div class="observer-notice">
                    👁️ ${t.observer_notice || 'Ви — спостерігач. Голосування для вас недоступне.'}
                </div>
            ` : !isFreeze && isActive && !voting.hasVoted ? `
                <div class="voting-actions-column">
                    <div class="vote-buttons">
                        <button class="btn btn-secondary" onclick="app.vote('${voting.id}', false)"><i class="ph-fill ph-x-circle" aria-hidden="true"></i> ${t.vote_against}</button>
                        <button class="btn btn-secondary" onclick="app.vote('${voting.id}', 'abstain')"><i class="ph-fill ph-minus-circle" aria-hidden="true"></i> ${t.abstain}</button>
                        <button class="btn btn-primary" onclick="app.vote('${voting.id}', true)"><i class="ph-fill ph-check-circle" aria-hidden="true"></i> ${t.vote_for}</button>
                    </div>
                    <div class="form-group-compact">
                        <textarea id="vote-comment" class="vote-comment-textarea" data-lang-placeholder="comment_placeholder" placeholder="${t.comment_placeholder}" maxlength="500"></textarea>
                        <div class="char-counter">
                            <span id="comment-counter">0</span> / 500
                        </div>
                    </div>
                </div>
            ` : !isFreeze && isActive && voting.hasVoted ? `
                <div class="voted-message">
                    <i class="ph ph-check" aria-hidden="true"></i> ${t.already_voted}
                </div>
            ` : ''}

            ${isFreeze ? freezeActions : ''}

            ${isActive && isAuthor ? `
                <div class="delete-section">
                    <button class="btn btn-danger" onclick="app.showDeleteVotingModal('${voting.id}')"><i class="ph ph-trash" aria-hidden="true"></i> ${t.delete}</button>
                </div>
            ` : ''}

            ${voting.status === 'completed' && !isFreeze ? `
                <div class="protocol-section">
                    <button class="btn btn-secondary" onclick="app.printProtocol('${voting.id}')"><i class="ph ph-printer" aria-hidden="true"></i> ${t.protocol_btn}</button>
                </div>
            ` : ''}

            ${!isFreeze ? commentsSection : ''}
        `;

        // Add character counter for comment
        const commentField = document.getElementById('vote-comment');
        if (commentField) {
            commentField.addEventListener('input', function() {
                const counter = document.getElementById('comment-counter');
                if (counter) counter.textContent = this.value.length;
            });
        }

        this.showModal('voting-detail-modal');
    },

    // Build and show a printable protocol (Друк / Зберегти PDF) for a completed
    // voting. Available to every member. Secret votes show counts only (no names).
    async printProtocol(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting) return;

        let votes = [];
        let counts = { yes: voting.yesVotes || 0, no: voting.noVotes || 0, abstain: voting.abstainVotes || 0 };
        let voterTotal = voting.totalMembers || 0;
        try {
            const [votesRes, resultsRes, vcRes] = await Promise.all([
                supabaseService.getVotingVotes(votingId),
                supabaseService.getVotingResults([votingId]),
                supabaseService.getVoterCount(voting.groupId)
            ]);
            if (votesRes.data) votes = votesRes.data;
            if (resultsRes.data && resultsRes.data[0]) {
                const r = resultsRes.data[0];
                counts = { yes: r.yes_votes || 0, no: r.no_votes || 0, abstain: r.abstain_votes || 0 };
            }
            if (vcRes.data != null) voterTotal = vcRes.data;
        } catch (e) { /* fall back to cached numbers */ }

        const esc = (s) => this.escapeHTML(String(s == null ? '' : s));
        const locale = this.currentLanguage === 'en' ? 'en-GB' : (this.currentLanguage === 'ru' ? 'ru-RU' : 'uk-UA');
        const fmt = (d) => { if (!d) return '—'; const dt = new Date(d); return isNaN(dt) ? '—' : dt.toLocaleString(locale); };
        const isSecret = voting.type === 'secret';
        const typeLabel = isSecret ? t.type_secret
            : voting.type === 'admin-change' ? t.type_admin
            : voting.type === 'remove-member' ? t.type_remove
            : voting.type === 'delete-group' ? (t.type_delete_group || t.type_simple)
            : t.type_simple;
        const total = voterTotal > 0 ? voterTotal : 1;
        const cast = counts.yes + counts.no + counts.abstain;
        const turnout = Math.round((cast / total) * 100);
        const share = (n) => cast > 0 ? Math.round((n / cast) * 100) : 0;
        const needed = Math.floor(total / 2) + 1;
        const accepted = voting.result === 'accepted';
        const voteWord = (ch) => ch === 'yes' ? t.vote_yes : ch === 'no' ? t.vote_no : t.vote_abstain;
        const voteColor = (ch) => ch === 'yes' ? '#1d7a4d' : ch === 'no' ? '#b3261e' : '#5f5e5a';

        const metaRow = (label, value) => `<tr><td style="color:#666;padding:3px 0;width:150px;vertical-align:top;">${esc(label)}</td><td style="padding:3px 0;font-weight:500;">${value}</td></tr>`;
        let targetRow = '';
        if ((voting.type === 'admin-change' || voting.type === 'remove-member') && voting.targetMemberName) {
            targetRow = metaRow(voting.type === 'admin-change' ? t.target_admin_candidate : t.target_member_remove, esc(voting.targetMemberName));
        }

        const bar = (label, n, color) => `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;">
                <div style="width:90px;font-size:13px;">${esc(label)}</div>
                <div style="flex:1;height:18px;background:#eee;border-radius:4px;overflow:hidden;"><div style="width:${share(n)}%;height:100%;background:${color};"></div></div>
                <div style="width:74px;text-align:right;font-size:13px;font-weight:500;">${n} · ${share(n)}%</div>
            </div>`;

        let listSection;
        if (isSecret) {
            listSection = `<div style="font-size:12.5px;color:#666;margin-top:6px;">${esc(t.protocol_secret_note)}</div>`;
        } else if (votes.length) {
            const rows = votes.map(v => {
                const nm = v.voter ? `${v.voter.first_name || ''} ${v.voter.last_name || ''}`.trim() : '';
                return `<tr>
                    <td style="padding:5px 4px;border-bottom:0.5px solid #ddd;">${esc(v.voter && v.voter.apartment ? v.voter.apartment : '—')}</td>
                    <td style="padding:5px 4px;border-bottom:0.5px solid #ddd;">${esc(nm)}</td>
                    <td style="padding:5px 4px;border-bottom:0.5px solid #ddd;color:${voteColor(v.choice)};">${esc(voteWord(v.choice))}</td>
                    <td style="padding:5px 4px;border-bottom:0.5px solid #ddd;color:#666;">${esc(fmt(v.created_at))}</td>
                    <td style="padding:5px 4px;border-bottom:0.5px solid #ddd;color:#444;">${esc(v.comment || '')}</td>
                </tr>`;
            }).join('');
            listSection = `<table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;">
                <thead><tr style="text-align:left;color:#666;">
                    <th style="padding:6px 4px;width:46px;font-weight:400;border-bottom:0.5px solid #ccc;">${esc(t.protocol_col_apt)}</th>
                    <th style="padding:6px 4px;font-weight:400;border-bottom:0.5px solid #ccc;">${esc(t.protocol_col_voter)}</th>
                    <th style="padding:6px 4px;width:80px;font-weight:400;border-bottom:0.5px solid #ccc;">${esc(t.protocol_col_vote)}</th>
                    <th style="padding:6px 4px;width:120px;font-weight:400;border-bottom:0.5px solid #ccc;">${esc(t.protocol_col_time)}</th>
                    <th style="padding:6px 4px;width:150px;font-weight:400;border-bottom:0.5px solid #ccc;">${esc(t.export_comments)}</th>
                </tr></thead><tbody>${rows}</tbody></table>`;
        } else {
            listSection = `<div style="font-size:12.5px;color:#666;margin-top:6px;">${esc(t.protocol_no_votes)}</div>`;
        }

        const descBlock = voting.description
            ? `<div style="margin:12px 0 16px;padding:10px 12px;background:#f6f6f4;border-radius:8px;color:#444;font-size:12.5px;">${esc(voting.description)}</div>`
            : '';

        const html = `
            <div style="text-align:center;border-bottom:0.5px solid #ddd;padding-bottom:14px;margin-bottom:18px;">
                <div style="font-size:12px;letter-spacing:0.12em;color:#888;">SPILKA · SPILKA.TOP</div>
                <div style="font-size:21px;font-weight:500;margin-top:10px;">${esc(t.protocol_heading)}</div>
                <div style="font-size:13px;color:#666;margin-top:2px;">${esc(t.protocol_subtitle)}</div>
                <div style="font-size:13px;margin-top:10px;">${esc(t.protocol_group)}: «${esc(voting.groupName || '')}»</div>
            </div>
            <table style="width:100%;font-size:13px;border-collapse:collapse;">
                ${metaRow(t.export_question, '<span style="font-weight:500;">' + esc(voting.title) + '</span>')}
                ${metaRow(t.export_type, esc(typeLabel))}
                ${targetRow}
                ${metaRow(t.protocol_initiator, esc(voting.initiatorName || '—'))}
                ${metaRow(t.protocol_period, esc(fmt(voting.createdAt)) + ' — ' + esc(fmt(voting.endedAt || voting.endsAt)))}
            </table>
            ${descBlock}
            <div style="font-size:14px;font-weight:500;margin:14px 0 10px;">${esc(t.protocol_quorum)}</div>
            <div style="display:flex;gap:10px;margin-bottom:18px;">
                <div style="flex:1;background:#f6f6f4;border-radius:8px;padding:10px 12px;"><div style="font-size:12px;color:#666;">${esc(t.protocol_voters)}</div><div style="font-size:22px;font-weight:500;">${voterTotal}</div></div>
                <div style="flex:1;background:#f6f6f4;border-radius:8px;padding:10px 12px;"><div style="font-size:12px;color:#666;">${esc(t.protocol_voted)}</div><div style="font-size:22px;font-weight:500;">${cast}</div></div>
                <div style="flex:1;background:#f6f6f4;border-radius:8px;padding:10px 12px;"><div style="font-size:12px;color:#666;">${esc(t.protocol_turnout)}</div><div style="font-size:22px;font-weight:500;">${turnout}%</div></div>
            </div>
            <div style="font-size:14px;font-weight:500;margin:0 0 10px;">${esc(t.protocol_results)}</div>
            ${bar(t.export_yes, counts.yes, '#1d7a4d')}
            ${bar(t.export_no, counts.no, '#b3261e')}
            ${bar(t.vote_abstain, counts.abstain, '#b4b2a9')}
            <div style="margin:16px 0 20px;padding:12px 14px;background:${accepted ? '#e7f4ec' : '#fbeaea'};border-radius:8px;">
                <div style="font-size:15px;font-weight:500;color:${accepted ? '#1d7a4d' : '#b3261e'};">${esc(accepted ? t.protocol_decision_accepted : t.protocol_decision_rejected)}</div>
                <div style="font-size:12px;color:#555;margin-top:2px;">${esc(t.protocol_rule)} (≥${needed} / ${total}). «${esc(t.export_yes)}» — ${counts.yes}.</div>
            </div>
            <div style="font-size:14px;font-weight:500;margin:0 0 8px;">${esc(t.protocol_namewise)}</div>
            ${listSection}
            <div style="display:flex;gap:30px;margin-top:28px;padding-top:18px;border-top:0.5px solid #ddd;">
                <div style="flex:1;"><div style="border-bottom:0.5px solid #999;height:26px;"></div><div style="font-size:11.5px;color:#666;margin-top:4px;">${esc(t.protocol_chair)}</div></div>
                <div style="flex:1;"><div style="border-bottom:0.5px solid #999;height:26px;"></div><div style="font-size:11.5px;color:#666;margin-top:4px;">${esc(t.protocol_secretary)}</div></div>
            </div>
            <div style="font-size:11px;color:#999;margin-top:16px;text-align:center;">${esc(t.protocol_generated)} · spilka.top · ${esc(fmt(new Date()))} · ID ${esc(voting.id)}</div>
        `;

        let ov = document.getElementById('protocol-overlay');
        if (!ov) { ov = document.createElement('div'); ov.id = 'protocol-overlay'; ov.className = 'protocol-overlay'; document.body.appendChild(ov); }
        ov.innerHTML = `
            <div class="protocol-toolbar">
                <button class="btn btn-secondary" onclick="app.closeProtocol()"><i class="ph ph-x" aria-hidden="true"></i> ${t.protocol_close}</button>
                <button class="btn btn-primary" onclick="window.print()"><i class="ph ph-printer" aria-hidden="true"></i> ${t.protocol_print}</button>
            </div>
            <div class="protocol-paper" id="protocol-paper">${html}</div>`;
        ov.style.display = 'block';
        document.body.classList.add('protocol-open');
        ov.scrollTop = 0;
    },

    closeProtocol() {
        const ov = document.getElementById('protocol-overlay');
        if (ov) ov.style.display = 'none';
        document.body.classList.remove('protocol-open');
    },

    async vote(votingId, voteType) {
        const t = this.translations[this.currentLanguage];

        if (!this.state.user.apartment) {
            this.toastError(t.apartment_required);
            return;
        }

        if (this.state.user.frozen) {
            this.toastError(t.frozen_cannot_vote);
            return;
        }

        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting || voting.hasVoted) return;

        // Observer check — observers cannot vote. Use the startup-loaded
        // myIsObserver flag (members array may be empty on the votings tab).
        const vGroup = this.state.groups.find(g => g.id === voting.groupId);
        const currentMember = vGroup?.members?.find(m => m.id === this.state.user.id);
        if ((vGroup?.myIsObserver === true) || (currentMember?.isObserver === true)) {
            this.toastError(t.observer_cannot_vote || 'Спостерігачі не можуть голосувати');
            return;
        }

        const commentField = document.getElementById('vote-comment');
        const comment = commentField ? commentField.value.trim().substring(0, 500) : '';

        const choiceMap = { true: 'yes', yes: 'yes', false: 'no', no: 'no', abstain: 'abstain' };
        const choice = choiceMap[String(voteType)] || 'abstain';

        try {
            const { data, error } = await supabaseService.castVote(votingId, choice, comment);
            if (error) {
                if (error.code === '23505') {
                    this.toastError(t.already_voted || 'Ви вже проголосували');
                    voting.hasVoted = true;
                } else if (error.code === 'observer' || error.code === '42501') {
                    // Server rejected the vote because the user is an observer.
                    this.toastError(t.observer_cannot_vote || 'Спостерігачі не можуть голосувати');
                } else if (error.code === 'voting_inactive') {
                    this.toastError(t.voting_ended || 'Голосування вже завершено');
                } else if (error.code === 'not_member') {
                    this.toastError(t.not_member || 'Ви не учасник цієї групи');
                } else if (error.code === 'joined_after') {
                    this.toastError(t.joined_after_vote || 'Ви приєдналися після початку цього голосування і не входите до його складу');
                } else {
                    throw new Error(error.message);
                }
                return;
            }

            // Optimistic local update
            if (choice === 'yes') voting.yesVotes++;
            else if (choice === 'no') voting.noVotes++;
            else voting.abstainVotes = (voting.abstainVotes || 0) + 1;

            if (!voting.comments) voting.comments = [];
            voting.comments.push({
                userId: this.state.user.id,
                userName: `${this.state.user.firstName} ${this.state.user.lastName}`,
                apartment: this.state.user.apartment || '',
                vote: choice,
                comment,
                time: new Date().toLocaleString()
            });

            voting.hasVoted = true;
            this.renderVotings();
            await this.showVotingDetail(votingId);
        } catch (err) {
            this.toastError(t.auth_error_network || 'Помилка голосування');
        }
    },

    // Show delete voting modal
    showDeleteVotingModal(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        
        if (!voting) return;
        
        // Check if voting is completed
        if (voting.status === 'completed') {
            this.toastError(t.cannot_delete_completed);
            return;
        }
        
        // Check if user is author
        if (voting.initiatorId !== this.state.user.id) {
            return;
        }

        this.state.currentVotingToDelete = votingId;
        
        // Reset modal fields
        document.getElementById('delete-reason-text').value = '';
        document.getElementById('delete-reason-counter').textContent = '0';
        
        // Add character counter
        const reasonField = document.getElementById('delete-reason-text');
        reasonField.oninput = function() {
            document.getElementById('delete-reason-counter').textContent = this.value.length;
        };
        
        this.showModal('delete-voting-modal');
    },

    // Confirm and delete voting
    async confirmDeleteVoting() {
        const t = this.translations[this.currentLanguage];
        const votingId = this.state.currentVotingToDelete;
        const voting = this.state.votings.find(v => v.id === votingId);

        if (!voting) {
            this.hideModal('delete-voting-modal');
            return;
        }

        const reason = document.getElementById('delete-reason-text').value.trim();

        if (reason.length < 5) {
            this.toastError(t.delete_reason_short);
            return;
        }

        if (reason.length > 200) {
            this.toastError(t.delete_reason_long || 'Причина занадто довга (макс. 200 символів)');
            return;
        }

        try {
            const { error } = await supabaseService.deleteVoting(votingId, reason);
            if (error) throw new Error(error.message);

            this.state.votings = this.state.votings.filter(v => v.id !== votingId);

            // Notify group members
            const notifText = `${t.voting_deleted_by || 'Голосування видалено'}: "${voting.title}". ${t.reason_label || 'Причина'}: ${reason}`;
            await supabaseService.notifyGroupMembers(voting.groupId, 'system', notifText);

            this.hideModal('delete-voting-modal');
            this.hideModal('voting-detail-modal');
            this.renderVotings();

            this.toastSuccess(t.voting_deleted);
        } catch (err) {
            this.toastError(this.humanError(err));
        }
    },

    // Group detail
    // Force a hard refresh: clear local caches + ask SW to skip-waiting +
    // re-fetch group data + reload current group detail. Bypasses any
    // stale PWA cache so the user always sees what's actually in the DB.
    async refreshGroupAndReload() {
        const t = this.translations[this.currentLanguage] || {};
        this.hideModal('group-menu-modal');
        this.showGlobalLoader('refresh_in_progress');
        try {
            // Drop the local groups cache so loadMyGroups doesn't use stale data
            try { localStorage.removeItem('vc_groups'); } catch (e) {}
            try { localStorage.removeItem('vc_notifications'); } catch (e) {}

            // Ask any installed service worker to skip-waiting (so the next
            // reload picks up the latest deployed code).
            if ('serviceWorker' in navigator) {
                try {
                    const reg = await navigator.serviceWorker.getRegistration();
                    if (reg && reg.waiting) {
                        reg.waiting.postMessage('SKIP_WAITING');
                    }
                } catch (e) { /* ignore */ }
            }

            // Re-pull data and re-render the current group page.
            const groupId = this.state.currentGroupId;
            await Promise.all([
                this.loadMyGroups(),
                this.loadMyVotings(),
                this.loadMyNotifications()
            ]);
            if (groupId) {
                await this.showGroupDetail(groupId);
            }
            this.toastSuccess(t.refresh_done || 'Дані оновлено');
        } catch (e) {
            this.toastError(this.humanError(e));
        } finally {
            this.hideGlobalLoader();
        }
    },

    async showGroupDetail(groupId) {
        const t = this.translations[this.currentLanguage];
        const group = this.state.groups.find(g => g.id === groupId);
        if (!group) return;

        // Store current group for filtering/sorting
        this.state.currentGroupId = groupId;
        this.state.membersSort = { by: 'name', order: 'asc' };
        this.state.membersFilter = '';

        // Show screen immediately with cached data
        document.getElementById('group-detail-name').textContent = group.name;
        document.getElementById('group-detail-id').textContent = group.groupId;
        document.getElementById('group-detail-description').textContent = group.description || '';
        this.showScreen('group-detail-screen');

        // Fetch fresh data from Supabase
        const { data, error } = await supabaseService.getGroupDetail(groupId);
        if (data) {
            group.members = (data.members || []).map(m => ({
                id: m.user_id,
                name: `${m.user.first_name} ${m.user.last_name}`.trim(),
                role: m.role,
                phone: m.user.phone,
                address: m.user.address ? `${m.user.address}, кв. ${m.user.apartment}` : `кв. ${m.user.apartment || '-'}`,
                frozen: m.is_frozen,
                frozenUntil: m.frozen_until,
                isObserver: m.is_observer === true,
                apartment: m.apartment || m.user.apartment || ''
            }));

            group.requests = (data.requests || []).map(r => ({
                id: r.id,
                userId: r.user_id,
                name: `${r.user.first_name} ${r.user.last_name}`.trim(),
                address: r.user.address ? `${r.user.address}, кв. ${r.user.apartment}` : `кв. ${r.user.apartment || '-'}`,
                apartment: r.apartment || r.user.apartment || '',
                asObserver: r.requested_as_observer === true,
                isRoleChange: r.is_role_change === true
            }));

            group.history = (data.history || []).map(h => ({
                date: new Date(h.created_at).toLocaleString(),
                action: h.action,
                details: h.details || {},
                from: h.details?.from || '',
                to: h.details?.to || '',
                member: h.details?.member || '',
                reason: h.details?.reason || '',
                initiator: h.details?.initiator || '',
                votingId: h.details?.votingId || ''
            }));

            group.membersCount = data.stats?.members_count || group.members.length;
            group.votingsCount = data.stats?.total_votings_count || 0;
        }

        // Fetch per-member vote counts so participation column shows real data
        // (Without this, getMemberParticipation would always return 0 because
        // votes are not loaded into voting.comments.)
        try {
            const { data: votesData } = await supabaseService.getGroupMemberVotes(group.id);
            group.memberVotes = {};
            (votesData || []).forEach(row => {
                group.memberVotes[row.user_id] = Number(row.voted_count) || 0;
            });
        } catch (e) {
            group.memberVotes = group.memberVotes || {};
        }

        // Count frozen / voter / observer members
        const members = group.members || [];
        const frozenCount = members.filter(m => m.frozen).length;
        // Excluded ("frozen") members are out of the quorum denominator, so they
        // are not counted as active voters here either — keeps the breakdown honest.
        const voterCount = members.filter(m => !m.isObserver && !m.frozen).length;
        const observerCount = members.filter(m => m.isObserver).length;

        document.getElementById('group-members-count').textContent = group.membersCount;

        // Show voter/observer breakdown
        const roleBreakdown = document.getElementById('role-breakdown');
        if (roleBreakdown) {
            roleBreakdown.textContent = `👍 ${voterCount} · 👁️ ${observerCount}`;
        }

        // Show frozen count if any
        const frozenDisplay = document.getElementById('frozen-count-display');
        if (frozenCount > 0) {
            document.getElementById('frozen-count').textContent = frozenCount;
            frozenDisplay.style.display = 'block';
        } else {
            frozenDisplay.style.display = 'none';
        }

        // Calculate voting stats
        const groupVotings = this.state.votings.filter(v => v.groupId === group.id);
        const totalVotings = groupVotings.length;
        const acceptedVotings = groupVotings.filter(v => v.status === 'completed' && v.result === 'accepted').length;
        const rejectedVotings = groupVotings.filter(v => v.status === 'completed' && v.result === 'rejected').length;
        const activeVotings = groupVotings.filter(v => v.status === 'active').length;

        document.getElementById('group-votings-count').textContent = totalVotings;
        document.getElementById('votings-accepted').textContent = acceptedVotings;
        document.getElementById('votings-rejected').textContent = rejectedVotings;
        document.getElementById('votings-pending').textContent = activeVotings;

        document.getElementById('group-admin-badge').style.display = group.isAdmin ? 'inline-block' : 'none';

        // Clear search
        document.getElementById('member-search').value = '';
        document.getElementById('clear-search').style.display = 'none';

        // Show "I'm here" banner if the current user was excluded from the count
        this.renderExcludedSelfBanner(group);

        // Render members with participation data
        this.renderMembersList(group);
    },

    // If the current user is excluded from the count in this group, show a
    // prominent self-service banner so a present (wrongly-excluded) person can
    // restore themselves instantly — a real "ghost" never clicks it.
    renderExcludedSelfBanner(group) {
        const t = this.translations[this.currentLanguage];
        const ml = document.getElementById('members-list');
        if (!ml) return;
        let banner = document.getElementById('excluded-self-banner');
        const me = (group.members || []).find(m => m.id === this.state.user.id);
        if (me && me.frozen) {
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'excluded-self-banner';
                ml.parentNode.insertBefore(banner, ml);
            }
            banner.className = 'excluded-self-banner';
            banner.innerHTML = `
                <div class="esb-text">
                    <i class="ph-fill ph-snowflake" aria-hidden="true"></i>
                    <span>${t.excluded_self_text}</span>
                </div>
                <button class="btn btn-primary esb-btn" onclick="app.restoreMe('${group.id}')">
                    <i class="ph ph-hand-waving" aria-hidden="true"></i> ${t.im_here_btn}
                </button>`;
        } else if (banner) {
            banner.remove();
        }
    },

    // Self-service restore: the excluded member returns themselves to the count.
    async restoreMe(groupId) {
        const t = this.translations[this.currentLanguage];
        const { error } = await supabaseService.restoreMe(groupId);
        if (error) { this.toastError(this.humanError(error)); return; }
        this.toastSuccess(t.im_here_done);
        await this.showGroupDetail(groupId);
    },

    // Admin manually returns an excluded member to the count.
    async adminRestoreMember(groupId, userId) {
        const t = this.translations[this.currentLanguage];
        const { error } = await supabaseService.setMemberFrozen(groupId, userId, false);
        if (error) { this.toastError(this.humanError(error)); return; }
        this.toastSuccess(t.member_restored_done);
        await this.showGroupDetail(groupId);
    },

    // Calculate member participation in group votings
    getMemberParticipation(memberId, groupId) {
        // Use only non-deleted votings for the denominator (matches the RPC)
        const groupVotings = this.state.votings.filter(
            v => v.groupId === groupId && v.status !== 'deleted'
        );
        const totalVotings = groupVotings.length;
        if (totalVotings === 0) return { participated: 0, total: 0, percentage: 0 };

        // Prefer authoritative DB-side counts (loaded by showGroupDetail via
        // get_group_member_votes RPC). Fallback to 0 if not yet loaded.
        const group = this.state.groups.find(g => g.id === groupId);
        const fromMap = group?.memberVotes?.[memberId];
        const participated = typeof fromMap === 'number'
            ? Math.min(fromMap, totalVotings)
            : 0;

        return {
            participated,
            total: totalVotings,
            percentage: Math.round((participated / totalVotings) * 100)
        };
    },

    // Render members list with current sort and filter
    renderMembersList(group) {
        const t = this.translations[this.currentLanguage];
        const membersList = document.getElementById('members-list');
        
        // Get participation data for each member
        let membersWithStats = group.members.map(member => ({
            ...member,
            participation: this.getMemberParticipation(member.id, group.id)
        }));
        
        // Apply filter
        if (this.state.membersFilter && this.state.membersFilter.length >= 3) {
            const filter = this.state.membersFilter.toLowerCase();
            membersWithStats = membersWithStats.filter(m => 
                m.name.toLowerCase().includes(filter) || 
                (m.phone && m.phone.includes(filter))
            );
        }
        
        // Apply sort
        if (this.state.membersSort.by === 'name') {
            membersWithStats.sort((a, b) => {
                const comparison = a.name.localeCompare(b.name);
                return this.state.membersSort.order === 'asc' ? comparison : -comparison;
            });
        } else if (this.state.membersSort.by === 'participation') {
            membersWithStats.sort((a, b) => {
                const comparison = a.participation.participated - b.participation.participated;
                return this.state.membersSort.order === 'asc' ? comparison : -comparison;
            });
        }
        
        // Update sort icons
        const nameSortIcon = document.getElementById('name-sort-icon');
        const participationSortIcon = document.getElementById('participation-sort-icon');
        
        if (nameSortIcon) {
            nameSortIcon.className = this.state.membersSort.by === 'name' 
                ? (this.state.membersSort.order === 'asc' ? 'ph ph-sort-ascending' : 'ph ph-sort-descending')
                : 'ph ph-sort-ascending';
        }
        if (participationSortIcon) {
            participationSortIcon.className = this.state.membersSort.by === 'participation'
                ? (this.state.membersSort.order === 'asc' ? 'ph ph-sort-ascending' : 'ph ph-sort-descending')
                : 'ph ph-sort-descending';
        }
        
        // Render
        if (membersWithStats.length === 0) {
            membersList.innerHTML = `<div class="empty-state-inline">${t.no_members_found || 'Учасників не знайдено'}</div>`;
            return;
        }

        // Count frozen members
        const frozenCount = group.members.filter(m => m.frozen).length;

        const isAdmin = group && group.isAdmin;

        membersList.innerHTML = membersWithStats.map(member => {
            const participationText = `${member.participation.participated}/${member.participation.total}`;
            const frozenIndicator = member.frozen ? `<i class="ph-fill ph-snowflake frozen-indicator" title="${t.frozen_badge}" aria-hidden="true"></i>` : '';
            const roleBadge = member.isObserver
                ? `<span class="role-badge observer" title="${t.role_observer || 'Спостерігач'}">👁️</span>`
                : `<span class="role-badge voter" title="${t.role_voter || 'Голосуючий'}">👍</span>`;
            const aptDisplay = member.apartment ? `кв. ${this.escapeHTML(member.apartment)}` : '';
            const restoreBtn = isAdmin && member.frozen
                ? `<button class="btn-icon-sm member-restore-btn" onclick="app.adminRestoreMember('${group.id}', '${member.id}')" title="${t.restore_member_menu}" aria-label="${t.restore_member_menu}"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i></button>`
                : '';
            const adminMenu = (isAdmin && member.id !== this.state.user.id
                ? `<button class="btn-icon-sm member-role-btn" onclick="app.showChangeRoleMenu('${group.id}', '${member.id}', ${member.isObserver})" title="${t.change_role_menu || 'Змінити роль'}" aria-label="${t.change_role_menu || 'Змінити роль'}"><i class="ph ph-swap" aria-hidden="true"></i></button>`
                : '') + restoreBtn;
            return `
            <div class="member-card ${member.frozen ? 'frozen' : ''}">
                <div class="member-avatar">
                    <i class="ph ph-user ${member.frozen ? 'text-info' : ''}" aria-hidden="true"></i>
                </div>
                <div class="member-info">
                    <div class="member-name">${this.escapeHTML(member.name)} ${roleBadge} ${frozenIndicator}</div>
                    <div class="member-address">${aptDisplay || this.escapeHTML(member.address || 'кв. -')}</div>
                </div>
                <div class="member-participation ${member.frozen ? 'text-info' : ''}">
                    ${member.frozen ? `<i class="ph-fill ph-snowflake" aria-hidden="true"></i> ${t.frozen_badge}` : participationText}
                </div>
                ${adminMenu}
            </div>
        `}).join('');

        // Render requests (only for admin)
        const requestsList = document.getElementById('requests-list');
        if (group.isAdmin && group.requests.length > 0) {
            requestsList.innerHTML = group.requests.map(request => {
                const roleLabel = request.asObserver
                    ? `👁️ ${t.role_observer || 'Спостерігач'}`
                    : `👍 ${t.role_voter || 'Голосуючий'}`;
                const aptLabel = request.apartment ? `кв. ${this.escapeHTML(request.apartment)}` : '';
                const roleChangeBadge = request.isRoleChange
                    ? `<span class="role-change-badge">${t.role_change_badge || 'зміна ролі'}</span>`
                    : '';
                return `
                <div class="request-item">
                    <div class="request-avatar"><i class="ph ph-user" aria-hidden="true"></i></div>
                    <div class="request-info">
                        <div class="request-name">${this.escapeHTML(request.name)} ${roleChangeBadge}</div>
                        <div class="request-address">${aptLabel} · ${roleLabel}</div>
                    </div>
                    <div class="request-actions">
                        <button class="btn-small btn-approve" onclick="app.approveRequest('${group.id}', '${request.id}')" aria-label="${t.approve || 'Approve'}"><i class="ph ph-check" aria-hidden="true"></i></button>
                        <button class="btn-small btn-reject" onclick="app.rejectRequest('${group.id}', '${request.id}')" aria-label="${t.reject || 'Reject'}"><i class="ph ph-x" aria-hidden="true"></i></button>
                    </div>
                </div>
            `}).join('');
        } else {
            requestsList.innerHTML = `<div class="empty-state-inline">${t.no_requests}</div>`;
        }

        // Render history
        const historySection = document.getElementById('history-section-header');
        const historyList = document.getElementById('history-list');
        
        if (group.history && group.history.length > 0) {
            historySection.style.display = 'flex';
            historyList.style.display = 'block';
            
            historyList.innerHTML = group.history.map(item => {
                let actionText = '';
                if (item.action === 'admin_change') {
                    actionText = `<i class="ph-fill ph-crown text-warning" aria-hidden="true"></i> ${t.history_admin_change}: ${this.escapeHTML(item.from)} → ${this.escapeHTML(item.to)}`;
                } else if (item.action === 'member_removed') {
                    actionText = `<i class="ph-fill ph-prohibit text-danger" aria-hidden="true"></i> ${t.history_member_removed}: ${this.escapeHTML(item.member)}`;
                    if (item.reason) actionText += ` (${this.escapeHTML(item.reason)})`;
                }

                const date = new Date(item.date).toLocaleDateString();

                return `
                    <div class="history-item">
                        <div class="history-item-action">${actionText}</div>
                        <div class="history-item-meta">
                            <i class="ph ph-calendar-blank" aria-hidden="true"></i> ${this.escapeHTML(date)} • <i class="ph ph-user" aria-hidden="true"></i> ${t.history_initiator}: ${this.escapeHTML(item.initiator)}
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            historySection.style.display = 'none';
            historyList.style.display = 'none';
        }

        this.showScreen('group-detail-screen');
    },

    exportGroupHistory() {
        const t = this.translations[this.currentLanguage];
        const groupCode = document.getElementById('group-detail-id').textContent;
        const group = this.state.groups.find(g => g.groupId === groupCode);
        
        if (!group) return;

        // Get all votings for this group
        const groupVotings = this.state.votings.filter(v => v.groupId === group.id);
        
        if (groupVotings.length === 0) {
            this.toastError((this.translations[this.currentLanguage] || {}).export_nothing || 'Немає голосувань для експорту');
            return;
        }

        // Map userId → per-group apartment (most accurate source) so each
        // exported vote line carries the VOTER's apartment, not the exporter's.
        const aptByUser = {};
        (group.members || []).forEach(m => { if (m.apartment) aptByUser[m.id] = m.apartment; });

        // Create CSV content
        const headers = [
            t.export_date,
            t.export_author,
            t.export_question,
            t.export_type,
            t.export_result,
            t.export_yes,
            t.export_no,
            t.export_abstain,
            t.export_votes,
            t.export_comments
        ].join(';');

        const rows = groupVotings.map(voting => {
            const createdDate = new Date(voting.createdAt).toLocaleString();
            const author = voting.initiatorName || t.unknown_author;
            const type = voting.type === 'secret' ? t.type_secret : 
                        voting.type === 'admin-change' ? t.type_admin :
                        voting.type === 'remove-member' ? t.type_remove : t.type_simple;
            const result = voting.status === 'completed' 
                ? (voting.result === 'accepted' ? t.result_accepted : t.result_rejected)
                : t.active_votings;
            
            const yesVotes = voting.yesVotes || 0;
            const noVotes = voting.noVotes || 0;
            const abstainVotes = voting.abstainVotes || 0;
            const totalVotes = yesVotes + noVotes + abstainVotes;
            
            // Build votes detail with apartment numbers instead of names
            let votesDetail = '';
            if (voting.comments && voting.comments.length > 0) {
                votesDetail = voting.comments.map(c => {
                    const voteType = c.vote === 'yes' ? t.export_yes :
                                   c.vote === 'no' ? t.export_no : t.export_abstain;
                    // Voter's own apartment: per-group membership first, then
                    // their profile apartment carried on the comment, then N/A.
                    const unit = aptByUser[c.userId] || c.apartment || 'N/A';
                    return `${unit}: ${voteType}${c.comment ? ' - ' + c.comment : ''}`;
                }).join(' | ');
            }
            
            return [
                createdDate,
                author,
                voting.title,
                type,
                result,
                yesVotes,
                noVotes,
                abstainVotes,
                totalVotes,
                votesDetail
            ].map(field => {
                let s = String(field);
                // Mitigate CSV formula injection — Excel/Sheets execute a cell that
                // starts with = + - @ (or tab/CR). Prefix such values with a quote.
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return `"${s.replace(/"/g, '""')}"`;
            }).join(';');
        });

        const csvContent = '\uFEFF' + [headers, ...rows].join('\n');
        
        // Download file
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `group-${group ? group.groupId : 'unknown'}-history-${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    },

    // Sort members by name
    sortMembersByName() {
        if (this.state.membersSort.by === 'name') {
            this.state.membersSort.order = this.state.membersSort.order === 'asc' ? 'desc' : 'asc';
        } else {
            this.state.membersSort.by = 'name';
            this.state.membersSort.order = 'asc';
        }
        const group = this.state.groups.find(g => g.id === this.state.currentGroupId);
        if (group) this.renderMembersList(group);
    },

    // Sort members by participation
    sortMembersByParticipation() {
        if (this.state.membersSort.by === 'participation') {
            this.state.membersSort.order = this.state.membersSort.order === 'asc' ? 'desc' : 'asc';
        } else {
            this.state.membersSort.by = 'participation';
            this.state.membersSort.order = 'desc';
        }
        const group = this.state.groups.find(g => g.id === this.state.currentGroupId);
        if (group) this.renderMembersList(group);
    },

    // Search members
    searchMembers(query) {
        this.state.membersFilter = query;
        const clearBtn = document.getElementById('clear-search');
        if (clearBtn) {
            clearBtn.style.display = query.length > 0 ? 'flex' : 'none';
        }
        const group = this.state.groups.find(g => g.id === this.state.currentGroupId);
        if (group) this.renderMembersList(group);
    },

    // Clear member search
    clearMemberSearch() {
        const searchInput = document.getElementById('member-search');
        if (searchInput) {
            searchInput.value = '';
            this.searchMembers('');
        }
    },

    async approveRequest(groupId, requestId, forceObserver = false) {
        const t = this.translations[this.currentLanguage] || {};
        try {
            const { error } = await supabaseService.approveJoinRequestV2(requestId, forceObserver);
            if (error) {
                const msg = error.message || '';
                if (msg.includes('apartment_taken_now')) {
                    // Apartment was taken between request submission and approval
                    const confirmed = await this.confirm({
                        message: t.apartment_taken_now_confirm || 'Квартира вже зайнята. Затвердити як спостерігача?',
                        okText: t.confirm_ok || 'Підтвердити',
                        cancelText: t.cancel || 'Скасувати',
                        danger: false
                    });
                    if (confirmed) {
                        await this.approveRequest(groupId, requestId, true);
                    }
                    return;
                }
                throw new Error(msg);
            }
            // Refresh BOTH the group detail (members list, requests, frozen
            // count, voting stats) AND the global groups list (so the
            // member count on the Groups screen reflects reality immediately
            // when the user navigates back).
            await Promise.all([
                this.showGroupDetail(groupId),
                this.loadMyGroups(),
                this.loadMyNotifications()
            ]);
            this.toastSuccess(t.request_approved || 'Запит схвалено');
        } catch (err) {
            this.toastError(this.humanError(err));
        }
    },

    async rejectRequest(groupId, requestId) {
        const t = this.translations[this.currentLanguage] || {};
        try {
            const { error } = await supabaseService.rejectJoinRequest(requestId);
            if (error) throw new Error(error.message);
            await Promise.all([
                this.showGroupDetail(groupId),
                this.loadMyNotifications()
            ]);
            this.toastSuccess(t.request_rejected || 'Запит відхилено');
        } catch (err) {
            this.toastError(this.humanError(err));
        }
    },

    // Show role change confirmation dialog for admin
    async showChangeRoleMenu(groupId, userId, currentlyObserver) {
        const t = this.translations[this.currentLanguage] || {};
        const makeObserver = !currentlyObserver;
        const roleLabel = makeObserver
            ? (t.role_observer || 'Спостерігач')
            : (t.role_voter || 'Голосуючий');
        const confirmed = await this.confirm({
            title: t.change_role_menu || 'Змінити роль',
            message: roleLabel,
            okText: t.confirm_ok || 'Підтвердити',
            cancelText: t.cancel || 'Скасувати',
            danger: false
        });
        if (confirmed) {
            this.adminChangeRole(groupId, userId, makeObserver);
        }
    },

    async adminChangeRole(groupId, userId, makeObserver) {
        const t = this.translations[this.currentLanguage] || {};
        try {
            const { error } = await supabaseService.adminChangeRole(groupId, userId, makeObserver);
            if (error) throw new Error(error.message);
            await this.showGroupDetail(groupId);
            this.toastSuccess(t.role_changed || 'Роль змінено');
        } catch (err) {
            this.toastError(this.humanError(err));
        }
    },

    // Request role change for current user (sends request for admin approval)
    async requestRoleChange(groupId, becomeObserver) {
        const t = this.translations[this.currentLanguage] || {};
        try {
            const { error } = await supabaseService.requestRoleChange(groupId, becomeObserver);
            if (error) {
                const msg = error.message || '';
                if (msg.includes('already_in_role')) {
                    this.toastError(t.already_in_role || 'Ви вже маєте цю роль');
                } else if (msg.includes('already_pending')) {
                    this.toastError(t.already_requested || 'Запит вже надіслано');
                } else if (msg.includes('admin_cannot_be_observer')) {
                    this.toastError(t.admin_cannot_be_observer || 'Адміністратор не може бути спостерігачем');
                } else if (msg.includes('apartment_taken')) {
                    const takenName = msg.includes('apartment_taken:') ? (msg.split('apartment_taken:')[1] || '') : '';
                    const who = takenName ? `: ${this.escapeHTML(takenName)}` : '';
                    this.toastError(`${t.apartment_taken || 'Квартира зайнята голосуючим'}${who}`);
                } else {
                    throw new Error(msg);
                }
                return;
            }
            this.toastSuccess(t.role_change_requested || 'Запит на зміну ролі надіслано');
        } catch (err) {
            this.toastError(this.humanError(err));
        }
    },

    copyGroupId() {
        const groupId = document.getElementById('group-detail-id').textContent;
        navigator.clipboard.writeText(groupId).then(() => {
            this.toastSuccess('ID ' + groupId);
        });
    },

    showGroupMenu() {
        const group = this.state.groups.find(g => g.id === this.state.currentGroupId);
        const isAdmin = group && group.isAdmin;

        const deleteBtn = document.getElementById('group-menu-delete-btn');
        if (deleteBtn) {
            deleteBtn.style.display = isAdmin ? 'flex' : 'none';
        }

        const leaveBtn = document.getElementById('group-menu-leave-btn');
        if (leaveBtn) {
            leaveBtn.style.display = isAdmin ? 'none' : 'flex';
        }

        this.showModal('group-menu-modal');
    },

    editGroup() {
        this.hideModal('group-menu-modal');
        const group = this.state.groups.find(g => g.id === this.state.currentGroupId);
        if (!group) return;
        document.getElementById('edit-group-name').value = group.name || '';
        document.getElementById('edit-group-description').value = group.description || '';
        this.showModal('edit-group-modal');
    },

    async saveEditedGroup() {
        const t = this.translations[this.currentLanguage];
        const name = document.getElementById('edit-group-name').value.trim();
        const description = document.getElementById('edit-group-description').value.trim();

        if (!name) {
            this.toastError(t.group_name_required || 'Введіть назву групи');
            return;
        }

        const groupId = this.state.currentGroupId;
        if (!groupId) return;

        const btn = document.querySelector('#edit-group-modal .btn-primary');
        if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }

        try {
            const { error } = await supabaseService.updateGroup(groupId, { name, description });
            if (error) throw new Error(error.message);

            // Update local state
            const group = this.state.groups.find(g => g.id === groupId);
            if (group) {
                group.name = name;
                group.description = description;
            }

            this.hideModal('edit-group-modal');
            document.getElementById('group-detail-name').textContent = name;
            document.getElementById('group-detail-description').textContent = description;
            this.renderGroups();
        } catch (err) {
            this.toastError(this.humanError(err));
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
    },

    confirmDeleteGroup() {
        this.hideModal('group-menu-modal');
        const t = this.translations[this.currentLanguage];
        const group = this.state.groups.find(g => g.id === this.state.currentGroupId);
        if (!group) return;

        if (group.membersCount >= 2) {
            this.toastError(t.delete_group_need_voting);
            return;
        }
        this.showModal('delete-group-modal');
    },

    async deleteGroup() {
        const t = this.translations[this.currentLanguage];
        const groupId = this.state.currentGroupId;
        if (!groupId) return;

        const btn = document.querySelector('#delete-group-modal .btn-primary, #delete-group-modal .btn[style]');
        if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }

        try {
            const { error } = await supabaseService.deleteGroup(groupId);
            if (error) throw new Error(error.message);

            // Remove from local state
            this.state.groups = this.state.groups.filter(g => g.id !== groupId);
            this.state.currentGroupId = null;

            this.hideModal('delete-group-modal');
            this.showScreen('groups-screen');
            this.renderGroups();
        } catch (err) {
            this.toastError(this.humanError(err));
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
    },

    leaveGroup() {
        this.hideModal('group-menu-modal');
        this.showModal('leave-group-modal');
    },

    async confirmLeaveGroup() {
        const t = this.translations[this.currentLanguage];
        const groupId = this.state.currentGroupId;
        if (!groupId) return;

        const btn = document.querySelector('#leave-group-modal .btn-primary, #leave-group-modal .btn[style]');
        if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }

        try {
            const { error } = await supabaseService.leaveGroup(groupId);
            if (error) throw new Error(error.message);

            const group = this.state.groups.find(g => g.id === groupId);
            const groupName = group ? group.name : '';

            this.state.groups = this.state.groups.filter(g => g.id !== groupId);
            this.state.currentGroupId = null;

            this.hideModal('leave-group-modal');
            this.showScreen('groups-screen');
            this.renderGroups();

            this.state.notifications.unshift({
                id: Date.now(),
                type: 'system',
                text: `${t.leave_group_success}: "${groupName}"`,
                time: t.just_now,
                read: false
            });
            this.renderNotifications();
        } catch (err) {
            this.toastError(this.humanError(err));
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
    },

    updateProfileDisplay() {
        if (!this.state.user) return;
        const t = this.translations[this.currentLanguage];
        document.getElementById('profile-name').textContent =
            `${this.state.user.firstName || ''} ${this.state.user.lastName || ''}`.trim();
        document.getElementById('profile-email').textContent = this.state.user.email || '';
        document.getElementById('profile-phone-display').textContent = this.state.user.phone || '';
        document.getElementById('profile-address-display').textContent =
            this.state.user.address ? `${this.state.user.address}, кв. ${this.state.user.apartment}` : '';
        document.getElementById('profile-groups-count').textContent = this.state.groups.length;

        // Render group roles section
        const rolesContainer = document.getElementById('profile-group-roles');
        if (rolesContainer && this.state.groups.length > 0) {
            rolesContainer.innerHTML = this.state.groups.map(group => {
                const myMember = (group.members || []).find(m => m.id === this.state.user.id);
                const isAdmin = group.isAdmin;
                // myIsObserver is loaded for every group on startup; the
                // members array is only filled after opening group detail.
                const isObserver = (group.myIsObserver === true) || (myMember?.isObserver === true);
                const roleLabel = isAdmin
                    ? `<i class="ph-fill ph-crown text-warning" aria-hidden="true"></i> ${t.admin || 'Адмін'}`
                    : isObserver
                        ? `👁️ ${t.role_observer || 'Спостерігач'}`
                        : `👍 ${t.role_voter || 'Голосуючий'}`;
                const roleChangeBtn = !isAdmin ? `
                    <button class="btn-text-sm" onclick="app.showRoleChangeDialog('${group.id}', ${isObserver})">
                        ${t.request_role_change_btn || 'Запросити зміну ролі'}
                    </button>` : '';
                return `
                    <div class="profile-group-role-row">
                        <span class="profile-group-name">${this.escapeHTML(group.name)}</span>
                        <span class="profile-role-badge">${roleLabel}</span>
                        ${roleChangeBtn}
                    </div>
                `;
            }).join('');
            rolesContainer.closest('.profile-roles-section')?.classList.remove('hidden');
        } else if (rolesContainer) {
            rolesContainer.closest('.profile-roles-section')?.classList.add('hidden');
        }
    },

    async showRoleChangeDialog(groupId, currentlyObserver) {
        const t = this.translations[this.currentLanguage];
        const becomeObserver = !currentlyObserver;
        const targetRole = becomeObserver
            ? (t.role_observer || 'Спостерігач')
            : (t.role_voter || 'Голосуючий');
        const confirmed = await this.confirm({
            title: t.request_role_change_btn || 'Запросити зміну ролі',
            message: `→ ${targetRole}`,
            okText: t.confirm_ok || 'Підтвердити',
            cancelText: t.cancel || 'Скасувати',
            danger: false
        });
        if (confirmed) {
            this.requestRoleChange(groupId, becomeObserver);
        }
    },

    // Language Support
    translations: {
        uk: {
            profile: 'Профіль',
            edit_profile: 'Редагувати профіль',
            instructions: 'Інструкції',
            instructions_title: 'Інструкції з використання',
            logout: 'Вийти',
            not_your_account: 'Це не ваш акаунт? Вийти',
            load_failed: 'Не вдалося завантажити. Потягніть вниз, щоб оновити.',
            theme: 'Тема',
            theme_auto: 'Системна',
            theme_light: 'Світла',
            theme_dark: 'Темна',
            install_app: 'Встановити на головний екран',
            install_thanks: 'Дякуємо! Spilka встановлено на головному екрані.',
            install_already: 'Додаток уже встановлено',
            install_ios_hint: 'На iPhone/iPad: натисніть «Поділитися» (квадрат зі стрілкою) і виберіть «На екран Домівка».',
            install_not_ready: 'Опція встановлення поки недоступна. Перевірте, що сторінку відкрито через HTTPS — і спробуйте знову.',
            install_dismissed: 'Скасовано — можна встановити пізніше з цього ж екрана.',
            auth_register_link: 'Реєстрація',
            register_title: 'Реєстрація',
            register_subtitle: 'Створіть акаунт для голосувань',
            register_password_placeholder: 'Пароль (мін. 8 символів)',
            register_submit_btn: 'Створити акаунт',
            register_google_btn: 'Реєстрація через Google',
            register_have_account: 'Вже маєте акаунт?',
            forgot_title: 'Відновлення пароля',
            forgot_subtitle: 'Введіть email — надішлемо посилання',
            forgot_submit_btn: 'Надіслати посилання',
            forgot_remembered: 'Згадали пароль?',
            reset_title: 'Новий пароль',
            reset_subtitle: 'Введіть новий пароль для акаунта',
            reset_pass1_placeholder: 'Новий пароль (мін. 8 символів)',
            reset_pass2_placeholder: 'Повторіть новий пароль',
            reset_submit_btn: 'Зберегти новий пароль',
            reset_mismatch: 'Паролі не співпадають',
            reset_done: 'Пароль оновлено',
            change_password: 'Змінити пароль',
            feedback_btn: 'Пропозиція / зауваження',
            feedback_title: 'Пропозиція або зауваження',
            feedback_hint: 'Напишіть, що подобається або що варто покращити. Ми читаємо все.',
            feedback_placeholder: 'Ваша пропозиція або зауваження...',
            feedback_send: 'Надіслати',
            feedback_thanks: 'Дякуємо! Ми отримали ваш відгук — найближчим часом розглянемо.',
            feedback_too_short: 'Напишіть більше деталей (мін. 5 символів)',
            admin_panel: 'Адмін-панель',
            admin_tab_users: 'Користувачі',
            admin_tab_groups: 'Групи',
            admin_tab_feedback: 'Відгуки',
            loading: 'Завантаження…',
            request_approved: 'Запит схвалено',
            request_rejected: 'Запит відхилено',
            approve: 'Прийняти',
            reject: 'Відхилити',
            loader_signing_in: 'Входимо в акаунт…',
            refresh_group: 'Оновити дані',
            refresh_in_progress: 'Оновлюємо…',
            refresh_done: 'Дані оновлено',
            dev_banner: '⚠️ Сайт у розробці — деякі функції можуть змінюватись',
            archive_all: 'В архів',
            archive_confirm_title: 'В архів',
            archive_confirm_msg: 'Перенести сповіщення в архів? Вони залишаться в історії, але список очиститься.',
            archive_empty: 'Список вже порожній',
            archive_done: 'Перенесено в архів',
            archive_needs_migration: 'Спочатку накатіть phase12-notif-archive.sql у Supabase SQL Editor',
            notifications_archive: 'Архів сповіщень',
            archive_search_placeholder: 'Пошук (від 3 символів)...',
            archive_load_more: 'Завантажити ще',
            archive_empty_state: 'Архів порожній',
            archive_no_search_results: 'Нічого не знайдено',
            unarchive: 'Розархівувати',
            unarchive_confirm: 'Повернути сповіщення до основного списку?',
            unarchive_done: 'Повернуто до основного списку',
            cta_complete_profile: 'Заповніть «Квартиру/офіс» у профілі, щоб голосувати',
            members_label: 'Учасників',
            votings_label: 'Голосувань',
            confirm_title: 'Підтвердження',
            confirm_ok: 'Підтвердити',
            logout_confirm: 'Вийти з акаунту? Доведеться увійти знову.',
            ptr_pull: 'Потягніть, щоб оновити',
            ptr_release: 'Відпустіть, щоб оновити',
            ptr_loading: 'Оновлюємо…',
            address: 'Адреса',
            groups_count: 'Груп',
            firstname: "Ім'я",
            lastname: 'Прізвище',
            phone: 'Телефон',
            apartment: 'Квартира/офіс',
            cancel: 'Скасувати',
            save: 'Зберегти',
            voting: 'Голосування',
            groups: 'Групи',
            notifications: 'Сповіщення',
            active_votings: 'Активні',
            completed_votings: 'Завершені',
            enter_group_id: 'Введіть ID групи (6 цифр)',
            join: 'Приєднатися',
            mark_all_read: 'Прочитано все',
            new_group: 'Нова група',
            group_name: 'Назва групи',
            group_name_placeholder: 'Наприклад: Будинок 61',
            group_description: 'Опис (необов\'язково)',
            group_desc_placeholder: 'Короткий опис групи...',
            group_hint: 'Після створення ви отримаєте унікальний ID для запрошення учасників',
            create: 'Створити',
            new_voting: 'Нове голосування',
            question: 'Питання',
            question_placeholder: 'Текст питання для голосування',
            description: 'Опис',
            description_placeholder: 'Детальний опис голосування...',
            group: 'Група',
            select_group: 'Виберіть групу',
            voting_type: 'Тип голосування',
            type_simple: 'Звичайне (за/проти)',
            type_secret: 'Тайне голосування',
            type_admin: 'Зміна адміністратора',
            type_remove: 'Видалення учасника',
            type_freeze: 'Виключити з підрахунку',
            freeze_members: 'Кого виключити з підрахунку',
            freeze_info: 'Виключає учасника з підрахунку голосів (напр., квартиру продано або людина не бере участі). На заперечення — 5 днів; будь-які 2 учасники можуть скасувати.',
            freeze_proposal: 'Пропозиція виключити з підрахунку',
            freeze_duration_info: 'Заперечити можна 5 днів. Якщо 2 учасники натиснуть «Не згоден» — виключення скасується. Сам учасник може повернути себе будь-коли кнопкою «Я тут».',
            freeze_voting: 'Виключення з підрахунку',
            only_admin_can_freeze: 'Тільки адміністратор може запропонувати виключення з підрахунку',
            select_freeze_members: 'Виберіть хоча б одного учасника',
            i_disagree: 'Я не згоден',
            disagree_info: 'Якщо 2 учасники не згодні — виключення буде скасовано автоматично.',
            you_objected: 'Ви висловили незгоду',
            already_objected: 'Ви вже висловили незгоду',
            objection_added: 'Вашу незгоду записано',
            objections_title: 'Незгода',
            no_objections: 'Поки що ніхто не висловив незгоду',
            objections_needed: 'Потрібно ще {count} учасників для скасування',
            auto_rejected: 'автоматично скасовано',
            freeze_rejected: 'Виключення скасовано',
            freeze_auto_rejected: 'Виключення скасовано: учасники заперечили',
            frozen_badge: 'поза підрахунком',
            frozen_abbr: 'поза',
            frozen_cannot_vote: 'Вас виключено з підрахунку. Натисніть «Я тут», щоб повернутися й голосувати.',
            excluded_self_text: 'Вас виключено з підрахунку голосів цієї групи. Якщо ви берете участь — поверніть себе одним дотиком.',
            im_here_btn: 'Я тут',
            im_here_done: 'Готово — вас повернуто до підрахунку',
            member_restored_done: 'Учасника повернуто до підрахунку',
            restore_member_menu: 'Повернути до підрахунку',
            protocol_btn: 'Протокол',
            protocol_print: 'Друк / Зберегти PDF',
            protocol_close: 'Закрити',
            protocol_heading: 'Протокол голосування',
            protocol_subtitle: 'онлайн-голосування спільноти',
            protocol_group: 'Спільнота',
            protocol_initiator: 'Ініціатор',
            protocol_period: 'Період голосування',
            protocol_quorum: 'Кворум та участь',
            protocol_voters: 'Голосуючих',
            protocol_voted: 'Проголосувало',
            protocol_turnout: 'Явка',
            protocol_results: 'Результати',
            protocol_decision_accepted: 'Рішення прийнято',
            protocol_decision_rejected: 'Рішення відхилено',
            protocol_rule: 'Потрібно більше половини голосуючих',
            protocol_namewise: 'Поіменний список голосів',
            protocol_secret_note: 'Таємне голосування — поіменний список не розкривається.',
            protocol_no_votes: 'Голосів не подано',
            protocol_col_apt: 'Кв.',
            protocol_col_voter: 'Співвласник',
            protocol_col_vote: 'Голос',
            protocol_col_time: 'Час',
            instr_protocol_title: 'Протокол голосування (друк / PDF)',
            instr_protocol_desc: 'Будь-який учасник може роздрукувати протокол завершеного голосування. Відкрийте голосування → «Протокол» → «Друк / Зберегти PDF». У протоколі: питання, тип, період, кворум і явка, результат із підрахунком «За/Проти/Утрималися», поіменний список голосів (для відкритого голосування) та місце для підписів. Для таємного — лише підсумкові цифри, без імен.',
            duration: 'Тривалість',
            hour: 'година',
            hours: 'години',
            days: 'дні',
            materials_link: 'Посилання на матеріали',
            link_placeholder: 'Google Drive, Dropbox...',
            admin: 'Адмін',
            member: 'Учасник',
            members: 'учасників',
            votings: 'голосувань',
            empty_groups: 'Ви ще не приєдналися до жодної групи',
            empty_groups_hint: 'Створіть свою групу або приєднайтеся за 6-значним кодом, який вам надішле адміністратор.',
            group_not_found: 'Групу не знайдено',
            already_requested: 'Запит вже надіслано',
            join_request_sent: 'Запит на приєднання надіслано',
            already_member: 'Ви вже є учасником цієї групи',
            enter_group_id_error: 'Введіть коректний ID групи (6 цифр)',
            empty_votings: 'Поки що немає голосувань',
            empty_votings_hint: 'Тут з\'являться голосування з ваших груп. Створіть перше — натисніть «+» вгорі.',
            empty_notifications: 'Сповіщень немає',
            empty_notifications_hint: 'Коли в ваших групах з\'являться нові події — побачите їх тут.',
            select_group: 'Виберіть групу',
            secret_voting: 'Тайне',
            open_voting: 'Відкрите',
            completed: 'Завершено',
            days: 'дн.',
            hours: 'год.',
            yes: 'За',
            no: 'Проти',
            participation: 'участі',
            instructions_title: 'Як користуватися Spilka',
            instr_quick_start: 'Швидкий старт',
            instr_qs_step1: '1. <strong>Зареєструйтесь</strong> через email і пароль (або увійдіть, якщо акаунт уже є). Якщо забули пароль — натисніть «Забули пароль?» на екрані входу, на пошту прийде посилання для скидання.',
            instr_qs_step2: '2. <strong>Заповніть профіль</strong> — вкажіть ім\'я, прізвище, телефон та номер квартири/ділянки (обов\'язково для голосування)',
            instr_qs_step3: '3. <strong>Створіть групу</strong> або <strong>приєднайтесь</strong> до існуючої за 6-значним кодом (вкажіть квартиру і роль)',
            instr_qs_step4: '4. <strong>Голосуйте</strong> у активних голосуваннях або створюйте власні',
            instr_qs_step5: '5. Слідкуйте за результатами у вкладці <strong>Сповіщення</strong>',
            instr_profile: 'Профіль',
            instr_profile_setup_title: 'Налаштування профілю',
            instr_profile_setup_desc: 'Після входу заповніть обов\'язкові поля: ім\'я, прізвище, телефон, адресу та номер квартири/ділянки. Без номера квартири ви не зможете голосувати.',
            instr_profile_edit_title: 'Редагування профілю',
            instr_profile_edit_desc: 'Відкрийте вкладку «Профіль» → натисніть «Редагувати профіль». Можна змінити будь-яке поле в будь-який час.',
            instr_profile_lang_title: 'Зміна мови',
            instr_profile_lang_desc: 'У вкладці «Профіль» виберіть мову: українська, English або русский. Вибір зберігається автоматично.',
            instr_group_mgmt: 'Групи',
            instr_create_group_title: 'Створення групи',
            instr_create_group_desc: 'Натисніть «+» у вкладці «Групи». Вкажіть назву та опис. Система створить унікальний 6-значний код. Ви автоматично станете адміністратором.',
            instr_join_group_title: 'Вступ до групи',
            instr_join_group_desc: 'У вкладці «Групи» розгорніть «Вступити до групи». Введіть 6-значний код, номер своєї квартири/офісу/будинку та оберіть роль (голосуючий чи спостерігач). Натисніть «Приєднатися» — адміністратор отримає запит і має його схвалити або відхилити.',
            instr_group_detail_title: 'Сторінка групи',
            instr_group_detail_desc: 'Натисніть на групу, щоб побачити: код групи (можна скопіювати), статистику, список учасників, запити на вступ та історію змін.',
            instr_members_title: 'Учасники групи',
            instr_members_desc: 'У списку учасників можна: шукати за ім\'ям або телефоном, сортувати за алфавітом або за участю в голосуваннях. Заморожені учасники позначені ❄️.',
            instr_requests_title: 'Запити на вступ',
            instr_requests_desc: 'Адміністратор бачить вхідні запити та може схвалити або відхилити кожного кандидата. Учаснику надійде сповіщення про рішення.',
            instr_voting_types: 'Типи голосування',
            instr_simple_title: 'Звичайне (відкрите)',
            instr_simple_desc: 'Хто створює: будь-який учасник групи (звичайні учасники — не більше 1 голосування на добу). Як працює: кожен обирає «За», «Проти» або «Утримуюсь», ім\'я та коментар (до 500 символів) видно всім. Тривалість: від 1 години до 5 днів — задає автор. Прийнято, якщо «За» проголосувало більше половини всіх учасників групи (для 10 — потрібно 6 «За»). Якщо час вийшов і «За» менше — відхилено. Підходить для: ремонт, витрати, правила.',
            instr_secret_title: 'Тайне',
            instr_secret_desc: 'Так само як звичайне, але всі імена приховані: видно лише підсумкові цифри «За / Проти / Утримуюсь». Коментарі недоступні. Умови прийняття ті самі — більше половини всіх учасників групи мають проголосувати «За». Підходить для чутливих питань (особисті конфлікти, фінансова прозорість).',
            instr_admin_title: 'Зміна адміністратора',
            instr_admin_desc: 'Хто створює: будь-який учасник. Кого можна обрати: будь-якого не-адмін учасника зі списку. Вимоги: у групі має бути мінімум 3 учасники. Тривалість фіксована: 72 години (3 доби). Прийнято, якщо «За» проголосувало більше половини всіх учасників групи. При успіху ролі змінюються автоматично: попередній адмін стає звичайним учасником, обраний — адміністратором. У групі може бути лише одне таке голосування одночасно.',
            instr_remove_title: 'Видалення учасника',
            instr_remove_desc: 'Хто створює: будь-який учасник. Обов\'язково: вказати причину (4 готові варіанти або довільний текст). Вимоги: мінімум 3 учасники в групі. Тривалість фіксована: 72 години. Прийнято, якщо «За» проголосувало більше половини всіх учасників групи. При успіху учасник автоматично видаляється з групи і отримує сповіщення з причиною.',
            instr_freeze_title: 'Виключення з підрахунку',
            instr_freeze_desc: 'Навіщо: щоб «мертві душі» (квартиру продано, людина виїхала чи зовсім не бере участі) не псували підрахунок — їх можна тимчасово прибрати зі знаменника, щоб відсоток участі та кворум відповідали реальності. Хто пропонує: лише адміністратор. Заперечення: 5 днів — будь-які 2 учасники, що натиснуть «Не згоден», скасовують виключення (звичайних голосів «За/Проти» тут немає). Якщо сам учасник заперечить — виключення скасовується одразу (це доказ, що він на місці). Повернення: виключений учасник будь-коли повертає себе кнопкою «Я тут»; адміністратор теж може повернути його вручну. Коли в ту саму квартиру вступає новий власник — виключеного «привида» система прибирає автоматично. Запобіжник: не можна виключити стількох, щоб активних залишилось менше двох.',
            instr_delete_group_title: 'Видалення групи',
            instr_delete_group_desc: 'Хто створює: будь-який учасник (адміністратор зобов\'язаний використати саме це голосування, якщо в групі більше 1 учасника). Тривалість: мінімум 24 години — задає автор. Прийнято, якщо «За» проголосувало більше половини всіх учасників. При успіху група, всі її голосування та історія видаляються безповоротно, всі учасники отримують сповіщення. У групі може бути лише одне таке голосування одночасно.',
            instr_leave_group_title: 'Вихід із групи',
            instr_leave_group_desc: 'Будь-який учасник (крім адміністратора) може покинути групу через меню (⋮). Адміністратор повинен спочатку передати свою роль через голосування «Зміна адміністратора».',
            instr_delete_group_admin_title: 'Видалення групи (адмін)',
            instr_delete_group_admin_desc: 'Адміністратор може видалити групу напряму тільки якщо він єдиний учасник. Якщо в групі 2+ учасників — потрібно створити голосування «Видалення групи».',
            instr_duration_4: '• Видалення групи: від 24 годин',
            instr_how_to_vote: 'Як голосувати',
            instr_cast_vote_title: 'Процес голосування',
            instr_cast_vote_desc: 'Відкрийте активне голосування → оберіть «За», «Проти» або «Утримуюсь» → за бажанням додайте коментар (до 500 символів) → голос зараховано.',
            instr_create_vote_title: 'Створення голосування',
            instr_create_vote_desc: 'Натисніть «+» у вкладці «Голосування». Заповніть: назву, опис, тип, групу, тривалість. Можна додати посилання на матеріали. Звичайні учасники можуть створити 1 голосування на день у кожній групі.',
            instr_delete_vote_title: 'Видалення голосування',
            instr_delete_vote_desc: 'Автор голосування може його видалити, вказавши причину (мін. 5 символів). Видалене голосування позначається відповідно.',
            instr_comments_title: 'Коментарі',
            instr_comments_desc: 'До відкритих голосувань можна додати коментар при голосуванні (до 500 символів). У тайних голосуваннях коментарі приховані.',
            instr_notifications: 'Сповіщення',
            instr_notif_desc: 'Ви отримуєте сповіщення про: нові голосування, запити на вступ, результати голосувань, зміни адміністратора, видалення та заморозку учасників. Непрочитані позначені синім. Можна позначити все як прочитане.',
            instr_badges: 'Позначення та статуси',
            instr_badge_yellow: 'Активне голосування (ще триває)',
            instr_badge_green: 'Прийнято (50%+1 проголосували «За»)',
            instr_badge_red: 'Відхилено (більшість проголосувала «Проти» або недостатньо голосів)',
            instr_badge_blue: 'Тайне голосування (імена голосуючих приховані)',
            instr_badge_frozen: 'Учасник поза підрахунком голосів',
            instr_badge_admin: 'Адміністратор групи',
            instr_rules: 'Правила та терміни',
            instr_duration_title: 'Тривалість',
            instr_duration_1: '• Звичайні/тайні голосування: від 1 години до 5 днів',
            instr_duration_2: '• Зміна адміна / Видалення учасника: фіксовано 72 години',
            instr_duration_3: '• Виключення з підрахунку: 5 днів на заперечення',
            instr_decision_title: 'Прийняття рішень',
            instr_decision_desc: 'Для прийняття рішення потрібно 50%+1 голос від <strong>голосуючих</strong> учасників групи (спостерігачі не враховуються). Результат визначається автоматично по завершенню терміну.',
            instr_limits_title: 'Обмеження',
            instr_limits_desc: '• Без номера квартири/ділянки — голосувати не можна<br>• Звичайний учасник: макс. 1 голосування на день у кожній групі<br>• Адміністратор: без обмежень<br>• Зміна адміна / видалення: мін. 3 учасники в групі',
            instr_export: 'Експорт даних',
            instr_export_desc: 'Адміністратор може завантажити історію голосувань групи у CSV-файл. У файлі: дата, автор, питання, тип, результат, кількість голосів «За/Проти/Утримався», коментарі. Файл відкривається в Excel або Google Sheets.',
            instr_roles: 'Ролі: голосуючий і спостерігач',
            instr_roles_apartment_title: 'Номер квартири = один голос',
            instr_roles_apartment_desc: 'При вступі ви вказуєте номер своєї квартири / офісу / будинку. Правило просте: <strong>одна квартира — один голос</strong>. Голосувати від цієї квартири може лише одна людина (голосуючий), решта мешканців можуть вступити як спостерігачі.',
            instr_roles_voter_title: '👍 Голосуючий',
            instr_roles_voter_desc: 'Повноцінний учасник: бачить голосування, голосує «За/Проти/Утримуюсь», створює власні голосування. Його голос рахується у результаті.',
            instr_roles_observer_title: '👁️ Спостерігач',
            instr_roles_observer_desc: 'Бачить усі голосування та результати, але <strong>не голосує</strong>. Спостерігачі не враховуються при підрахунку (кворум рахується тільки серед голосуючих). Підходить для членів сім\'ї, орендарів чи тих, хто хоче лише стежити.',
            instr_roles_change_title: 'Як змінити свою роль',
            instr_roles_change_desc: 'Відкрийте вкладку «Профіль» → у списку «Мої ролі в групах» натисніть «Запросити зміну ролі» біля потрібної групи. Запит піде адміністратору на підтвердження. Якщо у вашій квартирі вже є голосуючий — стати голосуючим не вийде, поки місце зайняте.',
            instr_roles_admin_title: 'Зміна ролі адміністратором',
            instr_roles_admin_desc: 'Адміністратор може сам змінити роль учасника: на сторінці групи у списку учасників натисніть кнопку зміни ролі (↔) біля потрібної людини.',
            instr_notif_archive_title: 'Архів сповіщень',
            instr_notif_archive_desc: 'Кнопка «В архів» ховає всі поточні сповіщення зі списку (вони не видаляються, а зберігаються). Щоб переглянути їх, натисніть значок архіву (вгорі на вкладці «Сповіщення»). В архіві є пошук від 3 літер, а кнопка повернення (↩) повертає сповіщення назад до основного списку.',
            instr_profile_password_title: 'Зміна пароля',
            instr_profile_password_desc: 'У вкладці «Профіль» натисніть «Змінити пароль». Введіть новий пароль двічі — і він одразу почне діяти.',
            instr_profile_theme_title: 'Тема оформлення',
            instr_profile_theme_desc: 'Кнопка «Тема» у профілі перемикає вигляд: світла, темна або системна (автоматично за налаштуваннями телефону). Вибір зберігається.',
            instr_profile_install_title: 'Встановити на телефон',
            instr_profile_install_desc: 'Якщо з\'явилася кнопка «Встановити на головний екран» — натисніть її, і Spilka додасться як застосунок (окрема іконка, працює як звичайна програма, без браузера).',
            instr_profile_feedback_title: 'Пропозиція або зауваження',
            instr_profile_feedback_desc: 'Кнопка «Пропозиція / зауваження» у профілі дозволяє надіслати нам ідею або повідомити про проблему. Ми читаємо всі повідомлення.',
            fill_name_error: "Будь ласка, заповніть ім'я та прізвище",
            profile_saved: 'Профіль оновлено!',
            notif_new_voting: 'Нове голосування у групі',
            notif_join_request: 'хоче приєднатися до групи',
            notif_voting_completed: 'Голосування завершено',
            notif_accepted: 'ПРИЙНЯТО',
            notif_rejected: 'ВІДХИЛЕНО',
            notif_welcome_admin: 'Вітаємо! Ви стали адміністратором групи',
            hours_ago: 'годин тому',
            days_ago: 'днів тому',
            day_ago: 'день тому',
            just_now: 'Щойно',
            participation_label: 'Участь',
            already_voted: 'Ви вже проголосували',
            joined_after_vote: 'Ви приєдналися після початку цього голосування і не входите до його складу',
            vote_against: 'Проти',
            vote_for: 'За',
            admin_full: 'Адміністратор',
            no_requests: 'Немає запитів',
            join_requests: 'Запити на вступ',
            target_member: 'Учасник',
            select_member: 'Виберіть учасника',
            select_duration: 'Оберіть тривалість голосування',
            removal_reason: 'Причина видалення',
            select_reason: 'Виберіть причину',
            reason_dues: 'Не платить внески',
            reason_rules: 'Порушує правила',
            reason_sold: 'Продав квартиру/приміщення',
            reason_other: 'Інше',
            reason_details: 'Детальний опис причини...',
            target_admin_candidate: 'Кандидат на посаду адміністратора',
            target_member_remove: 'Учасник для видалення',
            candidate_profile: 'Профіль кандидата',
            admin_change_success: 'Адміністратора змінено',
            new_admin_is: 'Новий адміністратор',
            you_removed_admin: 'Ви зняті з посади адміністратора групи',
            you_became_admin: 'Ви стали адміністратором групи',
            member_removed: 'Учасника видалено',
            removed_from_group: 'Вас видалено з групи',
            removal_reason_label: 'Причина',
            auto_fixed_duration: 'Тривалість фіксована для цього типу голосування',
            min_3_members_required: 'Потрібно мінімум 3 учасники в групі',
            history: 'Історія змін',
            history_admin_change: 'Зміна адміністратора',
            history_member_removed: 'Видалення учасника',
            history_date: 'Дата',
            history_action: 'Дія',
            history_initiator: 'Ініціатор',
            history_result: 'Результат',
            cant_remove_admin: 'Не можна видалити адміністратора',
            one_admin_change_at_time: 'Одночасно може бути тільки одне голосування про зміну адміністратора',
            author: 'Автор',
            opened: 'триває',
            result_accepted: 'Прийнято',
            result_rejected: 'Відхилено',
            abstain_short: 'Утр',
            unknown_author: 'Невідомий',
            delete_voting_title: 'Видалити голосування',
            delete_voting_warning: '⚠️ Голосування буде видалено безповоротно. Всі учасники отримають повідомлення.',
            delete_reason: 'Причина видалення',
            delete_reason_placeholder: 'Вкажіть причину (мінімум 5 символів)...',
            delete: 'Видалити',
            voting_deleted: 'Голосування видалено',
            voting_deleted_by: 'Голосування видалено автором',
            reason_label: 'Причина',
            cannot_delete_completed: 'Не можна видалити завершене голосування',
            delete_reason_short: 'Причина має бути не менше 5 символів',
            delete_reason_long: 'Причина занадто довга (макс. 200 символів)',
            export_nothing: 'Немає голосувань для експорту',
            reply_too_short: 'Напишіть відповідь',
            daily_limit_reached: 'Ви досягли ліміту: 1 голосування на 24 години для звичайних користувачів',
            abstain: 'Утриматися',
            comment: 'Коментар',
            comment_placeholder: 'Ваш коментар (необов\'язково, макс. 500 символів)...',
            comments: 'Коментарі',
            comment_count: 'символів',
            vote_yes: 'За',
            vote_no: 'Проти',
            vote_abstain: 'Утримався',
            your_comment: 'Ваш коментар',
            no_comments: 'Коментарів ще немає',
            terms_title: 'Умови використання',
            terms_intro: 'Для забезпечення повної прозорості та демократії в групі, всі учасники мають право:',
            terms_item1: 'Брати участь у голосуваннях після вказання номера квартири/ділянки',
            terms_item2: 'Експортувати повну історію голосувань групи в форматі CSV',
            terms_item3: 'Перевіряти результати голосувань на достовірність',
            terms_item4: 'Коментувати свої голоси (якщо це не таємне голосування)',
            terms_export_notice: 'Важливо: Ви розумієте, що будь-який учасник групи може завантажити історію голосувань, де буде видно номер вашої квартири/ділянки та ваші голоси.',
            terms_agree_text: 'Я ознайомлений(а) з умовами та погоджуюсь з ними',
            accept: 'Погодитись та продовжити',
            apartment_required: 'Вкажіть номер квартири або ділянки для участі в голосуваннях',
            apartment_required_title: 'Необхідно заповнити адресу',
            export_csv: 'Експорт історії (CSV)',
            export_date: 'Дата створення',
            export_author: 'Автор',
            export_question: 'Питання',
            export_type: 'Тип',
            export_result: 'Результат',
            export_yes: 'За',
            export_no: 'Проти',
            export_abstain: 'Утримались',
            export_comments: 'Коментарі',
            export_unit: 'Квартира/Ділянка',
            export_votes: 'Голоси',
            search_members: 'Пошук за ПІБ або телефоном...',
            participation_count: 'Участь',
            sort_by_name: 'Сортувати за іменем',
            sort_by_participation: 'Сортувати за участю',
            total_votings: 'всього',
            accepted_short: 'прийн.',
            active_short: 'актив.',
            rejected_short: 'відх.',
            no_members_found: 'Учасників не знайдено',
            stats_accepted: 'прийнято',
            stats_rejected: 'відхилено',
            stats_active: 'в процесі',
            // Auth
            auth_subtitle: 'Голосування для спільнот',
            auth_email_placeholder: 'Email',
            auth_password_placeholder: 'Пароль',
            auth_login_btn: 'Увійти',
            auth_register_btn: 'Зареєструватися',
            auth_forgot_password: 'Забули пароль?',
            auth_or_divider: 'або',
            auth_google_btn: 'Увійти через Google',
            auth_hint: 'Автоматична реєстрація при першому вході',
            auth_error_invalid: 'Невірний email або пароль',
            auth_error_exists: 'Цей email вже зареєстрований',
            auth_error_invalid_email: 'Введіть коректну email-адресу',
            auth_error_network: 'Помилка мережі. Спробуйте пізніше.',
            auth_error_fill_fields: 'Заповніть email та пароль',
            auth_error_password_short: 'Пароль має бути не менше 8 символів',
            auth_error_not_confirmed: 'Підтвердіть email перш ніж увійти',
            auth_error_enter_email: 'Введіть email для відновлення пароля',
            auth_check_email: 'Перевірте пошту для підтвердження реєстрації',
            auth_reset_sent: 'Лист для відновлення пароля надіслано на вашу пошту',
            group_menu: 'Меню групи',
            edit_group: 'Редагувати групу',
            delete_group: 'Видалити групу',
            delete_group_confirm: 'Ви впевнені, що хочете видалити цю групу? Всі голосування та історія будуть втрачені. Цю дію не можна скасувати.',
            group_name_required: 'Введіть назву групи',
            group_updated: 'Групу оновлено',
            group_deleted: 'Групу видалено',
            leave_group: 'Покинути групу',
            leave_group_confirm: 'Ви впевнені, що хочете покинути цю групу? Ви втратите доступ до голосувань та історії групи.',
            leave_group_success: 'Ви покинули групу',
            leave: 'Покинути',
            admin_cannot_leave: 'Адміністратор не може покинути групу. Спочатку передайте роль адміністратора іншому учаснику.',
            delete_group_need_voting: 'У групі є інші учасники. Для видалення групи створіть голосування типу «Видалення групи».',
            type_delete_group: 'Видалення групи',
            group_deleted_by_voting: 'Групу видалено за результатами голосування',
            delete_group_warning: 'Якщо голосування буде прийнято — групу буде видалено автоматично разом з усіма голосуваннями та історією.',
            one_delete_group_at_time: 'Вже існує активне голосування за видалення цієї групи.',
            min_duration_24h: 'Мінімальна тривалість для цього типу голосування — 24 години.',
            // Phase 14: voter/observer roles
            apartment_label: 'Квартира',
            role_voter: 'Голосуючий',
            role_observer: 'Спостерігач',
            join_role_required: 'Оберіть роль',
            join_apartment_required: 'Введіть номер квартири',
            apartment_taken: 'Квартира зайнята голосуючим',
            apartment_taken_hint: 'Оберіть роль "спостерігач" або введіть іншу квартиру.',
            error_generic: 'Сталася помилка. Спробуйте ще раз.',
            err_not_admin: 'Цю дію може виконати лише адміністратор групи',
            err_request_not_found: 'Заявку не знайдено — можливо, її вже розглянуто',
            err_exclusion_only_via_voting: 'Виключення можливе лише через голосування',
            not_member: 'Ви не учасник цієї групи',
            group_id_label: 'ID групи:',
            copy_btn: 'Копіювати',
            members_header: 'Учасники',
            observer_cannot_vote: 'Спостерігачі не можуть голосувати',
            observer_notice: 'Ви — спостерігач. Голосування для вас недоступне.',
            apartment_taken_now_confirm: 'Квартира вже зайнята. Затвердити як спостерігача?',
            request_role_change_btn: 'Запросити зміну ролі',
            change_role_menu: 'Змінити роль',
            role_changed: 'Роль змінено',
            role_change_requested: 'Запит на зміну ролі надіслано',
            already_in_role: 'Ви вже маєте цю роль',
            admin_cannot_be_observer: 'Адміністратор не може бути спостерігачем',
            role_change_badge: 'зміна ролі',
            my_roles_in_groups: 'Мої ролі в групах',
            join_group_btn: 'Приєднатися',
            join_group_section_title: 'Вступити до групи',
            join_id_label: 'ID групи',
            join_id_ph: '6 цифр, напр. 123456',
            join_apartment_label_full: 'Номер вашої квартири / офісу / будинку',
            join_apartment_ph: 'напр. 12 або 12А',
            join_apartment_hint: 'Одна квартира — один голос.',
            join_role_label: 'Ваша роль'
        },
        en: {
            profile: 'Profile',
            edit_profile: 'Edit Profile',
            instructions: 'Instructions',
            instructions_title: 'User Instructions',
            logout: 'Logout',
            not_your_account: 'Not your account? Log out',
            load_failed: 'Could not load. Pull down to refresh.',
            theme: 'Theme',
            theme_auto: 'System',
            theme_light: 'Light',
            theme_dark: 'Dark',
            install_app: 'Install on home screen',
            install_thanks: 'Thanks! Spilka is now on your home screen.',
            install_already: 'App is already installed',
            install_ios_hint: 'On iPhone/iPad: tap "Share" (square with arrow) and choose "Add to Home Screen".',
            install_not_ready: 'Install option is not available right now. Make sure you opened the page via HTTPS and try again.',
            install_dismissed: 'Cancelled — you can install later from this screen.',
            auth_register_link: 'Sign up',
            register_title: 'Sign up',
            register_subtitle: 'Create an account to vote',
            register_password_placeholder: 'Password (min. 8 chars)',
            register_submit_btn: 'Create account',
            register_google_btn: 'Sign up with Google',
            register_have_account: 'Already have an account?',
            forgot_title: 'Reset password',
            forgot_subtitle: 'Enter your email — we\'ll send a reset link',
            forgot_submit_btn: 'Send reset link',
            forgot_remembered: 'Remembered your password?',
            reset_title: 'New password',
            reset_subtitle: 'Enter a new password for your account',
            reset_pass1_placeholder: 'New password (min. 8 chars)',
            reset_pass2_placeholder: 'Repeat the new password',
            reset_submit_btn: 'Save new password',
            reset_mismatch: 'Passwords do not match',
            reset_done: 'Password updated',
            change_password: 'Change password',
            feedback_btn: 'Suggestion / report',
            feedback_title: 'Suggestion or report',
            feedback_hint: 'Tell us what works well or what to improve. We read every message.',
            feedback_placeholder: 'Your suggestion or report...',
            feedback_send: 'Send',
            feedback_thanks: 'Thanks! We\'ve received your feedback and will review it soon.',
            feedback_too_short: 'Please add more details (min. 5 chars)',
            admin_panel: 'Admin panel',
            admin_tab_users: 'Users',
            admin_tab_groups: 'Groups',
            admin_tab_feedback: 'Feedback',
            loading: 'Loading…',
            request_approved: 'Request approved',
            request_rejected: 'Request rejected',
            approve: 'Approve',
            reject: 'Reject',
            loader_signing_in: 'Signing you in…',
            refresh_group: 'Refresh data',
            refresh_in_progress: 'Refreshing…',
            refresh_done: 'Data refreshed',
            dev_banner: '⚠️ Site in development — some features may change',
            archive_all: 'Archive',
            archive_confirm_title: 'Archive',
            archive_confirm_msg: 'Move notifications to archive? They stay in history but the list is cleared.',
            archive_empty: 'List is already empty',
            archive_done: 'Moved to archive',
            archive_needs_migration: 'Apply phase12-notif-archive.sql in Supabase SQL Editor first',
            notifications_archive: 'Notification archive',
            archive_search_placeholder: 'Search (3+ characters)...',
            archive_load_more: 'Load more',
            archive_empty_state: 'Archive is empty',
            archive_no_search_results: 'Nothing found',
            unarchive: 'Unarchive',
            unarchive_confirm: 'Return notification to the main list?',
            unarchive_done: 'Returned to the main list',
            cta_complete_profile: 'Fill in "Apartment/office" in your profile to vote',
            members_label: 'Members',
            votings_label: 'Votings',
            confirm_title: 'Confirm',
            confirm_ok: 'Confirm',
            logout_confirm: 'Sign out? You will need to log in again.',
            ptr_pull: 'Pull to refresh',
            ptr_release: 'Release to refresh',
            ptr_loading: 'Refreshing…',
            address: 'Address',
            groups_count: 'Groups',
            firstname: 'First Name',
            lastname: 'Last Name',
            phone: 'Phone',
            apartment: 'Apartment/Office',
            cancel: 'Cancel',
            save: 'Save',
            voting: 'Voting',
            groups: 'Groups',
            notifications: 'Notifications',
            active_votings: 'Active',
            completed_votings: 'Completed',
            enter_group_id: 'Enter group ID (6 digits)',
            join: 'Join',
            mark_all_read: 'Mark all read',
            new_group: 'New Group',
            group_name: 'Group Name',
            group_name_placeholder: 'e.g., Building 61',
            group_description: 'Description (optional)',
            group_desc_placeholder: 'Short group description...',
            group_hint: 'After creation you will receive a unique ID to invite members',
            create: 'Create',
            new_voting: 'New Voting',
            question: 'Question',
            question_placeholder: 'Voting question text',
            description: 'Description',
            description_placeholder: 'Detailed description of the voting...',
            group: 'Group',
            select_group: 'Select group',
            voting_type: 'Voting Type',
            type_simple: 'Standard (yes/no)',
            type_secret: 'Secret voting',
            type_admin: 'Change administrator',
            type_remove: 'Remove member',
            type_freeze: 'Exclude from count',
            freeze_members: 'Who to exclude from the count',
            freeze_info: 'Excludes a member from the vote count (e.g. the flat was sold or the person does not take part). 5 days to object; any 2 members can cancel it.',
            freeze_proposal: 'Proposal to exclude from the count',
            freeze_duration_info: 'You have 5 days to object. If 2 members click "I disagree" the exclusion is cancelled. The member can return themselves any time with "I\'m here".',
            freeze_voting: 'Exclude from count',
            only_admin_can_freeze: 'Only the administrator can propose excluding a member from the count',
            select_freeze_members: 'Select at least one member',
            i_disagree: 'I disagree',
            disagree_info: 'If 2 members disagree the exclusion is cancelled automatically.',
            you_objected: 'You have objected',
            already_objected: 'You have already objected',
            objection_added: 'Your objection has been recorded',
            objections_title: 'Objections',
            no_objections: 'No objections yet',
            objections_needed: 'Need {count} more members to cancel',
            auto_rejected: 'automatically cancelled',
            freeze_rejected: 'Exclusion cancelled',
            freeze_auto_rejected: 'Exclusion cancelled: members objected',
            frozen_badge: 'out of count',
            frozen_abbr: 'out',
            frozen_cannot_vote: 'You are excluded from the count. Tap "I\'m here" to return and vote.',
            excluded_self_text: 'You have been excluded from this group\'s vote count. If you take part, return yourself with one tap.',
            im_here_btn: "I'm here",
            im_here_done: 'Done — you are back in the count',
            member_restored_done: 'Member returned to the count',
            restore_member_menu: 'Return to the count',
            protocol_btn: 'Protocol',
            protocol_print: 'Print / Save PDF',
            protocol_close: 'Close',
            protocol_heading: 'Voting protocol',
            protocol_subtitle: 'community online vote',
            protocol_group: 'Community',
            protocol_initiator: 'Initiator',
            protocol_period: 'Voting period',
            protocol_quorum: 'Quorum and turnout',
            protocol_voters: 'Eligible voters',
            protocol_voted: 'Voted',
            protocol_turnout: 'Turnout',
            protocol_results: 'Results',
            protocol_decision_accepted: 'Decision adopted',
            protocol_decision_rejected: 'Decision rejected',
            protocol_rule: 'Requires more than half of eligible voters',
            protocol_namewise: 'Itemized list of votes',
            protocol_secret_note: 'Secret ballot — the itemized list is not disclosed.',
            protocol_no_votes: 'No votes were cast',
            protocol_col_apt: 'Apt.',
            protocol_col_voter: 'Member',
            protocol_col_vote: 'Vote',
            protocol_col_time: 'Time',
            instr_protocol_title: 'Voting protocol (print / PDF)',
            instr_protocol_desc: 'Any member can print the protocol of a completed voting. Open the voting → "Protocol" → "Print / Save PDF". The protocol contains: question, type, period, quorum and turnout, the result with Yes/No/Abstain tallies, an itemized list of votes (for open voting) and space for signatures. For a secret ballot only the summary figures are shown, without names.',
            duration: 'Duration',
            hour: 'hour',
            hours: 'hours',
            days: 'days',
            materials_link: 'Materials link',
            link_placeholder: 'Google Drive, Dropbox...',
            admin: 'Admin',
            member: 'Member',
            members: 'members',
            votings: 'votings',
            empty_groups: 'You haven\'t joined any groups yet',
            empty_groups_hint: 'Create your own group or join one using the 6-digit code your admin sent you.',
            group_not_found: 'Group not found',
            already_requested: 'Request already sent',
            join_request_sent: 'Join request sent',
            already_member: 'You are already a member of this group',
            enter_group_id_error: 'Enter a valid group ID (6 digits)',
            empty_votings: 'No votings yet',
            empty_votings_hint: 'Votings from your groups will appear here. Tap the "+" button above to create the first one.',
            empty_notifications: 'No notifications',
            empty_notifications_hint: 'When something happens in your groups — you\'ll see it here.',
            select_group: 'Select group',
            secret_voting: 'Secret',
            open_voting: 'Open',
            completed: 'Completed',
            days: 'days',
            hours: 'hours',
            yes: 'Yes',
            no: 'No',
            participation: 'participation',
            instructions_title: 'How to use Spilka',
            instr_quick_start: 'Quick Start',
            instr_qs_step1: '1. <strong>Sign up</strong> with email and password (or sign in if you already have an account). Forgot your password? Tap "Forgot your password?" on the sign-in screen and you\'ll get a reset link by email.',
            instr_qs_step2: '2. <strong>Complete your profile</strong> — enter name, phone, and apartment/plot number (required to vote)',
            instr_qs_step3: '3. <strong>Create a group</strong> or <strong>join</strong> an existing one using the 6-digit code (enter your apartment and role)',
            instr_qs_step4: '4. <strong>Vote</strong> in active votings or create your own',
            instr_qs_step5: '5. Track results in the <strong>Notifications</strong> tab',
            instr_profile: 'Profile',
            instr_profile_setup_title: 'Profile Setup',
            instr_profile_setup_desc: 'After signing in, fill in required fields: name, surname, phone, address, and apartment/plot number. Without an apartment number, you cannot vote.',
            instr_profile_edit_title: 'Edit Profile',
            instr_profile_edit_desc: 'Open the "Profile" tab → tap "Edit Profile". You can change any field at any time.',
            instr_profile_lang_title: 'Change Language',
            instr_profile_lang_desc: 'In the "Profile" tab, select your language: Ukrainian, English, or Russian. Your choice is saved automatically.',
            instr_group_mgmt: 'Groups',
            instr_create_group_title: 'Creating a Group',
            instr_create_group_desc: 'Tap "+" in the "Groups" tab. Enter a name and description. The system will generate a unique 6-digit code. You automatically become the administrator.',
            instr_join_group_title: 'Joining a Group',
            instr_join_group_desc: 'On the "Groups" tab, expand "Join a group". Enter the 6-digit code, your apartment / office / house number and choose a role (voter or observer). Tap "Join" — the administrator will receive a request and must approve or reject it.',
            instr_group_detail_title: 'Group Page',
            instr_group_detail_desc: 'Tap a group to see: group code (can copy), statistics, member list, join requests, and change history.',
            instr_members_title: 'Group Members',
            instr_members_desc: 'In the member list you can: search by name or phone, sort alphabetically or by voting participation. Frozen members are marked with ❄️.',
            instr_requests_title: 'Join Requests',
            instr_requests_desc: 'The administrator sees incoming requests and can approve or reject each candidate. The applicant will be notified of the decision.',
            instr_voting_types: 'Voting Types',
            instr_simple_title: 'Standard (Open)',
            instr_simple_desc: 'Who can create: any group member (regular members — max 1 voting per day). How it works: each person picks "Yes", "No", or "Abstain"; the name and an optional comment (up to 500 chars) are visible to everyone. Duration: 1 hour to 5 days, set by the author. Accepted if more than half of ALL group members voted "Yes" (with 10 members you need 6 yeses). When time runs out, if "Yes" hasn\'t reached this — rejected. Use for: repairs, expenses, rules.',
            instr_secret_title: 'Secret',
            instr_secret_desc: 'Same as Standard, but all voter names are hidden — only the totals "Yes / No / Abstain" are shown. No comments. The acceptance rule is identical: more than half of all group members must vote "Yes". Use for sensitive topics (personal disputes, financial accountability).',
            instr_admin_title: 'Change Administrator',
            instr_admin_desc: 'Who can create: any member. Who can be elected: any non-admin member from the list. Requirements: at least 3 members in the group. Duration is fixed at 72 hours (3 days). Accepted if more than half of ALL members vote "Yes". On success roles are swapped automatically: the previous admin becomes a regular member and the elected member becomes admin. Only one such voting can run at a time per group.',
            instr_remove_title: 'Remove Member',
            instr_remove_desc: 'Who can create: any member. Required: a reason (4 preset options or free text). Requirements: at least 3 members. Duration fixed at 72 hours. Accepted if more than half of ALL members vote "Yes". On success the member is removed from the group automatically and notified with the reason.',
            instr_freeze_title: 'Exclude from the count',
            instr_freeze_desc: 'Why: so "ghost" members (flat sold, person moved out or never takes part) don\'t distort the math — they can be removed from the denominator so participation and quorum reflect reality. Who proposes: only the administrator. Objection: 5 days — any 2 members who click "I disagree" cancel the exclusion (there are no normal Yes/No votes here). If the targeted member objects themselves, it is cancelled at once (proof they are present). Return: an excluded member returns themselves any time with "I\'m here"; the admin can also restore them manually. When a new owner joins the same flat, the excluded "ghost" is removed automatically. Safeguard: you cannot exclude so many that fewer than two active members remain.',
            instr_delete_group_title: 'Delete Group',
            instr_delete_group_desc: 'Who can create: any member (the administrator must use this if the group has more than 1 member). Duration: at least 24 hours, set by the author. Accepted if more than half of ALL members vote "Yes". On success the group, its votings, and history are deleted permanently and every member is notified. Only one such voting can run at a time per group.',
            instr_leave_group_title: 'Leave Group',
            instr_leave_group_desc: 'Any member (except the administrator) can leave the group via the menu (⋮). The administrator must first transfer their role through a "Change Administrator" voting.',
            instr_delete_group_admin_title: 'Delete Group (Admin)',
            instr_delete_group_admin_desc: 'The administrator can delete the group directly only if they are the only member. If there are 2+ members — a "Delete Group" voting must be created.',
            instr_duration_4: '• Group deletion: from 24 hours',
            instr_how_to_vote: 'How to Vote',
            instr_cast_vote_title: 'Voting Process',
            instr_cast_vote_desc: 'Open an active voting → choose "Yes", "No", or "Abstain" → optionally add a comment (up to 500 characters) → your vote is recorded.',
            instr_create_vote_title: 'Creating a Voting',
            instr_create_vote_desc: 'Tap "+" in the "Votings" tab. Fill in: title, description, type, group, duration. You can attach a link to materials. Regular members can create 1 voting per day per group.',
            instr_delete_vote_title: 'Deleting a Voting',
            instr_delete_vote_desc: 'The voting author can delete it by providing a reason (min. 5 characters). Deleted votings are marked accordingly.',
            instr_comments_title: 'Comments',
            instr_comments_desc: 'You can add a comment when voting in open votings (up to 500 characters). In secret votings, comments are hidden.',
            instr_notifications: 'Notifications',
            instr_notif_desc: 'You receive notifications about: new votings, join requests, voting results, admin changes, member removal, and freezing. Unread ones are marked blue. You can mark all as read.',
            instr_badges: 'Badges & Statuses',
            instr_badge_yellow: 'Active voting (still in progress)',
            instr_badge_green: 'Accepted (50%+1 voted "Yes")',
            instr_badge_red: 'Rejected (majority voted "No" or insufficient votes)',
            instr_badge_blue: 'Secret voting (voter names are hidden)',
            instr_badge_frozen: 'Member excluded from the vote count',
            instr_badge_admin: 'Group administrator',
            instr_rules: 'Rules & Timeframes',
            instr_duration_title: 'Duration',
            instr_duration_1: '• Standard/secret votings: 1 hour to 5 days',
            instr_duration_2: '• Change admin / Remove member: fixed 72 hours',
            instr_duration_3: '• Exclude from the count: 5 days to object',
            instr_decision_title: 'Decision Making',
            instr_decision_desc: 'A 50%+1 vote from the group\'s <strong>voters</strong> is required for any decision (observers are not counted). Results are determined automatically when the time expires.',
            instr_limits_title: 'Limits',
            instr_limits_desc: '• Without apartment/plot number — you cannot vote<br>• Regular member: max 1 voting per day per group<br>• Administrator: no limits<br>• Change admin / removal: min. 3 members in group',
            instr_export: 'Data Export',
            instr_export_desc: 'The administrator can download the group\'s voting history as a CSV file. Contents: date, author, question, type, result, vote counts (Yes/No/Abstain), comments. Opens in Excel or Google Sheets.',
            instr_roles: 'Roles: voter and observer',
            instr_roles_apartment_title: 'One apartment = one vote',
            instr_roles_apartment_desc: 'When joining you enter your apartment / office / house number. The rule is simple: <strong>one apartment — one vote</strong>. Only one person per apartment can vote (the voter); other residents can join as observers.',
            instr_roles_voter_title: '👍 Voter',
            instr_roles_voter_desc: 'A full member: sees votings, casts "Yes/No/Abstain", creates their own votings. Their vote counts toward the result.',
            instr_roles_observer_title: '👁️ Observer',
            instr_roles_observer_desc: 'Sees all votings and results but <strong>does not vote</strong>. Observers are not counted (quorum is calculated among voters only). Good for family members, tenants, or anyone who just wants to follow along.',
            instr_roles_change_title: 'How to change your role',
            instr_roles_change_desc: 'Open the "Profile" tab → in "My roles in groups" tap "Request role change" next to the group. The request goes to the administrator for approval. If your apartment already has a voter, you can\'t become a voter until that seat is free.',
            instr_roles_admin_title: 'Role change by the administrator',
            instr_roles_admin_desc: 'The administrator can change a member\'s role directly: on the group page, in the members list, tap the change-role button (↔) next to the person.',
            instr_notif_archive_title: 'Notification archive',
            instr_notif_archive_desc: 'The "Archive" button hides all current notifications from the list (they are kept, not deleted). To view them, tap the archive icon (top of the "Notifications" tab). The archive has search from 3 letters, and the return button (↩) sends a notification back to the main list.',
            instr_profile_password_title: 'Change password',
            instr_profile_password_desc: 'On the "Profile" tab tap "Change password". Enter the new password twice — it takes effect immediately.',
            instr_profile_theme_title: 'Appearance theme',
            instr_profile_theme_desc: 'The "Theme" button in the profile switches the look: light, dark, or system (automatically following your phone settings). The choice is saved.',
            instr_profile_install_title: 'Install on your phone',
            instr_profile_install_desc: 'If an "Add to home screen" button appears — tap it, and Spilka will be added as an app (its own icon, works like a regular app, without the browser).',
            instr_profile_feedback_title: 'Suggestion or feedback',
            instr_profile_feedback_desc: 'The "Suggestion / feedback" button in the profile lets you send us an idea or report a problem. We read every message.',
            fill_name_error: 'Please enter your first and last name',
            profile_saved: 'Profile updated!',
            notif_new_voting: 'New voting in group',
            notif_join_request: 'wants to join group',
            notif_voting_completed: 'Voting completed',
            notif_accepted: 'ACCEPTED',
            notif_rejected: 'REJECTED',
            notif_welcome_admin: 'Congratulations! You are now admin of group',
            hours_ago: 'hours ago',
            days_ago: 'days ago',
            day_ago: 'day ago',
            just_now: 'Just now',
            participation_label: 'Participation',
            already_voted: 'You have already voted',
            joined_after_vote: 'You joined after this voting had started and are not part of it',
            vote_against: 'No',
            vote_for: 'Yes',
            admin_full: 'Administrator',
            no_requests: 'No requests',
            join_requests: 'Join requests',
            target_member: 'Member',
            select_member: 'Select member',
            select_duration: 'Choose a voting duration',
            removal_reason: 'Reason for removal',
            select_reason: 'Select reason',
            reason_dues: 'Not paying dues',
            reason_rules: 'Violating rules',
            reason_sold: 'Sold apartment/property',
            reason_other: 'Other',
            reason_details: 'Detailed reason description...',
            target_admin_candidate: 'Administrator candidate',
            target_member_remove: 'Member to remove',
            candidate_profile: 'Candidate profile',
            admin_change_success: 'Administrator changed',
            new_admin_is: 'New administrator',
            you_removed_admin: 'You have been removed as group administrator',
            you_became_admin: 'You became group administrator',
            member_removed: 'Member removed',
            removed_from_group: 'You have been removed from group',
            removal_reason_label: 'Reason',
            auto_fixed_duration: 'Duration is fixed for this voting type',
            min_3_members_required: 'Minimum 3 members required in group',
            history: 'Change history',
            history_admin_change: 'Administrator change',
            history_member_removed: 'Member removal',
            history_date: 'Date',
            history_action: 'Action',
            history_initiator: 'Initiator',
            history_result: 'Result',
            cant_remove_admin: 'Cannot remove administrator',
            one_admin_change_at_time: 'Only one administrator change voting can be active at a time',
            author: 'Author',
            opened: 'ongoing',
            result_accepted: 'Accepted',
            result_rejected: 'Rejected',
            abstain_short: 'Abs',
            unknown_author: 'Unknown',
            delete_voting_title: 'Delete Voting',
            delete_voting_warning: '⚠️ Voting will be permanently deleted. All members will be notified.',
            delete_reason: 'Reason for deletion',
            delete_reason_placeholder: 'Enter reason (minimum 5 characters)...',
            delete: 'Delete',
            voting_deleted: 'Voting deleted',
            voting_deleted_by: 'Voting deleted by author',
            reason_label: 'Reason',
            cannot_delete_completed: 'Cannot delete completed voting',
            delete_reason_short: 'Reason must be at least 5 characters',
            delete_reason_long: 'Reason is too long (max 200 characters)',
            export_nothing: 'No votings to export',
            reply_too_short: 'Please write a reply',
            daily_limit_reached: 'You have reached the limit: 1 voting per 24 hours for regular users',
            abstain: 'Abstain',
            comment: 'Comment',
            comment_placeholder: 'Your comment (optional, max 500 chars)...',
            comments: 'Comments',
            comment_count: 'characters',
            vote_yes: 'Yes',
            vote_no: 'No',
            vote_abstain: 'Abstained',
            your_comment: 'Your comment',
            no_comments: 'No comments yet',
            terms_title: 'Terms of Service',
            terms_intro: 'To ensure full transparency and democracy in the group, all members have the right to:',
            terms_item1: 'Participate in voting after providing apartment/plot number',
            terms_item2: 'Export complete voting history of the group in CSV format',
            terms_item3: 'Verify voting results for authenticity',
            terms_item4: 'Comment on their votes (if not secret voting)',
            terms_export_notice: 'Important: You understand that any group member can download voting history showing your apartment/plot number and your votes.',
            terms_agree_text: 'I have read and agree to the terms',
            accept: 'Accept and continue',
            apartment_required: 'Please provide apartment or plot number to participate in voting',
            apartment_required_title: 'Address required',
            export_csv: 'Export history (CSV)',
            export_date: 'Creation date',
            export_author: 'Author',
            export_question: 'Question',
            export_type: 'Type',
            export_result: 'Result',
            export_yes: 'Yes',
            export_no: 'No',
            export_abstain: 'Abstained',
            export_comments: 'Comments',
            export_unit: 'Apartment/Plot',
            export_votes: 'Votes',
            search_members: 'Search by name or phone...',
            participation_count: 'Participation',
            sort_by_name: 'Sort by name',
            sort_by_participation: 'Sort by participation',
            total_votings: 'total',
            accepted_short: 'acc.',
            active_short: 'act.',
            rejected_short: 'rej.',
            no_members_found: 'No members found',
            stats_accepted: 'accepted',
            stats_rejected: 'rejected',
            stats_active: 'in progress',
            // Auth
            auth_subtitle: 'Voting for communities',
            auth_email_placeholder: 'Email',
            auth_password_placeholder: 'Password',
            auth_login_btn: 'Sign In',
            auth_register_btn: 'Sign Up',
            auth_forgot_password: 'Forgot password?',
            auth_or_divider: 'or',
            auth_google_btn: 'Sign in with Google',
            auth_hint: 'Automatic registration on first login',
            auth_error_invalid: 'Invalid email or password',
            auth_error_exists: 'This email is already registered',
            auth_error_invalid_email: 'Please enter a valid email address',
            auth_error_network: 'Network error. Please try again later.',
            auth_error_fill_fields: 'Please fill in email and password',
            auth_error_password_short: 'Password must be at least 8 characters',
            auth_error_not_confirmed: 'Please confirm your email before signing in',
            auth_error_enter_email: 'Enter your email to reset password',
            auth_check_email: 'Check your email to confirm registration',
            auth_reset_sent: 'Password reset email has been sent',
            group_menu: 'Group Menu',
            edit_group: 'Edit Group',
            delete_group: 'Delete Group',
            delete_group_confirm: 'Are you sure you want to delete this group? All votings and history will be lost. This action cannot be undone.',
            group_name_required: 'Enter group name',
            group_updated: 'Group updated',
            group_deleted: 'Group deleted',
            leave_group: 'Leave group',
            leave_group_confirm: 'Are you sure you want to leave this group? You will lose access to votings and group history.',
            leave_group_success: 'You left the group',
            leave: 'Leave',
            admin_cannot_leave: 'Administrator cannot leave the group. Transfer the admin role to another member first.',
            delete_group_need_voting: 'There are other members in the group. To delete the group, create a "Delete group" voting.',
            type_delete_group: 'Delete group',
            group_deleted_by_voting: 'Group deleted by voting result',
            delete_group_warning: 'If the vote passes — the group will be automatically deleted along with all votings and history.',
            one_delete_group_at_time: 'There is already an active voting to delete this group.',
            min_duration_24h: 'Minimum duration for this voting type is 24 hours.',
            // Phase 14: voter/observer roles
            apartment_label: 'Apartment',
            role_voter: 'Voter',
            role_observer: 'Observer',
            join_role_required: 'Select a role',
            join_apartment_required: 'Enter apartment number',
            apartment_taken: 'Apartment taken by a voter',
            apartment_taken_hint: 'Choose "observer" role or enter a different apartment.',
            error_generic: 'Something went wrong. Please try again.',
            err_not_admin: 'Only the group administrator can do this',
            err_request_not_found: 'Request not found — it may already be resolved',
            err_exclusion_only_via_voting: 'Exclusion is only possible through a voting',
            not_member: 'You are not a member of this group',
            group_id_label: 'Group ID:',
            copy_btn: 'Copy',
            members_header: 'Members',
            observer_cannot_vote: 'Observers cannot vote',
            observer_notice: 'You are an observer. Voting is not available.',
            apartment_taken_now_confirm: 'Apartment taken. Approve as observer?',
            request_role_change_btn: 'Request role change',
            change_role_menu: 'Change role',
            role_changed: 'Role changed',
            role_change_requested: 'Role change request sent',
            already_in_role: 'You already have this role',
            admin_cannot_be_observer: 'Admin cannot be an observer',
            role_change_badge: 'role change',
            my_roles_in_groups: 'My roles in groups',
            join_group_btn: 'Join',
            join_group_section_title: 'Join a group',
            join_id_label: 'Group ID',
            join_id_ph: '6 digits, e.g. 123456',
            join_apartment_label_full: 'Your apartment / office / house number',
            join_apartment_ph: 'e.g. 12 or 12A',
            join_apartment_hint: 'One apartment — one vote.',
            join_role_label: 'Your role'
        },
        ru: {
            profile: 'Профиль',
            edit_profile: 'Редактировать профиль',
            instructions: 'Инструкции',
            instructions_title: 'Инструкции по использованию',
            logout: 'Выйти',
            not_your_account: 'Это не ваш аккаунт? Выйти',
            load_failed: 'Не удалось загрузить. Потяните вниз, чтобы обновить.',
            theme: 'Тема',
            theme_auto: 'Системная',
            theme_light: 'Светлая',
            theme_dark: 'Тёмная',
            install_app: 'Установить на главный экран',
            install_thanks: 'Спасибо! Spilka теперь на главном экране.',
            install_already: 'Приложение уже установлено',
            install_ios_hint: 'На iPhone/iPad: нажмите «Поделиться» (квадрат со стрелкой) и выберите «На экран Домой».',
            install_not_ready: 'Опция установки сейчас недоступна. Проверьте, что страница открыта через HTTPS — и попробуйте снова.',
            install_dismissed: 'Отменено — можно установить позже с этого же экрана.',
            auth_register_link: 'Регистрация',
            register_title: 'Регистрация',
            register_subtitle: 'Создайте аккаунт для голосований',
            register_password_placeholder: 'Пароль (мин. 8 символов)',
            register_submit_btn: 'Создать аккаунт',
            register_google_btn: 'Регистрация через Google',
            register_have_account: 'Уже есть аккаунт?',
            forgot_title: 'Восстановление пароля',
            forgot_subtitle: 'Введите email — пришлём ссылку',
            forgot_submit_btn: 'Отправить ссылку',
            forgot_remembered: 'Вспомнили пароль?',
            reset_title: 'Новый пароль',
            reset_subtitle: 'Введите новый пароль для аккаунта',
            reset_pass1_placeholder: 'Новый пароль (мин. 8 символов)',
            reset_pass2_placeholder: 'Повторите новый пароль',
            reset_submit_btn: 'Сохранить новый пароль',
            reset_mismatch: 'Пароли не совпадают',
            reset_done: 'Пароль обновлён',
            change_password: 'Сменить пароль',
            feedback_btn: 'Предложение / замечание',
            feedback_title: 'Предложение или замечание',
            feedback_hint: 'Напишите, что нравится или что стоит улучшить. Мы читаем всё.',
            feedback_placeholder: 'Ваше предложение или замечание...',
            feedback_send: 'Отправить',
            feedback_thanks: 'Спасибо! Мы получили ваш отзыв — в ближайшее время рассмотрим.',
            feedback_too_short: 'Напишите больше деталей (мин. 5 символов)',
            admin_panel: 'Админ-панель',
            admin_tab_users: 'Пользователи',
            admin_tab_groups: 'Группы',
            admin_tab_feedback: 'Отзывы',
            loading: 'Загрузка…',
            request_approved: 'Запрос одобрен',
            request_rejected: 'Запрос отклонён',
            approve: 'Принять',
            reject: 'Отклонить',
            loader_signing_in: 'Входим в аккаунт…',
            refresh_group: 'Обновить данные',
            refresh_in_progress: 'Обновляем…',
            refresh_done: 'Данные обновлены',
            dev_banner: '⚠️ Сайт в разработке — некоторые функции могут меняться',
            archive_all: 'В архив',
            archive_confirm_title: 'В архив',
            archive_confirm_msg: 'Перенести уведомления в архив? Они останутся в истории, но список очистится.',
            archive_empty: 'Список уже пуст',
            archive_done: 'Перенесено в архив',
            archive_needs_migration: 'Сначала накатите phase12-notif-archive.sql в Supabase SQL Editor',
            notifications_archive: 'Архив уведомлений',
            archive_search_placeholder: 'Поиск (от 3 символов)...',
            archive_load_more: 'Загрузить ещё',
            archive_empty_state: 'Архив пуст',
            archive_no_search_results: 'Ничего не найдено',
            unarchive: 'Разархивировать',
            unarchive_confirm: 'Вернуть уведомление в основной список?',
            unarchive_done: 'Возвращено в основной список',
            cta_complete_profile: 'Заполните «Квартиру/офис» в профиле, чтобы голосовать',
            members_label: 'Участников',
            votings_label: 'Голосований',
            confirm_title: 'Подтверждение',
            confirm_ok: 'Подтвердить',
            logout_confirm: 'Выйти из аккаунта? Придётся войти снова.',
            ptr_pull: 'Потяните, чтобы обновить',
            ptr_release: 'Отпустите, чтобы обновить',
            ptr_loading: 'Обновляем…',
            address: 'Адрес',
            groups_count: 'Групп',
            firstname: 'Имя',
            lastname: 'Фамилия',
            phone: 'Телефон',
            apartment: 'Квартира/офис',
            cancel: 'Отмена',
            save: 'Сохранить',
            voting: 'Голосования',
            groups: 'Группы',
            notifications: 'Уведомления',
            active_votings: 'Активные',
            completed_votings: 'Завершённые',
            enter_group_id: 'Введите ID группы (6 цифр)',
            join: 'Присоединиться',
            mark_all_read: 'Прочитано все',
            new_group: 'Новая группа',
            group_name: 'Название группы',
            group_name_placeholder: 'Например: Дом 61',
            group_description: 'Описание (необязательно)',
            group_desc_placeholder: 'Краткое описание группы...',
            group_hint: 'После создания вы получите уникальный ID для приглашения участников',
            create: 'Создать',
            new_voting: 'Новое голосование',
            question: 'Вопрос',
            question_placeholder: 'Текст вопроса для голосования',
            description: 'Описание',
            description_placeholder: 'Подробное описание голосования...',
            group: 'Группа',
            select_group: 'Выберите группу',
            voting_type: 'Тип голосования',
            type_simple: 'Обычное (за/против)',
            type_secret: 'Тайное голосование',
            type_admin: 'Смена администратора',
            type_remove: 'Удаление участника',
            type_freeze: 'Исключить из подсчёта',
            freeze_members: 'Кого исключить из подсчёта',
            freeze_info: 'Исключает участника из подсчёта голосов (например, квартиру продали или человек не участвует). На возражение — 5 дней; любые 2 участника могут отменить.',
            freeze_proposal: 'Предложение исключить из подсчёта',
            freeze_duration_info: 'Возразить можно 5 дней. Если 2 участника нажмут «Не согласен» — исключение отменяется. Сам участник может вернуть себя в любой момент кнопкой «Я тут».',
            freeze_voting: 'Исключение из подсчёта',
            only_admin_can_freeze: 'Только администратор может предложить исключение из подсчёта',
            select_freeze_members: 'Выберите хотя бы одного участника',
            i_disagree: 'Я не согласен',
            disagree_info: 'Если 2 участника не согласны — исключение будет отменено автоматически.',
            you_objected: 'Вы выразили несогласие',
            already_objected: 'Вы уже выразили несогласие',
            objection_added: 'Ваше несогласие записано',
            objections_title: 'Несогласие',
            no_objections: 'Пока никто не выразил несогласие',
            objections_needed: 'Нужно ещё {count} участников для отмены',
            auto_rejected: 'автоматически отменено',
            freeze_rejected: 'Исключение отменено',
            freeze_auto_rejected: 'Исключение отменено: участники возразили',
            frozen_badge: 'вне подсчёта',
            frozen_abbr: 'вне',
            frozen_cannot_vote: 'Вы исключены из подсчёта. Нажмите «Я тут», чтобы вернуться и голосовать.',
            excluded_self_text: 'Вы исключены из подсчёта голосов этой группы. Если вы участвуете — верните себя одним касанием.',
            im_here_btn: 'Я тут',
            im_here_done: 'Готово — вы снова в подсчёте',
            member_restored_done: 'Участник возвращён в подсчёт',
            restore_member_menu: 'Вернуть в подсчёт',
            protocol_btn: 'Протокол',
            protocol_print: 'Печать / Сохранить PDF',
            protocol_close: 'Закрыть',
            protocol_heading: 'Протокол голосования',
            protocol_subtitle: 'онлайн-голосование сообщества',
            protocol_group: 'Сообщество',
            protocol_initiator: 'Инициатор',
            protocol_period: 'Период голосования',
            protocol_quorum: 'Кворум и участие',
            protocol_voters: 'Голосующих',
            protocol_voted: 'Проголосовало',
            protocol_turnout: 'Явка',
            protocol_results: 'Результаты',
            protocol_decision_accepted: 'Решение принято',
            protocol_decision_rejected: 'Решение отклонено',
            protocol_rule: 'Нужно больше половины голосующих',
            protocol_namewise: 'Поименный список голосов',
            protocol_secret_note: 'Тайное голосование — поименный список не раскрывается.',
            protocol_no_votes: 'Голосов не подано',
            protocol_col_apt: 'Кв.',
            protocol_col_voter: 'Участник',
            protocol_col_vote: 'Голос',
            protocol_col_time: 'Время',
            instr_protocol_title: 'Протокол голосования (печать / PDF)',
            instr_protocol_desc: 'Любой участник может распечатать протокол завершённого голосования. Откройте голосование → «Протокол» → «Печать / Сохранить PDF». В протоколе: вопрос, тип, период, кворум и явка, результат с подсчётом «За/Против/Воздержались», поименный список голосов (для открытого голосования) и место для подписей. Для тайного — только итоговые цифры, без имён.',
            duration: 'Длительность',
            hour: 'час',
            hours: 'часов',
            days: 'дней',
            materials_link: 'Ссылка на материалы',
            link_placeholder: 'Google Drive, Dropbox...',
            admin: 'Админ',
            member: 'Участник',
            members: 'участников',
            votings: 'голосований',
            empty_groups: 'Вы ещё не присоединились ни к одной группе',
            empty_groups_hint: 'Создайте свою группу или присоединитесь по 6-значному коду, который вам пришлёт администратор.',
            group_not_found: 'Группа не найдена',
            already_requested: 'Запрос уже отправлен',
            join_request_sent: 'Запрос на присоединение отправлен',
            already_member: 'Вы уже являетесь участником этой группы',
            enter_group_id_error: 'Введите корректный ID группы (6 цифр)',
            empty_votings: 'Пока нет голосований',
            empty_votings_hint: 'Здесь появятся голосования из ваших групп. Нажмите «+» вверху, чтобы создать первое.',
            empty_notifications: 'Уведомлений нет',
            empty_notifications_hint: 'Когда в ваших группах появятся события — увидите их здесь.',
            select_group: 'Выберите группу',
            secret_voting: 'Тайное',
            open_voting: 'Открытое',
            completed: 'Завершено',
            days: 'дн.',
            hours: 'час.',
            yes: 'За',
            no: 'Против',
            participation: 'участия',
            instructions_title: 'Как пользоваться Spilka',
            instr_quick_start: 'Быстрый старт',
            instr_qs_step1: '1. <strong>Зарегистрируйтесь</strong> через email и пароль (или войдите, если аккаунт уже есть). Забыли пароль? Нажмите «Забули пароль?» на экране входа — на почту придёт ссылка для сброса.',
            instr_qs_step2: '2. <strong>Заполните профиль</strong> — укажите имя, фамилию, телефон и номер квартиры/участка (обязательно для голосования)',
            instr_qs_step3: '3. <strong>Создайте группу</strong> или <strong>присоединитесь</strong> к существующей по 6-значному коду (укажите квартиру и роль)',
            instr_qs_step4: '4. <strong>Голосуйте</strong> в активных голосованиях или создавайте свои',
            instr_qs_step5: '5. Следите за результатами во вкладке <strong>Уведомления</strong>',
            instr_profile: 'Профиль',
            instr_profile_setup_title: 'Настройка профиля',
            instr_profile_setup_desc: 'После входа заполните обязательные поля: имя, фамилию, телефон, адрес и номер квартиры/участка. Без номера квартиры голосовать нельзя.',
            instr_profile_edit_title: 'Редактирование профиля',
            instr_profile_edit_desc: 'Откройте вкладку «Профиль» → нажмите «Редактировать профиль». Можно изменить любое поле в любое время.',
            instr_profile_lang_title: 'Смена языка',
            instr_profile_lang_desc: 'Во вкладке «Профиль» выберите язык: українська, English или русский. Выбор сохраняется автоматически.',
            instr_group_mgmt: 'Группы',
            instr_create_group_title: 'Создание группы',
            instr_create_group_desc: 'Нажмите «+» во вкладке «Группы». Укажите название и описание. Система создаст уникальный 6-значный код. Вы автоматически станете администратором.',
            instr_join_group_title: 'Вступление в группу',
            instr_join_group_desc: 'На вкладке «Группы» разверните «Вступить в группу». Введите 6-значный код, номер своей квартиры/офиса/дома и выберите роль (голосующий или наблюдатель). Нажмите «Присоединиться» — администратор получит запрос и должен его одобрить или отклонить.',
            instr_group_detail_title: 'Страница группы',
            instr_group_detail_desc: 'Нажмите на группу, чтобы увидеть: код группы (можно скопировать), статистику, список участников, запросы на вступление и историю изменений.',
            instr_members_title: 'Участники группы',
            instr_members_desc: 'В списке участников можно: искать по имени или телефону, сортировать по алфавиту или по участию в голосованиях. Замороженные участники отмечены ❄️.',
            instr_requests_title: 'Запросы на вступление',
            instr_requests_desc: 'Администратор видит входящие запросы и может одобрить или отклонить каждого кандидата. Участнику придёт уведомление о решении.',
            instr_voting_types: 'Типы голосования',
            instr_simple_title: 'Обычное (открытое)',
            instr_simple_desc: 'Кто создаёт: любой участник группы (обычные участники — не более 1 голосования в сутки). Как работает: каждый выбирает «За», «Против» или «Воздержусь», имя и комментарий (до 500 символов) видны всем. Длительность: от 1 часа до 5 дней — задаёт автор. Принято, если «За» проголосовало более половины ВСЕХ участников группы (при 10 — нужно 6 «За»). Если время вышло, а «За» меньше — отклонено. Подходит для: ремонт, расходы, правила.',
            instr_secret_title: 'Тайное',
            instr_secret_desc: 'То же самое, что обычное, но все имена скрыты — видны только итоговые цифры «За / Против / Воздержусь». Комментариев нет. Условия принятия те же: более половины ВСЕХ участников должны проголосовать «За». Подходит для чувствительных вопросов (личные конфликты, финансовая прозрачность).',
            instr_admin_title: 'Смена администратора',
            instr_admin_desc: 'Кто создаёт: любой участник. Кого можно выбрать: любого не-админа из списка участников. Требования: в группе минимум 3 участника. Длительность фиксированная: 72 часа (3 суток). Принято, если «За» проголосовало более половины ВСЕХ участников. При успехе роли меняются автоматически: прежний админ становится обычным участником, выбранный — администратором. В группе одновременно может идти только одно такое голосование.',
            instr_remove_title: 'Удаление участника',
            instr_remove_desc: 'Кто создаёт: любой участник. Обязательно: указать причину (4 готовых варианта или свой текст). Требования: минимум 3 участника. Длительность фиксированная: 72 часа. Принято, если «За» проголосовало более половины ВСЕХ участников. При успехе участник автоматически удаляется из группы и получает уведомление с причиной.',
            instr_freeze_title: 'Исключение из подсчёта',
            instr_freeze_desc: 'Зачем: чтобы «мёртвые души» (квартиру продали, человек уехал или вовсе не участвует) не искажали подсчёт — их можно убрать из знаменателя, чтобы процент участия и кворум отражали реальность. Кто предлагает: только администратор. Возражение: 5 дней — любые 2 участника, нажавшие «Не согласен», отменяют исключение (обычных голосов «За/Против» здесь нет). Если сам участник возразит — исключение отменяется сразу (это доказательство, что он на месте). Возврат: исключённый участник в любой момент возвращает себя кнопкой «Я тут»; администратор тоже может вернуть его вручную. Когда в ту же квартиру вступает новый владелец — исключённого «призрака» система убирает автоматически. Предохранитель: нельзя исключить столько, чтобы активных осталось меньше двух.',
            instr_delete_group_title: 'Удаление группы',
            instr_delete_group_desc: 'Кто создаёт: любой участник (администратор обязан использовать именно это голосование, если в группе больше 1 участника). Длительность: минимум 24 часа — задаёт автор. Принято, если «За» проголосовало более половины ВСЕХ участников. При успехе группа, все её голосования и история удаляются безвозвратно, все участники получают уведомление. В группе одновременно может идти только одно такое голосование.',
            instr_leave_group_title: 'Выход из группы',
            instr_leave_group_desc: 'Любой участник (кроме администратора) может покинуть группу через меню (⋮). Администратор должен сначала передать свою роль через голосование «Смена администратора».',
            instr_delete_group_admin_title: 'Удаление группы (админ)',
            instr_delete_group_admin_desc: 'Администратор может удалить группу напрямую только если он единственный участник. Если в группе 2+ участников — нужно создать голосование «Удаление группы».',
            instr_duration_4: '• Удаление группы: от 24 часов',
            instr_how_to_vote: 'Как голосовать',
            instr_cast_vote_title: 'Процесс голосования',
            instr_cast_vote_desc: 'Откройте активное голосование → выберите «За», «Против» или «Воздержусь» → по желанию добавьте комментарий (до 500 символов) → голос засчитан.',
            instr_create_vote_title: 'Создание голосования',
            instr_create_vote_desc: 'Нажмите «+» во вкладке «Голосования». Заполните: название, описание, тип, группу, длительность. Можно добавить ссылку на материалы. Обычные участники могут создать 1 голосование в день в каждой группе.',
            instr_delete_vote_title: 'Удаление голосования',
            instr_delete_vote_desc: 'Автор голосования может его удалить, указав причину (мин. 5 символов). Удалённое голосование помечается соответственно.',
            instr_comments_title: 'Комментарии',
            instr_comments_desc: 'К открытым голосованиям можно добавить комментарий при голосовании (до 500 символов). В тайных голосованиях комментарии скрыты.',
            instr_notifications: 'Уведомления',
            instr_notif_desc: 'Вы получаете уведомления о: новых голосованиях, запросах на вступление, результатах голосований, сменах администратора, удалениях и заморозках участников. Непрочитанные отмечены синим. Можно отметить все как прочитанные.',
            instr_badges: 'Обозначения и статусы',
            instr_badge_yellow: 'Активное голосование (ещё идёт)',
            instr_badge_green: 'Принято (50%+1 проголосовали «За»)',
            instr_badge_red: 'Отклонено (большинство проголосовало «Против» или недостаточно голосов)',
            instr_badge_blue: 'Тайное голосование (имена голосующих скрыты)',
            instr_badge_frozen: 'Участник вне подсчёта голосов',
            instr_badge_admin: 'Администратор группы',
            instr_rules: 'Правила и сроки',
            instr_duration_title: 'Длительность',
            instr_duration_1: '• Обычные/тайные голосования: от 1 часа до 5 дней',
            instr_duration_2: '• Смена админа / Удаление участника: фиксировано 72 часа',
            instr_duration_3: '• Исключение из подсчёта: 5 дней на возражение',
            instr_decision_title: 'Принятие решений',
            instr_decision_desc: 'Для принятия решения нужно 50%+1 голос от <strong>голосующих</strong> участников группы (наблюдатели не учитываются). Результат определяется автоматически по завершении срока.',
            instr_limits_title: 'Ограничения',
            instr_limits_desc: '• Без номера квартиры/участка — голосовать нельзя<br>• Обычный участник: макс. 1 голосование в день в каждой группе<br>• Администратор: без ограничений<br>• Смена админа / удаление: мин. 3 участника в группе',
            instr_export: 'Экспорт данных',
            instr_export_desc: 'Администратор может скачать историю голосований группы в CSV-файл. В файле: дата, автор, вопрос, тип, результат, количество голосов «За/Против/Воздержался», комментарии. Открывается в Excel или Google Sheets.',
            instr_roles: 'Роли: голосующий и наблюдатель',
            instr_roles_apartment_title: 'Номер квартиры = один голос',
            instr_roles_apartment_desc: 'При вступлении вы указываете номер своей квартиры / офиса / дома. Правило простое: <strong>одна квартира — один голос</strong>. Голосовать от этой квартиры может только один человек (голосующий), остальные жильцы могут вступить как наблюдатели.',
            instr_roles_voter_title: '👍 Голосующий',
            instr_roles_voter_desc: 'Полноценный участник: видит голосования, голосует «За/Против/Воздержусь», создаёт собственные голосования. Его голос учитывается в результате.',
            instr_roles_observer_title: '👁️ Наблюдатель',
            instr_roles_observer_desc: 'Видит все голосования и результаты, но <strong>не голосует</strong>. Наблюдатели не учитываются при подсчёте (кворум считается только среди голосующих). Подходит для членов семьи, арендаторов или тех, кто хочет лишь следить.',
            instr_roles_change_title: 'Как сменить свою роль',
            instr_roles_change_desc: 'Откройте вкладку «Профиль» → в списке «Мои роли в группах» нажмите «Запросить смену роли» рядом с нужной группой. Запрос уйдёт администратору на подтверждение. Если в вашей квартире уже есть голосующий — стать голосующим не получится, пока место занято.',
            instr_roles_admin_title: 'Смена роли администратором',
            instr_roles_admin_desc: 'Администратор может сам сменить роль участника: на странице группы в списке участников нажмите кнопку смены роли (↔) рядом с нужным человеком.',
            instr_notif_archive_title: 'Архив уведомлений',
            instr_notif_archive_desc: 'Кнопка «В архив» прячет все текущие уведомления из списка (они не удаляются, а сохраняются). Чтобы их посмотреть, нажмите значок архива (вверху на вкладке «Уведомления»). В архиве есть поиск от 3 букв, а кнопка возврата (↩) возвращает уведомление обратно в основной список.',
            instr_profile_password_title: 'Смена пароля',
            instr_profile_password_desc: 'На вкладке «Профиль» нажмите «Изменить пароль». Введите новый пароль дважды — и он сразу начнёт действовать.',
            instr_profile_theme_title: 'Тема оформления',
            instr_profile_theme_desc: 'Кнопка «Тема» в профиле переключает вид: светлая, тёмная или системная (автоматически по настройкам телефона). Выбор сохраняется.',
            instr_profile_install_title: 'Установить на телефон',
            instr_profile_install_desc: 'Если появилась кнопка «Установить на главный экран» — нажмите её, и Spilka добавится как приложение (отдельная иконка, работает как обычная программа, без браузера).',
            instr_profile_feedback_title: 'Предложение или замечание',
            instr_profile_feedback_desc: 'Кнопка «Предложение / замечание» в профиле позволяет отправить нам идею или сообщить о проблеме. Мы читаем все сообщения.',
            fill_name_error: 'Пожалуйста, введите имя и фамилию',
            profile_saved: 'Профиль обновлён!',
            notif_new_voting: 'Новое голосование в группе',
            notif_join_request: 'хочет присоединиться к группе',
            notif_voting_completed: 'Голосование завершено',
            notif_accepted: 'ПРИНЯТО',
            notif_rejected: 'ОТКЛОНЕНО',
            notif_welcome_admin: 'Поздравляем! Вы стали администратором группы',
            hours_ago: 'часов назад',
            days_ago: 'дней назад',
            day_ago: 'день назад',
            just_now: 'Только что', 
            participation_label: 'Участие',
            already_voted: 'Вы уже проголосовали',
            joined_after_vote: 'Вы присоединились после начала этого голосования и не входите в его состав',
            vote_against: 'Против',
            vote_for: 'За',
            admin_full: 'Администратор',
            no_requests: 'Нет запросов',
            join_requests: 'Запросы на вступление',
            target_member: 'Участник',
            select_member: 'Выберите участника',
            select_duration: 'Выберите длительность голосования',
            removal_reason: 'Причина удаления',
            select_reason: 'Выберите причину',
            reason_dues: 'Не платит взносы',
            reason_rules: 'Нарушает правила',
            reason_sold: 'Продал квартиру/помещение',
            reason_other: 'Другое',
            reason_details: 'Подробное описание причины...',
            target_admin_candidate: 'Кандидат на должность администратора',
            target_member_remove: 'Участник для удаления',
            candidate_profile: 'Профиль кандидата',
            admin_change_success: 'Администратор изменён',
            new_admin_is: 'Новый администратор',
            you_removed_admin: 'Вы сняты с должности администратора группы',
            you_became_admin: 'Вы стали администратором группы',
            member_removed: 'Участник удалён',
            removed_from_group: 'Вас удалили из группы',
            removal_reason_label: 'Причина',
            auto_fixed_duration: 'Длительность фиксирована для этого типа голосования',
            min_3_members_required: 'Требуется минимум 3 участника в группе',
            history: 'История изменений',
            history_admin_change: 'Смена администратора',
            history_member_removed: 'Удаление участника',
            history_date: 'Дата',
            history_action: 'Действие',
            history_initiator: 'Инициатор',
            history_result: 'Результат',
            cant_remove_admin: 'Нельзя удалить администратора',
            one_admin_change_at_time: 'Одновременно может быть только одно голосование о смене администратора',
            author: 'Автор',
            opened: 'продолжается',
            result_accepted: 'Принято',
            result_rejected: 'Отклонено',
            abstain_short: 'Возд',
            unknown_author: 'Неизвестный',
            delete_voting_title: 'Удалить голосование',
            delete_voting_warning: '⚠️ Голосование будет удалено безвозвратно. Все участники получат уведомление.',
            delete_reason: 'Причина удаления',
            delete_reason_placeholder: 'Укажите причину (минимум 5 символов)...',
            delete: 'Удалить',
            voting_deleted: 'Голосование удалено',
            voting_deleted_by: 'Голосование удалено автором',
            reason_label: 'Причина',
            cannot_delete_completed: 'Нельзя удалить завершённое голосование',
            delete_reason_short: 'Причина должна быть не менее 5 символов',
            delete_reason_long: 'Причина слишком длинная (макс. 200 символов)',
            export_nothing: 'Нет голосований для экспорта',
            reply_too_short: 'Напишите ответ',
            daily_limit_reached: 'Вы достигли лимита: 1 голосование на 24 часа для обычных пользователей',
            abstain: 'Воздержаться',
            comment: 'Комментарий',
            comment_placeholder: 'Ваш комментарий (необязательно, макс. 500 символов)...',
            comments: 'Комментарии',
            comment_count: 'символов',
            vote_yes: 'За',
            vote_no: 'Против',
            vote_abstain: 'Воздержался',
            your_comment: 'Ваш комментарий',
            no_comments: 'Комментариев пока нет',
            terms_title: 'Условия использования',
            terms_intro: 'Для обеспечения полной прозрачности и демократии в группе, все участники имеют право:',
            terms_item1: 'Принимать участие в голосованиях после указания номера квартиры/участка',
            terms_item2: 'Экспортировать полную историю голосований группы в формате CSV',
            terms_item3: 'Проверять результаты голосований на достоверность',
            terms_item4: 'Комментировать свои голоса (если это не тайное голосование)',
            terms_export_notice: 'Важно: Вы понимаете, что любой участник группы может скачать историю голосований, где будет видно номер вашей квартиры/участка и ваши голоса.',
            terms_agree_text: 'Я ознакомлен(а) с условиями и согласен(на) с ними',
            accept: 'Согласиться и продолжить',
            apartment_required: 'Укажите номер квартиры или участка для участия в голосованиях',
            apartment_required_title: 'Необходимо заполнить адрес',
            export_csv: 'Экспорт истории (CSV)',
            export_date: 'Дата создания',
            export_author: 'Автор',
            export_question: 'Вопрос',
            export_type: 'Тип',
            export_result: 'Результат',
            export_yes: 'За',
            export_no: 'Против',
            export_abstain: 'Воздержались',
            export_comments: 'Комментарии',
            export_unit: 'Квартира/Участок',
            export_votes: 'Голоса',
            search_members: 'Поиск по ФИО или телефону...',
            participation_count: 'Участие',
            sort_by_name: 'Сортировать по имени',
            sort_by_participation: 'Сортировать по участию',
            total_votings: 'всего',
            accepted_short: 'прин.',
            active_short: 'актив.',
            rejected_short: 'откл.',
            no_members_found: 'Участников не найдено',
            stats_accepted: 'принято',
            stats_rejected: 'отклонено',
            stats_active: 'в процессе',
            // Auth
            auth_subtitle: 'Голосования для сообществ',
            auth_email_placeholder: 'Email',
            auth_password_placeholder: 'Пароль',
            auth_login_btn: 'Войти',
            auth_register_btn: 'Зарегистрироваться',
            auth_forgot_password: 'Забыли пароль?',
            auth_or_divider: 'или',
            auth_google_btn: 'Войти через Google',
            auth_hint: 'Автоматическая регистрация при первом входе',
            auth_error_invalid: 'Неверный email или пароль',
            auth_error_exists: 'Этот email уже зарегистрирован',
            auth_error_invalid_email: 'Введите корректный email-адрес',
            auth_error_network: 'Ошибка сети. Попробуйте позже.',
            auth_error_fill_fields: 'Заполните email и пароль',
            auth_error_password_short: 'Пароль должен быть не менее 8 символов',
            auth_error_not_confirmed: 'Подтвердите email перед входом',
            auth_error_enter_email: 'Введите email для восстановления пароля',
            auth_check_email: 'Проверьте почту для подтверждения регистрации',
            auth_reset_sent: 'Письмо для восстановления пароля отправлено на вашу почту',
            group_menu: 'Меню группы',
            edit_group: 'Редактировать группу',
            delete_group: 'Удалить группу',
            delete_group_confirm: 'Вы уверены, что хотите удалить эту группу? Все голосования и история будут потеряны. Это действие нельзя отменить.',
            group_name_required: 'Введите название группы',
            group_updated: 'Группа обновлена',
            group_deleted: 'Группа удалена',
            leave_group: 'Покинуть группу',
            leave_group_confirm: 'Вы уверены, что хотите покинуть эту группу? Вы потеряете доступ к голосованиям и истории группы.',
            leave_group_success: 'Вы покинули группу',
            leave: 'Покинуть',
            admin_cannot_leave: 'Администратор не может покинуть группу. Сначала передайте роль администратора другому участнику.',
            delete_group_need_voting: 'В группе есть другие участники. Для удаления группы создайте голосование типа «Удаление группы».',
            type_delete_group: 'Удаление группы',
            group_deleted_by_voting: 'Группа удалена по результатам голосования',
            delete_group_warning: 'Если голосование будет принято — группа будет удалена автоматически вместе со всеми голосованиями и историей.',
            one_delete_group_at_time: 'Уже существует активное голосование за удаление этой группы.',
            min_duration_24h: 'Минимальная длительность для этого типа голосования — 24 часа.',
            // Phase 14: voter/observer roles
            apartment_label: 'Квартира',
            role_voter: 'Голосующий',
            role_observer: 'Наблюдатель',
            join_role_required: 'Выберите роль',
            join_apartment_required: 'Введите номер квартиры',
            apartment_taken: 'Квартира занята голосующим',
            apartment_taken_hint: 'Выберите роль "наблюдатель" или введите другую квартиру.',
            error_generic: 'Произошла ошибка. Попробуйте ещё раз.',
            err_not_admin: 'Это действие доступно только администратору группы',
            err_request_not_found: 'Заявка не найдена — возможно, она уже рассмотрена',
            err_exclusion_only_via_voting: 'Исключение возможно только через голосование',
            not_member: 'Вы не участник этой группы',
            group_id_label: 'ID группы:',
            copy_btn: 'Копировать',
            members_header: 'Участники',
            observer_cannot_vote: 'Наблюдатели не могут голосовать',
            observer_notice: 'Вы — наблюдатель. Голосование для вас недоступно.',
            apartment_taken_now_confirm: 'Квартира занята. Одобрить как наблюдателя?',
            request_role_change_btn: 'Запросить смену роли',
            change_role_menu: 'Изменить роль',
            role_changed: 'Роль изменена',
            role_change_requested: 'Запрос на смену роли отправлен',
            already_in_role: 'У вас уже есть эта роль',
            admin_cannot_be_observer: 'Администратор не может быть наблюдателем',
            role_change_badge: 'смена роли',
            my_roles_in_groups: 'Мои роли в группах',
            join_group_btn: 'Присоединиться',
            join_group_section_title: 'Вступить в группу',
            join_id_label: 'ID группы',
            join_id_ph: '6 цифр, напр. 123456',
            join_apartment_label_full: 'Номер вашей квартиры / офиса / дома',
            join_apartment_ph: 'напр. 12 или 12А',
            join_apartment_hint: 'Одна квартира — один голос.',
            join_role_label: 'Ваша роль'
        }
    },

    currentLanguage: 'uk',

    // Description character counter
    updateDescriptionCounter() {
        const textarea = document.getElementById('voting-description');
        const counter = document.getElementById('description-counter');
        if (textarea && counter) {
            counter.textContent = textarea.value.length;
        }
    },

    // Freeze voting member selection
    searchFreezeMembers(query) {
        const t = this.translations[this.currentLanguage];
        if (!query || query.length < 2) {
            document.getElementById('freeze-search-results').classList.add('hidden');
            return;
        }
        
        const groupId = document.getElementById('voting-group').value;
        if (!groupId) return;
        
        const group = this.state.groups.find(g => g.id === groupId);
        if (!group) return;
        
        const resultsContainer = document.getElementById('freeze-search-results');
        const selectedIds = this.state.freezeSelectedMembers.map(m => m.id);
        
        // Filter members by query and exclude already selected + admin + already frozen
        const matches = group.members.filter(m => 
            !selectedIds.includes(m.id) && 
            m.role !== 'admin' && 
            !m.frozen &&
            (m.name.toLowerCase().includes(query.toLowerCase()) || 
             (m.phone && m.phone.includes(query)))
        );
        
        if (matches.length === 0) {
            resultsContainer.innerHTML = `<div class="freeze-search-empty">${t.nothing_found || 'Нічого не знайдено'}</div>`;
        } else {
            resultsContainer.innerHTML = matches.map(m => `
                <div class="search-result-item" role="option" onclick="app.selectFreezeMember('${m.id}')">
                    ${this.escapeHTML(m.name)} (${this.escapeHTML(m.address)})
                </div>
            `).join('');
        }
        
        resultsContainer.classList.remove('hidden');
    },

    selectFreezeMember(id) {
        const groupId = document.getElementById('voting-group').value;
        const group = this.state.groups.find(g => g.id === groupId);
        const member = group ? group.members.find(m => m.id === id) : null;
        
        if (member) {
            this.state.freezeSelectedMembers.push(member);
            this.renderFreezeMemberChips();
        }
        
        document.getElementById('freeze-search').value = '';
        document.getElementById('freeze-search-results').classList.add('hidden');
    },

    removeFreezeMember(id) {
        this.state.freezeSelectedMembers = this.state.freezeSelectedMembers.filter(m => m.id !== id);
        this.renderFreezeMemberChips();
    },

    renderFreezeMemberChips() {
        const container = document.getElementById('freeze-selected-members');
        if (!container) return;
        
        if (this.state.freezeSelectedMembers.length === 0) {
            container.innerHTML = '';
            return;
        }
        
        container.innerHTML = this.state.freezeSelectedMembers.map(m => `
            <div class="member-chip">
                ${this.escapeHTML(m.name)}
                <button onclick="app.removeFreezeMember('${m.id}')" type="button" aria-label="${this.escapeHTML(m.name)}">
                    <i class="ph ph-x" aria-hidden="true"></i>
                </button>
            </div>
        `).join('');
    },

    // Object to freeze voting
    async objectToFreeze(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting || voting.type !== 'freeze' || voting.status !== 'active') return;

        if (voting.objections && voting.objections.some(o => o.userId === this.state.user.id)) {
            this.toastError(t.already_objected);
            return;
        }

        try {
            const { error } = await supabaseService.addFreezeObjection(votingId);
            if (error) {
                if (error.code === '23505') {
                    this.toastError(t.already_objected);
                } else {
                    throw new Error(error.message);
                }
                return;
            }

            // Reload votings to get fresh status (DB trigger may have auto-rejected)
            await this.loadMyVotings();

            const refreshedVoting = this.state.votings.find(v => v.id === votingId);
            if (refreshedVoting && refreshedVoting.status === 'completed') {
                this.toastWarning(t.freeze_auto_rejected);
            } else {
                this.toastSuccess(t.objection_added);
            }

            this.showVotingDetail(votingId);
        } catch (err) {
            this.toastError(this.humanError(err));
        }
    },

    changeLanguage(lang) {
        this.currentLanguage = lang;
        const t = this.translations[lang];
        
        // Update all elements with data-lang attribute.
        // Skip the Instructions modal — its headings carry an <i> icon as a
        // child, and a plain textContent assignment here would wipe it.
        // updateInstructionsContent() owns those elements and preserves icons.
        document.querySelectorAll('[data-lang]').forEach(el => {
            if (el.closest('#instructions-modal')) return;
            const key = el.getAttribute('data-lang');
            if (t[key]) {
                if (/<[a-z][\s\S]*>/i.test(t[key])) {
                    el.innerHTML = t[key];
                } else {
                    el.textContent = t[key];
                }
            }
        });
        
        // Update all placeholders with data-lang-placeholder attribute
        document.querySelectorAll('[data-lang-placeholder]').forEach(el => {
            const key = el.getAttribute('data-lang-placeholder');
            if (t[key]) {
                el.placeholder = t[key];
            }
        });
        
        // Sync all language selectors
        document.querySelectorAll('#language-select, #auth-language-select').forEach(sel => {
            sel.value = lang;
        });

        // Update document title
        const titles = {
            uk: 'Spilka - Голосування для спільнот',
            en: 'Spilka - Voting for communities',
            ru: 'Spilka - Голосования для сообществ'
        };
        document.title = titles[lang];

        // Update nav labels
        const navLabels = document.querySelectorAll('.nav-label');
        if (navLabels[0]) navLabels[0].textContent = t.voting;
        if (navLabels[1]) navLabels[1].textContent = t.groups;
        if (navLabels[2]) navLabels[2].textContent = t.notifications;
        if (navLabels[3]) navLabels[3].textContent = t.profile;
        
        // Save language preference
        localStorage.setItem('votecoop-language', lang);
        
        // Update instructions content
        this.updateInstructionsContent(lang);
        
        // Re-render dynamic content
        this.renderVotings();
        this.renderGroups();
        this.renderNotifications();

        // Refresh theme toggle label (it has a dynamic prefix)
        const currentTheme = localStorage.getItem('votecoop-theme') || 'auto';
        this.updateThemeToggleUI(currentTheme);
    },


    updateInstructionsContent(lang) {
        const t = this.translations[lang];
        if (!t) return;
        
        // Update all elements with data-lang in instructions modal
        const instructionsModal = document.getElementById('instructions-modal');
        if (instructionsModal) {
            instructionsModal.querySelectorAll('[data-lang]').forEach(el => {
                const key = el.getAttribute('data-lang');
                if (t[key]) {
                    // Preserve existing icons (<i> tags) and update only text
                    const icon = el.querySelector('i');
                    if (icon && el.getAttribute('data-lang').startsWith('instr_')) {
                        el.innerHTML = '';
                        el.appendChild(icon);
                        if (/<[a-z][\s\S]*>/i.test(t[key])) {
                            const span = document.createElement('span');
                            span.innerHTML = ' ' + t[key];
                            el.appendChild(span);
                        } else {
                            el.appendChild(document.createTextNode(' ' + t[key]));
                        }
                    } else if (/<[a-z][\s\S]*>/i.test(t[key])) {
                        el.innerHTML = t[key];
                    } else {
                        el.textContent = t[key];
                    }
                }
            });
        }
    },

    // Complete voting and apply automatic role changes
    completeVoting(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting || voting.status !== 'active') return;

        const group = this.state.groups.find(g => g.id === voting.groupId);
        if (!group) return;

        // Mark as completed
        voting.status = 'completed';
        voting.endedAt = new Date();

        // Check if passed (50%+1 votes)
        const passed = voting.yesVotes > voting.totalMembers / 2;
        voting.result = passed ? 'accepted' : 'rejected';

        if (passed) {
            if (voting.type === 'admin-change' && voting.targetMemberId) {
                // Find old admin
                const oldAdmin = group.members.find(m => m.role === 'admin');
                const newAdmin = group.members.find(m => m.id === voting.targetMemberId);

                if (oldAdmin && newAdmin) {
                    // Change roles
                    oldAdmin.role = 'member';
                    newAdmin.role = 'admin';

                    // Update group admin status for current user
                    if (oldAdmin.id === this.state.user.id) {
                        group.isAdmin = false;
                    }
                    if (newAdmin.id === this.state.user.id) {
                        group.isAdmin = true;
                    }

                    // Add to history
                    if (!group.history) group.history = [];
                    group.history.unshift({
                        date: new Date().toISOString(),
                        action: 'admin_change',
                        from: oldAdmin.name,
                        to: newAdmin.name,
                        initiator: voting.initiatorName,
                        votingId: voting.id
                    });

                    // Add notifications
                    this.state.notifications.unshift({
                        id: Date.now(),
                        type: 'system',
                        text: `${t.admin_change_success}: ${newAdmin.name} ${t.new_admin_is}`,
                        time: t.just_now,
                        read: false
                    });
                }
            } else if (voting.type === 'remove-member' && voting.targetMemberId) {
                const removedMember = group.members.find(m => m.id === voting.targetMemberId);
                
                if (removedMember) {
                    // Remove from group
                    group.members = group.members.filter(m => m.id !== voting.targetMemberId);
                    group.membersCount--;

                    // Add to history
                    if (!group.history) group.history = [];
                    group.history.unshift({
                        date: new Date().toISOString(),
                        action: 'member_removed',
                        member: removedMember.name,
                        reason: voting.removalReason,
                        initiator: voting.initiatorName,
                        votingId: voting.id
                    });

                    // Add notification
                    this.state.notifications.unshift({
                        id: Date.now(),
                        type: 'system',
                        text: `${t.member_removed}: ${removedMember.name}`,
                        time: t.just_now,
                        read: false
                    });

                    // If removed member is current user, remove group from list
                    if (removedMember.id === this.state.user.id) {
                        this.state.groups = this.state.groups.filter(g => g.id !== group.id);
                        this.state.notifications.unshift({
                            id: Date.now() + 1,
                            type: 'system',
                            text: `${t.removed_from_group} "${group.name}". ${t.removal_reason_label}: ${voting.removalReason}`,
                            time: t.just_now,
                            read: false
                        });
                    }
                }
            } else if (voting.type === 'freeze' && voting.freezeMembers) {
                // Apply freeze to selected members
                voting.freezeMembers.forEach(freezeMember => {
                    const member = group.members.find(m => m.id === freezeMember.id);
                    if (member) {
                        member.frozen = true;
                        member.frozenAt = new Date().toISOString();
                        member.frozenByVotingId = voting.id;
                    }
                });
                
                // Store frozen member IDs in voting
                voting.frozenMembers = voting.freezeMembers.map(m => m.id);
                
                // Add to history
                if (!group.history) group.history = [];
                group.history.unshift({
                    date: new Date().toISOString(),
                    action: 'members_frozen',
                    members: voting.freezeMembers.map(m => m.name),
                    count: voting.freezeMembers.length,
                    initiator: voting.initiatorName,
                    votingId: voting.id
                });
                
                // Add notification
                const frozenNames = voting.freezeMembers.map(m => m.name).join(', ');
                this.state.notifications.unshift({
                    id: Date.now(),
                    type: 'system',
                    text: `${t.members_frozen}: ${frozenNames}`,
                    time: t.just_now,
                    read: false
                });
                
                // If current user is frozen, update user state
                const currentUserFrozen = voting.freezeMembers.find(m => m.id === this.state.user.id);
                if (currentUserFrozen) {
                    this.state.user.frozen = true;
                    this.state.notifications.unshift({
                        id: Date.now() + 1,
                        type: 'system',
                        text: t.you_have_been_frozen,
                        time: t.just_now,
                        read: false
                    });
                }
            } else if (voting.type === 'delete-group') {
                const groupName = group ? group.name : voting.groupName;

                // Remove group from local state
                this.state.groups = this.state.groups.filter(g => g.id !== voting.groupId);

                // Notify user
                this.state.notifications.unshift({
                    id: Date.now(),
                    type: 'system',
                    text: `${t.group_deleted_by_voting}: "${groupName}"`,
                    time: t.just_now,
                    read: false
                });

                // If viewing this group, navigate away
                if (this.state.currentGroupId === voting.groupId) {
                    this.state.currentGroupId = null;
                    this.showScreen('groups-screen');
                }
            }
        }

        this.renderVotings();
        this.renderGroups();
        this.renderNotifications();
    },

    // Check and complete expired votings (call this periodically)
    checkExpiredVotings() {
        const now = new Date();
        this.state.votings.forEach(voting => {
            if (voting.status === 'active' && voting.endsAt <= now) {
                this.completeVoting(voting.id);
            }
        });
    },

    // Instructions content by language
    instructionsContent: {
        uk: {
            voting_types_title: '🗳️ Типи голосування',
            simple_voting_title: 'Звичайне голосування',
            simple_voting_desc: 'Відкрите голосування, де всі бачать, хто і як проголосував після свого вибору. Підходить для загальних питань ОСГ.',
            secret_voting_title: 'Тайне голосування',
            secret_voting_desc: 'Приховане голосування — після голосування ви бачите тільки загальну кількість «за» та «проти», без імен. Використовується для чутливих питань.',
            admin_change_title: 'Зміна адміністратора',
            admin_change_desc: 'Спеціальне голосування для зміни керівника групи. Вимагає мінімум 3 учасників. Триває 72 години. Для прийняття рішення потрібно 50%+1 голос. Поки йде голосування, адмін не може видаляти учасників.',
            remove_member_title: 'Видалення учасника',
            remove_member_desc: 'Голосування про виключення учасника з групи. Рішення приймається більшістю 50%+1 голос. Тривалість — 72 години.',
            group_management_title: '👥 Управління групою',
            create_group_title: 'Створення групи',
            create_group_desc: 'Будь-який користувач може створити групу. Система автоматично генерує унікальний 6-значний ID для запрошення.',
            join_group_title: 'Вступ до групи',
            join_group_desc: 'Введіть 6-значний ID групи в поле пошуку. Адміністратор отримає запит на підтвердження.',
            decision_title: 'Прийняття рішень',
            decision_desc: 'Для прийняття будь-якого рішення потрібно мінімум 50%+1 голос від усіх учасників групи. Якщо набрано менше — голосування вважається «не відбулися» (🟡).',
            delete_group_title: 'Видалення групи',
            delete_group_desc: 'Якщо адміністратор єдиний учасник групи — він може видалити її напряму. Якщо в групі 2 або більше учасників — видалення можливе тільки через голосування типу «Видалення групи».',
            delete_group_voting_title: 'Голосування «Видалення групи»',
            delete_group_voting_desc: 'Будь-який учасник може створити голосування за видалення групи. Мінімальна тривалість — 24 години. Якщо 50%+1 проголосувало «за» — група видаляється автоматично, а всі учасники отримують сповіщення.',
            leave_group_title: 'Вихід із групи',
            leave_group_desc: 'Будь-який учасник (крім адміністратора) може добровільно покинути групу через меню групи (⋮). Адміністратор повинен спочатку передати свою роль через голосування «Зміна адміністратора».',
            badges_title: '🎨 Позначення голосувань',
            badges_desc: '🟡 — Голосування не відбулося (менше 50%+1 голосів)\n🟢 — Прийнято «за» (більшість проголосувала позитивно)\n🔴 — Прийнято «проти» (більшість проголосувала негативно)',
            duration_title: '⏱️ Тривалість голосування',
            duration_desc: '• Звичайні голосування: від 1 години до 5 днів\n• Управлінські голосування (зміна адміна, видалення учасника): фіксовано 72 години\n• Видалення групи: від 24 годин\nРезультат визначається автоматично по закінченню терміну.',
            archive_title: '📋 Архівування',
            archive_desc: 'Адміністратор може експортувати історію голосувань групи до Google Sheets. У таблиці зберігаються: дата, питання, опис, результат, кількість учасників.'
        },
        en: {
            voting_types_title: '🗳️ Voting Types',
            simple_voting_title: 'Standard Voting',
            simple_voting_desc: 'Open voting where everyone can see who voted how after making their choice. Suitable for general HOA matters.',
            secret_voting_title: 'Secret Voting',
            secret_voting_desc: 'Hidden voting — after voting you only see the total number of "for" and "against" votes, without names. Used for sensitive matters.',
            admin_change_title: 'Change Administrator',
            admin_change_desc: 'Special voting to change group leader. Requires at least 3 members. Lasts 72 hours. Decision requires 50%+1 vote. While voting is in progress, admin cannot remove members.',
            remove_member_title: 'Remove Member',
            remove_member_desc: 'Voting to exclude a member from the group. Decision is made by majority 50%+1 vote. Duration — 72 hours.',
            group_management_title: '👥 Group Management',
            create_group_title: 'Creating a Group',
            create_group_desc: 'Any user can create a group. The system automatically generates a unique 6-digit ID for invitations.',
            join_group_title: 'Joining a Group',
            join_group_desc: 'Enter the 6-digit group ID in the search field. The administrator will receive a request for approval.',
            decision_title: 'Decision Making',
            decision_desc: 'To make any decision, at least 50%+1 vote from all group members is required. If fewer votes are cast — the voting is considered "did not take place" (🟡).',
            delete_group_title: 'Deleting a Group',
            delete_group_desc: 'If the administrator is the only member — they can delete the group directly. If there are 2 or more members — deletion is only possible through a "Delete group" voting.',
            delete_group_voting_title: '"Delete Group" Voting',
            delete_group_voting_desc: 'Any member can create a vote to delete the group. Minimum duration is 24 hours. If 50%+1 vote "yes" — the group is automatically deleted and all members are notified.',
            leave_group_title: 'Leaving a Group',
            leave_group_desc: 'Any member (except the administrator) can voluntarily leave the group via the group menu (⋮). The administrator must first transfer their role through a "Change Administrator" voting.',
            badges_title: '🎨 Voting Badges',
            badges_desc: '🟡 — Voting did not take place (less than 50%+1 votes)\n🟢 — Accepted "for" (majority voted positively)\n🔴 — Accepted "against" (majority voted negatively)',
            duration_title: '⏱️ Voting Duration',
            duration_desc: '• Standard voting: from 1 hour to 5 days\n• Administrative voting (change admin, member removal): fixed 72 hours\n• Group deletion: from 24 hours\nResult is determined automatically at the end of the term.',
            archive_title: '📋 Archiving',
            archive_desc: 'The administrator can export the group\'s voting history to Google Sheets. The table contains: date, question, description, result, number of participants.'
        },
        ru: {
            voting_types_title: '🗳️ Типы голосования',
            simple_voting_title: 'Обычное голосование',
            simple_voting_desc: 'Открытое голосование, где все видят, кто и как проголосовал после своего выбора. Подходит для общих вопросов ОСГ.',
            secret_voting_title: 'Тайное голосование',
            secret_voting_desc: 'Скрытое голосование — после голосования вы видите только общее количество «за» и «против», без имён. Используется для чувствительных вопросов.',
            admin_change_title: 'Смена администратора',
            admin_change_desc: 'Специальное голосование для смены руководителя группы. Требуется минимум 3 участника. Длится 72 часа. Для принятия решения нужно 50%+1 голос. Пока идёт голосование, админ не может удалять участников.',
            remove_member_title: 'Удаление участника',
            remove_member_desc: 'Голосование об исключении участника из группы. Решение принимается большинством 50%+1 голос. Длительность — 72 часа.',
            group_management_title: '👥 Управление группой',
            create_group_title: 'Создание группы',
            create_group_desc: 'Любой пользователь может создать группу. Система автоматически генерирует уникальный 6-значный ID для приглашения.',
            join_group_title: 'Вступление в группу',
            join_group_desc: 'Введите 6-значный ID группы в поле поиска. Администратор получит запрос на подтверждение.',
            decision_title: 'Принятие решений',
            decision_desc: 'Для принятия любого решения требуется минимум 50%+1 голос от всех участников группы. Если набрано меньше — голосование считается «не состоявшимся» (🟡).',
            delete_group_title: 'Удаление группы',
            delete_group_desc: 'Если администратор единственный участник группы — он может удалить её напрямую. Если в группе 2 или более участников — удаление возможно только через голосование типа «Удаление группы».',
            delete_group_voting_title: 'Голосование «Удаление группы»',
            delete_group_voting_desc: 'Любой участник может создать голосование за удаление группы. Минимальная длительность — 24 часа. Если 50%+1 проголосовало «за» — группа удаляется автоматически, а все участники получают уведомление.',
            leave_group_title: 'Выход из группы',
            leave_group_desc: 'Любой участник (кроме администратора) может добровольно покинуть группу через меню группы (⋮). Администратор должен сначала передать свою роль через голосование «Смена администратора».',
            badges_title: '🎨 Обозначения голосований',
            badges_desc: '🟡 — Голосование не состоялось (меньше 50%+1 голосов)\n🟢 — Принято «за» (большинство проголосовало положительно)\n🔴 — Принято «против» (большинство проголосовало отрицательно)',
            duration_title: '⏱️ Длительность голосования',
            duration_desc: '• Обычные голосования: от 1 часа до 5 дней\n• Административные голосования (смена админа, удаление участника): фиксировано 72 часа\n• Удаление группы: от 24 часов\nРезультат определяется автоматически по окончании срока.',
            archive_title: '📋 Архивирование',
            archive_desc: 'Администратор может экспортировать историю голосований группы в Google Sheets. В таблице сохраняются: дата, вопрос, описание, результат, количество участников.'
        }
    },



    // Edit Profile
    showEditProfile() {
        document.getElementById('edit-firstname').value = this.state.user.firstName;
        document.getElementById('edit-lastname').value = this.state.user.lastName;
        document.getElementById('edit-phone').value = this.state.user.phone;
        document.getElementById('edit-address').value = this.state.user.address;
        document.getElementById('edit-apartment').value = this.state.user.apartment;
        this.showModal('edit-profile-modal');
    },

    // Hide CTA after profile updated successfully
    _afterProfileUpdate() { this.refreshProfileCTA(); },

    async saveEditedProfile() {
        const t = this.translations[this.currentLanguage];
        const firstName = document.getElementById('edit-firstname').value.trim();
        const lastName = document.getElementById('edit-lastname').value.trim();
        const phone = document.getElementById('edit-phone').value.trim();
        const address = document.getElementById('edit-address').value.trim();
        const apartment = document.getElementById('edit-apartment').value.trim();

        this.state.user = {
            ...this.state.user,
            firstName,
            lastName,
            phone,
            address,
            apartment
        };

        // Save to Supabase if connected
        if (supabaseService.isReady() && this.state.user.id) {
            const { profile, error } = await supabaseService.updateProfile(this.state.user.id, {
                first_name: firstName,
                last_name: lastName,
                phone: phone,
                address: address,
                apartment: apartment
            });

            if (error) {
                this.toastError(t.auth_error_network);
                return;
            }
        }

        this.updateProfileDisplay();
        this.hideModal('edit-profile-modal');
        this.toastSuccess(t.profile_saved);
        this._afterProfileUpdate();
    },

    // Instructions
    showInstructions() {
        this.updateInstructionsContent(this.currentLanguage);
        this.showModal('instructions-modal');
    }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});