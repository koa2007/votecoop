module.exports = {
  genCode: function (app) {
    for (let i = 0; i < 30; i++) {
      let c = "";
      for (let j = 0; j < 6; j++)
        c += "0123456789"[Math.floor(Math.random() * 10)];
      try {
        app.findFirstRecordByFilter("groups", "group_code = {:c}", { c: c });
      } catch (e) {
        return c;
      }
    }
    throw new Error("code_gen_failed");
  },
  membership: function (app, gid, uid) {
    try {
      return app.findFirstRecordByFilter(
        "group_members",
        "group = {:g} && user = {:u}",
        { g: gid, u: uid },
      );
    } catch (e) {
      return null;
    }
  },
  isAdmin: function (app, gid, uid) {
    const m = this.membership(app, gid, uid);
    return !!(m && m.get("role") === "admin");
  },
  adminOf: function (app, gid) {
    try {
      return app.findFirstRecordByFilter(
        "group_members",
        "group = {:g} && role = 'admin'",
        { g: gid },
      );
    } catch (e) {
      return null;
    }
  },
  notify: function (app, uid, type, text, meta) {
    const col = app.findCollectionByNameOrId("notifications");
    const r = new Record(col);
    r.set("user", uid);
    r.set("type", type);
    r.set("text", text);
    r.set("is_read", false);
    r.set("metadata", meta || {});
    app.save(r);
  },
  notifyGroup: function (app, gid, exceptUid, type, text, meta) {
    var members = app.findRecordsByFilter(
      "group_members",
      "group = {:g}",
      "",
      0,
      0,
      { g: gid },
    );
    for (var i = 0; i < members.length; i++) {
      var u = members[i].get("user");
      if (exceptUid && u === exceptUid) continue;
      try {
        this.notify(app, u, type, text, meta);
      } catch (e) {}
    }
  },
  fullName: function (app, uid) {
    try {
      const p = app.findFirstRecordByFilter("profiles", "user = {:u}", {
        u: uid,
      });
      const n = (
        (p.get("first_name") || "") +
        " " +
        (p.get("last_name") || "")
      ).trim();
      return n || "User";
    } catch (e) {
      return "User";
    }
  },
  applyEffect: function (tx, v) {
    const gid = v.get("group"),
      type = v.get("type"),
      target = v.get("target_member");
    if (type === "admin-change") {
      if (!target) return;
      const tm = this.membership(tx, gid, target);
      // Target gone or became an observer mid-vote — an admin must be a voting
      // member (creation hook rejects observers; this covers role changes since).
      if (!tm || tm.get("is_observer")) return;
      const admins = tx.findRecordsByFilter(
        "group_members",
        "group = {:g} && role = 'admin'",
        "",
        0,
        0,
        { g: gid },
      );
      for (const a of admins) {
        a.set("role", "member");
        tx.save(a);
      }
      tm.set("role", "admin");
      tx.save(tm);
      const h = new Record(tx.findCollectionByNameOrId("group_history"));
      h.set("group", gid);
      h.set("action", "admin_change");
      h.set("voting", v.id);
      h.set("details", { new_admin: target });
      tx.save(h);
    } else if (type === "remove-member") {
      if (!target) return;
      const tm = this.membership(tx, gid, target);
      if (!tm || tm.get("role") === "admin") return;
      tx.delete(tm);
      const h = new Record(tx.findCollectionByNameOrId("group_history"));
      h.set("group", gid);
      h.set("action", "member_removed");
      h.set("voting", v.id);
      h.set("details", {
        removed_user: target,
        reason: v.get("removal_reason"),
      });
      tx.save(h);
    } else if (type === "delete-group") {
      this.deleteGroupCascade(tx, gid, "видалено за результатами голосування");
    }
  },
  // Cascade-delete a group with everything that belongs to it (votings, votes,
  // objections, requests, history, memberships) so nothing is orphaned.
  // Used by the delete-group VOTING effect and the direct single-member delete.
  deleteGroupCascade: function (tx, gid, reasonText) {
    const members = tx.findRecordsByFilter(
      "group_members",
      "group = {:g}",
      "",
      0,
      0,
      { g: gid },
    );
    let gname = "";
    try {
      gname = tx.findRecordById("groups", gid).get("name");
    } catch (er) {}
    if (reasonText) {
      for (const m of members)
        this.notify(
          tx,
          m.get("user"),
          "system",
          'Групу "' + gname + '" ' + reasonText,
          {},
        );
    }
    const gvs = tx.findRecordsByFilter("votings", "group = {:g}", "", 0, 0, {
      g: gid,
    });
    for (const vv of gvs) {
      try {
        for (const x of tx.findRecordsByFilter(
          "votes",
          "voting = {:v}",
          "",
          0,
          0,
          { v: vv.id },
        ))
          tx.delete(x);
      } catch (er) {}
      try {
        for (const x of tx.findRecordsByFilter(
          "freeze_objections",
          "voting = {:v}",
          "",
          0,
          0,
          { v: vv.id },
        ))
          tx.delete(x);
      } catch (er) {}
      try {
        for (const x of tx.findRecordsByFilter(
          "freeze_targets",
          "voting = {:v}",
          "",
          0,
          0,
          { v: vv.id },
        ))
          tx.delete(x);
      } catch (er) {}
      try {
        tx.delete(vv);
      } catch (er) {}
    }
    try {
      for (const x of tx.findRecordsByFilter(
        "join_requests",
        "group = {:g}",
        "",
        0,
        0,
        { g: gid },
      ))
        tx.delete(x);
    } catch (er) {}
    try {
      for (const x of tx.findRecordsByFilter(
        "group_history",
        "group = {:g}",
        "",
        0,
        0,
        { g: gid },
      ))
        tx.delete(x);
    } catch (er) {}
    for (const m of members) {
      try {
        tx.delete(m);
      } catch (er) {}
    }
    try {
      tx.delete(tx.findRecordById("groups", gid));
    } catch (er) {}
  },
  isAppAdmin: function (auth) {
    if (!auth) return false;
    var em = "";
    try {
      em = auth.email();
    } catch (e) {}
    if (!em) {
      try {
        em = auth.get("email");
      } catch (e) {}
    }
    return em === "koa2007@gmail.com";
  },
  adminUser: function (app) {
    try {
      return app.findFirstRecordByFilter("users", "email = {:e}", {
        e: "koa2007@gmail.com",
      });
    } catch (e) {
      return null;
    }
  },
  cnt: function (app, col, filter, params) {
    try {
      return app.findRecordsByFilter(
        col,
        filter || "id != ''",
        "",
        0,
        0,
        params || {},
      ).length;
    } catch (e) {
      return 0;
    }
  },
  activeVoters: function (app, gid) {
    try {
      return app.findRecordsByFilter(
        "group_members",
        "group = {:g} && is_observer = false && is_frozen = false",
        "",
        0,
        0,
        { g: gid },
      ).length;
    } catch (e) {
      return 0;
    }
  },
  // The IDs (not just the count) of the active electorate — snapshotted onto a
  // voting at creation so eligibility to vote and the quorum denominator stay
  // in lockstep even if roles/freeze change mid-vote.
  activeVoterIds: function (app, gid) {
    try {
      return app
        .findRecordsByFilter(
          "group_members",
          "group = {:g} && is_observer = false && is_frozen = false",
          "",
          0,
          0,
          { g: gid },
        )
        .map(function (m) {
          return m.get("user");
        });
    } catch (e) {
      return [];
    }
  },
  // Read a json field back as the list of ids that was written into it.
  //
  // A json field handed to a JS hook is NOT a JS array: PocketBase stores it as
  // raw bytes and goja wraps that []byte by reflection, so `.length` is the byte
  // length of the JSON text and `arr[i]` is a byte value, not an id. Comparing
  // `arr[i] === someId` then compares a number with a string and is always false.
  // That is what made every member fail the electorate check with
  // `not_in_electorate` and made the quorum denominator the text length.
  // Go through the string form to get the real values back.
  readIdList: function (rec, field) {
    try {
      const raw = rec.get(field);
      if (raw === null || raw === undefined) return [];
      const s = String(raw).trim();
      if (!s || s === "null" || s === '""') return [];
      const parsed = JSON.parse(s);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (x) {
        return typeof x === "string" && x !== "";
      });
    } catch (e) {
      return [];
    }
  },
  distinctObjections: function (app, vid) {
    // unique index (voting,user) guarantees one row per user, so a plain count is distinct
    try {
      return app.findRecordsByFilter(
        "freeze_objections",
        "voting = {:v}",
        "",
        0,
        0,
        { v: vid },
      ).length;
    } catch (e) {
      return 0;
    }
  },
  completeFreeze: function (tx, fresh, gid) {
    const self = this;
    const vid = fresh.id;
    const finish = function (result, adminNote) {
      fresh.set("status", "completed");
      fresh.set("result", result);
      fresh.set("completed_at", new Date().toISOString());
      tx.save(fresh);
      if (adminNote) {
        const adm = self.adminOf(tx, gid);
        if (adm)
          self.notify(tx, adm.get("user"), "freeze_result", adminNote, {
            group_id: gid,
            voting_id: vid,
          });
      }
    };
    if (self.distinctObjections(tx, vid) >= 2) {
      finish("rejected", "Виключення скасовано: учасники заперечили");
      return;
    }
    const targets = tx.findRecordsByFilter(
      "freeze_targets",
      "voting = {:v}",
      "",
      0,
      0,
      { v: vid },
    );
    const uids = targets.map(function (t) {
      return t.get("user");
    });
    let willExclude = 0;
    for (const u of uids) {
      const m = self.membership(tx, gid, u);
      if (m && !m.get("is_observer") && !m.get("is_frozen")) willExclude++;
    }
    if (self.activeVoters(tx, gid) - willExclude < 2) {
      finish(
        "rejected",
        "Виключення скасовано: залишилось би замало активних учасників",
      );
      return;
    }
    for (const u of uids) {
      const m = self.membership(tx, gid, u);
      if (m && !m.get("is_frozen")) {
        m.set("is_frozen", true);
        m.set("frozen_until", "");
        tx.save(m);
      }
      const h = new Record(tx.findCollectionByNameOrId("group_history"));
      h.set("group", gid);
      h.set("action", "member_excluded");
      h.set("voting", vid);
      h.set("details", { user: u });
      tx.save(h);
    }
    finish("accepted", null);
    self.notifyGroup(
      tx,
      gid,
      null,
      "member_excluded",
      "Учасника(ів) виключено з підрахунку за результатами голосування",
      { group_id: gid, voting_id: vid },
    );
  },
  // groupIds (optional): limit the sweep to those groups. The cron passes nothing
  // and sweeps everything; the HTTP route passes the caller's own groups, so one
  // logged-in user can no longer make the server walk and transact over every
  // group in the system on demand.
  completeExpired: function (app, groupIds) {
    const self = this;
    const scope =
      groupIds && groupIds.length
        ? groupIds.reduce(function (acc, g) {
            acc[g] = true;
            return acc;
          }, {})
        : null;
    // PocketBase stores dates as "YYYY-MM-DD HH:MM:SS.sssZ" (SPACE separator)
    // and compares filter params as strings. Passing ISO "…T…" here made every
    // same-day ends_at look expired (' ' < 'T'), so votings were completed on
    // the first minute-tick after creation. Bind the param in the stored format.
    const due = app.findRecordsByFilter(
      "votings",
      "status = 'active' && ends_at <= {:now}",
      "",
      0,
      0,
      { now: new Date().toISOString().replace("T", " ") },
    );
    for (const v of due) {
      if (scope && !scope[v.get("group")]) continue;
      try {
        app.runInTransaction((tx) => {
          const fresh = tx.findRecordById("votings", v.id);
          if (fresh.get("status") !== "active") return;
          const gid = fresh.get("group");
          if (fresh.get("type") === "freeze") {
            self.completeFreeze(tx, fresh, gid);
            return;
          }
          const yes = tx.findRecordsByFilter(
            "votes",
            "voting = {:v} && choice = 'yes'",
            "",
            0,
            0,
            { v: v.id },
          ).length;
          // Denominator = the electorate fixed at creation. Prefer the immutable
          // voter_ids snapshot (its length == who was allowed to vote); fall back to
          // the numeric snapshot, then a live count for pre-snapshot votings.
          const vids = self.readIdList(fresh, "voter_ids");
          const snap = fresh.get("voter_snapshot");
          const voters = vids.length
            ? vids.length
            : snap && snap > 0
              ? snap
              : self.activeVoters(tx, gid);
          const accepted = voters > 0 && yes > voters / 2;
          fresh.set("status", "completed");
          fresh.set("result", accepted ? "accepted" : "rejected");
          fresh.set("completed_at", new Date().toISOString());
          tx.save(fresh);
          if (accepted) self.applyEffect(tx, fresh);
          self.notifyGroup(
            tx,
            gid,
            null,
            "voting_completed",
            "Голосування завершено: " +
              (fresh.get("title") || "") +
              " \u2014 " +
              (accepted ? "прийнято" : "відхилено"),
            {
              group_id: gid,
              voting_id: v.id,
              result: accepted ? "accepted" : "rejected",
            },
          );
        });
      } catch (er) {}
    }
  },
};
