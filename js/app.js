// VoteCoop App
const app = {
    state: {
        user: null,
        groups: [],
        votings: [],
        notifications: [],
        currentScreen: 'auth-screen',
        votingFilter: 'active',
        userVotingHistory: {}, // { groupId: lastVotingTimestamp }
        currentVotingToDelete: null // For delete modal
    },

    // Initialize app
    init() {
        this.loadMockData();
        this.setupEventListeners();
        this.renderVotings();
        this.renderGroups();
        this.renderNotifications();
        
        // Load saved language preference
        const savedLang = localStorage.getItem('votecoop-language') || 'uk';
        if (savedLang !== 'uk') {
            document.getElementById('language-select').value = savedLang;
            this.changeLanguage(savedLang);
        }
    },

    // Mock data for prototype
    loadMockData() {
        this.state.user = {
            id: 1,
            firstName: 'Олександр',
            lastName: 'Петренко',
            email: 'oleksandr@example.com',
            phone: '+380 50 123 4567',
            address: 'вул. Шевченка, 61',
            apartment: '15'
        };

        this.state.groups = [
            {
                id: 1,
                name: 'Будинок 61',
                description: 'Житловий комплекс на вул. Шевченка',
                groupId: '284756',
                isAdmin: true,
                membersCount: 12,
                votingsCount: 5,
                members: [
                    { id: 1, name: 'Олександр Петренко', role: 'admin', address: 'кв. 15', phone: '+380501234567' },
                    { id: 2, name: 'Марія Іваненко', role: 'member', address: 'кв. 3', phone: '+380671234567' },
                    { id: 3, name: 'Іван Сидоренко', role: 'member', address: 'кв. 7', phone: '+380931234567' },
                    { id: 4, name: 'Наталія Коваленко', role: 'member', address: 'кв. 12', phone: '+380501112233' },
                    { id: 5, name: 'Петро Мельник', role: 'member', address: 'кв. 8', phone: '+380672223344' }
                ],
                requests: [
                    { id: 6, name: 'Анна Шевченко', address: 'кв. 22' }
                ],
                history: [
                    {
                        date: new Date(Date.now() - 2592000000).toISOString(),
                        action: 'admin_change',
                        from: 'Василь Петренко',
                        to: 'Олександр Петренко',
                        initiator: 'Марія Іваненко',
                        votingId: 101
                    }
                ]
            },
            {
                id: 2,
                name: 'СТ Ромашка',
                description: 'Дачний кооператив',
                groupId: '195342',
                isAdmin: false,
                membersCount: 8,
                votingsCount: 2,
                members: [
                    { id: 7, name: 'Василь Григоренко', role: 'admin', address: 'ділянка 5' },
                    { id: 1, name: 'Олександр Петренко', role: 'member', address: 'ділянка 12' }
                ],
                requests: []
            }
        ];

        this.state.votings = [
            {
                id: 1,
                title: 'Встановлення відеоспостереження у під\'їздах',
                groupId: 1,
                groupName: 'Будинок 61',
                type: 'simple',
                status: 'active',
                createdAt: new Date(Date.now() - 86400000),
                endsAt: new Date(Date.now() + 172800000),
                yesVotes: 8,
                noVotes: 2,
                abstainVotes: 1,
                totalMembers: 12,
                link: 'https://drive.google.com/...',
                hasVoted: false,
                initiatorId: 1,
                initiatorName: 'Олександр Петренко',
                comments: [
                    { userId: 2, userName: 'Марія Іваненко', vote: 'yes', comment: 'Це дуже важливо для безпеки будинку', time: '2 години тому' },
                    { userId: 3, userName: 'Іван Сидоренко', vote: 'no', comment: 'Занадто дорого для нашого бюджету', time: '5 годин тому' },
                    { userId: 4, userName: 'Наталія Коваленко', vote: 'abstain', comment: '', time: '1 день тому' }
                ]
            },
            {
                id: 2,
                title: 'Ремонт даху - вибір підрядника',
                groupId: 1,
                groupName: 'Будинок 61',
                type: 'simple',
                status: 'active',
                createdAt: new Date(Date.now() - 43200000),
                endsAt: new Date(Date.now() + 259200000),
                yesVotes: 10,
                noVotes: 0,
                totalMembers: 12,
                link: null,
                hasVoted: true
            },
            {
                id: 3,
                title: 'Зміна правил паркування у дворі',
                groupId: 1,
                groupName: 'Будинок 61',
                type: 'simple',
                status: 'completed',
                result: 'accepted',
                createdAt: new Date(Date.now() - 604800000),
                endedAt: new Date(Date.now() - 86400000),
                yesVotes: 9,
                noVotes: 2,
                totalMembers: 12,
                hasVoted: true
            },
            {
                id: 4,
                title: 'Тайне голосування: обрання голови кооперативу',
                groupId: 2,
                groupName: 'СТ Ромашка',
                type: 'secret',
                status: 'active',
                createdAt: new Date(Date.now() - 120000000),
                endsAt: new Date(Date.now() + 432000000),
                yesVotes: 5,
                noVotes: 1,
                totalMembers: 8,
                hasVoted: false
            },
            {
                id: 5,
                title: 'Встановлення огорожі території',
                groupId: 2,
                groupName: 'СТ Ромашка',
                type: 'simple',
                status: 'completed',
                result: 'rejected',
                createdAt: new Date(Date.now() - 518400000),
                endedAt: new Date(Date.now() - 172800000),
                yesVotes: 3,
                noVotes: 4,
                abstainVotes: 1,
                totalMembers: 8,
                hasVoted: true,
                initiatorId: 7,
                initiatorName: 'Василь Григоренко',
                comments: []
            },
            {
                id: 6,
                title: 'Зміна адміністратора групи',
                groupId: 1,
                groupName: 'Будинок 61',
                type: 'admin-change',
                status: 'active',
                createdAt: new Date(Date.now() - 86400000),
                endsAt: new Date(Date.now() + 172800000),
                yesVotes: 7,
                noVotes: 1,
                abstainVotes: 0,
                totalMembers: 12,
                hasVoted: false,
                targetMemberId: 2,
                targetMemberName: 'Марія Іваненко',
                initiatorId: 3,
                initiatorName: 'Іван Сидоренко',
                comments: []
            },
            {
                id: 7,
                title: 'Видалення учасника з групи',
                groupId: 1,
                groupName: 'Будинок 61',
                type: 'remove-member',
                status: 'active',
                createdAt: new Date(Date.now() - 43200000),
                endsAt: new Date(Date.now() + 216000000),
                yesVotes: 8,
                noVotes: 2,
                abstainVotes: 0,
                totalMembers: 12,
                hasVoted: false,
                targetMemberId: 5,
                targetMemberName: 'Петро Мельник',
                removalReason: 'Не платить внески',
                initiatorId: 2,
                initiatorName: 'Марія Іваненко',
                comments: []
            }
        ];

        this.state.notifications = [
            {
                id: 1,
                type: 'voting',
                text: 'Нове голосування у групі "Будинок 61": Встановлення відеоспостереження',
                time: '2 години тому',
                read: false
            },
            {
                id: 2,
                type: 'member',
                text: 'Анна Шевченко хоче приєднатися до групи "Будинок 61"',
                time: '5 годин тому',
                read: false
            },
            {
                id: 3,
                type: 'result',
                text: 'Голосування завершено: Зміна правил паркування - ПРИЙНЯТО',
                time: '1 день тому',
                read: true
            },
            {
                id: 4,
                type: 'voting',
                text: 'Нове голосування у групі "СТ Ромашка": Тайне голосування',
                time: '2 дні тому',
                read: true
            },
            {
                id: 5,
                type: 'system',
                text: 'Вітаємо! Ви стали адміністратором групи "Будинок 61"',
                time: '3 дні тому',
                read: true
            }
        ];
    },

    // Setup event listeners
    setupEventListeners() {
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
        // Hide all screens
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        
        // Show target screen
        const target = document.getElementById(screenId);
        if (target) {
            target.classList.remove('hidden');
            this.state.currentScreen = screenId;
        }

        // Show/hide main screens container
        const mainScreens = ['voting-screen', 'groups-screen', 'notifications-screen', 'profile-screen'];
        const mainContainer = document.getElementById('main-screens');
        if (mainScreens.includes(screenId)) {
            mainContainer.classList.remove('hidden');
        }
    },

    updateNavActive(activeItem) {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        activeItem.classList.add('active');
    },

    // Auth
    login() {
        // Simulate Google login
        document.getElementById('auth-screen').classList.add('hidden');
        
        // Check if profile is complete
        if (!this.state.user.firstName) {
            document.getElementById('profile-setup-screen').classList.remove('hidden');
        } else {
            document.getElementById('main-screens').classList.remove('hidden');
            this.showScreen('voting-screen');
        }
    },

    saveProfile() {
        const t = this.translations[this.currentLanguage];
        const firstName = document.getElementById('profile-firstname').value;
        const lastName = document.getElementById('profile-lastname').value;
        const phone = document.getElementById('profile-phone').value;
        const address = document.getElementById('profile-address').value;
        const apartment = document.getElementById('profile-apartment').value;

        if (!firstName || !lastName) {
            alert(t.fill_name_error);
            return;
        }

        // Check if this is first profile save (no apartment field yet)
        const isFirstSave = !this.state.user || !this.state.user.apartment;

        this.state.user = {
            ...this.state.user,
            firstName,
            lastName,
            phone,
            address,
            apartment
        };

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
        // Reset checkbox
        document.getElementById('terms-agree').checked = false;
        this.showModal('terms-modal');
    },

    acceptTerms() {
        const t = this.translations[this.currentLanguage];
        const agreed = document.getElementById('terms-agree').checked;

        if (!agreed) {
            alert(t.terms_agree_text);
            return;
        }

        this.hideModal('terms-modal');
        document.getElementById('profile-setup-screen').classList.add('hidden');
        document.getElementById('main-screens').classList.remove('hidden');
        this.showScreen('voting-screen');
        this.updateProfileDisplay();
    },

    logout() {
        location.reload();
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
            const progress = Math.round((totalVoted / voting.totalMembers) * 100);
            const yesPercent = Math.round((voting.yesVotes / voting.totalMembers) * 100);
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
                <div class="voting-card" onclick="app.showVotingDetail(${voting.id})">
                    <div class="voting-header">
                        <div class="voting-title">${voting.title}</div>
                        <div class="voting-status ${statusClass}"></div>
                    </div>
                    <div class="voting-author" style="font-size: 12px; color: var(--color-text-secondary); margin-bottom: 4px;">
                        <i class="ph ph-user"></i> ${authorName}
                    </div>
                    <div class="voting-meta">
                        <span><i class="ph ph-users-three"></i> ${voting.groupName}</span>
                        ${voting.status === 'active' 
                            ? `<span><i class="ph ph-scales"></i> ${voting.type === 'secret' ? t.secret_voting : t.open_voting}</span><span><i class="ph ph-clock"></i> ${timeLeft}</span>`
                            : `<span>${voting.result === 'accepted' ? '<i class="ph-fill ph-check-circle" style="color: #22c55e;"></i> ' + t.result_accepted : '<i class="ph-fill ph-x-circle" style="color: #ef4444;"></i> ' + t.result_rejected}</span>`
                        }
                    </div>
                    <div class="voting-date" style="font-size: 12px; color: var(--color-text-tertiary); margin-bottom: 8px;">
                        <i class="ph ph-calendar-blank"></i> ${dateRangeStr}
                    </div>
                    <div class="voting-progress">
                        <div class="progress-bar">
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
            <div class="group-card" onclick="app.showGroupDetail(${group.id})">
                <div class="group-card-header">
                    <div class="group-card-title">${group.name}</div>
                    <div class="group-card-role ${group.isAdmin ? '' : 'member'}">
                        ${group.isAdmin ? t.admin : t.member}
                    </div>
                </div>
                <div class="group-card-meta">
                    <i class="ph ph-users-three"></i> ${group.membersCount} ${t.members} • <i class="ph ph-scales"></i> ${group.votingsCount} ${t.votings}
                </div>
                <div class="group-id-badge">
                    <i class="ph ph-key"></i> ${group.groupId}
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
        navLabel.textContent = unreadCount > 0 ? `${t.notifications} (${unreadCount})` : t.notifications;

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
                <div class="notification-item ${notif.read ? 'read' : 'unread'}" onclick="app.markRead(${notif.id})">
                    <div class="notification-icon">${icons[notif.type] || '🔔'}</div>
                    <div class="notification-content">
                        <div class="notification-text">${notif.text}</div>
                        <div class="notification-time">${notif.time}</div>
                    </div>
                    ${!notif.read ? '<div class="notification-dot"></div>' : ''}
                </div>
            `;
        }).join('');
    },

    markRead(id) {
        const notif = this.state.notifications.find(n => n.id === id);
        if (notif) {
            notif.read = true;
            this.renderNotifications();
        }
    },

    markAllRead() {
        this.state.notifications.forEach(n => n.read = true);
        this.renderNotifications();
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
            this.state.groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
        
        // Reset type-specific fields
        document.getElementById('target-member-group').classList.add('hidden');
        document.getElementById('removal-reason-group').classList.add('hidden');
        document.getElementById('duration-group').classList.remove('hidden');
        
        this.showModal('create-voting-modal');
    },

    onVotingTypeChange() {
        const t = this.translations[this.currentLanguage];
        const type = document.getElementById('voting-type').value;
        const groupId = parseInt(document.getElementById('voting-group').value);
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
                        eligibleMembers.map(m => `<option value="${m.id}">${m.name} (${m.address})</option>`).join('');
                }
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
            
            // Show reason field for removal
            if (type === 'remove-member') {
                reasonGroup.classList.remove('hidden');
            }
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
    createGroup() {
        const name = document.getElementById('group-name').value;
        const description = document.getElementById('group-description').value;

        if (!name) {
            alert('Введіть назву групи');
            return;
        }

        const newGroup = {
            id: Date.now(),
            name,
            description,
            groupId: Math.random().toString().slice(2, 8),
            isAdmin: true,
            membersCount: 1,
            votingsCount: 0,
            members: [{ id: this.state.user.id, name: `${this.state.user.firstName} ${this.state.user.lastName}`, role: 'admin' }],
            requests: []
        };

        this.state.groups.push(newGroup);
        this.renderGroups();
        this.hideModal('create-group-modal');
        
        // Clear form
        document.getElementById('group-name').value = '';
        document.getElementById('group-description').value = '';
    },

    createVoting() {
        const t = this.translations[this.currentLanguage];
        
        // Check if user has apartment specified
        if (!this.state.user.apartment) {
            alert(t.apartment_required);
            return;
        }
        
        const title = document.getElementById('voting-title').value;
        const description = document.getElementById('voting-description').value;
        const groupId = parseInt(document.getElementById('voting-group').value);
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
        
        // Check daily limit for non-admin users (1 voting per 24 hours)
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
        
        // Check minimum members for admin-change and remove-member
        if ((type === 'admin-change' || type === 'remove-member') && group.membersCount < 3) {
            alert(t.min_3_members_required);
            return;
        }
        
        // Check for target member in admin-change and remove-member
        if ((type === 'admin-change' || type === 'remove-member') && !targetMemberId) {
            alert(t.select_member);
            return;
        }
        
        // Check for reason in remove-member
        let removalReason = '';
        if (type === 'remove-member') {
            if (!reasonSelect.value) {
                alert(t.select_reason);
                return;
            }
            removalReason = reasonSelect.value === 'other' ? reasonText.value : t[`reason_${reasonSelect.value}`];
        }
        
        // Check if admin-change already active
        if (type === 'admin-change') {
            const existingAdminChange = this.state.votings.find(v => 
                v.groupId === groupId && v.type === 'admin-change' && v.status === 'active'
            );
            if (existingAdminChange) {
                alert(t.one_admin_change_at_time);
                return;
            }
        }

        // Check freeze voting requirements (only admin can create)
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

        const targetMember = targetMemberId ? group.members.find(m => m.id === parseInt(targetMemberId)) : null;

        // Build freeze members data if freeze type
        let freezeMembersData = null;
        if (type === 'freeze') {
            freezeMembersData = this.state.freezeSelectedMembers.map(m => ({
                id: m.id,
                name: m.name,
                address: m.address
            }));
        }

        const newVoting = {
            id: Date.now(),
            title,
            description,
            groupId,
            groupName: group.name,
            type,
            status: 'active',
            createdAt: new Date(),
            endsAt: new Date(Date.now() + duration * 3600000),
            yesVotes: 0,
            noVotes: 0,
            totalMembers: group.membersCount,
            link,
            hasVoted: false,
            targetMemberId: targetMemberId ? parseInt(targetMemberId) : null,
            targetMemberName: targetMember ? targetMember.name : null,
            removalReason: removalReason,
            initiatorId: this.state.user.id,
            initiatorName: `${this.state.user.firstName} ${this.state.user.lastName}`,
            // Freeze-specific fields
            freezeMembers: freezeMembersData,
            objections: [], // Array of {userId, userName, time}
            frozenMembers: [] // Array of member IDs that were frozen after completion
        };

        this.state.votings.unshift(newVoting);
        
        // Track voting creation time for non-admin users
        if (!group.isAdmin) {
            this.state.userVotingHistory[groupId] = Date.now();
        }
        
        this.renderVotings();
        this.hideModal('create-voting-modal');
        
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
        // Clear freeze form
        this.state.freezeSelectedMembers = [];
        this.renderFreezeMemberChips();
        const freezeGroup = document.getElementById('freeze-members-group');
        if (freezeGroup) freezeGroup.classList.add('hidden');
    },

    joinGroup() {
        const groupId = document.getElementById('join-group-id').value;
        if (!groupId || groupId.length !== 6) {
            alert('Введіть коректний ID групи (6 цифр)');
            return;
        }

        // Check if already member
        const existing = this.state.groups.find(g => g.groupId === groupId);
        if (existing) {
            alert('Ви вже є учасником цієї групи');
            return;
        }

        // Mock: Create new group for demo
        const newGroup = {
            id: Date.now(),
            name: `Група ${groupId}`,
            description: 'Нова група',
            groupId,
            isAdmin: false,
            membersCount: 5,
            votingsCount: 0,
            members: [],
            requests: []
        };

        this.state.groups.push(newGroup);
        this.renderGroups();
        document.getElementById('join-group-id').value = '';
        
        // Add notification
        this.state.notifications.unshift({
            id: Date.now(),
            type: 'system',
            text: `Запит на приєднання до групи ${groupId} надіслано адміністратору`,
            time: 'Щойно',
            read: false
        });
        this.renderNotifications();
    },

    // Voting detail
    showVotingDetail(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting) return;

        // Save current voting ID for delete modal
        this.state.currentVotingToDelete = votingId;

        const content = document.getElementById('voting-detail-content');
        const isActive = voting.status === 'active';
        const isAuthor = voting.initiatorId === this.state.user.id;
        const abstainVotes = voting.abstainVotes || 0;
        const yesPercent = Math.round((voting.yesVotes / voting.totalMembers) * 100);
        const noPercent = Math.round((voting.noVotes / voting.totalMembers) * 100);
        const abstainPercent = Math.round((abstainVotes / voting.totalMembers) * 100);
        const totalVoted = voting.yesVotes + voting.noVotes + abstainVotes;
        const participation = Math.round((totalVoted / voting.totalMembers) * 100);

        // Build target member info
        let targetInfo = '';
        if (voting.type === 'admin-change' && voting.targetMemberName) {
            targetInfo = `
                <div class="target-info" style="margin-top: 16px; padding: 12px; background: var(--color-surface-secondary); border-radius: var(--radius-md);">
                    <div style="font-weight: 600; margin-bottom: 4px;"><i class="ph ph-user"></i> ${t.target_admin_candidate}</div>
                    <div style="color: var(--color-text-secondary);">${voting.targetMemberName}</div>
                </div>
            `;
        } else if (voting.type === 'remove-member' && voting.targetMemberName) {
            targetInfo = `
                <div class="target-info" style="margin-top: 16px; padding: 12px; background: var(--color-surface-secondary); border-radius: var(--radius-md);">
                    <div style="font-weight: 600; margin-bottom: 4px;"><i class="ph ph-user"></i> ${t.target_member_remove}</div>
                    <div style="color: var(--color-text-secondary);">${voting.targetMemberName}</div>
                    ${voting.removalReason ? `<div style="margin-top: 8px; font-size: 14px;"><strong>${t.removal_reason_label}:</strong> ${voting.removalReason}</div>` : ''}
                </div>
            `;
        }

        // Build comments section
        let commentsSection = '';
        if (voting.comments && voting.comments.length > 0) {
            const commentsList = voting.comments.map(c => {
                const voteLabel = c.vote === 'yes' ? t.vote_yes : c.vote === 'no' ? t.vote_no : t.vote_abstain;
                const voteEmoji = c.vote === 'yes' ? '<i class="ph-fill ph-check-circle" style="color: #22c55e;"></i>' : c.vote === 'no' ? '<i class="ph-fill ph-x-circle" style="color: #ef4444;"></i>' : '<i class="ph-fill ph-minus-circle" style="color: #6b7280;"></i>';
                return `
                    <div class="comment-item" style="padding: 12px; border-bottom: 1px solid var(--color-border);">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <span style="font-weight: 600;">${c.userName}</span>
                            <span style="color: var(--color-text-tertiary); font-size: 12px;">${c.time}</span>
                        </div>
                        <div style="font-size: 14px; margin-bottom: 4px;">${voteEmoji} ${voteLabel}</div>
                        ${c.comment ? `<div style="font-size: 14px; color: var(--color-text-secondary);">${c.comment}</div>` : ''}
                    </div>
                `;
            }).join('');
            
            commentsSection = `
                <div class="comments-section" style="margin-top: 24px; border-top: 1px solid var(--color-border); padding-top: 16px;">
                    <h4 style="margin-bottom: 12px;"><i class="ph ph-chat-circle-text"></i> ${t.comments}</h4>
                    <div class="comments-list">${commentsList}</div>
                </div>
            `;
        } else {
            commentsSection = `
                <div class="comments-section" style="margin-top: 24px; border-top: 1px solid var(--color-border); padding-top: 16px;">
                    <h4 style="margin-bottom: 12px;"><i class="ph ph-chat-circle-text"></i> ${t.comments}</h4>
                    <div style="padding: 20px; text-align: center; color: var(--color-text-tertiary);">${t.no_comments}</div>
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
            dateRangeHtml = `<div style="font-size: 14px; color: var(--color-text-secondary); margin-top: 4px;"><i class="ph ph-calendar-blank"></i> ${createdDateStr} ${createdTimeStr} — ${endDateStr}</div>`;
        } else {
            const endsAt = new Date(voting.endsAt);
            const endsDateStr = endsAt.toLocaleDateString();
            dateRangeHtml = `<div style="font-size: 14px; color: var(--color-text-secondary); margin-top: 4px;"><i class="ph ph-calendar-blank"></i> ${createdDateStr} ${createdTimeStr} — ${endsDateStr} (${t.opened})</div>`;
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
                `<span class="member-chip" style="background: #0ea5e9;">${m.name} (${m.address})</span>`
            ).join('') : '';
            
            freezeInfo = `
                <div style="margin-top: 16px; padding: 16px; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); border-radius: var(--radius-md); border: 1px solid #7dd3fc;">
                    <div style="font-weight: 600; margin-bottom: 12px; color: #0369a1;">
                        <i class="ph ph-snowflake" style="color: #0ea5e9;"></i> ${t.freeze_proposal}
                    </div>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
                        ${freezeMembersChips}
                    </div>
                    <div style="font-size: 13px; color: #0369a1;">
                        <i class="ph ph-info"></i> ${t.freeze_duration_info}
                    </div>
                </div>
            `;
            
            // Objections section
            let objectionsList = '';
            if (voting.objections && voting.objections.length > 0) {
                objectionsList = voting.objections.map(o => 
                    `<div style="padding: 8px 0; border-bottom: 1px solid var(--color-border); font-size: 14px;">
                        <i class="ph-fill ph-x-circle" style="color: #ef4444;"></i> ${o.userName}
                        <span style="color: var(--color-text-tertiary); font-size: 12px;">(${new Date(o.time).toLocaleDateString()})</span>
                    </div>`
                ).join('');
            } else {
                objectionsList = `<div style="padding: 12px; text-align: center; color: var(--color-text-tertiary); font-size: 14px;">${t.no_objections}</div>`;
            }
            
            freezeResults = `
                <div style="margin-top: 20px; padding: 16px; background: var(--color-surface-secondary); border-radius: var(--radius-md);">
                    <div style="font-weight: 600; margin-bottom: 12px;">
                        <i class="ph ph-users"></i> ${t.objections_title}: ${objectionCount}/${objectionThreshold}
                        ${objectionCount >= objectionThreshold ? `<span style="color: #ef4444; margin-left: 8px;">(${t.auto_rejected})</span>` : ''}
                    </div>
                    <div>${objectionsList}</div>
                    ${objectionCount < objectionThreshold ? `
                        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); font-size: 13px; color: var(--color-text-secondary);">
                            ${t.objections_needed.replace('{count}', objectionThreshold - objectionCount)}
                        </div>
                    ` : ''}
                </div>
            `;
            
            // Freeze voting actions - "I disagree" button
            if (isActive && !hasObjected) {
                freezeActions = `
                    <div class="voting-actions" style="flex-direction: column; gap: 12px;">
                        <button class="btn btn-secondary" style="background: #fee2e2; color: #dc2626; border-color: #fecaca;" onclick="app.objectToFreeze(${voting.id})">
                            <i class="ph-fill ph-hand-palm"></i> ${t.i_disagree}
                        </button>
                        <div style="font-size: 13px; color: var(--color-text-secondary); text-align: center;">
                            ${t.disagree_info}
                        </div>
                    </div>
                `;
            } else if (isActive && hasObjected) {
                freezeActions = `
                    <div style="text-align: center; padding: 20px; color: var(--color-text-secondary);">
                        <i class="ph ph-check" style="color: #22c55e;"></i> ${t.you_objected}
                    </div>
                `;
            }
        }

        content.innerHTML = `
            <div class="voting-detail-header">
                <div class="voting-detail-status ${isActive ? 'active' : 'completed'}">
                    ${isActive ? `<i class="ph-fill ph-circle" style="color: #ef4444;"></i> ${t.active_votings}` : `<i class="ph-fill ph-check-circle" style="color: #22c55e;"></i> ${t.completed}`}
                </div>
                <h2 class="voting-detail-title">${voting.title}</h2>
                ${voting.description ? `<div style="font-size: 15px; color: var(--color-text); margin: 12px 0; padding: 12px; background: var(--color-surface-secondary); border-radius: var(--radius-md); line-height: 1.5;">${voting.description}</div>` : ''}
                <div style="font-size: 14px; color: var(--color-text-secondary); margin-bottom: 8px;">
                    <i class="ph ph-user"></i> ${t.author}: ${authorName}
                </div>
                ${dateRangeHtml}
                <div class="voting-detail-meta" style="margin-top: 12px;">
                    <span><i class="ph ph-users-three"></i> ${voting.groupName}</span>
                    ${isActive 
                        ? `<span><i class="ph ph-scales"></i> ${voting.type === 'secret' ? t.secret_voting : voting.type === 'freeze' ? t.freeze_voting : t.open_voting}</span><span><i class="ph ph-clock"></i> ${this.getTimeLeft(voting.endsAt)}</span>`
                        : `<span>${voting.result === 'accepted' ? '<i class="ph-fill ph-check-circle" style="color: #22c55e;"></i> ' + t.result_accepted : '<i class="ph-fill ph-x-circle" style="color: #ef4444;"></i> ' + t.result_rejected}</span>`
                    }
                </div>
                ${voting.link ? `<a href="${voting.link}" target="_blank" class="btn btn-secondary" style="margin-top: 16px;"><i class="ph ph-paperclip"></i> ${t.materials_link}</a>` : ''}
                ${isFreeze ? freezeInfo : targetInfo}
            </div>

            ${!isFreeze ? `
            <div class="voting-results">
                <div class="result-item">
                    <span class="result-label"><i class="ph-fill ph-check-circle" style="color: #22c55e;"></i> ${t.yes}</span>
                    <span class="result-value">${voting.yesVotes} (${yesPercent}%)</span>
                </div>
                <div class="result-bar">
                    <div class="result-bar-fill yes" style="width: ${yesPercent}%"></div>
                </div>
                
                <div class="result-item" style="margin-top: 16px;">
                    <span class="result-label"><i class="ph-fill ph-x-circle" style="color: #ef4444;"></i> ${t.no}</span>
                    <span class="result-value">${voting.noVotes} (${noPercent}%)</span>
                </div>
                <div class="result-bar">
                    <div class="result-bar-fill no" style="width: ${noPercent}%"></div>
                </div>

                <div class="result-item" style="margin-top: 16px;">
                    <span class="result-label"><i class="ph-fill ph-minus-circle" style="color: #6b7280;"></i> ${t.abstain}</span>
                    <span class="result-value">${abstainVotes} (${abstainPercent}%)</span>
                </div>

                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-border);">
                    <span class="result-label">${t.participation_label}: ${participation}% (${totalVoted}/${voting.totalMembers})</span>
                </div>
            </div>
            ` : freezeResults}

            ${!isFreeze && isActive && !voting.hasVoted ? `
                <div class="voting-actions" style="flex-direction: column; gap: 12px;">
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-secondary" style="flex: 1;" onclick="app.vote(${voting.id}, false)"><i class="ph-fill ph-x-circle"></i> ${t.vote_against}</button>
                        <button class="btn btn-secondary" style="flex: 1;" onclick="app.vote(${voting.id}, 'abstain')"><i class="ph-fill ph-minus-circle"></i> ${t.abstain}</button>
                        <button class="btn btn-primary" style="flex: 1;" onclick="app.vote(${voting.id}, true)"><i class="ph-fill ph-check-circle"></i> ${t.vote_for}</button>
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <textarea id="vote-comment" data-lang-placeholder="comment_placeholder" placeholder="${t.comment_placeholder}" maxlength="500" style="min-height: 80px;"></textarea>
                        <div style="font-size: 12px; color: var(--color-text-tertiary); text-align: right; margin-top: 4px;">
                            <span id="comment-counter">0</span> / 500
                        </div>
                    </div>
                </div>
            ` : !isFreeze && isActive && voting.hasVoted ? `
                <div style="text-align: center; padding: 20px; color: var(--color-text-secondary);">
                    <i class="ph ph-check"></i> ${t.already_voted}
                </div>
            ` : ''}

            ${isFreeze ? freezeActions : ''}

            ${isActive && isAuthor ? `
                <div style="margin-top: 20px; text-align: center;">
                    <button class="btn btn-danger" onclick="app.showDeleteVotingModal(${voting.id})" style="background: var(--color-danger);">🗑️ ${t.delete}</button>
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

    vote(votingId, voteType) {
        const t = this.translations[this.currentLanguage];
        
        // Check if user has apartment specified
        if (!this.state.user.apartment) {
            alert(t.apartment_required);
            return;
        }
        
        // Check if user is frozen
        if (this.state.user.frozen) {
            alert(t.frozen_cannot_vote);
            return;
        }
        
        const voting = this.state.votings.find(v => v.id === votingId);
        if (voting && !voting.hasVoted) {
            // Get comment if exists
            const commentField = document.getElementById('vote-comment');
            const comment = commentField ? commentField.value.trim().substring(0, 500) : '';

            // Count vote
            if (voteType === true || voteType === 'yes') {
                voting.yesVotes++;
            } else if (voteType === false || voteType === 'no') {
                voting.noVotes++;
            } else if (voteType === 'abstain') {
                voting.abstainVotes = (voting.abstainVotes || 0) + 1;
            }

            // Add comment to voting
            if (!voting.comments) voting.comments = [];
            voting.comments.push({
                userId: this.state.user.id,
                userName: `${this.state.user.firstName} ${this.state.user.lastName}`,
                vote: voteType === true || voteType === 'yes' ? 'yes' : voteType === false || voteType === 'no' ? 'no' : 'abstain',
                comment: comment,
                time: t.just_now
            });

            voting.hasVoted = true;
            this.renderVotings();
            this.showVotingDetail(votingId);
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
    confirmDeleteVoting() {
        const t = this.translations[this.currentLanguage];
        const votingId = this.state.currentVotingToDelete;
        const voting = this.state.votings.find(v => v.id === votingId);
        
        if (!voting) {
            this.hideModal('delete-voting-modal');
            return;
        }

        const reason = document.getElementById('delete-reason-text').value.trim();
        
        // Validate reason length
        if (reason.length < 5) {
            alert(t.delete_reason_short);
            return;
        }

        // Check max length (200 chars)
        if (reason.length > 200) {
            alert('Причина занадто довга (макс. 200 символів)');
            return;
        }

        // Delete voting
        this.state.votings = this.state.votings.filter(v => v.id !== votingId);

        // Send notification to all group members
        this.state.notifications.unshift({
            id: Date.now(),
            type: 'system',
            text: `${t.voting_deleted_by}: "${voting.title}". ${t.reason_label}: ${reason}`,
            time: t.just_now,
            read: false
        });

        this.hideModal('delete-voting-modal');
        this.hideModal('voting-detail-modal');
        this.renderVotings();
        this.renderNotifications();
        
        alert(t.voting_deleted);
    },

    // Group detail
    showGroupDetail(groupId) {
        const t = this.translations[this.currentLanguage];
        const group = this.state.groups.find(g => g.id === groupId);
        if (!group) return;

        // Store current group for filtering/sorting
        this.state.currentGroupId = groupId;
        this.state.membersSort = { by: 'name', order: 'asc' };
        this.state.membersFilter = '';

        document.getElementById('group-detail-name').textContent = group.name;
        document.getElementById('group-detail-id').textContent = group.groupId;
        document.getElementById('group-detail-description').textContent = group.description || '';
        // Count frozen members
        const frozenCount = group.members.filter(m => m.frozen).length;
        const activeMembersCount = group.membersCount - frozenCount;
        
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
            membersList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--color-text-tertiary);">${t.no_members_found || 'Учасників не знайдено'}</div>`;
            return;
        }

        // Count frozen members
        const frozenCount = group.members.filter(m => m.frozen).length;
        
        membersList.innerHTML = membersWithStats.map(member => {
            const participationText = `${member.participation.participated}/${member.participation.total}`;
            const frozenIndicator = member.frozen ? `<i class="ph-fill ph-snowflake frozen-indicator" title="${t.frozen_badge}"></i>` : '';
            return `
            <div class="member-card ${member.frozen ? 'frozen' : ''}" style="display: flex; align-items: center; padding: 12px 16px; background: var(--color-surface); border-radius: var(--radius-md); margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); ${member.frozen ? 'opacity: 0.7; background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);' : ''}">
                <div class="member-avatar" style="width: 44px; height: 44px; border-radius: 50%; background: ${member.frozen ? '#bae6fd' : 'var(--color-surface-secondary)'}; display: flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0;">
                    <i class="ph ph-user" style="font-size: 24px; color: ${member.frozen ? '#0ea5e9' : 'var(--color-text-secondary)'};"></i>
                </div>
                <div class="member-info" style="flex: 1; min-width: 0;">
                    <div class="member-name" style="font-weight: 500; font-size: 15px; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${member.name} ${frozenIndicator}</div>
                    <div class="member-address" style="font-size: 13px; color: var(--color-text-secondary); margin-top: 2px;">${member.address || 'кв. -'}</div>
                </div>
                <div class="member-participation" style="font-size: 15px; font-weight: 600; color: ${member.frozen ? '#0ea5e9' : 'var(--color-text)'}; padding-left: 12px;">
                    ${member.frozen ? `<i class="ph-fill ph-snowflake"></i> ${t.frozen_badge}` : participationText}
                </div>
            </div>
        `}).join('');

        // Render requests (only for admin)
        const requestsList = document.getElementById('requests-list');
        if (group.isAdmin && group.requests.length > 0) {
            requestsList.innerHTML = group.requests.map(request => `
                <div class="request-item">
                    <div class="request-avatar"><i class="ph ph-user"></i></div>
                    <div class="request-info">
                        <div class="request-name">${request.name}</div>
                        <div class="request-address">${request.address}</div>
                    </div>
                    <div class="request-actions">
                        <button class="btn-small btn-approve" onclick="app.approveRequest(${group.id}, ${request.id})"><i class="ph ph-check"></i></button>
                        <button class="btn-small btn-reject" onclick="app.rejectRequest(${group.id}, ${request.id})"><i class="ph ph-x"></i></button>
                    </div>
                </div>
            `).join('');
        } else {
            requestsList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--color-text-tertiary);">${t.no_requests}</div>`;
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
                    actionText = `<i class="ph-fill ph-crown" style="color: #f59e0b;"></i> ${t.history_admin_change}: ${item.from} → ${item.to}`;
                } else if (item.action === 'member_removed') {
                    actionText = `<i class="ph-fill ph-prohibit" style="color: #ef4444;"></i> ${t.history_member_removed}: ${item.member}`;
                    if (item.reason) actionText += ` (${item.reason})`;
                }
                
                const date = new Date(item.date).toLocaleDateString();
                
                return `
                    <div class="history-item" style="padding: 12px; border-bottom: 1px solid var(--color-border);">
                        <div style="font-size: 14px; margin-bottom: 4px;">${actionText}</div>
                        <div style="font-size: 12px; color: var(--color-text-tertiary);">
                            <i class="ph ph-calendar-blank"></i> ${date} • <i class="ph ph-user"></i> ${t.history_initiator}: ${item.initiator}
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
        const groupId = parseInt(document.getElementById('group-detail-id').textContent);
        const group = this.state.groups.find(g => g.groupId === groupId);
        
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
                    // Use apartment number from user profile (mock - in real app would lookup)
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
        link.download = `group-${groupId}-history-${new Date().toISOString().split('T')[0]}.csv`;
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

    approveRequest(groupId, requestId) {
        const group = this.state.groups.find(g => g.id === groupId);
        const request = group.requests.find(r => r.id === requestId);
        if (group && request) {
            group.members.push({ ...request, role: 'member' });
            group.requests = group.requests.filter(r => r.id !== requestId);
            group.membersCount++;
            this.showGroupDetail(groupId);
        }
    },

    rejectRequest(groupId, requestId) {
        const group = this.state.groups.find(g => g.id === groupId);
        if (group) {
            group.requests = group.requests.filter(r => r.id !== requestId);
            this.showGroupDetail(groupId);
        }
    },

    copyGroupId() {
        const groupId = document.getElementById('group-detail-id').textContent;
        navigator.clipboard.writeText(groupId).then(() => {
            alert('ID скопійовано: ' + groupId);
        });
    },

    showGroupMenu() {
        // Simple alert for prototype - could be a dropdown menu
        alert('Меню групи: \n• Редагувати\n• Архівувати\n• Видалити (голосування)');
    },

    updateProfileDisplay() {
        document.getElementById('profile-name').textContent = 
            `${this.state.user.firstName} ${this.state.user.lastName}`;
        document.getElementById('profile-phone-display').textContent = this.state.user.phone;
        document.getElementById('profile-address-display').textContent = 
            `${this.state.user.address}, кв. ${this.state.user.apartment}`;
        document.getElementById('profile-groups-count').textContent = this.state.groups.length;
    },

    // Language Support
    translations: {
        uk: {
            profile: 'Профіль',
            edit_profile: 'Редагувати профіль',
            instructions: 'Інструкції',
            instructions_title: '📖 Інструкції з використання',
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
            instr_voting_types: 'Типи голосування',
            instr_simple_title: 'Звичайне голосування',
            instr_simple_desc: 'Відкрите голосування, де всі бачать, хто і як проголосував після свого вибору. Підходить для загальних питань ОСГ.',
            instr_secret_title: 'Тайне голосування',
            instr_secret_desc: 'Приховане голосування — після голосування ви бачите тільки загальну кількість «за» та «проти», без імен. Використовується для чутливих питань.',
            instr_admin_title: 'Зміна адміністратора',
            instr_admin_desc: 'Спеціальне голосування для зміни керівника групи. Вимагає мінімум 3 учасників. Триває 72 години. Для прийняття рішення потрібно 50%+1 голос. Поки йде голосування, адмін не може видаляти учасників.',
            instr_remove_title: 'Видалення учасника',
            instr_remove_desc: 'Голосування про виключення учасника з групи. Рішення приймається більшістю 50%+1 голос. Тривалість — 72 години.',
            instr_group_mgmt: 'Управління групою',
            instr_create_group_title: 'Створення групи',
            instr_create_group_desc: 'Будь-який користувач може створити групу. Система автоматично генерує унікальний 6-значний ID для запрошення.',
            instr_join_group_title: 'Вступ до групи',
            instr_join_group_desc: 'Введіть 6-значний ID групи в поле пошуку. Адміністратор отримає запит на підтвердження.',
            instr_decision_title: 'Прийняття рішень',
            instr_decision_desc: 'Для прийняття будь-якого рішення потрібно мінімум 50%+1 голос від усіх учасників групи. Якщо набрано менше — голосування вважається «не відбулися» (🟡).',
            instr_delete_group_title: 'Видалення групи',
            instr_delete_group_desc: 'Якщо в групі 3+ учасників, адміністратор не може видалити групу без голосування. Усім учасникам надсилається запит на підтвердження.',
            instr_badges: '🎨 Позначення голосувань',
            instr_badge_yellow: 'Голосування не відбулося (менше 50%+1 голосів)',
            instr_badge_green: 'Прийнято «за» (більшість проголосувала позитивно)',
            instr_badge_red: 'Прийнято «проти» (більшість проголосувала негативно)',
            instr_duration: '⏱️ Тривалість голосування',
            instr_duration_1: '• Звичайні голосування: від 1 години до 5 днів',
            instr_duration_2: '• Управлінські голосування (зміна адміна, видалення): фіксовано 72 години',
            instr_duration_3: 'Результат визначається автоматично по закінченню терміну.',
            instr_archive: '📋 Архівування',
            instr_archive_desc: 'Адміністратор може експортувати історію голосувань групи до Google Sheets. У таблиці зберігаються: дата, питання, опис, результат, кількість учасників.',
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
            stats_active: 'в процесі'
        },
        en: {
            profile: 'Profile',
            edit_profile: 'Edit Profile',
            instructions: 'Instructions',
            instructions_title: '📖 User Instructions',
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
            instr_voting_types: '🗳️ Voting Types',
            instr_simple_title: 'Standard Voting',
            instr_simple_desc: 'Open voting where everyone can see who voted how after making their choice. Suitable for general HOA matters.',
            instr_secret_title: 'Secret Voting',
            instr_secret_desc: 'Hidden voting — after voting you only see the total number of "for" and "against" votes, without names. Used for sensitive matters.',
            instr_admin_title: 'Change Administrator',
            instr_admin_desc: 'Special voting to change group leader. Requires at least 3 members. Lasts 72 hours. Decision requires 50%+1 vote. While voting is in progress, admin cannot remove members.',
            instr_remove_title: 'Remove Member',
            instr_remove_desc: 'Voting to exclude a member from the group. Decision is made by majority 50%+1 vote. Duration — 72 hours.',
            instr_group_mgmt: '👥 Group Management',
            instr_create_group_title: 'Creating a Group',
            instr_create_group_desc: 'Any user can create a group. The system automatically generates a unique 6-digit ID for invitations.',
            instr_join_group_title: 'Joining a Group',
            instr_join_group_desc: 'Enter the 6-digit group ID in the search field. The administrator will receive a request for approval.',
            instr_decision_title: 'Decision Making',
            instr_decision_desc: 'To make any decision, at least 50%+1 vote from all group members is required. If fewer votes are cast — the voting is considered "did not take place" (🟡).',
            instr_delete_group_title: 'Deleting a Group',
            instr_delete_group_desc: 'If there are 3+ members in the group, the administrator cannot delete the group without voting. All members receive a request for confirmation.',
            instr_badges: '🎨 Voting Badges',
            instr_badge_yellow: 'Voting did not take place (less than 50%+1 votes)',
            instr_badge_green: 'Accepted "for" (majority voted positively)',
            instr_badge_red: 'Accepted "against" (majority voted negatively)',
            instr_duration: '⏱️ Voting Duration',
            instr_duration_1: '• Standard voting: from 1 hour to 5 days',
            instr_duration_2: '• Administrative voting (change admin, removal): fixed 72 hours',
            instr_duration_3: 'Result is determined automatically at the end of the term.',
            instr_archive: '📋 Archiving',
            instr_archive_desc: 'The administrator can export the group\'s voting history to Google Sheets. The table contains: date, question, description, result, number of participants.',
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
            stats_active: 'in progress'
        },
        ru: {
            profile: 'Профиль',
            edit_profile: 'Редактировать профиль',
            instructions: 'Инструкции',
            instructions_title: '📖 Инструкции по использованию',
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
            instr_voting_types: '🗳️ Типы голосования',
            instr_simple_title: 'Обычное голосование',
            instr_simple_desc: 'Открытое голосование, где все видят, кто и как проголосовал после своего выбора. Подходит для общих вопросов ОСГ.',
            instr_secret_title: 'Тайное голосование',
            instr_secret_desc: 'Скрытое голосование — после голосования вы видите только общее количество «за» и «против», без имён. Используется для чувствительных вопросов.',
            instr_admin_title: 'Смена администратора',
            instr_admin_desc: 'Специальное голосование для смены руководителя группы. Требуется минимум 3 участника. Длится 72 часа. Для принятия решения нужно 50%+1 голос. Пока идёт голосование, админ не может удалять участников.',
            instr_remove_title: 'Удаление участника',
            instr_remove_desc: 'Голосование об исключении участника из группы. Решение принимается большинством 50%+1 голос. Длительность — 72 часа.',
            instr_group_mgmt: '👥 Управление группой',
            instr_create_group_title: 'Создание группы',
            instr_create_group_desc: 'Любой пользователь может создать группу. Система автоматически генерирует уникальный 6-значный ID для приглашения.',
            instr_join_group_title: 'Вступление в группу',
            instr_join_group_desc: 'Введите 6-значный ID группы в поле поиска. Администратор получит запрос на подтверждение.',
            instr_decision_title: 'Принятие решений',
            instr_decision_desc: 'Для принятия любого решения требуется минимум 50%+1 голос от всех участников группы. Если набрано меньше — голосование считается «не состоявшимся» (🟡).',
            instr_delete_group_title: 'Удаление группы',
            instr_delete_group_desc: 'Если в группе 3+ участников, администратор не может удалить группу без голосования. Всем участникам отправляется запрос на подтверждение.',
            instr_badges: '🎨 Обозначения голосований',
            instr_badge_yellow: 'Голосование не состоялось (меньше 50%+1 голосов)',
            instr_badge_green: 'Принято «за» (большинство проголосовало положительно)',
            instr_badge_red: 'Принято «против» (большинство проголосовало отрицательно)',
            instr_duration: '⏱️ Длительность голосования',
            instr_duration_1: '• Обычные голосования: от 1 часа до 5 дней',
            instr_duration_2: '• Административные голосования (смена админа, удаление): фиксировано 72 часа',
            instr_duration_3: 'Результат определяется автоматически по окончании срока.',
            instr_archive: '📋 Архивирование',
            instr_archive_desc: 'Администратор может экспортировать историю голосований группы в Google Sheets. В таблице сохраняются: дата, вопрос, описание, результат, количество участников.',
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
            stats_active: 'в процессе'
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
        if (!query || query.length < 2) {
            document.getElementById('freeze-search-results').classList.add('hidden');
            return;
        }
        
        const groupId = parseInt(document.getElementById('voting-group').value);
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
            resultsContainer.innerHTML = '<div style="padding: 12px; color: var(--color-text-tertiary);">Нічого не знайдено</div>';
        } else {
            resultsContainer.innerHTML = matches.map(m => `
                <div class="search-result-item" onclick="app.selectFreezeMember(${m.id}, '${m.name.replace(/'/g, "\\'")}')">
                    ${m.name} (${m.address})
                </div>
            `).join('');
        }
        
        resultsContainer.classList.remove('hidden');
    },

    selectFreezeMember(id, name) {
        const groupId = parseInt(document.getElementById('voting-group').value);
        const group = this.state.groups.find(g => g.id === groupId);
        const member = group.members.find(m => m.id === id);
        
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
                ${m.name}
                <button onclick="app.removeFreezeMember(${m.id})" type="button">
                    <i class="ph ph-x"></i>
                </button>
            </div>
        `).join('');
    },

    // Object to freeze voting
    objectToFreeze(votingId) {
        const t = this.translations[this.currentLanguage];
        const voting = this.state.votings.find(v => v.id === votingId);
        if (!voting || voting.type !== 'freeze' || voting.status !== 'active') return;
        
        // Check if already objected
        if (voting.objections && voting.objections.some(o => o.userId === this.state.user.id)) {
            alert(t.already_objected);
            return;
        }
        
        // Add objection
        if (!voting.objections) voting.objections = [];
        voting.objections.push({
            userId: this.state.user.id,
            userName: `${this.state.user.firstName} ${this.state.user.lastName}`,
            time: new Date().toISOString()
        });
        
        // Check if threshold reached (2 objections = auto rejection)
        if (voting.objections.length >= 2) {
            voting.status = 'completed';
            voting.result = 'rejected';
            voting.endedAt = new Date().toISOString();
            
            // Add notification
            this.state.notifications.unshift({
                id: Date.now(),
                type: 'system',
                text: `${t.freeze_rejected}: "${voting.title}"`,
                time: t.just_now,
                read: false
            });
            
            alert(t.freeze_auto_rejected);
        } else {
            alert(t.objection_added);
        }
        
        this.renderVotings();
        this.showVotingDetail(votingId);
    },

    changeLanguage(lang) {
        this.currentLanguage = lang;
        const t = this.translations[lang];
        
        // Update all elements with data-lang attribute
        document.querySelectorAll('[data-lang]').forEach(el => {
            const key = el.getAttribute('data-lang');
            if (t[key]) {
                el.textContent = t[key];
            }
        });
        
        // Update all placeholders with data-lang-placeholder attribute
        document.querySelectorAll('[data-lang-placeholder]').forEach(el => {
            const key = el.getAttribute('data-lang-placeholder');
            if (t[key]) {
                el.placeholder = t[key];
            }
        });
        
        // Update document title
        const titles = {
            uk: 'VoteCoop - Голосування ОСГ',
            en: 'VoteCoop - HOA Voting',
            ru: 'VoteCoop - Голосование ОСГ'
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
        this.updateMockNotifications();
        this.renderNotifications();
    },

    updateMockNotifications() {
        const t = this.translations[this.currentLanguage];
        // Update mock notification texts based on current language
        this.state.notifications = [
            {
                id: 1,
                type: 'voting',
                text: `${t.notif_new_voting} "Будинок 61": ${t.instr_simple_title}`,
                time: `2 ${t.hours_ago}`,
                read: false
            },
            {
                id: 2,
                type: 'member',
                text: `Анна Шевченко ${t.notif_join_request} "Будинок 61"`,
                time: `5 ${t.hours_ago}`,
                read: false
            },
            {
                id: 3,
                type: 'result',
                text: `${t.notif_voting_completed}: ${t.instr_simple_title} - ${t.notif_accepted}`,
                time: `1 ${t.day_ago}`,
                read: true
            },
            {
                id: 4,
                type: 'voting',
                text: `${t.notif_new_voting} "СТ Ромашка": ${t.type_secret}`,
                time: `2 ${t.days_ago}`,
                read: true
            },
            {
                id: 5,
                type: 'system',
                text: `${t.notif_welcome_admin} "Будинок 61"`,
                time: `3 ${t.days_ago}`,
                read: true
            }
        ];
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
                        el.appendChild(document.createTextNode(' ' + t[key]));
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
            delete_group_desc: 'Якщо в групі 3+ учасників, адміністратор не може видалити групу без голосування. Усім учасникам надсилається запит на підтвердження.',
            badges_title: '🎨 Позначення голосувань',
            badges_desc: '🟡 — Голосування не відбулося (менше 50%+1 голосів)\n🟢 — Прийнято «за» (більшість проголосувала позитивно)\n🔴 — Прийнято «проти» (більшість проголосувала негативно)',
            duration_title: '⏱️ Тривалість голосування',
            duration_desc: '• Звичайні голосування: від 1 години до 5 днів\n• Управлінські голосування (зміна адміна, видалення): фіксовано 72 години\nРезультат визначається автоматично по закінченню терміну.',
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
            delete_group_desc: 'If there are 3+ members in the group, the administrator cannot delete the group without voting. All members receive a request for confirmation.',
            badges_title: '🎨 Voting Badges',
            badges_desc: '🟡 — Voting did not take place (less than 50%+1 votes)\n🟢 — Accepted "for" (majority voted positively)\n🔴 — Accepted "against" (majority voted negatively)',
            duration_title: '⏱️ Voting Duration',
            duration_desc: '• Standard voting: from 1 hour to 5 days\n• Administrative voting (change admin, removal): fixed 72 hours\nResult is determined automatically at the end of the term.',
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
            delete_group_desc: 'Если в группе 3+ участников, администратор не может удалить группу без голосования. Всем участникам отправляется запрос на подтверждение.',
            badges_title: '🎨 Обозначения голосований',
            badges_desc: '🟡 — Голосование не состоялось (меньше 50%+1 голосов)\n🟢 — Принято «за» (большинство проголосовало положительно)\n🔴 — Принято «против» (большинство проголосовало отрицательно)',
            duration_title: '⏱️ Длительность голосования',
            duration_desc: '• Обычные голосования: от 1 часа до 5 дней\n• Административные голосования (смена админа, удаление): фиксировано 72 часа\nРезультат определяется автоматически по окончании срока.',
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

    saveEditedProfile() {
        const t = this.translations[this.currentLanguage];
        this.state.user.firstName = document.getElementById('edit-firstname').value;
        this.state.user.lastName = document.getElementById('edit-lastname').value;
        this.state.user.phone = document.getElementById('edit-phone').value;
        this.state.user.address = document.getElementById('edit-address').value;
        this.state.user.apartment = document.getElementById('edit-apartment').value;
        
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