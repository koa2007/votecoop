// Supabase Service Module — single point of interaction with Supabase
// Requires: @supabase/supabase-js CDN + js/config.js loaded before this file

const supabaseService = {
    client: null,
    initialized: false,

    // Initialize Supabase client
    init() {
        if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
            throw new Error('Supabase config not found. Copy js/config.example.js to js/config.js');
        }

        if (SUPABASE_URL === 'https://YOUR_PROJECT.supabase.co' || SUPABASE_ANON_KEY === 'YOUR_ANON_KEY') {
            this.initialized = false;
            return false;
        }

        try {
            this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            this.initialized = true;
            return true;
        } catch (err) {
            this.initialized = false;
            return false;
        }
    },

    // Check if Supabase is configured and ready
    isReady() {
        return this.initialized && this.client !== null;
    },

    // Safe helper to get current user ID (returns null if not authenticated)
    async _getUserId() {
        try {
            const { data, error } = await this.client.auth.getUser();
            if (error || !data?.user) return null;
            return data.user.id;
        } catch {
            return null;
        }
    },

    // === AUTH ===

    // Sign in with Google OAuth (redirects to Google)
    async signInWithGoogle() {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const redirectUrl = window.location.origin + window.location.pathname;

        const { data, error } = await this.client.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: redirectUrl
            }
        });

        return { data, error };
    },

    // Sign in with email and password
    async signInWithEmail(email, password) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const { data, error } = await this.client.auth.signInWithPassword({
            email: email,
            password: password
        });

        return { data, error };
    },

    // Register new user with email and password
    async signUpWithEmail(email, password) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const redirectUrl = window.location.origin + window.location.pathname;

        const { data, error } = await this.client.auth.signUp({
            email: email,
            password: password,
            options: {
                emailRedirectTo: redirectUrl
            }
        });

        return { data, error };
    },

    // Send password reset email
    async resetPassword(email) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const redirectUrl = window.location.origin + window.location.pathname;

        const { data, error } = await this.client.auth.resetPasswordForEmail(email, {
            redirectTo: redirectUrl
        });

        return { data, error };
    },

    // Sign out
    async signOut() {
        if (!this.isReady()) {
            return { error: null };
        }

        const { error } = await this.client.auth.signOut();
        return { error };
    },

    // Get current session
    async getSession() {
        if (!this.isReady()) {
            return { session: null, error: null };
        }

        const { data, error } = await this.client.auth.getSession();
        return { session: data?.session || null, error };
    },

    // Get current user from session
    async getUser() {
        if (!this.isReady()) {
            return { user: null, error: null };
        }

        const { data, error } = await this.client.auth.getUser();
        return { user: data?.user || null, error };
    },

    // Listen for auth state changes
    onAuthStateChange(callback) {
        if (!this.isReady()) {
            return { data: { subscription: { unsubscribe() {} } } };
        }

        return this.client.auth.onAuthStateChange((event, session) => {
            callback(event, session);
        });
    },

    // === PROFILE ===

    // Get profile by user ID
    async getProfile(userId) {
        if (!this.isReady()) {
            return { profile: null, error: null };
        }

        const { data, error } = await this.client.from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        return { profile: data, error };
    },

    // Update profile fields
    async updateProfile(userId, profileData) {
        if (!this.isReady()) {
            return { profile: null, error: { message: 'Supabase not configured' } };
        }

        const { data, error } = await this.client.from('profiles')
            .update(profileData)
            .eq('id', userId)
            .select()
            .single();

        return { profile: data, error };
    },

    // Check if profile is completed
    async isProfileCompleted(userId) {
        if (!this.isReady()) {
            return false;
        }

        const { profile, error } = await this.getProfile(userId);

        if (error || !profile) {
            return false;
        }

        return profile.profile_completed === true;
    },

    // === GROUPS ===

    // Create group + add creator as admin (atomic RPC)
    async createGroup(name, description) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const { data, error } = await this.client.rpc('create_group_with_member', {
            p_name: name,
            p_description: description || ''
        });

        return { data: data?.[0] || null, error };
    },

    // Get all groups the current user is a member of
    async getMyGroups() {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        const { data, error } = await this.client.from('group_members')
            .select(`
                role,
                group:groups (
                    id, name, description, group_code, created_by, created_at
                )
            `)
            .eq('user_id', userId);

        return { data, error };
    },

    async getGroupsStats(groupIds) {
        if (!this.isReady() || !groupIds.length) {
            return { data: [], error: null };
        }
        const { data, error } = await this.client.from('group_stats')
            .select('group_id, members_count, active_votings_count, total_votings_count')
            .in('group_id', groupIds);
        return { data: data || [], error };
    },

    // Combined groups + stats in one RPC call (faster than 2 separate queries)
    async getMyGroupsWithStats() {
        if (!this.isReady()) {
            return { data: null, error: null };
        }
        const { data, error } = await this.client.rpc('get_my_groups_with_stats');
        return { data, error };
    },

    // Update group name/description (admin only)
    async updateGroup(groupId, updates) {
        const userId = await this._getUserId();
        if (!userId) return { error: { message: 'User not authenticated' } };

        const { data, error } = await this.client
            .from('groups')
            .update({
                name: updates.name,
                description: updates.description
            })
            .eq('id', groupId)
            .eq('created_by', userId)
            .select()
            .single();

        return { data, error };
    },

    // Delete group (admin/creator only)
    async deleteGroup(groupId) {
        const userId = await this._getUserId();
        if (!userId) return { error: { message: 'User not authenticated' } };

        const { error } = await this.client
            .from('groups')
            .delete()
            .eq('id', groupId)
            .eq('created_by', userId);

        return { error };
    },

    async leaveGroup(groupId) {
        if (!this.isReady()) {
            return { error: { message: 'Supabase not configured' } };
        }
        const { error } = await this.client.rpc('leave_group', { p_group_id: groupId });
        return { error };
    },

    // Get detailed group info (members, requests, history, stats)
    async getGroupDetail(groupId) {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        const [membersRes, requestsRes, historyRes, statsRes] = await Promise.all([
            this.client.from('group_members')
                .select('user_id, role, is_frozen, frozen_until, is_observer, apartment, user:profiles(id, first_name, last_name, phone, address, apartment)')
                .eq('group_id', groupId),
            // Explicit FK: join_requests has TWO refs to profiles
            // (user_id and resolved_by), so PostgREST needs the FK name.
            this.client.from('join_requests')
                .select('id, user_id, status, created_at, apartment, requested_as_observer, is_role_change, user:profiles!join_requests_user_id_fkey(id, first_name, last_name, address, apartment)')
                .eq('group_id', groupId)
                .eq('status', 'pending'),
            this.client.from('group_history')
                .select('*')
                .eq('group_id', groupId)
                .order('created_at', { ascending: false }),
            this.client.from('group_stats')
                .select('*')
                .eq('group_id', groupId)
                .maybeSingle()
        ]);

        return {
            data: {
                members: membersRes.data,
                requests: requestsRes.data,
                history: historyRes.data,
                stats: statsRes.data
            },
            error: membersRes.error || requestsRes.error || historyRes.error || statsRes.error
        };
    },

    // Find group by 6-digit code (bypasses RLS via RPC)
    async findGroupByCode(code) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const { data, error } = await this.client.rpc('find_group_by_code', {
            p_code: code
        });

        return { data: data?.[0] || null, error };
    },

    // Send join request for a group
    async sendJoinRequest(groupId) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        const { data, error } = await this.client.from('join_requests')
            .insert({ group_id: groupId, user_id: userId })
            .select()
            .single();

        return { data, error };
    },

    // Approve join request (atomic RPC: update request + add member)
    async approveJoinRequest(requestId) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const { data, error } = await this.client.rpc('approve_join_request', {
            p_request_id: requestId
        });

        return { data, error };
    },

    // Reject join request
    async rejectJoinRequest(requestId) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        const { data, error } = await this.client.from('join_requests')
            .update({
                status: 'rejected',
                resolved_at: new Date().toISOString(),
                resolved_by: userId
            })
            .eq('id', requestId)
            .select()
            .single();

        return { data, error };
    },

    // === VOTINGS ===

    // Create a new voting
    async createVoting(votingData) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        const { data, error } = await this.client.from('votings')
            .insert({
                group_id: votingData.groupId,
                title: votingData.title,
                description: votingData.description || '',
                type: votingData.type,
                link: votingData.link || null,
                target_member_id: votingData.targetMemberId || null,
                removal_reason: votingData.removalReason || null,
                freeze_duration_days: votingData.freezeDurationDays || 7,
                ends_at: votingData.endsAt,
                created_by: userId
            })
            .select()
            .single();

        return { data, error };
    },

    // Add freeze targets for a freeze voting
    async addFreezeTargets(votingId, userIds) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const rows = userIds.map(uid => ({ voting_id: votingId, user_id: uid }));

        const { data, error } = await this.client.from('freeze_targets')
            .insert(rows)
            .select();

        return { data, error };
    },

    // Get all votings for the current user's groups
    async getMyVotings() {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        // Get group IDs
        const { data: memberships, error: membershipError } = await this.client.from('group_members')
            .select('group_id')
            .eq('user_id', userId);

        if (membershipError) {
            return { data: null, error: membershipError };
        }

        if (!memberships || memberships.length === 0) {
            return { data: [], error: null };
        }

        const groupIds = memberships.map(m => m.group_id);

        const { data, error } = await this.client.from('votings')
            .select(`
                *,
                group:groups(name),
                creator:profiles!created_by(first_name, last_name),
                target:profiles!target_member_id(first_name, last_name)
            `)
            .in('group_id', groupIds)
            .neq('status', 'deleted')
            .order('created_at', { ascending: false });

        return { data, error };
    },

    // Get vote counts for votings (from view)
    async getVotingResults(votingIds) {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        if (!votingIds || votingIds.length === 0) {
            return { data: [], error: null };
        }

        const { data, error } = await this.client.from('voting_results')
            .select('*')
            .in('voting_id', votingIds);

        return { data, error };
    },

    // Get individual votes for a voting (with voter profiles)
    async getVotingVotes(votingId) {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        const { data, error } = await this.client.from('votes')
            .select('*, voter:profiles!user_id(first_name, last_name, apartment)')
            .eq('voting_id', votingId)
            .order('created_at', { ascending: true });

        return { data, error };
    },

    // Cast a vote
    async castVote(votingId, choice, comment) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        const { data, error } = await this.client.from('votes')
            .insert({
                voting_id: votingId,
                user_id: userId,
                choice,
                comment: comment || ''
            })
            .select()
            .single();

        return { data, error };
    },

    // Delete (soft) a voting — only the author can delete
    async deleteVoting(votingId, reason) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        const { data, error } = await this.client.from('votings')
            .update({
                status: 'deleted',
                deleted_at: new Date().toISOString(),
                deleted_reason: reason
            })
            .eq('id', votingId)
            .eq('created_by', userId)
            .select()
            .single();

        return { data, error };
    },

    // Add a freeze objection
    async addFreezeObjection(votingId) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        const { data, error } = await this.client.from('freeze_objections')
            .insert({ voting_id: votingId, user_id: userId })
            .select()
            .single();

        return { data, error };
    },

    // Get freeze objections for a voting
    async getFreezeObjections(votingId) {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        const { data, error } = await this.client.from('freeze_objections')
            .select('*, user:profiles(first_name, last_name)')
            .eq('voting_id', votingId);

        return { data, error };
    },

    // Get freeze targets for a voting
    async getFreezeTargets(votingId) {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        const { data, error } = await this.client.from('freeze_targets')
            .select('*, user:profiles(first_name, last_name, address, apartment)')
            .eq('voting_id', votingId);

        return { data, error };
    },

    // Trigger server-side check for expired votings
    async checkExpiredVotings() {
        if (!this.isReady()) {
            return { error: null };
        }

        const { error } = await this.client.rpc('check_my_expired_votings');
        return { error };
    },

    // === NOTIFICATIONS ===

    // Get current user's notifications
    async getMyNotifications() {
        if (!this.isReady()) {
            return { data: null, error: null };
        }

        const userId = await this._getUserId();
        if (!userId) return { data: null, error: { message: 'User not authenticated' } };

        // Try with metadata column first; if the migration hasn't been
        // applied yet (phase11), fall back to the legacy column set so
        // notifications still load.
        // Also try to filter out archived rows; if archived_at column
        // doesn't exist (phase12 not applied), retry without that filter.
        let q1 = this.client.from('notifications')
            .select('id, type, text, is_read, created_at, metadata, archived_at')
            .eq('user_id', userId)
            .is('archived_at', null)
            .order('created_at', { ascending: false })
            .limit(100);
        let { data, error } = await q1;

        if (error && /archived_at/i.test(error.message || '')) {
            // archived_at not yet migrated — retry without it
            const r = await this.client.from('notifications')
                .select('id, type, text, is_read, created_at, metadata')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(100);
            data = r.data; error = r.error;
        }

        if (error && /metadata.*does not exist/i.test(error.message || '')) {
            const r = await this.client.from('notifications')
                .select('id, type, text, is_read, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(100);
            data = r.data; error = r.error;
        }

        return { data, error };
    },

    // Archive all currently active (non-archived) notifications for this user.
    async archiveAllNotifications() {
        if (!this.isReady()) return { error: { message: 'Supabase not configured' } };
        const userId = await this._getUserId();
        if (!userId) return { error: { message: 'User not authenticated' } };
        const { error } = await this.client.from('notifications')
            .update({ archived_at: new Date().toISOString(), is_read: true })
            .eq('user_id', userId)
            .is('archived_at', null);
        return { error };
    },

    // Fetch archived notifications (for an Archive view, future use).
    async getArchivedNotifications() {
        if (!this.isReady()) return { data: [], error: null };
        const userId = await this._getUserId();
        if (!userId) return { data: [], error: { message: 'User not authenticated' } };
        const { data, error } = await this.client.from('notifications')
            .select('id, type, text, is_read, created_at, metadata, archived_at')
            .eq('user_id', userId)
            .not('archived_at', 'is', null)
            .order('archived_at', { ascending: false })
            .limit(200);
        return { data, error };
    },

    // Paginated search across notifications. archivedOnly=true → only archive,
    // false → only active, null → both. Empty query returns recent items.
    async searchNotifications(query, archivedOnly, limit = 50, offset = 0) {
        if (!this.isReady()) return { data: [], error: null };
        const userId = await this._getUserId();
        if (!userId) return { data: [], error: { message: 'User not authenticated' } };
        let q = this.client.from('notifications')
            .select('id, type, text, is_read, created_at, metadata, archived_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (archivedOnly === true) q = q.not('archived_at', 'is', null);
        else if (archivedOnly === false) q = q.is('archived_at', null);
        if (query && query.trim().length >= 3) {
            q = q.ilike('text', `%${query.trim()}%`);
        }
        const { data, error } = await q;
        return { data: data || [], error };
    },

    // Move a single notification back from archive to active list.
    async unarchiveNotification(notificationId) {
        if (!this.isReady()) return { error: null };
        const userId = await this._getUserId();
        if (!userId) return { error: { message: 'User not authenticated' } };
        const { error } = await this.client.from('notifications')
            .update({ archived_at: null })
            .eq('id', notificationId)
            .eq('user_id', userId);
        return { error };
    },

    // Mark a single notification as read
    async markNotificationRead(notificationId) {
        if (!this.isReady()) {
            return { error: null };
        }

        const userId = await this._getUserId();
        if (!userId) return { error: { message: 'User not authenticated' } };

        const { error } = await this.client.from('notifications')
            .update({ is_read: true })
            .eq('id', notificationId)
            .eq('user_id', userId);

        return { error };
    },

    // Mark all notifications as read
    async markAllNotificationsRead() {
        if (!this.isReady()) {
            return { error: null };
        }

        const userId = await this._getUserId();
        if (!userId) return { error: { message: 'User not authenticated' } };

        const { error } = await this.client.from('notifications')
            .update({ is_read: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        return { error };
    },

    // Create a notification
    async createNotification(userId, type, text) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }

        const { data, error } = await this.client.from('notifications')
            .insert({ user_id: userId, type, text })
            .select()
            .single();

        return { data, error };
    },

    // Notify all members of a group (via RPC)
    async notifyGroupMembers(groupId, type, text) {
        if (!this.isReady()) {
            return { error: { message: 'Supabase not configured' } };
        }

        const userId = await this._getUserId();
        if (!userId) return { error: { message: 'User not authenticated' } };

        const { error } = await this.client.rpc('notify_group_members', {
            p_group_id: groupId,
            p_type: type,
            p_text: text,
            p_exclude_user: userId
        });

        return { error };
    },

    async notifyJoinRequest(groupId) {
        if (!this.isReady()) {
            return { error: { message: 'Supabase not configured' } };
        }
        const { error } = await this.client.rpc('notify_join_request', { p_group_id: groupId });
        return { error };
    },

    // === PHASE 14: VOTER / OBSERVER ROLE SYSTEM ===

    async submitJoinRequestV2(groupId, apartment, asObserver) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }
        return await this.client.rpc('submit_join_request_v2', {
            p_group_id: groupId,
            p_apartment: apartment,
            p_as_observer: asObserver
        });
    },

    async requestRoleChange(groupId, becomeObserver) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }
        return await this.client.rpc('request_role_change', {
            p_group_id: groupId,
            p_become_observer: becomeObserver
        });
    },

    async approveJoinRequestV2(requestId, forceObserver = false) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }
        return await this.client.rpc('approve_join_request_v2', {
            p_request_id: requestId,
            p_force_observer: forceObserver
        });
    },

    async getVoterCount(groupId) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }
        return await this.client.rpc('get_voter_count', { p_group_id: groupId });
    },

    async adminChangeRole(groupId, userId, makeObserver) {
        if (!this.isReady()) {
            return { data: null, error: { message: 'Supabase not configured' } };
        }
        return await this.client.from('group_members')
            .update({ is_observer: makeObserver })
            .eq('group_id', groupId)
            .eq('user_id', userId);
    }
};
