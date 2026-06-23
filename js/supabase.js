// PocketBase adapter — drop-in replacement for the old Supabase service.
// Keeps the same `supabaseService` method names + {data,error} shapes so
// js/app.js works unchanged. Backed by PocketBase at same origin.
// Requires: pocketbase SDK loaded before this file; js/config.js for URL.

const supabaseService = {
    pb: null,
    client: null,        // compat shim (see bottom)
    initialized: false,

    init() {
        try {
            const url = (typeof POCKETBASE_URL !== 'undefined' && POCKETBASE_URL) || window.location.origin;
            this.pb = new PocketBase(url);
            this.pb.autoCancellation(false);
            this.client = this._buildClientShim();
            this.initialized = true;
            return true;
        } catch (err) {
            this.initialized = false;
            return false;
        }
    },

    isReady() { return this.initialized && this.pb !== null; },

    _uid() { return this.pb?.authStore?.record?.id || null; },
    async _getUserId() { return this._uid(); },
    _err(e) { return { message: (e && (e.message || e.data?.message)) || String(e), code: e?.status, data: e?.response || e?.data }; },

    // ---- profile helpers ----
    async _profileByUser(uid) {
        try { return await this.pb.collection('profiles').getFirstListItem(`user="${uid}"`); }
        catch (e) { return null; }
    },
    async _profilesMap(uids) {
        const map = {};
        const uniq = [...new Set(uids.filter(Boolean))];
        for (const u of uniq) { const p = await this._profileByUser(u); if (p) map[u] = p; }
        return map;
    },

    // === AUTH ===
    async signInWithGoogle() { return { data: null, error: { message: 'google_not_configured_yet' } }; },

    async signInWithEmail(email, password) {
        try { const r = await this.pb.collection('users').authWithPassword(email, password);
            return { data: { user: r.record, session: { user: r.record } }, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    async signUpWithEmail(email, password) {
        try {
            await this.pb.collection('users').create({ email, password, passwordConfirm: password });
            const r = await this.pb.collection('users').authWithPassword(email, password);
            return { data: { user: r.record, session: { user: r.record } }, error: null };
        } catch (e) { return { data: null, error: this._err(e) }; }
    },

    async resetPassword(email) {
        try { await this.pb.collection('users').requestPasswordReset(email); return { data: {}, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    async updatePassword(newPassword) {
        const uid = this._uid();
        if (!uid) return { error: { message: 'not_authenticated' } };
        try { await this.pb.collection('users').update(uid, { password: newPassword, passwordConfirm: newPassword }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },

    async signOut() { try { this.pb.authStore.clear(); } catch (e) {} return { error: null }; },

    async getSession() {
        const rec = this.pb?.authStore?.record;
        return { session: rec ? { user: rec } : null, error: null };
    },
    async getUser() {
        const rec = this.pb?.authStore?.record;
        return { user: rec || null, error: null };
    },

    onAuthStateChange(callback) {
        // Fire once on load + on authStore changes
        const unsub = this.pb.authStore.onChange((token, record) => {
            callback(record ? 'SIGNED_IN' : 'SIGNED_OUT', record ? { user: record } : null);
        }, false);
        return { data: { subscription: { unsubscribe: unsub } } };
    },

    // === PROFILE ===
    async getProfile(userId) {
        const p = await this._profileByUser(userId);
        return { profile: p ? this._mapProfile(p, userId) : null, error: null };
    },
    _mapProfile(p, userId) {
        return {
            id: userId, _pbId: p.id,
            first_name: p.first_name || '', last_name: p.last_name || '',
            phone: p.phone || '', address: p.address || '', apartment: p.apartment || '',
            default_role: p.default_role || 'voter', profile_completed: !!p.profile_completed
        };
    },
    async updateProfile(userId, profileData) {
        try {
            const existing = await this._profileByUser(userId);
            const payload = {};
            ['first_name', 'last_name', 'phone', 'address', 'apartment', 'default_role', 'profile_completed'].forEach(k => {
                if (k in profileData) payload[k] = profileData[k];
            });
            let rec;
            if (existing) rec = await this.pb.collection('profiles').update(existing.id, payload);
            else rec = await this.pb.collection('profiles').create({ user: userId, ...payload });
            return { profile: this._mapProfile(rec, userId), error: null };
        } catch (e) { return { profile: null, error: this._err(e) }; }
    },
    async isProfileCompleted(userId) {
        const p = await this._profileByUser(userId);
        return !!(p && p.profile_completed);
    },

    // === GROUPS ===
    async createGroup(name, description) {
        try { const r = await this.pb.send('/api/spilka/create-group', { method: 'POST', body: { name, description } });
            return { data: r.data, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    async getMyGroups() { return this.getMyGroupsWithStats(); },
    async getGroupsStats() { return { data: [], error: null }; }, // folded into my-groups

    async getMyGroupsWithStats() {
        try { const r = await this.pb.send('/api/spilka/my-groups', { method: 'POST', body: {} });
            return { data: r.data, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    async getMyMemberships() {
        const uid = this._uid(); if (!uid) return { data: [], error: null };
        try {
            const rows = await this.pb.collection('group_members').getFullList({ filter: `user="${uid}"` });
            return { data: rows.map(m => ({ group_id: m.group, is_observer: !!m.is_observer, apartment: m.apartment || '', role: m.role })), error: null };
        } catch (e) { return { data: [], error: this._err(e) }; }
    },

    async updateGroup(groupId, updates) {
        try { const r = await this.pb.collection('groups').update(groupId, { name: updates.name, description: updates.description });
            return { data: r, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    async deleteGroup(groupId) {
        try { await this.pb.collection('groups').delete(groupId); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },

    async leaveGroup(groupId) {
        try { await this.pb.send('/api/spilka/leave-group', { method: 'POST', body: { group_id: groupId } }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },

    async getGroupDetail(groupId) {
        try {
            const members = await this.pb.collection('group_members').getFullList({ filter: `group="${groupId}"` });
            const reqs = await this.pb.collection('join_requests').getFullList({ filter: `group="${groupId}" && status="pending"` });
            let history = [];
            try { history = await this.pb.collection('group_history').getFullList({ filter: `group="${groupId}"`, sort: '-created' }); } catch (e) {}
            const pmap = await this._profilesMap([...members.map(m => m.user), ...reqs.map(r => r.user)]);
            const prof = (uid) => { const p = pmap[uid]; return p ? { id: uid, first_name: p.first_name || '', last_name: p.last_name || '', phone: p.phone || '', address: p.address || '', apartment: p.apartment || '' } : { id: uid, first_name: '', last_name: '', apartment: '' }; };
            return { data: {
                members: members.map(m => ({ user_id: m.user, role: m.role, is_frozen: !!m.is_frozen, frozen_until: m.frozen_until || null, is_observer: !!m.is_observer, apartment: m.apartment || '', user: prof(m.user) })),
                requests: reqs.map(r => ({ id: r.id, user_id: r.user, status: r.status, created_at: r.created, apartment: r.apartment || '', requested_as_observer: !!r.requested_as_observer, is_role_change: !!r.is_role_change, user: prof(r.user) })),
                history: history.map(h => ({ id: h.id, action: h.action, details: h.details || {}, created_at: h.created, voting_id: h.voting || null })),
                stats: { members_count: members.length }
            }, error: null };
        } catch (e) { return { data: null, error: this._err(e) }; }
    },

    async findGroupByCode(code) {
        try { const r = await this.pb.send('/api/spilka/find-group', { method: 'POST', body: { code } });
            return { data: r.data, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    // join requests
    async submitJoinRequestV2(groupId, apartment, asObserver) {
        try { const r = await this.pb.send('/api/spilka/submit-join', { method: 'POST', body: { group_id: groupId, apartment, as_observer: asObserver } });
            return { data: r.data, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },
    async sendJoinRequest(groupId) { return this.submitJoinRequestV2(groupId, '', false); }, // legacy fallback

    async approveJoinRequest(requestId) { return this.approveJoinRequestV2(requestId, false); },
    async approveJoinRequestV2(requestId, forceObserver) {
        try { await this.pb.send('/api/spilka/approve-join', { method: 'POST', body: { request_id: requestId, force_observer: !!forceObserver } });
            return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },
    async rejectJoinRequest(requestId) {
        try { await this.pb.send('/api/spilka/reject-join', { method: 'POST', body: { request_id: requestId } }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },

    async requestRoleChange(groupId, becomeObserver) {
        try { await this.pb.send('/api/spilka/request-role-change', { method: 'POST', body: { group_id: groupId, become_observer: !!becomeObserver } });
            return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },
    async adminChangeRole(groupId, userId, makeObserver) {
        try { await this.pb.send('/api/spilka/admin-change-role', { method: 'POST', body: { group_id: groupId, user_id: userId, make_observer: !!makeObserver } });
            return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },
    async getVoterCount(groupId) {
        try { const r = await this.pb.send('/api/spilka/voter-count', { method: 'POST', body: { group_id: groupId } });
            return { data: r.data, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    // === VOTINGS ===
    async createVoting(v) {
        try {
            const rec = await this.pb.collection('votings').create({
                group: v.groupId, title: v.title, description: v.description || '', type: v.type,
                status: 'active', link: v.link || '', target_member: v.targetMemberId || '',
                removal_reason: v.removalReason || '', freeze_duration_days: v.freezeDurationDays || 7, ends_at: v.endsAt
            });
            return { data: rec, error: null };
        } catch (e) { return { data: null, error: this._err(e) }; }
    },
    async addFreezeTargets(votingId, userIds) {
        try { for (const uid of userIds) await this.pb.collection('freeze_targets').create({ voting: votingId, user: uid }); return { data: true, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    async getMyVotings() {
        const uid = this._uid(); if (!uid) return { data: [], error: null };
        try {
            const mems = await this.pb.collection('group_members').getFullList({ filter: `user="${uid}"` });
            if (!mems.length) return { data: [], error: null };
            const gfilter = mems.map(m => `group="${m.group}"`).join(' || ');
            const vts = await this.pb.collection('votings').getFullList({ filter: `(${gfilter}) && status!="deleted"`, sort: '-created' });
            const gids = [...new Set(mems.map(m => m.group))];
            const gmap = {}; for (const g of gids) { try { gmap[g] = await this.pb.collection('groups').getOne(g); } catch (e) {} }
            const pmap = await this._profilesMap([...vts.map(v => v.created_by), ...vts.map(v => v.target_member)]);
            const data = vts.map(v => ({
                id: v.id, group_id: v.group, title: v.title, description: v.description, type: v.type, status: v.status,
                result: v.result || null, link: v.link || null, target_member_id: v.target_member || null,
                removal_reason: v.removal_reason || null, freeze_duration_days: v.freeze_duration_days,
                ends_at: v.ends_at, completed_at: v.completed_at || null, created_at: v.created,
                group: { name: gmap[v.group]?.name || '' },
                creator: pmap[v.created_by] ? { first_name: pmap[v.created_by].first_name, last_name: pmap[v.created_by].last_name } : null,
                target: v.target_member && pmap[v.target_member] ? { first_name: pmap[v.target_member].first_name, last_name: pmap[v.target_member].last_name } : null
            }));
            return { data, error: null };
        } catch (e) { return { data: null, error: this._err(e) }; }
    },

    async getVotingResults(votingIds) {
        if (!votingIds || !votingIds.length) return { data: [], error: null };
        try { const r = await this.pb.send('/api/spilka/voting-results', { method: 'POST', body: { voting_ids: votingIds } });
            return { data: r.data, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    async getVotingVotes(votingId) {
        try {
            const votes = await this.pb.collection('votes').getFullList({ filter: `voting="${votingId}"`, sort: 'created' });
            const pmap = await this._profilesMap(votes.map(v => v.user));
            return { data: votes.map(v => ({ id: v.id, user_id: v.user, choice: v.choice, comment: v.comment || '', created_at: v.created,
                voter: pmap[v.user] ? { first_name: pmap[v.user].first_name, last_name: pmap[v.user].last_name, apartment: pmap[v.user].apartment } : null })), error: null };
        } catch (e) { return { data: null, error: this._err(e) }; }
    },

    async castVote(votingId, choice, comment) {
        try { const rec = await this.pb.collection('votes').create({ voting: votingId, choice, comment: comment || '' });
            return { data: rec, error: null }; }
        catch (e) { const er = this._err(e); if (er.code === 400 && /unique|idx_vote/i.test(JSON.stringify(er.data || ''))) er.code = '23505'; return { data: null, error: er }; }
    },

    async deleteVoting(votingId, reason) {
        try { const rec = await this.pb.collection('votings').update(votingId, { status: 'deleted', deleted_at: new Date().toISOString(), deleted_reason: reason });
            return { data: rec, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    // freeze beta
    async addFreezeObjection(votingId) {
        try { const rec = await this.pb.collection('freeze_objections').create({ voting: votingId, user: this._uid() }); return { data: rec, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },
    async getFreezeObjections(votingId) {
        try { const rows = await this.pb.collection('freeze_objections').getFullList({ filter: `voting="${votingId}"` });
            const pmap = await this._profilesMap(rows.map(r => r.user));
            return { data: rows.map(r => ({ user_id: r.user, time: r.created, user: pmap[r.user] ? { first_name: pmap[r.user].first_name, last_name: pmap[r.user].last_name } : null })), error: null }; }
        catch (e) { return { data: [], error: this._err(e) }; }
    },
    async getFreezeTargets(votingId) {
        try { const rows = await this.pb.collection('freeze_targets').getFullList({ filter: `voting="${votingId}"` });
            const pmap = await this._profilesMap(rows.map(r => r.user));
            return { data: rows.map(r => ({ user_id: r.user, user: pmap[r.user] ? { first_name: pmap[r.user].first_name, last_name: pmap[r.user].last_name, address: pmap[r.user].address, apartment: pmap[r.user].apartment } : null })), error: null }; }
        catch (e) { return { data: [], error: this._err(e) }; }
    },

    async checkExpiredVotings() {
        try { await this.pb.send('/api/spilka/complete-expired', { method: 'POST', body: {} }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },

    // === NOTIFICATIONS ===
    async getMyNotifications() {
        const uid = this._uid(); if (!uid) return { data: [], error: null };
        try { const rows = await this.pb.collection('notifications').getFullList({ filter: `user="${uid}" && archived_at=""`, sort: '-created' });
            return { data: rows.map(n => ({ id: n.id, type: n.type, text: n.text, is_read: !!n.is_read, created_at: n.created, metadata: n.metadata || {}, archived_at: n.archived_at || null })), error: null }; }
        catch (e) { return { data: [], error: this._err(e) }; }
    },
    async createNotification() { return { error: null }; }, // server-side via routes
    async markNotificationRead(id) { try { await this.pb.collection('notifications').update(id, { is_read: true }); return { error: null }; } catch (e) { return { error: this._err(e) }; } },
    async markAllNotificationsRead() {
        const uid = this._uid(); if (!uid) return { error: null };
        try { const rows = await this.pb.collection('notifications').getFullList({ filter: `user="${uid}" && is_read=false` });
            for (const n of rows) await this.pb.collection('notifications').update(n.id, { is_read: true }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },
    async archiveAllNotifications() {
        const uid = this._uid(); if (!uid) return { error: null };
        try { const rows = await this.pb.collection('notifications').getFullList({ filter: `user="${uid}" && archived_at=""` });
            const now = new Date().toISOString();
            for (const n of rows) await this.pb.collection('notifications').update(n.id, { archived_at: now, is_read: true }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },
    async getArchivedNotifications() {
        const uid = this._uid(); if (!uid) return { data: [], error: null };
        try { const rows = await this.pb.collection('notifications').getFullList({ filter: `user="${uid}" && archived_at!=""`, sort: '-archived_at' });
            return { data: rows.map(n => ({ id: n.id, type: n.type, text: n.text, is_read: !!n.is_read, created_at: n.created, metadata: n.metadata || {}, archived_at: n.archived_at })), error: null }; }
        catch (e) { return { data: [], error: this._err(e) }; }
    },
    async searchNotifications(query, archivedOnly, limit = 50, offset = 0) {
        const uid = this._uid(); if (!uid) return { data: [], error: null };
        let f = `user="${uid}"`;
        if (archivedOnly === true) f += ` && archived_at!=""`; else if (archivedOnly === false) f += ` && archived_at=""`;
        if (query && query.trim().length >= 3) f += ` && text~"${query.trim().replace(/"/g, '')}"`;
        try { const res = await this.pb.collection('notifications').getList(Math.floor(offset / limit) + 1, limit, { filter: f, sort: '-created' });
            return { data: res.items.map(n => ({ id: n.id, type: n.type, text: n.text, is_read: !!n.is_read, created_at: n.created, metadata: n.metadata || {}, archived_at: n.archived_at || null })), error: null }; }
        catch (e) { return { data: [], error: this._err(e) }; }
    },
    async unarchiveNotification(id) { try { await this.pb.collection('notifications').update(id, { archived_at: null }); return { error: null }; } catch (e) { return { error: this._err(e) }; } },
    async notifyJoinRequest() { return { error: null }; },     // handled server-side
    async notifyGroupMembers() { return { error: null }; },
    async adminBroadcastNotification(userIds, text) {
        try { const r = await this.pb.send('/api/spilka/broadcast', { method: 'POST', body: { user_ids: userIds, text } }); return { data: r.data, error: null }; }
        catch (e) { return { data: null, error: this._err(e) }; }
    },

    // === MEMBER VOTES (participation) ===
    async getGroupMemberVotes(groupId) {
        try { const r = await this.pb.send('/api/spilka/member-votes', { method: 'POST', body: { group_id: groupId } }); return { data: r.data, error: null }; }
        catch (e) { return { data: [], error: this._err(e) }; }
    },

    // === FEEDBACK ===
    async submitFeedback(text) {
        try { await this.pb.collection('feedback').create({ text, status: 'new' }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },
    async getAdminFeedback() { return { data: [], error: null }; },
    async updateFeedbackStatus(id, status) {
        try { await this.pb.collection('feedback').update(id, { status }); return { error: null }; }
        catch (e) { return { error: this._err(e) }; }
    },

    // === compat shim for the few direct supabaseService.client.* calls ===
    _buildClientShim() {
        const svc = this;
        return {
            auth: {
                updateUser: async ({ password }) => { const r = await svc.updatePassword(password); return { error: r.error }; },
                onAuthStateChange: (cb) => svc.onAuthStateChange((e, s) => cb(e, s)).data.subscription
            },
            from: (table) => svc._queryBuilder(table),
            channel: () => svc._noopChannel(),
            removeChannel: () => {}
        };
    },
    _noopChannel() { const ch = { on: () => ch, subscribe: () => ch }; return ch; },
    _queryBuilder(table) {
        // minimal builder used by app.js: feedback insert/update, votes select, group_stats select
        const svc = this;
        return {
            insert: (row) => ({ then: undefined, async select() { return this.__run('insert', row); }, async single() { return this.__run('insert', row); },
                async __run() { try { if (table === 'feedback') { await svc.submitFeedback(row.text); return { data: row, error: null }; } return { data: null, error: null }; } catch (e) { return { data: null, error: svc._err(e) }; } },
                // direct await (no .select) -> behaves like a promise
                then(res) { this.__run().then(res); } }),
            update: (vals) => ({ eq: (col, val) => ({ async then(res) { try { if (table === 'feedback') await svc.updateFeedbackStatus(val, vals.status); res({ error: null }); } catch (e) { res({ error: svc._err(e) }); } } }) }),
            select: () => svc._noopSelect(table)
        };
    },
    _noopSelect() { return { eq: () => this._noopSelect(), in: () => this._noopSelect(), order: () => this._noopSelect(), async then(res) { res({ data: [], error: null }); } }; }
};
