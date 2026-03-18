// VoteCoop App
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
        listenersAttached: false
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

        // Listen for auth state changes (handles OAuth redirect callback)
        supabaseService.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session) {
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

        // Load profile from DB
        const { profile, error } = await supabaseService.getProfile(userId);

        if (profile && profile.profile_completed) {
            // Profile complete — show main app
            this.state.user = {
                id: profile.id,
                firstName: profile.first_name,
                lastName: profile.last_name,
                email: userEmail,
                phone: profile.phone || '',
                address: profile.address || '',
                apartment: profile.apartment || ''
            };

            this.setupEventListeners();
            this.updateProfileDisplay();
            this.showScreen('main-screens');

            // Load data from Supabase in parallel
            try {
                await Promise.all([
                    this.loadMyGroups(),
                    this.loadMyVotings(),
                    this.loadMyNotifications()
                ]);
            } catch (loadErr) {
                // Data load failed silently — groups/votings may be empty
            }

            // Check expired votings (non-blocking)
            this.checkExpiredVotingsServer();

            // Periodic check every 60 seconds
            if (this._expiryInterval) clearInterval(this._expiryInterval);
            this._expiryInterval = setInterval(() => this.checkExpiredVotingsServer(), 60000);
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
        this.state.user = null;
        this.state.groups = [];
        this.state.votings = [];
        this.state.notifications = [];
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

    // Navigation
    showScreen(screenId) {
        const mainScreens = ['voting-screen', 'groups-screen', 'notifications-screen', 'profile-screen'];
        const topLevelScreens = ['loading-screen', 'auth-screen', 'profile-setup-screen'];
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
        this.setBtnLoading('auth-login-btn', true);

        const { data, error } = await supabaseService.signInWithEmail(email, password);

        this.setBtnLoading('auth-login-btn', false);

        if (error) {
            if (error.message.includes('Invalid login credentials')) {
                this.showAuthError(t.auth_error_invalid);
            } else if (error.message.includes('Email not confirmed')) {
                this.showAuthError(t.auth_error_not_confirmed);
            } else {
                this.showAuthError(t.auth_error_network);
            }
            return;
        }

        // Success — onAuthStateChange will handle the rest
    },

    // Register with email/password
    async registerWithEmail() {
        const t = this.translations[this.currentLanguage];
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;

        if (!email || !password) {
            this.showAuthError(t.auth_error_fill_fields);
            return;
        }

        if (password.length < 6) {
            this.showAuthError(t.auth_error_password_short);
            return;
        }

        if (!supabaseService.isReady()) {
            this.showAuthError(t.auth_error_network || 'Service unavailable');
            return;
        }

        this.hideAuthMessages();
        this.setBtnLoading('auth-register-btn', true);

        const { data, error } = await supabaseService.signUpWithEmail(email, password);

        this.setBtnLoading('auth-register-btn', false);

        if (error) {
            if (error.message.includes('already registered')) {
                this.showAuthError(t.auth_error_exists);
            } else {
                this.showAuthError(error.message);
            }
            return;
        }

        // Check if email confirmation is required
        if (data?.user?.identities?.length === 0) {
            this.showAuthError(t.auth_error_exists);
        } else {
            this.showAuthSuccess(t.auth_check_email);
        }
    },

    // Reset password
    async resetPassword() {
        const t = this.translations[this.currentLanguage];
        const email = document.getElementById('auth-email').value.trim();

        if (!email) {
            this.showAuthError(t.auth_error_enter_email);
            return;
        }

        if (!supabaseService.isReady()) {
            this.showAuthError(t.auth_error_network);
            return;
        }

        this.hideAuthMessages();

        const { data, error } = await supabaseService.resetPassword(email);

        if (error) {
            this.showAuthError(error.message);
            return;
        }

        this.showAuthSuccess(t.auth_reset_sent);
    },


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
            alert(t.fill_name_error);
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
                alert(t.auth_error_network);
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
    },

    showTermsModal() {
        document.getElementById('terms-agree').checked = false;
        this.showModal('terms-modal');
    },

    async acceptTerms() {
        const t = this.translations[this.currentLanguage];
        const agreed = document.getElementById('terms-agree').checked;

        if (!agreed) {
            alert(t.terms_agree_text);
            return;
        }

        this.hideModal('terms-modal');
        document.getElementById('profile-setup-screen').classList.add('hidden');
        document.getElementById('main-screens').classList.remove('hidden');

        this.setupEventListeners();
        this.showScreen('voting-screen');
        this.updateProfileDisplay();

        // Load data from Supabase
        try {
            await Promise.all([
                this.loadMyGroups(),
                this.loadMyVotings(),
                this.loadMyNotifications()
            ]);
        } catch (loadErr) {
            console.error('[acceptTerms] Data load failed:', loadErr);
        }

        // Start periodic check
        if (this._expiryInterval) clearInterval(this._expiryInterval);
        this._expiryInterval = setInterval(() => this.checkExpiredVotingsServer(), 60000);
    },

    async logout() {
        if (supabaseService.isReady()) {
            await supabaseService.signOut();
        }
        // Clear state and reload
        location.reload();
    },

    // === DATA LOADING FROM SUPABASE ===

    async loadMyGroups() {
        const { data, error } = await supabaseService.getMyGroups();
        if (error || !data) return;

        const groupIds = data.map(item => item.group.id);
        const { data: stats } = await supabaseService.getGroupsStats(groupIds);
        const statsMap = {};
        (stats || []).forEach(s => { statsMap[s.group_id] = s; });

        this.state.groups = data.map(item => {
            const s = statsMap[item.group.id] || {};
            return {
                id: item.group.id,
                name: item.group.name,
                description: item.group.description,
                groupId: item.group.group_code,
                isAdmin: item.role === 'admin',
                membersCount: s.members_count || 0,
                votingsCount: s.total_votings_count || 0,
                members: [],
                requests: [],
                history: []
            };
        });

        this.renderGroups();
        this.updateProfileDisplay();
    },

    async loadMyVotings() {
        const { data: votings, error } = await supabaseService.getMyVotings();
        if (error || !votings) return;

        const votingIds = votings.map(v => v.id);
        const { data: results } = await supabaseService.getVotingResults(votingIds);
        const resultsMap = {};
        (results || []).forEach(r => { resultsMap[r.voting_id] = r; });

        // Check which votings user has voted on
        const userId = this.state.user.id;
        let votedSet = new Set();
        if (votingIds.length > 0) {
            const { data: myVotes } = await supabaseService.client.from('votes')
                .select('voting_id')
                .eq('user_id', userId)
                .in('voting_id', votingIds);
            votedSet = new Set((myVotes || []).map(mv => mv.voting_id));
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

        // Populate totalMembers from group_stats
        const groupIds = [...new Set(votings.map(v => v.group_id))];
        if (groupIds.length > 0) {
            const { data: allStats } = await supabaseService.client.from('group_stats')
                .select('group_id, members_count')
                .in('group_id', groupIds);
            const statsMap = {};
            (allStats || []).forEach(s => { statsMap[s.group_id] = s.members_count; });
            this.state.votings.forEach(v => {
                v.totalMembers = statsMap[v.groupId] || 1;
            });
        }

        this.renderVotings();
    },

    async loadMyNotifications() {
        const { data, error } = await supabaseService.getMyNotifications();
        if (error || !data) return;

        this.state.notifications = data.map(n => ({
            id: n.id,
            type: n.type,
            text: n.text,
            time: new Date(n.created_at).toLocaleString(),
            read: n.is_read
        }));

        this.renderNotifications();
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
            list.innerHTML = `<div class="empty-state">${t.empty_votings}</div>`;
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
        if (diff <= 0) return t.completed;
        
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
            list.innerHTML = `<div class="empty-state">${t.empty_groups}</div>`;
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
            list.innerHTML = `<div class="empty-state">${t.empty_notifications}</div>`;
            return;
        }

        list.innerHTML = this.state.notifications.map(notif => {
            const icons = {
                voting: '<i class="ph ph-scales"></i>',
                member: '<i class="ph ph-user"></i>',
                result: '<i class="ph ph-check-circle"></i>',
                system: '🔔'
            };

            return `
                <div class="notification-item ${notif.read ? 'read' : 'unread'}" role="button" tabindex="0" onclick="app.markRead('${notif.id}')" onkeydown="if(event.key==='Enter')app.markRead('${notif.id}')">
                    <div class="notification-icon">${icons[notif.type] || '🔔'}</div>
                    <div class="notification-content">
                        <div class="notification-text">${this.escapeHTML(notif.text)}</div>
                        <div class="notification-time">${this.escapeHTML(notif.time)}</div>
                    </div>
                    ${!notif.read ? '<div class="notification-dot"></div>' : ''}
                </div>
            `;
        }).join('');
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

    // Modals
    showModal(modalId) {
        document.getElementById(modalId).classList.remove('hidden');
    },

    hideModal(modalId) {
        document.getElementById(modalId).classList.add('hidden');
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
            // Fixed 7 days (168 hours) for freeze votes
            durationGroup.classList.add('hidden');
            document.getElementById('voting-duration').value = '168';

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
            alert(t.fill_name_error || 'Введіть назву групи');
            return;
        }

        if (!this.state.user) {
            alert(t.auth_error_network || 'User not authenticated');
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
            alert(t.auth_error_network || 'Error creating group');
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
    },

    async createVoting() {
        const t = this.translations[this.currentLanguage];

        if (!this.state.user) {
            alert(t.auth_error_network || 'User not authenticated');
            return;
        }

        if (!this.state.user.apartment) {
            alert(t.apartment_required);
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
            alert(t.fill_name_error);
            return;
        }

        const group = this.state.groups.find(g => g.id === groupId);

        // Check daily limit for non-admin users
        if (!group.isAdmin) {
            const lastVotingTime = this.state.userVotingHistory[groupId];
            if (lastVotingTime) {
                const hoursSinceLastVoting = (Date.now() - lastVotingTime) / (1000 * 60 * 60);
                if (hoursSinceLastVoting < 24) {
                    alert(t.daily_limit_reached);
                    return;
                }
            }
        }

        if ((type === 'admin-change' || type === 'remove-member') && group.membersCount < 3) {
            alert(t.min_3_members_required);
            return;
        }

        if ((type === 'admin-change' || type === 'remove-member') && !targetMemberId) {
            alert(t.select_member);
            return;
        }

        let removalReason = '';
        if (type === 'remove-member') {
            if (!reasonSelect.value) {
                alert(t.select_reason);
                return;
            }
            removalReason = reasonSelect.value === 'other' ? reasonText.value : t[`reason_${reasonSelect.value}`];
        }

        if (type === 'admin-change') {
            const existingAdminChange = this.state.votings.find(v =>
                v.groupId === groupId && v.type === 'admin-change' && v.status === 'active'
            );
            if (existingAdminChange) {
                alert(t.one_admin_change_at_time);
                return;
            }
        }

        if (type === 'freeze') {
            if (!group.isAdmin) {
                alert(t.only_admin_can_freeze);
                return;
            }
            if (!this.state.freezeSelectedMembers || this.state.freezeSelectedMembers.length === 0) {
                alert(t.select_freeze_members);
                return;
            }
        }

        if (type === 'delete-group') {
            const existingDeleteGroup = this.state.votings.find(v =>
                v.groupId === groupId && v.type === 'delete-group' && v.status === 'active'
            );
            if (existingDeleteGroup) {
                alert(t.one_delete_group_at_time);
                return;
            }
            if (duration < 24) {
                alert(t.min_duration_24h);
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
                freezeDurationDays: type === 'freeze' ? 7 : null
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
        } catch (err) {
            alert(t.auth_error_network || 'Error creating voting');
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }

        // Clear form
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
    },

    async joinGroup() {
        const t = this.translations[this.currentLanguage];
        const code = document.getElementById('join-group-id').value.trim();
        if (!code || code.length !== 6) {
            alert(t.enter_group_id_error || 'Введіть коректний ID групи (6 цифр)');
            return;
        }

        // Check if already member locally
        const existing = this.state.groups.find(g => g.groupId === code);
        if (existing) {
            alert(t.already_member || 'Ви вже є учасником цієї групи');
            return;
        }

        try {
            // Find group by code
            const { data: group, error: findErr } = await supabaseService.findGroupByCode(code);
            if (findErr || !group) {
                alert(t.group_not_found || 'Групу не знайдено');
                return;
            }

            // Send join request
            const { data: request, error: reqErr } = await supabaseService.sendJoinRequest(group.id);
            if (reqErr) {
                if (reqErr.code === '23505') {
                    alert(t.already_requested || 'Запит вже надіслано');
                } else {
                    throw new Error(reqErr.message);
                }
                return;
            }

            document.getElementById('join-group-id').value = '';

            // Create notification in DB
            await supabaseService.createNotification(
                this.state.user.id,
                'system',
                `${t.join_request_sent || 'Запит на приєднання надіслано'}: ${group.name}`
            );

            // Add notification locally for instant display
            this.state.notifications.unshift({
                id: request.id,
                type: 'system',
                text: `${t.join_request_sent || 'Запит на приєднання надіслано'}: ${group.name}`,
                time: new Date().toLocaleString(),
                read: false
            });
            this.renderNotifications();

            alert(t.join_request_sent || 'Запит на приєднання надіслано');
        } catch (err) {
            alert(t.auth_error_network || 'Помилка мережі');
        }
    },

    // Voting detail
    async showVotingDetail(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting) return;

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
                        userName: o.user ? `${o.user.first_name} ${o.user.last_name}`.trim() : ''
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

        const content = document.getElementById('voting-detail-content');
        const isActive = voting.status === 'active';
        const isAuthor = voting.initiatorId === this.state.user.id;
        const abstainVotes = voting.abstainVotes || 0;
        const safeTotal = voting.totalMembers > 0 ? voting.totalMembers : 1;
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
                    ${isActive ? `<i class="ph-fill ph-circle text-danger" aria-hidden="true"></i> ${t.active_votings}` : `<i class="ph-fill ph-check-circle text-success" aria-hidden="true"></i> ${t.completed}`}
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
                    <span class="result-label">${t.participation_label}: ${participation}% (${totalVoted}/${voting.totalMembers})</span>
                </div>
            </div>
            ` : freezeResults}

            ${!isFreeze && isActive && !voting.hasVoted ? `
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
                    <button class="btn btn-danger" onclick="app.showDeleteVotingModal('${voting.id}')">🗑️ ${t.delete}</button>
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

    async vote(votingId, voteType) {
        const t = this.translations[this.currentLanguage];

        if (!this.state.user.apartment) {
            alert(t.apartment_required);
            return;
        }

        if (this.state.user.frozen) {
            alert(t.frozen_cannot_vote);
            return;
        }

        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting || voting.hasVoted) return;

        const commentField = document.getElementById('vote-comment');
        const comment = commentField ? commentField.value.trim().substring(0, 500) : '';

        const choiceMap = { true: 'yes', yes: 'yes', false: 'no', no: 'no', abstain: 'abstain' };
        const choice = choiceMap[String(voteType)] || 'abstain';

        try {
            const { data, error } = await supabaseService.castVote(votingId, choice, comment);
            if (error) {
                if (error.code === '23505') {
                    alert(t.already_voted || 'Ви вже проголосували');
                    voting.hasVoted = true;
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
                vote: choice,
                comment,
                time: new Date().toLocaleString()
            });

            voting.hasVoted = true;
            this.renderVotings();
            this.showVotingDetail(votingId);
        } catch (err) {
            alert(t.auth_error_network || 'Помилка голосування');
        }
    },

    // Show delete voting modal
    showDeleteVotingModal(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        
        if (!voting) return;
        
        // Check if voting is completed
        if (voting.status === 'completed') {
            alert(t.cannot_delete_completed);
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
            alert(t.delete_reason_short);
            return;
        }

        if (reason.length > 200) {
            alert('Причина занадто довга (макс. 200 символів)');
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

            alert(t.voting_deleted);
        } catch (err) {
            alert(t.auth_error_network || 'Помилка');
        }
    },

    // Group detail
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
                frozenUntil: m.frozen_until
            }));

            group.requests = (data.requests || []).map(r => ({
                id: r.id,
                userId: r.user_id,
                name: `${r.user.first_name} ${r.user.last_name}`.trim(),
                address: r.user.address ? `${r.user.address}, кв. ${r.user.apartment}` : `кв. ${r.user.apartment || '-'}`
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

        // Count frozen members
        const members = group.members || [];
        const frozenCount = members.filter(m => m.frozen).length;

        document.getElementById('group-members-count').textContent = group.membersCount;

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

        // Render members with participation data
        this.renderMembersList(group);
    },

    // Calculate member participation in group votings
    getMemberParticipation(memberId, groupId) {
        const groupVotings = this.state.votings.filter(v => v.groupId === groupId);
        const totalVotings = groupVotings.length;
        if (totalVotings === 0) return { participated: 0, total: 0, percentage: 0 };
        
        const participated = groupVotings.filter(v => {
            return v.comments && v.comments.some(c => c.userId === memberId);
        }).length;
        
        return { participated, total: totalVotings, percentage: Math.round((participated / totalVotings) * 100) };
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
        
        membersList.innerHTML = membersWithStats.map(member => {
            const participationText = `${member.participation.participated}/${member.participation.total}`;
            const frozenIndicator = member.frozen ? `<i class="ph-fill ph-snowflake frozen-indicator" title="${t.frozen_badge}" aria-hidden="true"></i>` : '';
            return `
            <div class="member-card ${member.frozen ? 'frozen' : ''}">
                <div class="member-avatar">
                    <i class="ph ph-user ${member.frozen ? 'text-info' : ''}" aria-hidden="true"></i>
                </div>
                <div class="member-info">
                    <div class="member-name">${this.escapeHTML(member.name)} ${frozenIndicator}</div>
                    <div class="member-address">${this.escapeHTML(member.address || 'кв. -')}</div>
                </div>
                <div class="member-participation ${member.frozen ? 'text-info' : ''}">
                    ${member.frozen ? `<i class="ph-fill ph-snowflake" aria-hidden="true"></i> ${t.frozen_badge}` : participationText}
                </div>
            </div>
        `}).join('');

        // Render requests (only for admin)
        const requestsList = document.getElementById('requests-list');
        if (group.isAdmin && group.requests.length > 0) {
            requestsList.innerHTML = group.requests.map(request => `
                <div class="request-item">
                    <div class="request-avatar"><i class="ph ph-user" aria-hidden="true"></i></div>
                    <div class="request-info">
                        <div class="request-name">${this.escapeHTML(request.name)}</div>
                        <div class="request-address">${this.escapeHTML(request.address)}</div>
                    </div>
                    <div class="request-actions">
                        <button class="btn-small btn-approve" onclick="app.approveRequest('${group.id}', '${request.id}')" aria-label="${t.approve || 'Approve'}"><i class="ph ph-check" aria-hidden="true"></i></button>
                        <button class="btn-small btn-reject" onclick="app.rejectRequest('${group.id}', '${request.id}')" aria-label="${t.reject || 'Reject'}"><i class="ph ph-x" aria-hidden="true"></i></button>
                    </div>
                </div>
            `).join('');
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
            alert('Немає голосувань для експорту');
            return;
        }

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
                    const unit = this.state.user.apartment || 'N/A';
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
            ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(';');
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

    async approveRequest(groupId, requestId) {
        const t = this.translations[this.currentLanguage];
        try {
            const { error } = await supabaseService.approveJoinRequest(requestId);
            if (error) throw new Error(error.message);
            await this.showGroupDetail(groupId);
        } catch (err) {
            alert(t.auth_error_network || 'Помилка');
        }
    },

    async rejectRequest(groupId, requestId) {
        const t = this.translations[this.currentLanguage];
        try {
            const { error } = await supabaseService.rejectJoinRequest(requestId);
            if (error) throw new Error(error.message);
            await this.showGroupDetail(groupId);
        } catch (err) {
            alert(t.auth_error_network || 'Помилка');
        }
    },

    copyGroupId() {
        const groupId = document.getElementById('group-detail-id').textContent;
        navigator.clipboard.writeText(groupId).then(() => {
            alert('ID скопійовано: ' + groupId);
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
            alert(t.group_name_required || 'Введіть назву групи');
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
            alert(t.auth_error_network || err.message);
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
            alert(t.delete_group_need_voting);
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
            alert(t.auth_error_network || err.message);
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
            alert(t.auth_error_network || err.message);
        } finally {
            if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
        }
    },

    updateProfileDisplay() {
        if (!this.state.user) return;
        document.getElementById('profile-name').textContent =
            `${this.state.user.firstName || ''} ${this.state.user.lastName || ''}`.trim();
        document.getElementById('profile-email').textContent = this.state.user.email || '';
        document.getElementById('profile-phone-display').textContent = this.state.user.phone || '';
        document.getElementById('profile-address-display').textContent =
            this.state.user.address ? `${this.state.user.address}, кв. ${this.state.user.apartment}` : '';
        document.getElementById('profile-groups-count').textContent = this.state.groups.length;
    },

    // Language Support
    translations: {
        uk: {
            profile: 'Профіль',
            edit_profile: 'Редагувати профіль',
            instructions: 'Інструкції',
            instructions_title: 'Інструкції з використання',
            logout: 'Вийти',
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
            type_freeze: 'Заморозка учасників',
            freeze_members: 'Учасники для заморозки',
            freeze_info: 'Заморозка діє 7 днів. Будь-які 2 учасники можуть оскаржити.',
            freeze_proposal: 'Пропозиція заморозки',
            freeze_duration_info: 'Термін дії: 7 днів. Якщо 2 учасники не згодні — заморозка скасовується.',
            freeze_voting: 'Заморозка',
            only_admin_can_freeze: 'Тільки адміністратор може створити голосування на заморозку',
            select_freeze_members: 'Виберіть хоча б одного учасника для заморозки',
            i_disagree: 'Я не згоден',
            disagree_info: 'Якщо збереться 2 учасники, які не згодні — заморозка буде скасована автоматично.',
            you_objected: 'Ви висловили незгоду',
            already_objected: 'Ви вже висловили незгоду',
            objection_added: 'Вашу незгоду записано',
            objections_title: 'Незгода',
            no_objections: 'Поки що ніхто не висловив незгоду',
            objections_needed: 'Потрібно ще {count} учасників для скасування',
            auto_rejected: 'автоматично відхилено',
            freeze_rejected: 'Заморозку відхилено',
            freeze_auto_rejected: 'Заморозку автоматично відхилено через 2 незгоди',
            frozen_badge: 'заморожено',
            frozen_abbr: 'замор.',
            frozen_cannot_vote: 'Ви заморожені та не можете голосувати',
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
            group_not_found: 'Групу не знайдено',
            already_requested: 'Запит вже надіслано',
            join_request_sent: 'Запит на приєднання надіслано',
            already_member: 'Ви вже є учасником цієї групи',
            enter_group_id_error: 'Введіть коректний ID групи (6 цифр)',
            empty_votings: 'Немає голосувань',
            empty_notifications: 'Немає сповіщень',
            select_group: 'Виберіть групу',
            secret_voting: 'Тайне',
            open_voting: 'Відкрите',
            completed: 'Завершено',
            days: 'дн.',
            hours: 'год.',
            yes: 'За',
            no: 'Проти',
            participation: 'участі',
            instructions_title: 'Як користуватися VoteCoop',
            instr_quick_start: 'Швидкий старт',
            instr_qs_step1: '1. <strong>Увійдіть</strong> через Google-акаунт',
            instr_qs_step2: '2. <strong>Заповніть профіль</strong> — вкажіть ім\'я, прізвище, телефон та номер квартири/ділянки (обов\'язково для голосування)',
            instr_qs_step3: '3. <strong>Створіть групу</strong> або <strong>приєднайтесь</strong> до існуючої за 6-значним кодом',
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
            instr_join_group_desc: 'Введіть 6-значний код групи у поле «Приєднатися» і натисніть кнопку. Адміністратор отримає запит і має його схвалити або відхилити.',
            instr_group_detail_title: 'Сторінка групи',
            instr_group_detail_desc: 'Натисніть на групу, щоб побачити: код групи (можна скопіювати), статистику, список учасників, запити на вступ та історію змін.',
            instr_members_title: 'Учасники групи',
            instr_members_desc: 'У списку учасників можна: шукати за ім\'ям або телефоном, сортувати за алфавітом або за участю в голосуваннях. Заморожені учасники позначені ❄️.',
            instr_requests_title: 'Запити на вступ',
            instr_requests_desc: 'Адміністратор бачить вхідні запити та може схвалити або відхилити кожного кандидата. Учаснику надійде сповіщення про рішення.',
            instr_voting_types: 'Типи голосування',
            instr_simple_title: 'Звичайне (відкрите)',
            instr_simple_desc: 'Відкрите голосування — всі бачать, хто і як проголосував. Підходить для загальних питань: ремонт, витрати, правила. Тривалість: від 1 години до 5 днів.',
            instr_secret_title: 'Тайне',
            instr_secret_desc: 'Анонімне голосування — видно лише загальну кількість голосів «За/Проти/Утримався», без імен. Коментарі приховані. Для чутливих питань.',
            instr_admin_title: 'Зміна адміністратора',
            instr_admin_desc: 'Голосування за нового керівника групи. Вимоги: мін. 3 учасники, 72 години, 50%+1 для прийняття. При успіху — ролі міняються автоматично.',
            instr_remove_title: 'Видалення учасника',
            instr_remove_desc: 'Голосування за виключення учасника. Потрібно вказати причину. Вимоги: мін. 3 учасники, 72 години, 50%+1 для прийняття. При успіху — учасник видаляється автоматично.',
            instr_freeze_title: 'Заморозка учасника (BETA)',
            instr_freeze_desc: 'Тільки адміністратор може створити. Обирає учасників для заморозки на 7 днів. Заморожений учасник не може голосувати. Якщо 2+ учасники натиснуть «Не згоден» — заморозка автоматично скасовується.',
            instr_delete_group_title: 'Видалення групи',
            instr_delete_group_desc: 'Будь-який учасник може створити голосування за видалення групи. Мінімальна тривалість — 24 години. Якщо 50%+1 проголосувало «за» — група видаляється автоматично, а всі учасники отримують сповіщення.',
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
            instr_badge_frozen: 'Заморожений учасник (не може голосувати)',
            instr_badge_admin: 'Адміністратор групи',
            instr_rules: 'Правила та терміни',
            instr_duration_title: 'Тривалість',
            instr_duration_1: '• Звичайні/тайні голосування: від 1 години до 5 днів',
            instr_duration_2: '• Зміна адміна / Видалення учасника: фіксовано 72 години',
            instr_duration_3: '• Заморозка: 7 днів дії після прийняття',
            instr_decision_title: 'Прийняття рішень',
            instr_decision_desc: 'Для прийняття рішення потрібно 50%+1 голос від усіх учасників групи. Результат визначається автоматично по завершенню терміну.',
            instr_limits_title: 'Обмеження',
            instr_limits_desc: '• Без номера квартири/ділянки — голосувати не можна<br>• Звичайний учасник: макс. 1 голосування на день у кожній групі<br>• Адміністратор: без обмежень<br>• Зміна адміна / видалення: мін. 3 учасники в групі',
            instr_export: 'Експорт даних',
            instr_export_desc: 'Адміністратор може завантажити історію голосувань групи у CSV-файл. У файлі: дата, автор, питання, тип, результат, кількість голосів «За/Проти/Утримався», коментарі. Файл відкривається в Excel або Google Sheets.',
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
            vote_against: 'Проти',
            vote_for: 'За',
            admin_full: 'Адміністратор',
            no_requests: 'Немає запитів',
            join_requests: 'Запити на вступ',
            target_member: 'Учасник',
            select_member: 'Виберіть учасника',
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
            auth_error_network: 'Помилка мережі. Спробуйте пізніше.',
            auth_error_fill_fields: 'Заповніть email та пароль',
            auth_error_password_short: 'Пароль має бути не менше 6 символів',
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
            min_duration_24h: 'Мінімальна тривалість для цього типу голосування — 24 години.'
        },
        en: {
            profile: 'Profile',
            edit_profile: 'Edit Profile',
            instructions: 'Instructions',
            instructions_title: 'User Instructions',
            logout: 'Logout',
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
            type_freeze: 'Freeze members',
            freeze_members: 'Members to freeze',
            freeze_info: 'Freeze lasts 7 days. Any 2 members can object.',
            freeze_proposal: 'Freeze proposal',
            freeze_duration_info: 'Duration: 7 days. If 2 members disagree — freeze is cancelled.',
            freeze_voting: 'Freeze',
            only_admin_can_freeze: 'Only administrator can create freeze voting',
            select_freeze_members: 'Select at least one member to freeze',
            i_disagree: 'I disagree',
            disagree_info: 'If 2 members disagree — freeze will be automatically cancelled.',
            you_objected: 'You have objected',
            already_objected: 'You have already objected',
            objection_added: 'Your objection has been recorded',
            objections_title: 'Objections',
            no_objections: 'No objections yet',
            objections_needed: 'Need {count} more members to cancel',
            auto_rejected: 'automatically rejected',
            freeze_rejected: 'Freeze rejected',
            freeze_auto_rejected: 'Freeze automatically rejected due to 2 objections',
            frozen_badge: 'frozen',
            frozen_abbr: 'frz.',
            frozen_cannot_vote: 'You are frozen and cannot vote',
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
            empty_groups: 'You have not joined any groups yet',
            group_not_found: 'Group not found',
            already_requested: 'Request already sent',
            join_request_sent: 'Join request sent',
            already_member: 'You are already a member of this group',
            enter_group_id_error: 'Enter a valid group ID (6 digits)',
            empty_votings: 'No votings',
            empty_notifications: 'No notifications',
            select_group: 'Select group',
            secret_voting: 'Secret',
            open_voting: 'Open',
            completed: 'Completed',
            days: 'days',
            hours: 'hours',
            yes: 'Yes',
            no: 'No',
            participation: 'participation',
            instructions_title: 'How to use VoteCoop',
            instr_quick_start: 'Quick Start',
            instr_qs_step1: '1. <strong>Sign in</strong> with your Google account',
            instr_qs_step2: '2. <strong>Complete your profile</strong> — enter name, phone, and apartment/plot number (required to vote)',
            instr_qs_step3: '3. <strong>Create a group</strong> or <strong>join</strong> an existing one using the 6-digit code',
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
            instr_join_group_desc: 'Enter the 6-digit group code in the "Join" field and tap the button. The administrator will receive a request and must approve or reject it.',
            instr_group_detail_title: 'Group Page',
            instr_group_detail_desc: 'Tap a group to see: group code (can copy), statistics, member list, join requests, and change history.',
            instr_members_title: 'Group Members',
            instr_members_desc: 'In the member list you can: search by name or phone, sort alphabetically or by voting participation. Frozen members are marked with ❄️.',
            instr_requests_title: 'Join Requests',
            instr_requests_desc: 'The administrator sees incoming requests and can approve or reject each candidate. The applicant will be notified of the decision.',
            instr_voting_types: 'Voting Types',
            instr_simple_title: 'Standard (Open)',
            instr_simple_desc: 'Open voting — everyone can see who voted and how. Suitable for general matters: repairs, expenses, rules. Duration: 1 hour to 5 days.',
            instr_secret_title: 'Secret',
            instr_secret_desc: 'Anonymous voting — only total vote counts are visible (Yes/No/Abstain), without names. Comments are hidden. For sensitive matters.',
            instr_admin_title: 'Change Administrator',
            instr_admin_desc: 'Vote for a new group leader. Requirements: min. 3 members, 72 hours, 50%+1 to accept. On success — roles are swapped automatically.',
            instr_remove_title: 'Remove Member',
            instr_remove_desc: 'Vote to exclude a member. A reason must be provided. Requirements: min. 3 members, 72 hours, 50%+1 to accept. On success — the member is removed automatically.',
            instr_freeze_title: 'Freeze Member (BETA)',
            instr_freeze_desc: 'Only the administrator can create this. Select members to freeze for 7 days. Frozen members cannot vote. If 2+ members click "I Disagree" — the freeze is automatically cancelled.',
            instr_delete_group_title: 'Delete Group',
            instr_delete_group_desc: 'Any member can create a vote to delete the group. Minimum duration is 24 hours. If 50%+1 vote "yes" — the group is automatically deleted and all members are notified.',
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
            instr_badge_frozen: 'Frozen member (cannot vote)',
            instr_badge_admin: 'Group administrator',
            instr_rules: 'Rules & Timeframes',
            instr_duration_title: 'Duration',
            instr_duration_1: '• Standard/secret votings: 1 hour to 5 days',
            instr_duration_2: '• Change admin / Remove member: fixed 72 hours',
            instr_duration_3: '• Freeze: 7 days effective after acceptance',
            instr_decision_title: 'Decision Making',
            instr_decision_desc: 'A 50%+1 vote from all group members is required for any decision. Results are determined automatically when the time expires.',
            instr_limits_title: 'Limits',
            instr_limits_desc: '• Without apartment/plot number — you cannot vote<br>• Regular member: max 1 voting per day per group<br>• Administrator: no limits<br>• Change admin / removal: min. 3 members in group',
            instr_export: 'Data Export',
            instr_export_desc: 'The administrator can download the group\'s voting history as a CSV file. Contents: date, author, question, type, result, vote counts (Yes/No/Abstain), comments. Opens in Excel or Google Sheets.',
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
            vote_against: 'No',
            vote_for: 'Yes',
            admin_full: 'Administrator',
            no_requests: 'No requests',
            join_requests: 'Join requests',
            target_member: 'Member',
            select_member: 'Select member',
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
            auth_error_network: 'Network error. Please try again later.',
            auth_error_fill_fields: 'Please fill in email and password',
            auth_error_password_short: 'Password must be at least 6 characters',
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
            min_duration_24h: 'Minimum duration for this voting type is 24 hours.'
        },
        ru: {
            profile: 'Профиль',
            edit_profile: 'Редактировать профиль',
            instructions: 'Инструкции',
            instructions_title: 'Инструкции по использованию',
            logout: 'Выйти',
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
            type_freeze: 'Заморозка участников',
            freeze_members: 'Участники для заморозки',
            freeze_info: 'Заморозка действует 7 дней. Любые 2 участника могут оспорить.',
            freeze_proposal: 'Предложение заморозки',
            freeze_duration_info: 'Срок действия: 7 дней. Если 2 участника не согласны — заморозка отменяется.',
            freeze_voting: 'Заморозка',
            only_admin_can_freeze: 'Только администратор может создать голосование на заморозку',
            select_freeze_members: 'Выберите хотя бы одного участника для заморозки',
            i_disagree: 'Я не согласен',
            disagree_info: 'Если соберётся 2 участника, которые не согласны — заморозка будет отменена автоматически.',
            you_objected: 'Вы выразили несогласие',
            already_objected: 'Вы уже выразили несогласие',
            objection_added: 'Ваше несогласие записано',
            objections_title: 'Несогласие',
            no_objections: 'Пока никто не выразил несогласие',
            objections_needed: 'Нужно ещё {count} участников для отмены',
            auto_rejected: 'автоматически отклонено',
            freeze_rejected: 'Заморозка отклонена',
            freeze_auto_rejected: 'Заморозка автоматически отклонена из-за 2 несогласий',
            frozen_badge: 'заморожено',
            frozen_abbr: 'замор.',
            frozen_cannot_vote: 'Вы заморожены и не можете голосовать',
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
            group_not_found: 'Группа не найдена',
            already_requested: 'Запрос уже отправлен',
            join_request_sent: 'Запрос на присоединение отправлен',
            already_member: 'Вы уже являетесь участником этой группы',
            enter_group_id_error: 'Введите корректный ID группы (6 цифр)',
            empty_votings: 'Нет голосований',
            empty_notifications: 'Нет уведомлений',
            select_group: 'Выберите группу',
            secret_voting: 'Тайное',
            open_voting: 'Открытое',
            completed: 'Завершено',
            days: 'дн.',
            hours: 'час.',
            yes: 'За',
            no: 'Против',
            participation: 'участия',
            instructions_title: 'Как пользоваться VoteCoop',
            instr_quick_start: 'Быстрый старт',
            instr_qs_step1: '1. <strong>Войдите</strong> через Google-аккаунт',
            instr_qs_step2: '2. <strong>Заполните профиль</strong> — укажите имя, фамилию, телефон и номер квартиры/участка (обязательно для голосования)',
            instr_qs_step3: '3. <strong>Создайте группу</strong> или <strong>присоединитесь</strong> к существующей по 6-значному коду',
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
            instr_join_group_desc: 'Введите 6-значный код группы в поле «Присоединиться» и нажмите кнопку. Администратор получит запрос и должен его одобрить или отклонить.',
            instr_group_detail_title: 'Страница группы',
            instr_group_detail_desc: 'Нажмите на группу, чтобы увидеть: код группы (можно скопировать), статистику, список участников, запросы на вступление и историю изменений.',
            instr_members_title: 'Участники группы',
            instr_members_desc: 'В списке участников можно: искать по имени или телефону, сортировать по алфавиту или по участию в голосованиях. Замороженные участники отмечены ❄️.',
            instr_requests_title: 'Запросы на вступление',
            instr_requests_desc: 'Администратор видит входящие запросы и может одобрить или отклонить каждого кандидата. Участнику придёт уведомление о решении.',
            instr_voting_types: 'Типы голосования',
            instr_simple_title: 'Обычное (открытое)',
            instr_simple_desc: 'Открытое голосование — все видят, кто и как проголосовал. Подходит для общих вопросов: ремонт, расходы, правила. Длительность: от 1 часа до 5 дней.',
            instr_secret_title: 'Тайное',
            instr_secret_desc: 'Анонимное голосование — видно только общее количество голосов «За/Против/Воздержался», без имён. Комментарии скрыты. Для чувствительных вопросов.',
            instr_admin_title: 'Смена администратора',
            instr_admin_desc: 'Голосование за нового руководителя группы. Требования: мин. 3 участника, 72 часа, 50%+1 для принятия. При успехе — роли меняются автоматически.',
            instr_remove_title: 'Удаление участника',
            instr_remove_desc: 'Голосование за исключение участника. Нужно указать причину. Требования: мин. 3 участника, 72 часа, 50%+1 для принятия. При успехе — участник удаляется автоматически.',
            instr_freeze_title: 'Заморозка участника (BETA)',
            instr_freeze_desc: 'Только администратор может создать. Выбирает участников для заморозки на 7 дней. Замороженный участник не может голосовать. Если 2+ участника нажмут «Не согласен» — заморозка автоматически отменяется.',
            instr_delete_group_title: 'Удаление группы',
            instr_delete_group_desc: 'Любой участник может создать голосование за удаление группы. Минимальная длительность — 24 часа. Если 50%+1 проголосовало «за» — группа удаляется автоматически, а все участники получают уведомление.',
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
            instr_badge_frozen: 'Замороженный участник (не может голосовать)',
            instr_badge_admin: 'Администратор группы',
            instr_rules: 'Правила и сроки',
            instr_duration_title: 'Длительность',
            instr_duration_1: '• Обычные/тайные голосования: от 1 часа до 5 дней',
            instr_duration_2: '• Смена админа / Удаление участника: фиксировано 72 часа',
            instr_duration_3: '• Заморозка: 7 дней действия после принятия',
            instr_decision_title: 'Принятие решений',
            instr_decision_desc: 'Для принятия решения нужно 50%+1 голос от всех участников группы. Результат определяется автоматически по завершении срока.',
            instr_limits_title: 'Ограничения',
            instr_limits_desc: '• Без номера квартиры/участка — голосовать нельзя<br>• Обычный участник: макс. 1 голосование в день в каждой группе<br>• Администратор: без ограничений<br>• Смена админа / удаление: мин. 3 участника в группе',
            instr_export: 'Экспорт данных',
            instr_export_desc: 'Администратор может скачать историю голосований группы в CSV-файл. В файле: дата, автор, вопрос, тип, результат, количество голосов «За/Против/Воздержался», комментарии. Открывается в Excel или Google Sheets.',
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
            vote_against: 'Против',
            vote_for: 'За',
            admin_full: 'Администратор',
            no_requests: 'Нет запросов',
            join_requests: 'Запросы на вступление',
            target_member: 'Участник',
            select_member: 'Выберите участника',
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
            auth_error_network: 'Ошибка сети. Попробуйте позже.',
            auth_error_fill_fields: 'Заполните email и пароль',
            auth_error_password_short: 'Пароль должен быть не менее 6 символов',
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
            min_duration_24h: 'Минимальная длительность для этого типа голосования — 24 часа.'
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
                <div class="search-result-item" role="option" onclick="app.selectFreezeMember('${m.id}', '${m.name.replace(/'/g, "\\'")}')">
                    ${this.escapeHTML(m.name)} (${this.escapeHTML(m.address)})
                </div>
            `).join('');
        }
        
        resultsContainer.classList.remove('hidden');
    },

    selectFreezeMember(id, name) {
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
            alert(t.already_objected);
            return;
        }

        try {
            const { error } = await supabaseService.addFreezeObjection(votingId);
            if (error) {
                if (error.code === '23505') {
                    alert(t.already_objected);
                } else {
                    throw new Error(error.message);
                }
                return;
            }

            // Reload votings to get fresh status (DB trigger may have auto-rejected)
            await this.loadMyVotings();

            const refreshedVoting = this.state.votings.find(v => v.id === votingId);
            if (refreshedVoting && refreshedVoting.status === 'completed') {
                alert(t.freeze_auto_rejected);
            } else {
                alert(t.objection_added);
            }

            this.showVotingDetail(votingId);
        } catch (err) {
            alert(t.auth_error_network || 'Помилка');
        }
    },

    changeLanguage(lang) {
        this.currentLanguage = lang;
        const t = this.translations[lang];
        
        // Update all elements with data-lang attribute
        document.querySelectorAll('[data-lang]').forEach(el => {
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
            uk: 'VoteCoop - Голосування для спільнот',
            en: 'VoteCoop - Voting for communities',
            ru: 'VoteCoop - Голосования для сообществ'
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
                alert(t.auth_error_network);
                return;
            }
        }

        this.updateProfileDisplay();
        this.hideModal('edit-profile-modal');
        alert(t.profile_saved);
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