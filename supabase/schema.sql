-- ============================================
-- VoteCoop Database Schema for Supabase
-- ============================================
-- Run this in Supabase SQL Editor after creating a project
-- Auth is handled by Supabase Auth (Email + Google OAuth)

-- ============================================
-- 1. PROFILES (extends Supabase auth.users)
-- ============================================
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    apartment TEXT DEFAULT '',
    language TEXT NOT NULL DEFAULT 'uk' CHECK (language IN ('uk', 'en', 'ru')),
    profile_completed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, first_name, last_name)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
        COALESCE(NEW.raw_user_meta_data->>'last_name', '')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================
-- 2. GROUPS
-- ============================================
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    group_code CHAR(6) NOT NULL UNIQUE,
    created_by UUID NOT NULL REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generate unique 6-digit code
CREATE OR REPLACE FUNCTION generate_group_code()
RETURNS CHAR(6) AS $$
DECLARE
    new_code CHAR(6);
BEGIN
    LOOP
        new_code := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM groups WHERE group_code = new_code);
    END LOOP;
    RETURN new_code;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 3. GROUP MEMBERS
-- ============================================
CREATE TABLE group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    frozen_until TIMESTAMPTZ,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(group_id, user_id)
);

-- ============================================
-- 4. JOIN REQUESTS
-- ============================================
CREATE TABLE join_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES profiles(id),
    UNIQUE(group_id, user_id)
);

-- ============================================
-- 5. VOTINGS
-- ============================================
CREATE TABLE votings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('simple', 'secret', 'admin-change', 'remove-member', 'freeze')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'deleted')),
    result TEXT CHECK (result IN ('accepted', 'rejected', NULL)),
    link TEXT,

    -- For admin-change and remove-member types
    target_member_id UUID REFERENCES profiles(id),
    removal_reason TEXT,

    -- For freeze type
    freeze_duration_days INT DEFAULT 7,

    -- Timing
    created_by UUID NOT NULL REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,

    -- Deletion
    deleted_at TIMESTAMPTZ,
    deleted_reason TEXT
);

-- ============================================
-- 6. VOTES (individual ballots)
-- ============================================
CREATE TABLE votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voting_id UUID NOT NULL REFERENCES votings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id),
    choice TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
    comment TEXT DEFAULT '' CHECK (LENGTH(comment) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(voting_id, user_id)
);

-- ============================================
-- 7. FREEZE TARGETS (members selected for freeze)
-- ============================================
CREATE TABLE freeze_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voting_id UUID NOT NULL REFERENCES votings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id),
    UNIQUE(voting_id, user_id)
);

-- ============================================
-- 8. FREEZE OBJECTIONS
-- ============================================
CREATE TABLE freeze_objections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voting_id UUID NOT NULL REFERENCES votings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(voting_id, user_id)
);

-- ============================================
-- 9. NOTIFICATIONS
-- ============================================
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('voting', 'member', 'result', 'system')),
    text TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 10. GROUP HISTORY (audit log)
-- ============================================
CREATE TABLE group_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    initiated_by UUID REFERENCES profiles(id),
    voting_id UUID REFERENCES votings(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- VIEWS (for convenient querying)
-- ============================================

-- Vote counts per voting (without revealing who voted what in secret votings)
CREATE VIEW voting_results AS
SELECT
    voting_id,
    COUNT(*) FILTER (WHERE choice = 'yes') AS yes_votes,
    COUNT(*) FILTER (WHERE choice = 'no') AS no_votes,
    COUNT(*) FILTER (WHERE choice = 'abstain') AS abstain_votes,
    COUNT(*) AS total_votes
FROM votes
GROUP BY voting_id;

-- Member count per group
CREATE VIEW group_stats AS
SELECT
    g.id AS group_id,
    COUNT(DISTINCT gm.user_id) AS members_count,
    COUNT(DISTINCT v.id) FILTER (WHERE v.status = 'active') AS active_votings_count,
    COUNT(DISTINCT v.id) AS total_votings_count,
    COUNT(DISTINCT gm.user_id) FILTER (WHERE gm.is_frozen = TRUE) AS frozen_count
FROM groups g
LEFT JOIN group_members gm ON gm.group_id = g.id
LEFT JOIN votings v ON v.group_id = g.id AND v.status != 'deleted'
GROUP BY g.id;

-- ============================================
-- INDEXES (performance)
-- ============================================
CREATE INDEX idx_group_members_group ON group_members(group_id);
CREATE INDEX idx_group_members_user ON group_members(user_id);
CREATE INDEX idx_votings_group ON votings(group_id);
CREATE INDEX idx_votings_status ON votings(status);
CREATE INDEX idx_votings_ends_at ON votings(ends_at) WHERE status = 'active';
CREATE INDEX idx_votes_voting ON votes(voting_id);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE is_read = FALSE;
CREATE INDEX idx_join_requests_pending ON join_requests(group_id) WHERE status = 'pending';
CREATE INDEX idx_group_history_group ON group_history(group_id);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE votings ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE freeze_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE freeze_objections ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_history ENABLE ROW LEVEL SECURITY;

-- PROFILES: users can read any profile, update only their own
CREATE POLICY "Profiles are viewable by authenticated users"
    ON profiles FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE TO authenticated
    USING (id = auth.uid());

-- GROUPS: visible to members
CREATE POLICY "Groups visible to members"
    ON groups FOR SELECT TO authenticated
    USING (
        EXISTS (SELECT 1 FROM group_members WHERE group_id = groups.id AND user_id = auth.uid())
    );

CREATE POLICY "Authenticated users can create groups"
    ON groups FOR INSERT TO authenticated
    WITH CHECK (created_by = auth.uid());

-- GROUP MEMBERS: visible to fellow group members
CREATE POLICY "Members visible to group members"
    ON group_members FOR SELECT TO authenticated
    USING (
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_members.group_id AND gm.user_id = auth.uid())
    );

CREATE POLICY "Admins can manage members"
    ON group_members FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_members.group_id AND gm.user_id = auth.uid() AND gm.role = 'admin')
    );

-- JOIN REQUESTS: visible to group admins and the requester
CREATE POLICY "Join requests visible to admins and requester"
    ON join_requests FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = join_requests.group_id AND gm.user_id = auth.uid() AND gm.role = 'admin')
    );

CREATE POLICY "Authenticated users can create join requests"
    ON join_requests FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can update join requests"
    ON join_requests FOR UPDATE TO authenticated
    USING (
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = join_requests.group_id AND gm.user_id = auth.uid() AND gm.role = 'admin')
    );

-- VOTINGS: visible to group members
CREATE POLICY "Votings visible to group members"
    ON votings FOR SELECT TO authenticated
    USING (
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = votings.group_id AND gm.user_id = auth.uid())
    );

CREATE POLICY "Group members can create votings"
    ON votings FOR INSERT TO authenticated
    WITH CHECK (
        created_by = auth.uid()
        AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = votings.group_id AND gm.user_id = auth.uid())
    );

CREATE POLICY "Authors can delete own votings"
    ON votings FOR UPDATE TO authenticated
    USING (created_by = auth.uid());

-- VOTES: members can vote, see own votes; secret voting hides voter identity
CREATE POLICY "Members can cast votes"
    ON votes FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM votings v
            JOIN group_members gm ON gm.group_id = v.group_id
            WHERE v.id = votes.voting_id AND gm.user_id = auth.uid() AND v.status = 'active'
        )
    );

CREATE POLICY "Vote visibility based on voting type"
    ON votes FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM votings v
            JOIN group_members gm ON gm.group_id = v.group_id
            WHERE v.id = votes.voting_id AND gm.user_id = auth.uid() AND v.type != 'secret'
        )
    );

-- FREEZE: visible to group members
CREATE POLICY "Freeze targets visible to group members"
    ON freeze_targets FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM votings v
            JOIN group_members gm ON gm.group_id = v.group_id
            WHERE v.id = freeze_targets.voting_id AND gm.user_id = auth.uid()
        )
    );

CREATE POLICY "Freeze objections visible to group members"
    ON freeze_objections FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM votings v
            JOIN group_members gm ON gm.group_id = v.group_id
            WHERE v.id = freeze_objections.voting_id AND gm.user_id = auth.uid()
        )
    );

CREATE POLICY "Members can object to freeze"
    ON freeze_objections FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

-- NOTIFICATIONS: only own
CREATE POLICY "Users see own notifications"
    ON notifications FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "Users can update own notifications"
    ON notifications FOR UPDATE TO authenticated
    USING (user_id = auth.uid());

-- GROUP HISTORY: visible to group members
CREATE POLICY "History visible to group members"
    ON group_history FOR SELECT TO authenticated
    USING (
        EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_history.group_id AND gm.user_id = auth.uid())
    );

-- ============================================
-- FUNCTIONS (business logic)
-- ============================================

-- Auto-complete votings when time expires
CREATE OR REPLACE FUNCTION complete_expired_votings()
RETURNS void AS $$
DECLARE
    v RECORD;
    yes_count INT;
    no_count INT;
    total_members INT;
    voting_result TEXT;
BEGIN
    FOR v IN SELECT * FROM votings WHERE status = 'active' AND ends_at <= now()
    LOOP
        SELECT
            COUNT(*) FILTER (WHERE choice = 'yes'),
            COUNT(*) FILTER (WHERE choice = 'no')
        INTO yes_count, no_count
        FROM votes WHERE voting_id = v.id;

        SELECT COUNT(*) INTO total_members
        FROM group_members WHERE group_id = v.group_id;

        IF yes_count > total_members / 2 THEN
            voting_result := 'accepted';
        ELSE
            voting_result := 'rejected';
        END IF;

        UPDATE votings
        SET status = 'completed', result = voting_result, completed_at = now()
        WHERE id = v.id;

        -- Apply side effects for accepted special votings
        IF voting_result = 'accepted' THEN
            IF v.type = 'admin-change' AND v.target_member_id IS NOT NULL THEN
                UPDATE group_members SET role = 'member'
                WHERE group_id = v.group_id AND role = 'admin';

                UPDATE group_members SET role = 'admin'
                WHERE group_id = v.group_id AND user_id = v.target_member_id;

                INSERT INTO group_history (group_id, action, details, voting_id)
                VALUES (v.group_id, 'admin_change', jsonb_build_object('new_admin', v.target_member_id), v.id);
            END IF;

            IF v.type = 'remove-member' AND v.target_member_id IS NOT NULL THEN
                DELETE FROM group_members
                WHERE group_id = v.group_id AND user_id = v.target_member_id;

                INSERT INTO group_history (group_id, action, details, voting_id)
                VALUES (v.group_id, 'member_removed', jsonb_build_object('removed_user', v.target_member_id, 'reason', v.removal_reason), v.id);
            END IF;

            IF v.type = 'freeze' THEN
                UPDATE group_members SET is_frozen = TRUE, frozen_until = now() + INTERVAL '7 days'
                WHERE group_id = v.group_id
                AND user_id IN (SELECT user_id FROM freeze_targets WHERE voting_id = v.id);

                INSERT INTO group_history (group_id, action, details, voting_id)
                VALUES (v.group_id, 'members_frozen', jsonb_build_object('voting_id', v.id), v.id);
            END IF;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Auto-reject freeze if 2+ objections
CREATE OR REPLACE FUNCTION check_freeze_objections()
RETURNS TRIGGER AS $$
DECLARE
    objection_count INT;
BEGIN
    SELECT COUNT(*) INTO objection_count
    FROM freeze_objections WHERE voting_id = NEW.voting_id;

    IF objection_count >= 2 THEN
        UPDATE votings
        SET status = 'completed', result = 'rejected', completed_at = now()
        WHERE id = NEW.voting_id AND type = 'freeze' AND status = 'active';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_freeze_objection
    AFTER INSERT ON freeze_objections
    FOR EACH ROW EXECUTE FUNCTION check_freeze_objections();

-- Auto-unfreeze members when freeze expires
CREATE OR REPLACE FUNCTION unfreeze_expired_members()
RETURNS void AS $$
BEGIN
    UPDATE group_members
    SET is_frozen = FALSE, frozen_until = NULL
    WHERE is_frozen = TRUE AND frozen_until <= now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Updated_at trigger for profiles
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- CRON JOBS (via pg_cron extension in Supabase)
-- Enable pg_cron in Supabase Dashboard > Database > Extensions
-- ============================================
-- Run every minute: complete expired votings
-- SELECT cron.schedule('complete-votings', '* * * * *', 'SELECT complete_expired_votings()');
-- Run every hour: unfreeze expired members
-- SELECT cron.schedule('unfreeze-members', '0 * * * *', 'SELECT unfreeze_expired_members()');

-- ============================================
-- PHASE 2: RPC Functions & Additional Policies
-- ============================================

-- Auto-generate group_code on INSERT
CREATE OR REPLACE FUNCTION set_group_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.group_code IS NULL OR NEW.group_code = '' THEN
        NEW.group_code := generate_group_code();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_group_code
    BEFORE INSERT ON groups
    FOR EACH ROW EXECUTE FUNCTION set_group_code();

-- RPC: Create group + first admin member atomically
CREATE OR REPLACE FUNCTION create_group_with_member(
    p_name TEXT,
    p_description TEXT DEFAULT ''
)
RETURNS TABLE(group_id UUID, group_code CHAR(6)) AS $$
DECLARE
    v_group_id UUID;
    v_group_code CHAR(6);
BEGIN
    INSERT INTO groups (name, description, created_by, group_code)
    VALUES (p_name, p_description, auth.uid(), generate_group_code())
    RETURNING id, groups.group_code INTO v_group_id, v_group_code;

    INSERT INTO group_members (group_id, user_id, role)
    VALUES (v_group_id, auth.uid(), 'admin');

    RETURN QUERY SELECT v_group_id, v_group_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC: Approve join request + add member atomically
CREATE OR REPLACE FUNCTION approve_join_request(p_request_id UUID)
RETURNS VOID AS $$
DECLARE v_request RECORD;
BEGIN
    SELECT jr.* INTO v_request
    FROM join_requests jr
    JOIN group_members gm ON gm.group_id = jr.group_id
    WHERE jr.id = p_request_id AND jr.status = 'pending'
      AND gm.user_id = auth.uid() AND gm.role = 'admin';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request not found or you are not admin';
    END IF;

    UPDATE join_requests SET status = 'approved', resolved_at = now(), resolved_by = auth.uid()
    WHERE id = p_request_id;

    INSERT INTO group_members (group_id, user_id, role)
    VALUES (v_request.group_id, v_request.user_id, 'member');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC: Find group by code (bypasses RLS for non-members)
CREATE OR REPLACE FUNCTION find_group_by_code(p_code TEXT)
RETURNS TABLE(id UUID, name TEXT, description TEXT, group_code CHAR(6), members_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT g.id, g.name, g.description, g.group_code,
           (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS members_count
    FROM groups g WHERE g.group_code = p_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC: Check expired votings wrapper
CREATE OR REPLACE FUNCTION check_my_expired_votings()
RETURNS VOID AS $$
BEGIN
    PERFORM complete_expired_votings();
    PERFORM unfreeze_expired_members();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper: Notify all group members
CREATE OR REPLACE FUNCTION notify_group_members(
    p_group_id UUID, p_type TEXT, p_text TEXT, p_exclude_user UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO notifications (user_id, type, text)
    SELECT gm.user_id, p_type, p_text
    FROM group_members gm
    WHERE gm.group_id = p_group_id
      AND (p_exclude_user IS NULL OR gm.user_id != p_exclude_user);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Missing INSERT policies
CREATE POLICY "Voting creators can add freeze targets"
    ON freeze_targets FOR INSERT TO authenticated
    WITH CHECK (EXISTS (
        SELECT 1 FROM votings v WHERE v.id = freeze_targets.voting_id
          AND v.created_by = auth.uid() AND v.type = 'freeze'
    ));

CREATE POLICY "Authenticated users can create notifications"
    ON notifications FOR INSERT TO authenticated WITH CHECK (TRUE);

CREATE POLICY "Members can add group history"
    ON group_history FOR INSERT TO authenticated
    WITH CHECK (EXISTS (
        SELECT 1 FROM group_members gm
        WHERE gm.group_id = group_history.group_id AND gm.user_id = auth.uid()
    ));
