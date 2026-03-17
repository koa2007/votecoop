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
    }
};
