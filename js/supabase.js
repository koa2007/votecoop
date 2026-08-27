// PocketBase adapter — drop-in replacement for the old Supabase service.
// Keeps the same `supabaseService` method names + {data,error} shapes so
// js/app.js works unchanged. Backed by PocketBase at same origin.
// Requires: pocketbase SDK loaded before this file; js/config.js for URL.

const supabaseService = {
  pb: null,
  client: null, // compat shim (see bottom)
  initialized: false,

  init() {
    try {
      const url =
        (typeof POCKETBASE_URL !== "undefined" && POCKETBASE_URL) ||
        window.location.origin;
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

  isReady() {
    return this.initialized && this.pb !== null;
  },

  _uid() {
    return this.pb?.authStore?.record?.id || null;
  },
  async _getUserId() {
    return this._uid();
  },
  // PocketBase returns dates as "YYYY-MM-DD HH:MM:SS.sssZ" (space); app.js
  // expects ISO. Normalize so new Date(...) parses everywhere.
  _d(s) {
    return s ? String(s).replace(" ", "T") : s || null;
  },
  // Route errors come as {error: "<code>"} in the body while e.message is the
  // SDK's generic text — surface the code as the message so every
  // `error.message.includes('<code>')` branch in app.js actually fires.
  _err(e) {
    const body = e?.response || e?.data || {};
    const code = typeof body.error === "string" ? body.error : "";
    return {
      message: code || (e && (e.message || body.message)) || String(e),
      code: e?.status,
      data: body,
    };
  },

  // ---- profile helpers ----
  async _profileByUser(uid) {
    // Only a real 404 means "no profile yet". A transient/network error must
    // NOT look like a missing profile — that routed real users back to the
    // profile-setup screen. Callers catch and decide.
    try {
      return await this.pb
        .collection("profiles")
        .getFirstListItem(`user="${uid}"`);
    } catch (e) {
      if (e?.status === 404) return null;
      throw e;
    }
  },
  async _profilesMap(uids) {
    const uniq = [...new Set(uids.filter(Boolean))];
    if (!uniq.length) return {};
    // Single batched query instead of one request per user (was N+1 on the
    // voting list and group detail — the app's busiest screens). One retry:
    // a transient blip otherwise blanks every name on those screens.
    const filter = uniq.map((u) => `user="${u}"`).join(" || ");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rows = await this.pb
          .collection("profiles")
          .getFullList({ filter });
        const map = {};
        rows.forEach((p) => {
          map[p.user] = p;
        });
        return map;
      } catch (e) {
        /* retry once, then degrade to empty names */
      }
    }
    return {};
  },

  // === AUTH ===
  async signInWithGoogle() {
    return { data: null, error: { message: "google_not_configured_yet" } };
  },

  async signInWithEmail(email, password) {
    try {
      const r = await this.pb
        .collection("users")
        .authWithPassword(email, password);
      return {
        data: { user: r.record, session: { user: r.record } },
        error: null,
      };
    } catch (e) {
      const er = this._err(e);
      // PocketBase says "Failed to authenticate"; app.js expects the
      // Supabase wording to show the friendly "invalid credentials" message.
      if (er.code === 400) er.message = "Invalid login credentials";
      return { data: null, error: er };
    }
  },

  async signUpWithEmail(email, password) {
    try {
      await this.pb
        .collection("users")
        .create({ email, password, passwordConfirm: password });
      const r = await this.pb
        .collection("users")
        .authWithPassword(email, password);
      return {
        data: { user: r.record, session: { user: r.record } },
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async resetPassword(email) {
    try {
      await this.pb.collection("users").requestPasswordReset(email);
      return { data: {}, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  // Complete a password reset using the one-time token from the email link
  // (no active session — the token proves identity).
  async confirmPasswordReset(token, newPassword) {
    try {
      await this.pb
        .collection("users")
        .confirmPasswordReset(token, newPassword, newPassword);
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },

  // PocketBase requires the CURRENT password (oldPassword) when the owner
  // changes their own password, and it invalidates the auth token afterwards —
  // so re-authenticate with the new password to keep the session alive.
  async updatePassword(newPassword, oldPassword) {
    const uid = this._uid();
    if (!uid) return { error: { message: "not_authenticated" } };
    const email = this.pb.authStore.record?.email || "";
    try {
      await this.pb.collection("users").update(uid, {
        password: newPassword,
        passwordConfirm: newPassword,
        oldPassword: oldPassword || "",
      });
      try {
        await this.pb.collection("users").authWithPassword(email, newPassword);
      } catch (e2) {
        /* re-login screen will handle */
      }
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },

  async signOut() {
    try {
      this.pb.authStore.clear();
    } catch (e) {}
    return { error: null };
  },

  // Confirm the stored session still belongs to a real account. Returns false
  // (and clears the session) ONLY on a definitive auth rejection — a token for
  // a deleted user. Network errors (offline) keep the session so we never log
  // a PWA user out just because they had no connection on launch.
  async validateSession() {
    if (!this.pb?.authStore?.isValid) return false;
    try {
      await this.pb.collection("users").authRefresh();
      return true;
    } catch (e) {
      const status = e?.status || e?.response?.status || 0;
      if (status === 401 || status === 403 || status === 404) {
        try {
          this.pb.authStore.clear();
        } catch (_) {}
        return false;
      }
      return true; // transient/offline — assume still valid
    }
  },

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
      callback(
        record ? "SIGNED_IN" : "SIGNED_OUT",
        record ? { user: record } : null,
      );
    }, false);
    return { data: { subscription: { unsubscribe: unsub } } };
  },

  // === PROFILE ===
  async getProfile(userId) {
    try {
      const p = await this._profileByUser(userId);
      return { profile: p ? this._mapProfile(p, userId) : null, error: null };
    } catch (e) {
      return { profile: null, error: this._err(e) };
    }
  },
  _mapProfile(p, userId) {
    return {
      id: userId,
      _pbId: p.id,
      first_name: p.first_name || "",
      last_name: p.last_name || "",
      phone: p.phone || "",
      address: p.address || "",
      apartment: p.apartment || "",
      default_role: p.default_role || "voter",
      profile_completed: !!p.profile_completed,
      terms_version: p.terms_version || 0,
      terms_accepted: p.terms_accepted || null,
    };
  },
  async updateProfile(userId, profileData) {
    try {
      const payload = {};
      [
        "first_name",
        "last_name",
        "phone",
        "address",
        "apartment",
        "default_role",
        "profile_completed",
        "terms_version",
        "terms_accepted",
      ].forEach((k) => {
        if (k in profileData) payload[k] = profileData[k];
      });
      // Only treat a real 404 as "no profile yet". A transient error must NOT
      // fall through to create() — that produced duplicate profiles in prod.
      let existing = null;
      try {
        existing = await this.pb
          .collection("profiles")
          .getFirstListItem(`user="${userId}"`);
      } catch (e) {
        if (e?.status && e.status !== 404) throw e;
      }
      let rec;
      if (existing) {
        rec = await this.pb.collection("profiles").update(existing.id, payload);
      } else {
        try {
          rec = await this.pb
            .collection("profiles")
            .create({ user: userId, ...payload });
        } catch (e) {
          // Lost a race (or unique index hit) — a row now exists; update it.
          const p = await this.pb
            .collection("profiles")
            .getFirstListItem(`user="${userId}"`);
          rec = await this.pb.collection("profiles").update(p.id, payload);
        }
      }
      return { profile: this._mapProfile(rec, userId), error: null };
    } catch (e) {
      return { profile: null, error: this._err(e) };
    }
  },
  async isProfileCompleted(userId) {
    try {
      const p = await this._profileByUser(userId);
      return !!(p && p.profile_completed);
    } catch (e) {
      return false;
    }
  },

  // === GROUPS ===
  async createGroup(name, description) {
    try {
      const r = await this.pb.send("/api/spilka/create-group", {
        method: "POST",
        body: { name, description },
      });
      const d = r.data || r;
      // Normalize to the Supabase-era shape app.js expects (group_id / group_code).
      return {
        data: { group_id: d.id || d.group_id, group_code: d.group_code },
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async getMyGroups() {
    return this.getMyGroupsWithStats();
  },
  async getGroupsStats() {
    return { data: [], error: null };
  }, // folded into my-groups

  async getMyGroupsWithStats() {
    try {
      const r = await this.pb.send("/api/spilka/my-groups", {
        method: "POST",
        body: {},
      });
      return { data: r.data, pending: r.pending || [], error: null };
    } catch (e) {
      return { data: null, pending: [], error: this._err(e) };
    }
  },

  async getMyMemberships() {
    const uid = this._uid();
    if (!uid) return { data: [], error: null };
    try {
      const rows = await this.pb
        .collection("group_members")
        .getFullList({ filter: `user="${uid}"` });
      return {
        data: rows.map((m) => ({
          group_id: m.group,
          is_observer: !!m.is_observer,
          apartment: m.apartment || "",
          role: m.role,
        })),
        error: null,
      };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },

  // Via the route, not a direct collection update: `groups` has no update rule,
  // so the PATCH this used to send was rejected for everyone including the admin.
  async updateGroup(groupId, updates) {
    try {
      const r = await this.pb.send("/api/spilka/update-group", {
        method: "POST",
        body: {
          group_id: groupId,
          name: updates.name,
          description: updates.description,
        },
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async deleteGroup(groupId) {
    // Direct delete goes through a guarded route (admin + sole member only) —
    // the raw collection delete has no deleteRule and silently 404'd.
    try {
      await this.pb.send("/api/spilka/delete-group-direct", {
        method: "POST",
        body: { group_id: groupId },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },

  async leaveGroup(groupId) {
    try {
      await this.pb.send("/api/spilka/leave-group", {
        method: "POST",
        body: { group_id: groupId },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },

  async getGroupDetail(groupId) {
    try {
      const members = await this.pb
        .collection("group_members")
        .getFullList({ filter: `group="${groupId}"` });
      const reqs = await this.pb
        .collection("join_requests")
        .getFullList({ filter: `group="${groupId}" && status="pending"` });
      let history = [];
      try {
        history = await this.pb
          .collection("group_history")
          .getFullList({ filter: `group="${groupId}"`, sort: "-created" });
      } catch (e) {}
      const pmap = await this._profilesMap(members.map((m) => m.user));
      // Applicant details come from an admin-only route, not from the profiles
      // collection: while a request was pending, every resident of the house could
      // read the applicant's name, phone and address straight from the API.
      let reqDetails = {};
      try {
        const rr = await this.pb.send("/api/spilka/group-requests", {
          method: "POST",
          body: { group_id: groupId },
        });
        for (const r of rr.data || []) reqDetails[r.id] = r;
      } catch (e) {
        /* not an admin — the list stays empty, which is the point */
      }
      const prof = (uid) => {
        const p = pmap[uid];
        return p
          ? {
              id: uid,
              first_name: p.first_name || "",
              last_name: p.last_name || "",
              phone: p.phone || "",
              address: p.address || "",
              apartment: p.apartment || "",
            }
          : { id: uid, first_name: "", last_name: "", apartment: "" };
      };
      return {
        data: {
          members: members.map((m) => ({
            user_id: m.user,
            role: m.role,
            is_frozen: !!m.is_frozen,
            frozen_until: this._d(m.frozen_until),
            is_observer: !!m.is_observer,
            apartment: m.apartment || "",
            user: prof(m.user),
          })),
          requests: reqs.map((r) => {
            const d = reqDetails[r.id] || {};
            return {
              id: r.id,
              user_id: r.user,
              status: r.status,
              created_at: this._d(r.created),
              apartment: d.apartment || r.apartment || "",
              requested_as_observer: !!r.requested_as_observer,
              is_role_change: !!r.is_role_change,
              user: {
                id: r.user,
                first_name: d.name || "",
                last_name: "",
                apartment: d.apartment || r.apartment || "",
                address: d.address || "",
              },
            };
          }),
          history: history.map((h) => ({
            id: h.id,
            action: h.action,
            details: h.details || {},
            created_at: this._d(h.created),
            voting_id: h.voting || null,
          })),
          stats: { members_count: members.length },
        },
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async findGroupByCode(code) {
    try {
      const r = await this.pb.send("/api/spilka/find-group", {
        method: "POST",
        body: { code },
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  // join requests
  async submitJoinRequestV2(groupId, apartment, asObserver) {
    try {
      const r = await this.pb.send("/api/spilka/submit-join", {
        method: "POST",
        body: { group_id: groupId, apartment, as_observer: asObserver },
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },
  async sendJoinRequest(groupId) {
    return this.submitJoinRequestV2(groupId, "", false);
  }, // legacy fallback

  async approveJoinRequest(requestId) {
    return this.approveJoinRequestV2(requestId, false);
  },
  async approveJoinRequestV2(requestId, forceObserver) {
    try {
      await this.pb.send("/api/spilka/approve-join", {
        method: "POST",
        body: { request_id: requestId, force_observer: !!forceObserver },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async rejectJoinRequest(requestId) {
    try {
      await this.pb.send("/api/spilka/reject-join", {
        method: "POST",
        body: { request_id: requestId },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },

  async requestRoleChange(groupId, becomeObserver) {
    try {
      await this.pb.send("/api/spilka/request-role-change", {
        method: "POST",
        body: { group_id: groupId, become_observer: !!becomeObserver },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async adminChangeRole(groupId, userId, makeObserver) {
    try {
      await this.pb.send("/api/spilka/admin-change-role", {
        method: "POST",
        body: {
          group_id: groupId,
          user_id: userId,
          make_observer: !!makeObserver,
        },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async getVoterCount(groupId) {
    try {
      const r = await this.pb.send("/api/spilka/voter-count", {
        method: "POST",
        body: { group_id: groupId },
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  // === VOTINGS ===
  async createVoting(v) {
    try {
      const rec = await this.pb.collection("votings").create({
        group: v.groupId,
        title: v.title,
        description: v.description || "",
        type: v.type,
        status: "active",
        link: v.link || "",
        target_member: v.targetMemberId || "",
        removal_reason: v.removalReason || "",
        freeze_duration_days: v.freezeDurationDays || 7,
        ends_at: v.endsAt,
      });
      // Normalize to the shape app.js reads (it builds the new card from
      // created_at / ends_at). Raw PB record has `created` and space-separated
      // dates → "Invalid Date" / undefined on the fresh card until reload.
      return {
        data: {
          id: rec.id,
          group_id: rec.group,
          title: rec.title,
          description: rec.description,
          electorate_size:
            Array.isArray(rec.voter_ids) && rec.voter_ids.length
              ? rec.voter_ids.length
              : rec.voter_snapshot || 0,
          type: rec.type,
          status: rec.status,
          created_by: rec.created_by || null,
          link: rec.link || "",
          target_member: rec.target_member || "",
          ends_at: this._d(rec.ends_at),
          created_at: this._d(rec.created),
        },
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },
  async addFreezeTargets(votingId, userIds) {
    try {
      for (const uid of userIds)
        await this.pb
          .collection("freeze_targets")
          .create({ voting: votingId, user: uid });
      return { data: true, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async getMyVotings() {
    const uid = this._uid();
    if (!uid) return { data: [], error: null };
    try {
      const mems = await this.pb
        .collection("group_members")
        .getFullList({ filter: `user="${uid}"` });
      if (!mems.length) return { data: [], error: null };
      const gfilter = mems.map((m) => `group="${m.group}"`).join(" || ");
      const vts = await this.pb
        .collection("votings")
        .getFullList({
          filter: `(${gfilter}) && status!="deleted"`,
          sort: "-created",
        });
      const gids = [...new Set(mems.map((m) => m.group))];
      const gmap = {};
      if (gids.length) {
        try {
          const grows = await this.pb
            .collection("groups")
            .getFullList({
              filter: gids.map((id) => `id="${id}"`).join(" || "),
            });
          grows.forEach((g) => {
            gmap[g.id] = g;
          });
        } catch (e) {
          /* group names fall back to '' */
        }
      }
      const pmap = await this._profilesMap([
        ...vts.map((v) => v.created_by),
        ...vts.map((v) => v.target_member),
      ]);
      const data = vts.map((v) => ({
        id: v.id,
        group_id: v.group,
        title: v.title,
        description: v.description,
        type: v.type,
        status: v.status,
        created_by: v.created_by || null,
        result: v.result || null,
        link: v.link || null,
        target_member_id: v.target_member || null,
        removal_reason: v.removal_reason || null,
        freeze_duration_days: v.freeze_duration_days,
        // How many residents were entitled to vote when this voting STARTED.
        // That is the number the server decides the outcome by, so it is the
        // only number the app may show as "of N" — a live count drifts as
        // people join or leave and makes the printed protocol contradict itself.
        electorate_size: Array.isArray(v.voter_ids) && v.voter_ids.length
          ? v.voter_ids.length
          : (v.voter_snapshot || 0),
        // Whether the CURRENT user is inside that frozen electorate. Without it the
        // voting screen had no way to know a resident's ballot would be refused, and
        // showed a newcomer the full set of vote buttons and a comment box.
        in_electorate:
          Array.isArray(v.voter_ids) && v.voter_ids.length
            ? v.voter_ids.indexOf(uid) !== -1
            : true,
        ends_at: this._d(v.ends_at),
        completed_at: this._d(v.completed_at),
        created_at: this._d(v.created),
        group: { name: gmap[v.group]?.name || "" },
        creator: pmap[v.created_by]
          ? {
              first_name: pmap[v.created_by].first_name,
              last_name: pmap[v.created_by].last_name,
            }
          : null,
        target:
          v.target_member && pmap[v.target_member]
            ? {
                first_name: pmap[v.target_member].first_name,
                last_name: pmap[v.target_member].last_name,
              }
            : null,
      }));
      return { data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async getVotingResults(votingIds) {
    if (!votingIds || !votingIds.length) return { data: [], error: null };
    try {
      const r = await this.pb.send("/api/spilka/voting-results", {
        method: "POST",
        body: { voting_ids: votingIds },
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async getVotingVotes(votingId) {
    // Reads via the server route, NOT the votes collection directly. For secret
    // votings the server returns only the caller's own row (no other names/choices),
    // so a secret ballot stays secret even against the raw API.
    try {
      const r = await this.pb.send("/api/spilka/voting-ballots", {
        method: "POST",
        body: { voting_id: votingId },
      });
      return {
        data: (r.data || []).map((v) => ({
          id: v.id,
          user_id: v.user_id,
          choice: v.choice,
          comment: v.comment || "",
          created_at: this._d(v.created),
          voter: {
            first_name: v.first_name || "",
            last_name: v.last_name || "",
            apartment: v.apartment || "",
          },
        })),
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  async castVote(votingId, choice, comment) {
    try {
      const rec = await this.pb
        .collection("votes")
        .create({ voting: votingId, choice, comment: comment || "" });
      return { data: rec, error: null };
    } catch (e) {
      const er = this._err(e);
      // Normalize the server-side vote-hook rejections to stable codes app.js checks.
      const raw = (er.message || "") + " " + JSON.stringify(er.data || "");
      if (er.code === 400 && /unique|idx_vote|already_voted/i.test(raw))
        er.code = "23505";
      else if (/observer_cannot_vote/i.test(raw)) er.code = "observer";
      else if (/voting_not_active/i.test(raw)) er.code = "voting_inactive";
      else if (/frozen_cannot_vote/i.test(raw)) er.code = "frozen";
      else if (/joined_after_voting_started|not_in_electorate/i.test(raw))
        er.code = "joined_after";
      else if (/not_member/i.test(raw)) er.code = "not_member";
      return { data: null, error: er };
    }
  },

  async deleteVoting(votingId, reason) {
    try {
      const rec = await this.pb
        .collection("votings")
        .update(votingId, {
          status: "deleted",
          deleted_at: new Date().toISOString(),
          deleted_reason: reason,
        });
      return { data: rec, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  // Self-service "I'm here" — an excluded member returns themselves to the count.
  async restoreMe(groupId) {
    try {
      await this.pb.send("/api/spilka/restore-me", {
        method: "POST",
        body: { group_id: groupId },
      });
      return { data: true, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },
  // Admin manually toggles a member's exclusion from the count.
  async setMemberFrozen(groupId, userId, frozen) {
    try {
      await this.pb.send("/api/spilka/set-frozen", {
        method: "POST",
        body: { group_id: groupId, user_id: userId, frozen: !!frozen },
      });
      return { data: true, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  // freeze (exclude-from-count)
  async addFreezeObjection(votingId) {
    try {
      const rec = await this.pb
        .collection("freeze_objections")
        .create({ voting: votingId, user: this._uid() });
      return { data: rec, error: null };
    } catch (e) {
      const er = this._err(e);
      if (
        er.code === 400 &&
        /unique|not_unique/i.test(
          (er.message || "") + JSON.stringify(er.data || ""),
        )
      )
        er.code = "23505";
      return { data: null, error: er };
    }
  },
  async getFreezeObjections(votingId) {
    try {
      const rows = await this.pb
        .collection("freeze_objections")
        .getFullList({ filter: `voting="${votingId}"` });
      const pmap = await this._profilesMap(rows.map((r) => r.user));
      return {
        data: rows.map((r) => ({
          user_id: r.user,
          time: this._d(r.created),
          user: pmap[r.user]
            ? {
                first_name: pmap[r.user].first_name,
                last_name: pmap[r.user].last_name,
              }
            : null,
        })),
        error: null,
      };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },
  async getFreezeTargets(votingId) {
    try {
      const rows = await this.pb
        .collection("freeze_targets")
        .getFullList({ filter: `voting="${votingId}"` });
      const pmap = await this._profilesMap(rows.map((r) => r.user));
      return {
        data: rows.map((r) => ({
          user_id: r.user,
          user: pmap[r.user]
            ? {
                first_name: pmap[r.user].first_name,
                last_name: pmap[r.user].last_name,
                address: pmap[r.user].address,
                apartment: pmap[r.user].apartment,
              }
            : null,
        })),
        error: null,
      };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },

  async checkExpiredVotings() {
    try {
      await this.pb.send("/api/spilka/complete-expired", {
        method: "POST",
        body: {},
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },

  // Which votings the current user has voted on (for hasVoted flags)
  async getMyVotes() {
    const uid = this._uid();
    if (!uid) return { data: [], error: null };
    try {
      const rows = await this.pb
        .collection("votes")
        .getFullList({ filter: `user="${uid}"` });
      return { data: rows.map((v) => ({ voting_id: v.voting })), error: null };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },

  // PocketBase realtime — collection view-rules gate which events a user gets.
  async realtimeSubscribe(collection, cb) {
    try {
      return await this.pb.collection(collection).subscribe("*", cb);
    } catch (e) {
      return () => {};
    }
  },
  realtimeUnsubscribe(collection) {
    try {
      this.pb.collection(collection).unsubscribe("*");
    } catch (e) {}
  },

  // === NOTIFICATIONS ===
  async getMyNotifications() {
    const uid = this._uid();
    if (!uid) return { data: [], error: null };
    try {
      const rows = await this.pb
        .collection("notifications")
        .getFullList({
          filter: `user="${uid}" && archived_at=""`,
          sort: "-created",
        });
      return {
        data: rows.map((n) => ({
          id: n.id,
          type: n.type,
          text: n.text,
          is_read: !!n.is_read,
          created_at: this._d(n.created),
          metadata: n.metadata || {},
          archived_at: this._d(n.archived_at) || null,
        })),
        error: null,
      };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },
  async markNotificationRead(id) {
    try {
      await this.pb.collection("notifications").update(id, { is_read: true });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async updateNotificationMetadata(id, metadata) {
    try {
      await this.pb.collection("notifications").update(id, { metadata });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  // Update in parallel chunks — the old one-by-one loop took seconds for a
  // user with hundreds of notifications and hammered the backend.
  async _updateNotifBatch(rows, payload) {
    const CHUNK = 10;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await Promise.all(
        rows
          .slice(i, i + CHUNK)
          .map((n) =>
            this.pb.collection("notifications").update(n.id, payload),
          ),
      );
    }
  },
  async markAllNotificationsRead() {
    const uid = this._uid();
    if (!uid) return { error: null };
    try {
      const rows = await this.pb
        .collection("notifications")
        .getFullList({ filter: `user="${uid}" && is_read=false` });
      await this._updateNotifBatch(rows, { is_read: true });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async archiveAllNotifications() {
    const uid = this._uid();
    if (!uid) return { error: null };
    try {
      const rows = await this.pb
        .collection("notifications")
        .getFullList({ filter: `user="${uid}" && archived_at=""` });
      const now = new Date().toISOString();
      await this._updateNotifBatch(rows, { archived_at: now, is_read: true });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async getArchivedNotifications() {
    const uid = this._uid();
    if (!uid) return { data: [], error: null };
    try {
      const rows = await this.pb
        .collection("notifications")
        .getFullList({
          filter: `user="${uid}" && archived_at!=""`,
          sort: "-archived_at",
        });
      return {
        data: rows.map((n) => ({
          id: n.id,
          type: n.type,
          text: n.text,
          is_read: !!n.is_read,
          created_at: this._d(n.created),
          metadata: n.metadata || {},
          archived_at: this._d(n.archived_at),
        })),
        error: null,
      };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },
  async searchNotifications(query, archivedOnly, limit = 50, offset = 0) {
    const uid = this._uid();
    if (!uid) return { data: [], error: null };
    let f = this.pb.filter("user={:uid}", { uid });
    if (archivedOnly === true) f += ` && archived_at!=""`;
    else if (archivedOnly === false) f += ` && archived_at=""`;
    // Bind the user's search text safely (filter injection otherwise).
    if (query && query.trim().length >= 3)
      f += ` && ` + this.pb.filter("text~{:q}", { q: query.trim() });
    try {
      const res = await this.pb
        .collection("notifications")
        .getList(Math.floor(offset / limit) + 1, limit, {
          filter: f,
          sort: "-created",
        });
      return {
        data: res.items.map((n) => ({
          id: n.id,
          type: n.type,
          text: n.text,
          is_read: !!n.is_read,
          created_at: this._d(n.created),
          metadata: n.metadata || {},
          archived_at: this._d(n.archived_at) || null,
        })),
        error: null,
      };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },
  async unarchiveNotification(id) {
    try {
      await this.pb.collection("notifications").update(id, { archived_at: "" });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async adminBroadcastNotification(userIds, text) {
    try {
      const r = await this.pb.send("/api/spilka/broadcast", {
        method: "POST",
        body: { user_ids: userIds, text },
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },

  // === MEMBER VOTES (participation) ===
  async getGroupMemberVotes(groupId) {
    try {
      const r = await this.pb.send("/api/spilka/member-votes", {
        method: "POST",
        body: { group_id: groupId },
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: [], error: this._err(e) };
    }
  },

  // === FEEDBACK ===
  async submitFeedback(text) {
    try {
      await this.pb.collection("feedback").create({ text, status: "new" });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  // Admin panel (only the koa2007 account passes the server-side check).
  async getAdminStats() {
    try {
      const r = await this.pb.send("/api/spilka/admin-stats", {
        method: "POST",
        body: {},
      });
      return { data: r.data, error: null };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },
  async getAdminRecentUsers() {
    try {
      const r = await this.pb.send("/api/spilka/admin-users", {
        method: "POST",
        body: {},
      });
      return {
        data: (r.data || []).map((u) => ({
          ...u,
          created_at: this._d(u.created_at),
        })),
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },
  async getAdminRecentGroups() {
    try {
      const r = await this.pb.send("/api/spilka/admin-groups", {
        method: "POST",
        body: {},
      });
      return {
        data: (r.data || []).map((g) => ({
          ...g,
          created_at: this._d(g.created_at),
        })),
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },
  async getAdminFeedback() {
    try {
      const r = await this.pb.send("/api/spilka/admin-feedback", {
        method: "POST",
        body: {},
      });
      return {
        data: (r.data || []).map((f) => ({
          ...f,
          created_at: this._d(f.created_at),
          replied_at: this._d(f.replied_at),
        })),
        error: null,
      };
    } catch (e) {
      return { data: null, error: this._err(e) };
    }
  },
  async replyToFeedback(id, reply) {
    try {
      await this.pb.send("/api/spilka/reply-feedback", {
        method: "POST",
        body: { feedback_id: id, reply },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },
  async updateFeedbackStatus(id, status) {
    try {
      await this.pb.send("/api/spilka/feedback-status", {
        method: "POST",
        body: { feedback_id: id, status },
      });
      return { error: null };
    } catch (e) {
      return { error: this._err(e) };
    }
  },

  // === compat shim for the few direct supabaseService.client.* calls ===
  _buildClientShim() {
    const svc = this;
    return {
      auth: {
        updateUser: async ({ password }) => {
          const r = await svc.updatePassword(password);
          return { error: r.error };
        },
        onAuthStateChange: (cb) =>
          svc.onAuthStateChange((e, s) => cb(e, s)).data.subscription,
      },
      from: (table) => svc._queryBuilder(table),
      channel: () => svc._noopChannel(),
      removeChannel: () => {},
    };
  },
  _noopChannel() {
    const ch = { on: () => ch, subscribe: () => ch };
    return ch;
  },
  _queryBuilder(table) {
    // minimal builder used by app.js: feedback insert/update, votes select, group_stats select
    const svc = this;
    return {
      insert: (row) => ({
        then: undefined,
        async select() {
          return this.__run("insert", row);
        },
        async single() {
          return this.__run("insert", row);
        },
        async __run() {
          try {
            if (table === "feedback") {
              await svc.submitFeedback(row.text);
              return { data: row, error: null };
            }
            return { data: null, error: null };
          } catch (e) {
            return { data: null, error: svc._err(e) };
          }
        },
        // direct await (no .select) -> behaves like a promise
        then(res) {
          this.__run().then(res);
        },
      }),
      update: (vals) => ({
        eq: (col, val) => ({
          async then(res) {
            try {
              if (table === "feedback")
                await svc.updateFeedbackStatus(val, vals.status);
              res({ error: null });
            } catch (e) {
              res({ error: svc._err(e) });
            }
          },
        }),
      }),
      select: () => svc._noopSelect(table),
    };
  },
  _noopSelect() {
    return {
      eq: () => this._noopSelect(),
      in: () => this._noopSelect(),
      order: () => this._noopSelect(),
      async then(res) {
        res({ data: [], error: null });
      },
    };
  },
};
