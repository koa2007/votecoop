/// <reference path="../pb_data/types.d.ts" />

// ===== Ownership / anti-forgery hooks =====
onRecordCreateRequest((e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) throw new BadRequestError("not_authenticated");
  e.record.set("created_by", e.auth.id);
  const gid = e.record.get("group");
  const m = L.membership(e.app, gid, e.auth.id);
  if (!m) throw new BadRequestError("not_member");
  if (m.get("is_frozen")) throw new BadRequestError("excluded_cannot_create");
  // A voting always starts open with no verdict. The collection's create rule only
  // asks for a logged-in user, so without this a member could POST a record that is
  // already {status: completed, result: accepted} and the app would show — and
  // print a protocol for — a decision the house never took.
  e.record.set("status", "active");
  e.record.set("result", "");
  e.record.set("completed_at", "");
  e.record.set("deleted_at", "");
  // Freeze the quorum denominator at creation so later exclusions can't change THIS voting.
  e.record.set("voter_snapshot", L.activeVoters(e.app, gid));
  // Also snapshot WHO the electorate is (IDs), not just how many, so a later
  // role/freeze change (or a self-restore) can't let an excluded member vote
  // outside the counted denominator. Enforced in the votes create hook.
  e.record.set("voter_ids", L.activeVoterIds(e.app, gid));
  if (e.record.get("type") === "freeze") {
    if (m.get("role") !== "admin")
      throw new BadRequestError("only_admin_can_freeze");
    e.record.set("ends_at", new Date(Date.now() + 5 * 86400000).toISOString()); // fixed 5-day objection window
  } else {
    // ends_at arrives from the browser. Unchecked, a date in the past let the
    // minute cron close the voting before anyone could open it ("burning" a
    // topic as rejected), and a date far ahead left it open forever.
    const MIN_MS = 30 * 60000,
      MAX_MS = 60 * 86400000;
    const raw = e.record.getString("ends_at");
    const ends = raw ? Date.parse(raw.replace(" ", "T")) : NaN;
    if (!ends || isNaN(ends)) throw new BadRequestError("ends_at_required");
    const delta = ends - Date.now();
    if (delta < MIN_MS) throw new BadRequestError("ends_at_too_soon");
    if (delta > MAX_MS) throw new BadRequestError("ends_at_too_far");
  }
  if (e.record.get("type") === "admin-change") {
    // An admin must be a voting member: promoting an observer would violate
    // the admin_cannot_be_observer invariant enforced everywhere else.
    const tm = L.membership(e.app, gid, e.record.get("target_member"));
    if (!tm) throw new BadRequestError("target_not_member");
    if (tm.get("is_observer"))
      throw new BadRequestError("observer_cannot_be_admin");
  }
  if (e.record.get("type") === "remove-member") {
    // The same guard the admin-change branch has had all along, and the only branch
    // that lacked it. Without it the house could spend three days voting to expel a
    // name nobody recognises — a stranger, or the admin — and the app would stamp
    // ПРИЙНЯТО on an effect that cannot happen: a ghost decision with a printable
    // protocol behind it.
    const tm = L.membership(e.app, gid, e.record.get("target_member"));
    if (!tm) throw new BadRequestError("target_not_member");
    if (tm.get("role") === "admin")
      throw new BadRequestError("cannot_remove_admin");
  }
  e.next();
}, "votings");
onRecordAfterCreateSuccess((e) => {
  try {
    const L = require(`${__hooks}/lib.js`);
    const gid = e.record.get("group");
    if (e.record.get("type") === "freeze") {
      L.notifyGroup(
        e.app,
        gid,
        null,
        "freeze_proposal",
        'Пропозиція виключити з підрахунку: "' +
          (e.record.get("title") || "") +
          '". У вас 5 днів, щоб натиснути «Не згоден».',
        {
          group_id: gid,
          voting_id: e.record.id,
          i18n: "notif_freeze_proposal",
          p: { title: e.record.get("title") || "" },
        },
      );
    } else {
      L.notifyGroup(
        e.app,
        gid,
        e.record.get("created_by"),
        "new_voting",
        "Нове голосування: " + (e.record.get("title") || ""),
        {
          group_id: gid,
          voting_id: e.record.id,
          i18n: "notif_new_voting",
          p: { title: e.record.get("title") || "" },
        },
      );
    }
  } catch (er) {}
  e.next();
}, "votings");
onRecordCreateRequest((e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) throw new BadRequestError("not_authenticated");
  e.record.set("user", e.auth.id);
  let v;
  try {
    v = e.app.findRecordById("votings", e.record.get("voting"));
  } catch (er) {
    throw new BadRequestError("voting_not_found");
  }
  if (v.get("status") !== "active")
    throw new BadRequestError("voting_not_active");
  // The deadline decides the vote, so it has to be enforced on the ballot path and
  // not left to the minute cron. Until this check existed a ballot arriving in the
  // gap between ends_at and the next sweep was counted, and a late "yes" was shown
  // to flip a verdict from rejected to accepted — with a timestamp in the printed
  // protocol later than the deadline the same protocol declares.
  const endsRaw = v.getString("ends_at");
  const endsMs = endsRaw ? Date.parse(endsRaw.replace(" ", "T")) : NaN;
  if (endsMs && !isNaN(endsMs) && Date.now() > endsMs)
    throw new BadRequestError("voting_expired");
  const m = L.membership(e.app, v.get("group"), e.auth.id);
  if (!m) throw new BadRequestError("not_member");
  // Electorate integrity: eligibility is FIXED at creation. If the voting captured an
  // explicit voter_ids snapshot, only those IDs may vote — this matches the quorum
  // denominator exactly, so a mid-vote role/freeze change (or a self-restore) can no
  // longer let an excluded member add a vote outside the counted denominator. Older
  // votings without the snapshot fall back to the membership-created check.
  // NB: read the snapshot via L.readIdList — a raw v.get("voter_ids") yields the
  // JSON *bytes*, so the comparison below silently never matched and every single
  // member was refused with not_in_electorate.
  const roll = L.readIdList(v, "voter_ids");
  if (roll.length) {
    // The roll IS the electorate: it is the quorum denominator, so it must also be
    // the sole answer to "may this person vote". Layering the LIVE is_observer /
    // is_frozen flags on top of it let a sitting admin demote three neighbours in
    // the middle of a voting about replacing him — they stayed in the frozen
    // denominator but could no longer cast a ballot, which made that voting
    // arithmetically unwinnable and the admin unremovable. Rights and denominator
    // now move together, exactly as this snapshot was introduced to guarantee.
    let inRoll = false;
    for (let i = 0; i < roll.length; i++) {
      if (roll[i] === e.auth.id) {
        inRoll = true;
        break;
      }
    }
    if (!inRoll) throw new BadRequestError("not_in_electorate");
  } else {
    // Votings created before snapshots existed have no roll; fall back to the live
    // flags, which is all those older records can be judged by.
    if (m.get("is_observer")) throw new BadRequestError("observer_cannot_vote");
    if (m.get("is_frozen")) throw new BadRequestError("frozen_cannot_vote");
    if (m.getString("created") > v.getString("created"))
      throw new BadRequestError("joined_after_voting_started");
  }
  // Friendly duplicate check; the idx_vote_unique index remains the hard guarantee.
  if (
    e.app.findRecordsByFilter(
      "votes",
      "voting = {:v} && user = {:u}",
      "",
      1,
      0,
      { v: v.id, u: e.auth.id },
    ).length
  )
    throw new BadRequestError("already_voted");
  e.next();
}, "votes");
onRecordCreateRequest((e) => {
  if (!e.auth) throw new BadRequestError("not_authenticated");
  e.record.set("user", e.auth.id);
  e.next();
}, "feedback");

// ===== Ownership can never be reassigned =====
// PocketBase evaluates an updateRule against the record as it stood BEFORE the
// change, and never re-checks it against the incoming values. So a rule like
// `user = @request.auth.id` lets anyone PATCH their OWN row and move it into
// somebody else's name — verified against 0.39.4. Consequences here: a resident
// could hang their name and flat number on a neighbour (and the victim could not
// undo it, profiles.deleteRule is superuser-only), or push a fabricated
// "Administrator: ..." message into a neighbour's inbox. Pin the owner back.
onRecordUpdateRequest((e) => {
  if (e.auth && e.auth.collection().name === "_superusers") {
    e.next();
    return;
  }
  const orig = e.app.findRecordById("profiles", e.record.id);
  e.record.set("user", orig.get("user"));
  e.next();
}, "profiles");

onRecordUpdateRequest((e) => {
  if (e.auth && e.auth.collection().name === "_superusers") {
    e.next();
    return;
  }
  const orig = e.app.findRecordById("notifications", e.record.id);
  // Owner, sender-controlled text and kind all stay as delivered; the app only
  // ever flips is_read / archived_at / metadata.
  e.record.set("user", orig.get("user"));
  e.record.set("type", orig.get("type"));
  e.record.set("text", orig.get("text"));
  e.next();
}, "notifications");

onRecordUpdateRequest((e) => {
  if (e.auth && e.auth.collection().name === "_superusers") {
    e.next();
    return;
  }
  const L = require(`${__hooks}/lib.js`);
  const orig = e.app.findRecordById("votings", e.record.id);
  if (orig.get("status") !== "active" || e.record.get("status") !== "deleted")
    throw new BadRequestError("only_active_to_deleted_allowed");
  if (e.record.getString("result") || e.record.getString("completed_at"))
    throw new BadRequestError("cannot_set_result");
  // Cancelling changes the STATUS and nothing else. The collection's update rule
  // only asks for a logged-in user, so everything else is guarded here — and this
  // list used to be missing. Sending {status: "deleted", type: "simple"} rewrote a
  // SECRET ballot into an open one, and /voting-ballots then handed out who voted
  // how, with names and flat numbers.
  const pinned = [
    "group",
    "type",
    "title",
    "description",
    "created_by",
    "target_member",
    "removal_reason",
    "link",
    "ends_at",
    "voter_snapshot",
    "freeze_duration_days",
  ];
  for (const f of pinned) {
    if (e.record.getString(f) !== orig.getString(f))
      throw new BadRequestError("only_status_change_allowed");
  }
  if (
    JSON.stringify(L.readIdList(e.record, "voter_ids")) !==
    JSON.stringify(L.readIdList(orig, "voter_ids"))
  )
    throw new BadRequestError("only_status_change_allowed");
  // Only the author or a group admin may cancel a voting — except for the two
  // kinds aimed AT the admin. Letting an admin cancel the vote to replace them
  // (or to dissolve the group) made them unremovable: residents propose, the
  // admin cancels, forever. The app's own help promises the opposite. For those
  // two types only the person who started it may withdraw it.
  const uid = e.auth ? e.auth.id : "";
  const aimedAtAdmin =
    orig.get("type") === "admin-change" || orig.get("type") === "delete-group";
  const allowed = aimedAtAdmin
    ? uid === orig.get("created_by")
    : uid === orig.get("created_by") ||
      L.isAdmin(e.app, orig.get("group"), uid);
  if (!allowed) throw new BadRequestError("not_allowed_to_delete");
  e.next();
}, "votings");

// Cancelling a voting told nobody and left no trace. The client called
// `notifyGroupMembers`, which has been an empty stub since the PocketBase move, so
// the author believed the house had been informed. Residents who had already voted
// simply found the question gone, with no record of who withdrew it or why.
onRecordAfterUpdateSuccess((e) => {
  try {
    if (e.record.get("status") !== "deleted") {
      e.next();
      return;
    }
    const L = require(`${__hooks}/lib.js`);
    const gid = e.record.get("group");
    const reason = e.record.getString("deleted_reason") || "";
    const h = new Record(e.app.findCollectionByNameOrId("group_history"));
    h.set("group", gid);
    h.set("action", "voting_cancelled");
    h.set("voting", e.record.id);
    h.set("details", { by: e.auth ? e.auth.id : "", reason: reason });
    e.app.save(h);
    L.notifyGroup(
      e.app,
      gid,
      e.auth ? e.auth.id : null,
      "voting_cancelled",
      'Голосування "' +
        (e.record.get("title") || "") +
        '" скасовано' +
        (reason ? ": " + reason : ""),
      {
        group_id: gid,
        voting_id: e.record.id,
        i18n: reason ? "notif_voting_cancelled_reason" : "notif_voting_cancelled",
        p: { title: e.record.get("title") || "", reason: reason },
      },
    );
  } catch (er) {}
  e.next();
}, "votings");

// ===== RPC routes =====
routerAdd("POST", "/api/spilka/create-group", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body;
  const name = (b.name || "").trim();
  if (!name) return e.json(400, { error: "name_required" });
  let out = null;
  e.app.runInTransaction((tx) => {
    const code = L.genCode(tx);
    const g = new Record(tx.findCollectionByNameOrId("groups"));
    g.set("name", name);
    g.set("description", b.description || "");
    g.set("group_code", code);
    g.set("created_by", auth.id);
    tx.save(g);
    const m = new Record(tx.findCollectionByNameOrId("group_members"));
    m.set("group", g.id);
    m.set("user", auth.id);
    m.set("role", "admin");
    m.set("is_observer", false);
    try {
      const p = tx.findFirstRecordByFilter("profiles", "user = {:u}", {
        u: auth.id,
      });
      m.set("apartment", p.get("apartment") || "");
    } catch (er) {}
    tx.save(m);
    out = { id: g.id, name: g.get("name"), group_code: g.get("group_code") };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/find-group", (e) => {
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const code = (e.requestInfo().body.code || "").trim();
  try {
    const g = e.app.findFirstRecordByFilter("groups", "group_code = {:c}", {
      c: code,
    });
    return e.json(200, {
      data: { id: g.id, name: g.get("name"), group_code: g.get("group_code") },
    });
  } catch (er) {
    return e.json(200, { data: null });
  }
});

routerAdd("POST", "/api/spilka/my-groups", (e) => {
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const mine = e.app.findRecordsByFilter(
    "group_members",
    "user = {:u}",
    "",
    0,
    0,
    { u: auth.id },
  );
  const data = [];
  for (const m of mine) {
    const gid = m.get("group");
    let g;
    try {
      g = e.app.findRecordById("groups", gid);
    } catch (er) {
      continue;
    }
    const members = e.app.findRecordsByFilter(
      "group_members",
      "group = {:g}",
      "",
      0,
      0,
      { g: gid },
    );
    const active = e.app.findRecordsByFilter(
      "votings",
      "group = {:g} && status = 'active'",
      "",
      0,
      0,
      { g: gid },
    );
    const total = e.app.findRecordsByFilter(
      "votings",
      "group = {:g} && status != 'deleted'",
      "",
      0,
      0,
      { g: gid },
    );
    data.push({
      group_id: gid,
      name: g.get("name"),
      description: g.get("description"),
      group_code: g.get("group_code"),
      created_by: g.get("created_by"),
      role: m.get("role"),
      is_observer: !!m.get("is_observer"),
      apartment: m.get("apartment") || "",
      members_count: members.length,
      active_votings_count: active.length,
      total_votings_count: total.length,
    });
  }
  // Requests still awaiting an admin. Until now, someone who entered a house code
  // and pressed "Приєднатися" saw a toast and then an app that looked exactly as it
  // did before: the Groups tab still said "Ви ще не приєдналися до жодної групи",
  // and no notification was ever written. After one reload there was no evidence in
  // the app that they had applied at all. The house name lives in a collection they
  // are not a member of, so only the server can answer this.
  const pending = [];
  try {
    const reqs = e.app.findRecordsByFilter(
      "join_requests",
      "user = {:u} && status = 'pending'",
      "-created",
      20,
      0,
      { u: auth.id },
    );
    for (const r of reqs) {
      let nm = "";
      try {
        nm = e.app.findRecordById("groups", r.get("group")).get("name");
      } catch (er) {}
      pending.push({
        request_id: r.id,
        group_id: r.get("group"),
        name: nm,
        apartment: r.get("apartment") || "",
        is_role_change: !!r.get("is_role_change"),
        created_at: r.getString("created"),
      });
    }
  } catch (er) {}
  return e.json(200, { data: data, pending: pending });
});

// Pending applications, for the admin who has to decide on them. This exists so the
// applicant's profile can stop being readable by the whole house: the third branch of
// profiles.listRule made an applicant's name, phone and address visible to EVERY
// resident from the moment they applied — while the product deliberately hides the
// occupant's name in the other direction, inside submit-join.
routerAdd("POST", "/api/spilka/group-requests", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const gid = e.requestInfo().body.group_id;
  if (!L.isAdmin(e.app, gid, e.auth.id))
    return e.json(403, { error: "not_admin" });
  const reqs = e.app.findRecordsByFilter(
    "join_requests",
    "group = {:g} && status = 'pending'",
    "-created",
    100,
    0,
    { g: gid },
  );
  const out = [];
  for (const r of reqs) {
    const uid = r.get("user");
    let apt = r.getString("apartment");
    let addr = "";
    try {
      const pr = e.app.findFirstRecordByFilter("profiles", "user = {:u}", {
        u: uid,
      });
      if (!apt) apt = pr.getString("apartment");
      addr = pr.getString("address");
    } catch (er) {}
    out.push({
      id: r.id,
      user_id: uid,
      name: L.fullName(e.app, uid),
      apartment: apt,
      address: addr,
      requested_as_observer: !!r.get("requested_as_observer"),
      is_role_change: !!r.get("is_role_change"),
      created: r.getString("created"),
    });
  }
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/voter-count", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const gid = e.requestInfo().body.group_id;
  if (!L.membership(e.app, gid, e.auth.id))
    return e.json(403, { error: "not_member" });
  return e.json(200, { data: L.activeVoters(e.app, gid) });
});

routerAdd("POST", "/api/spilka/voting-results", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const ids = (e.requestInfo().body.voting_ids || []).slice(0, 200);
  const data = [];
  for (const vid of ids) {
    let vt;
    try {
      vt = e.app.findRecordById("votings", vid);
    } catch (er) {
      continue;
    }
    if (!L.membership(e.app, vt.get("group"), e.auth.id)) continue;
    // Do not leak a running tally of an ACTIVE secret ballot — it could sway voters.
    // Counts become available once the secret voting is completed (for the protocol).
    if (vt.get("type") === "secret" && vt.get("status") === "active") continue;
    const yes = e.app.findRecordsByFilter(
      "votes",
      "voting = {:v} && choice = 'yes'",
      "",
      0,
      0,
      { v: vid },
    ).length;
    const no = e.app.findRecordsByFilter(
      "votes",
      "voting = {:v} && choice = 'no'",
      "",
      0,
      0,
      { v: vid },
    ).length;
    const ab = e.app.findRecordsByFilter(
      "votes",
      "voting = {:v} && choice = 'abstain'",
      "",
      0,
      0,
      { v: vid },
    ).length;
    data.push({
      voting_id: vid,
      yes_votes: yes,
      no_votes: no,
      abstain_votes: ab,
      total_votes: yes + no + ab,
    });
  }
  return e.json(200, { data: data });
});

// Itemized ballot list. For OPEN votings — everyone's vote with names (as before).
// For SECRET votings — ONLY the caller's own row, so the direct `votes` collection
// (now locked to own-row read) can never de-anonymize a secret ballot.
routerAdd("POST", "/api/spilka/voting-ballots", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const vid = e.requestInfo().body.voting_id;
  let vt;
  try {
    vt = e.app.findRecordById("votings", vid);
  } catch (er) {
    return e.json(400, { error: "voting_not_found" });
  }
  if (!L.membership(e.app, vt.get("group"), e.auth.id))
    return e.json(403, { error: "not_member" });
  const secret = vt.get("type") === "secret";
  const filter = secret ? "voting = {:v} && user = {:u}" : "voting = {:v}";
  const rows = e.app.findRecordsByFilter("votes", filter, "created", 0, 0, {
    v: vid,
    u: e.auth.id,
  });
  const data = rows.map((r) => {
    const uid = r.get("user");
    let fn = "",
      ln = "",
      apt = "";
    try {
      const p = e.app.findFirstRecordByFilter("profiles", "user = {:u}", {
        u: uid,
      });
      fn = p.get("first_name") || "";
      ln = p.get("last_name") || "";
      apt = p.get("apartment") || "";
    } catch (er) {}
    return {
      id: r.id,
      user_id: uid,
      choice: r.get("choice"),
      comment: secret ? "" : r.get("comment") || "",
      created: r.getString("created"),
      first_name: fn,
      last_name: ln,
      apartment: apt,
    };
  });
  return e.json(200, { data: data });
});

routerAdd("POST", "/api/spilka/member-votes", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const gid = e.requestInfo().body.group_id;
  if (!L.membership(e.app, gid, e.auth.id))
    return e.json(403, { error: "not_member" });
  const votings = e.app.findRecordsByFilter(
    "votings",
    "group = {:g} && status != 'deleted'",
    "",
    0,
    0,
    { g: gid },
  );
  const counts = {};
  const eligible = {};
  const members = e.app.findRecordsByFilter(
    "group_members",
    "group = {:g}",
    "",
    0,
    0,
    { g: gid },
  );
  for (const v of votings) {
    // Per-member turnout in a SECRET ballot is sensitive, and it does not stop being
    // sensitive when the urn closes: in a small house a unanimous tally plus the list
    // of who voted reveals every single choice. This used to be skipped only while
    // the ballot was running, so the participation column on the members screen
    // published exactly that the moment the voting completed.
    if (v.get("type") === "secret") continue;
    // A freeze proposal has no yes/no ballot at all — counting it as a missed vote
    // is what made the column read "0/2" for people who had voted in everything.
    if (v.get("type") === "freeze") continue;
    const roll = L.readIdList(v, "voter_ids");
    if (roll.length) {
      for (let i = 0; i < roll.length; i++)
        eligible[roll[i]] = (eligible[roll[i]] || 0) + 1;
    } else {
      // Legacy votings carry no roll; the best available answer is everyone who is
      // in the house today.
      for (const mm of members) {
        const u = mm.get("user");
        eligible[u] = (eligible[u] || 0) + 1;
      }
    }
    const vts = e.app.findRecordsByFilter("votes", "voting = {:v}", "", 0, 0, {
      v: v.id,
    });
    for (const vt of vts) {
      const u = vt.get("user");
      counts[u] = (counts[u] || 0) + 1;
    }
  }
  // The denominator has to come from here too. The client used to divide by every
  // voting in the group, while the numerator skipped secret ones — so during any
  // secret ballot every neighbour was shown as having missed a vote they had cast,
  // and a resident who moved in last month was scored against votings the server
  // itself had barred them from.
  const ids = {};
  for (const mm of members) ids[mm.get("user")] = true;
  for (const u of Object.keys(counts)) ids[u] = true;
  return e.json(200, {
    data: Object.keys(ids).map((u) => ({
      user_id: u,
      voted_count: counts[u] || 0,
      eligible_count: eligible[u] || 0,
    })),
  });
});

routerAdd("POST", "/api/spilka/submit-join", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body;
  const gid = b.group_id,
    apt = (b.apartment || "").trim(),
    asObs = !!b.as_observer;
  if (!apt) return e.json(400, { error: "apartment_required" });
  if (L.membership(e.app, gid, auth.id))
    return e.json(400, { error: "already_member" });
  if (
    e.app.findRecordsByFilter(
      "join_requests",
      "group = {:g} && user = {:u} && status = 'pending'",
      "",
      0,
      0,
      { g: gid, u: auth.id },
    ).length
  )
    return e.json(400, { error: "already_pending" });
  // Do NOT leak the occupant's real name to a non-member submitting a join request.
  if (!asObs) {
    const c = e.app.findRecordsByFilter(
      "group_members",
      "group = {:g} && is_observer = false && is_frozen = false && apartment = {:a}",
      "",
      1,
      0,
      { g: gid, a: apt },
    );
    if (c.length) return e.json(400, { error: "apartment_taken" });
  }
  let rid = null;
  e.app.runInTransaction((tx) => {
    const r = new Record(tx.findCollectionByNameOrId("join_requests"));
    r.set("group", gid);
    r.set("user", auth.id);
    r.set("apartment", apt);
    r.set("requested_as_observer", asObs);
    r.set("is_role_change", false);
    r.set("status", "pending");
    tx.save(r);
    rid = r.id;
    const adm = L.adminOf(tx, gid);
    if (adm) {
      let gn = "";
      try {
        gn = tx.findRecordById("groups", gid).get("name");
      } catch (er) {}
      L.notify(
        tx,
        adm.get("user"),
        "join_request",
        L.fullName(tx, auth.id) +
          ' хоче приєднатися до "' +
          gn +
          '" (кв.' +
          apt +
          (asObs ? ", спостерігач)" : ", голосуючий)"),
        {
          group_id: gid,
          request_id: rid,
          requester_id: auth.id,
          apartment: apt,
          as_observer: asObs,
        },
      );
    }
  });
  return e.json(200, { data: rid });
});

routerAdd("POST", "/api/spilka/request-role-change", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body;
  const gid = b.group_id,
    becomeObs = !!b.become_observer;
  const m = L.membership(e.app, gid, auth.id);
  if (!m) return e.json(400, { error: "not_member" });
  if (!!m.get("is_observer") === becomeObs)
    return e.json(400, { error: "already_in_role" });
  const apt = m.get("apartment") || "";
  if (!apt) return e.json(400, { error: "apartment_missing_on_membership" });
  if (m.get("role") === "admin" && becomeObs)
    return e.json(400, { error: "admin_cannot_be_observer" });
  if (
    e.app.findRecordsByFilter(
      "join_requests",
      "group = {:g} && user = {:u} && status = 'pending'",
      "",
      0,
      0,
      { g: gid, u: auth.id },
    ).length
  )
    return e.json(400, { error: "already_pending" });
  if (!becomeObs) {
    const c = e.app.findRecordsByFilter(
      "group_members",
      "group = {:g} && is_observer = false && is_frozen = false && apartment = {:a} && user != {:u}",
      "",
      1,
      0,
      { g: gid, a: apt, u: auth.id },
    );
    if (c.length) return e.json(400, { error: "apartment_taken" });
  }
  let rid = null;
  e.app.runInTransaction((tx) => {
    const r = new Record(tx.findCollectionByNameOrId("join_requests"));
    r.set("group", gid);
    r.set("user", auth.id);
    r.set("apartment", apt);
    r.set("requested_as_observer", becomeObs);
    r.set("is_role_change", true);
    r.set("status", "pending");
    tx.save(r);
    rid = r.id;
    const adm = L.adminOf(tx, gid);
    if (adm && adm.get("user") !== auth.id)
      L.notify(
        tx,
        adm.get("user"),
        "role_change_request",
        L.fullName(tx, auth.id) +
          " просить змінити роль (кв." +
          apt +
          " → " +
          (becomeObs ? "спостерігач)" : "голосуючий)"),
        {
          group_id: gid,
          request_id: rid,
          is_role_change: true,
          as_observer: becomeObs,
        },
      );
  });
  return e.json(200, { data: rid });
});

routerAdd("POST", "/api/spilka/approve-join", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body;
  const rid = b.request_id,
    force = !!b.force_observer;
  let req;
  try {
    req = e.app.findRecordById("join_requests", rid);
  } catch (er) {
    return e.json(400, { error: "request_not_found" });
  }
  if (req.get("status") !== "pending")
    return e.json(400, { error: "request_not_found" });
  if (!L.isAdmin(e.app, req.get("group"), auth.id))
    return e.json(403, { error: "not_admin" });
  const finalObs = !!req.get("requested_as_observer") || force;
  const apt = req.get("apartment") || "";
  if (!finalObs && apt) {
    const taken = e.app.findRecordsByFilter(
      "group_members",
      "group = {:g} && is_observer = false && is_frozen = false && apartment = {:a} && user != {:u}",
      "",
      1,
      0,
      { g: req.get("group"), a: apt, u: req.get("user") },
    );
    if (taken.length) return e.json(400, { error: "apartment_taken_now" });
  }
  e.app.runInTransaction((tx) => {
    req.set("status", "approved");
    req.set("resolved_at", new Date().toISOString());
    req.set("resolved_by", auth.id);
    tx.save(req);
    if (req.get("is_role_change")) {
      const m = L.membership(tx, req.get("group"), req.get("user"));
      if (m) {
        m.set("is_observer", finalObs);
        tx.save(m);
      }
    } else {
      if (apt) {
        const ghosts = tx.findRecordsByFilter(
          "group_members",
          "group = {:g} && is_frozen = true && apartment = {:a}",
          "",
          0,
          0,
          { g: req.get("group"), a: apt },
        );
        for (const gh of ghosts) tx.delete(gh);
      }
      const m = new Record(tx.findCollectionByNameOrId("group_members"));
      m.set("group", req.get("group"));
      m.set("user", req.get("user"));
      m.set("role", "member");
      m.set("is_observer", finalObs);
      m.set("apartment", apt);
      tx.save(m);
    }
    L.notify(
      tx,
      req.get("user"),
      req.get("is_role_change") ? "role_change_approved" : "join_approved",
      req.get("is_role_change")
        ? "Зміну ролі затверджено: ви тепер " +
            (finalObs ? "спостерігач" : "голосуючий")
        : "Заявку на приєднання прийнято" +
            (finalObs && !req.get("requested_as_observer")
              ? " (як спостерігач — кв. зайнята)"
              : ""),
      { group_id: req.get("group"), as_observer: finalObs },
    );
  });
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/reject-join", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const rid = e.requestInfo().body.request_id;
  let req;
  try {
    req = e.app.findRecordById("join_requests", rid);
  } catch (er) {
    return e.json(400, { error: "request_not_found" });
  }
  if (req.get("status") !== "pending")
    return e.json(400, { error: "request_not_found" });
  if (!L.isAdmin(e.app, req.get("group"), auth.id))
    return e.json(403, { error: "not_admin" });
  req.set("status", "rejected");
  req.set("resolved_at", new Date().toISOString());
  req.set("resolved_by", auth.id);
  e.app.save(req);
  // Name the house. A resident who applied to their own building and to their
  // parents' got "Заявку на приєднання відхилено" with nothing to tell them which,
  // and tapping it did nothing — they are not a member, so the client had no group
  // to open. The name is only readable here, on the server.
  let rejectedFrom = "";
  try {
    rejectedFrom = e.app.findRecordById("groups", req.get("group")).get("name");
  } catch (er) {}
  L.notify(
    e.app,
    req.get("user"),
    "join_rejected",
    rejectedFrom
      ? 'Заявку на приєднання до "' + rejectedFrom + '" відхилено'
      : "Заявку на приєднання відхилено",
    {
      group_id: req.get("group"),
      group_name: rejectedFrom,
      i18n: rejectedFrom ? "notif_join_rejected_named" : "notif_join_rejected",
      p: { group: rejectedFrom },
    },
  );
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/admin-change-role", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body;
  const gid = b.group_id,
    targetUid = b.user_id,
    makeObs = !!b.make_observer;
  if (!L.isAdmin(e.app, gid, auth.id))
    return e.json(403, { error: "not_admin" });
  const m = L.membership(e.app, gid, targetUid);
  if (!m) return e.json(400, { error: "not_member" });
  // An admin must stay a voting member (admin_cannot_be_observer invariant, enforced
  // at voting creation and in applyEffect). Never turn an admin into an observer.
  if (makeObs && m.get("role") === "admin")
    return e.json(400, { error: "admin_cannot_be_observer" });
  if (!makeObs) {
    const apt = m.get("apartment") || "";
    if (apt) {
      const taken = e.app.findRecordsByFilter(
        "group_members",
        "group = {:g} && is_observer = false && is_frozen = false && apartment = {:a} && user != {:u}",
        "",
        1,
        0,
        { g: gid, a: apt, u: targetUid },
      );
      if (taken.length)
        return e.json(400, {
          error: "apartment_taken:" + L.fullName(e.app, taken[0].get("user")),
        });
    }
  }
  m.set("is_observer", makeObs);
  e.app.save(m);
  // Losing the right to vote is not a silent bookkeeping change. Until this was
  // added, an admin could move every resident to "observer" one call at a time —
  // no notice, no trace — leaving themselves the only voter, push through any
  // decision, then move everyone back. Telling the member and writing it into the
  // group's history is what makes that visible.
  try {
    L.notify(
      e.app,
      targetUid,
      "role_changed_by_admin",
      makeObs
        ? "Адміністратор змінив вашу роль: ви тепер спостерігач і не берете участі в голосуваннях."
        : "Адміністратор змінив вашу роль: ви тепер голосуючий учасник.",
      { group_id: gid, as_observer: makeObs, by: auth.id },
    );
    const h = new Record(e.app.findCollectionByNameOrId("group_history"));
    h.set("group", gid);
    h.set("action", "role_changed");
    h.set("details", { user: targetUid, as_observer: makeObs, by: auth.id });
    e.app.save(h);
  } catch (er) {}
  return e.json(200, { data: true });
});

// Renaming a group / editing its description. The groups collection has no update
// rule at all (superuser-only), so the client's direct PATCH could never succeed —
// "Зберегти" on the edit-group dialog failed for every admin, every time.
routerAdd("POST", "/api/spilka/update-group", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body;
  const gid = b.group_id;
  // A number or an object in `name` threw inside .trim() and PocketBase answered with
  // an untranslated "Something went wrong while processing your request".
  if (typeof b.name !== "string") return e.json(400, { error: "name_required" });
  const name = b.name.trim();
  if (!name) return e.json(400, { error: "name_required" });
  if (name.length > 200) return e.json(400, { error: "name_too_long" });
  const hasDesc = typeof b.description === "string";
  const desc = hasDesc ? b.description.trim() : "";
  if (desc.length > 2000) return e.json(400, { error: "description_too_long" });
  if (!L.isAdmin(e.app, gid, auth.id))
    return e.json(403, { error: "not_admin" });
  let g;
  try {
    g = e.app.findRecordById("groups", gid);
  } catch (er) {
    return e.json(400, { error: "group_not_found" });
  }
  const oldName = g.getString("name");
  g.set("name", name);
  // Only touch the description when it was actually sent. Writing "" for an absent
  // field silently erased the house description on any caller that omitted it.
  if (hasDesc) g.set("description", desc);
  e.app.save(g);
  // The house name is the address every resident sees and every protocol carries.
  // Changing it left no trace at all, while the neighbouring role change writes one.
  if (oldName !== name) {
    try {
      const h = new Record(e.app.findCollectionByNameOrId("group_history"));
      h.set("group", gid);
      h.set("action", "group_renamed");
      h.set("details", { by: auth.id, from: oldName, to: name });
      e.app.save(h);
      L.notifyGroup(
        e.app,
        gid,
        auth.id,
        "group_renamed",
        'Спільноту перейменовано: "' + oldName + '" → "' + name + '"',
        {
          group_id: gid,
          i18n: "notif_group_renamed",
          p: { from: oldName, to: name },
        },
      );
    } catch (er) {}
  }
  return e.json(200, {
    data: { id: g.id, name: g.get("name"), description: g.get("description") },
  });
});

routerAdd("POST", "/api/spilka/leave-group", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const gid = e.requestInfo().body.group_id;
  const m = L.membership(e.app, gid, auth.id);
  if (!m) return e.json(400, { error: "not_member" });
  if (m.get("role") === "admin")
    return e.json(400, { error: "admin_must_transfer_first" });
  // Walking out while a voting ABOUT YOU is running used to turn that voting into a
  // decision the system could not carry out: the effect hook found no membership,
  // did nothing, and the app still stamped "прийнято" and let anyone print a
  // protocol naming you as the new chair (or as expelled). No malice required — one
  // ordinary button. Wait for it to close, or ask the author to withdraw it.
  const aboutMe = e.app.findRecordsByFilter(
    "votings",
    "group = {:g} && status = 'active' && target_member = {:u}",
    "",
    1,
    0,
    { g: gid, u: auth.id },
  );
  if (aboutMe.length) return e.json(400, { error: "target_of_active_voting" });
  e.app.delete(m);
  return e.json(200, { data: true });
});

// Direct deletion of a group WITHOUT a voting — allowed only for the admin and
// only while they are the sole member (groups.deleteRule is null, so the old
// client-side collection delete silently failed since the PB migration).
routerAdd("POST", "/api/spilka/delete-group-direct", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const gid = e.requestInfo().body.group_id;
  const m = L.membership(e.app, gid, auth.id);
  if (!m || m.get("role") !== "admin")
    return e.json(403, { error: "not_admin" });
  const members = e.app.findRecordsByFilter(
    "group_members",
    "group = {:g}",
    "",
    0,
    0,
    { g: gid },
  );
  if (members.length > 1)
    return e.json(400, { error: "delete_group_need_voting" });
  e.app.runInTransaction((tx) => {
    L.deleteGroupCascade(tx, gid, null);
  });
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/broadcast", (e) => {
  const L = require(`${__hooks}/lib.js`);
  const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(auth)) return e.json(403, { error: "not_admin" });
  const b = e.requestInfo().body;
  const uids = b.user_ids || [],
    text = (b.text || "").trim();
  if (!text) return e.json(400, { error: "text_required" });
  let n = 0;
  for (const uid of uids) {
    L.notify(e.app, uid, "admin_message", text, { from: "admin" });
    n++;
  }
  return e.json(200, { data: n });
});

routerAdd("POST", "/api/spilka/complete-expired", (e) => {
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const L = require(`${__hooks}/lib.js`);
  // Only the caller's own groups: this route exists so the screen refreshes
  // promptly, not so one account can make the server sweep every group there is.
  // The minute cron still covers everything.
  const mine = e.app.findRecordsByFilter(
    "group_members",
    "user = {:u}",
    "",
    0,
    0,
    { u: e.auth.id },
  );
  const gids = mine.map(function (m) {
    return m.get("group");
  });
  if (!gids.length) return e.json(200, { data: true });
  L.completeExpired(e.app, gids);
  return e.json(200, { data: true });
});

// ===== Admin / feedback =====
onRecordAfterCreateSuccess((e) => {
  try {
    const L = require(`${__hooks}/lib.js`);
    const adm = L.adminUser(e.app);
    if (adm)
      L.notify(
        e.app,
        adm.id,
        "new_feedback",
        "Новий відгук: " + (e.record.get("text") || "").slice(0, 80),
        { feedback_id: e.record.id },
      );
  } catch (er) {}
  e.next();
}, "feedback");

routerAdd("POST", "/api/spilka/admin-stats", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const now = Date.now();
  // Space-separated format to match PB date storage (string comparison in filters).
  const d7 = new Date(now - 7 * 86400000).toISOString().replace("T", " ");
  const d1 = new Date(now - 86400000).toISOString().replace("T", " ");
  const c = (col, f, prm) => L.cnt(e.app, col, f, prm);
  return e.json(200, {
    data: {
      users_total: c("users"),
      users_completed: c("profiles", "profile_completed = true"),
      users_last_7d: c("users", "created >= {:d}", { d: d7 }),
      users_last_24h: c("users", "created >= {:d}", { d: d1 }),
      groups_total: c("groups"),
      groups_last_7d: c("groups", "created >= {:d}", { d: d7 }),
      memberships_total: c("group_members"),
      votings_total: c("votings", "status != 'deleted'"),
      votings_active: c("votings", "status = 'active'"),
      votings_completed: c("votings", "status = 'completed'"),
      votings_accepted: c("votings", "result = 'accepted'"),
      votings_rejected: c("votings", "result = 'rejected'"),
      votes_total: c("votes"),
      feedback_total: c("feedback"),
      feedback_new: c("feedback", "status = 'new'"),
    },
  });
});

routerAdd("POST", "/api/spilka/admin-users", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const users = e.app.findRecordsByFilter(
    "users",
    "id != ''",
    "-created",
    30,
    0,
    {},
  );
  const out = users.map((u) => {
    let p = null;
    try {
      p = e.app.findFirstRecordByFilter("profiles", "user = {:u}", { u: u.id });
    } catch (er) {}
    let gc = 0;
    try {
      gc = e.app.findRecordsByFilter("group_members", "user = {:u}", "", 0, 0, {
        u: u.id,
      }).length;
    } catch (er) {}
    return {
      id: u.id,
      email: u.get("email"),
      first_name: p ? p.get("first_name") : "",
      last_name: p ? p.get("last_name") : "",
      profile_completed: p ? !!p.get("profile_completed") : false,
      groups_count: gc,
      created_at: u.getString("created"),
    };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/admin-groups", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const groups = e.app.findRecordsByFilter(
    "groups",
    "id != ''",
    "-created",
    30,
    0,
    {},
  );
  const out = groups.map((g) => {
    let mc = 0,
      vc = 0,
      cem = "";
    try {
      mc = e.app.findRecordsByFilter(
        "group_members",
        "group = {:g}",
        "",
        0,
        0,
        { g: g.id },
      ).length;
    } catch (er) {}
    try {
      vc = e.app.findRecordsByFilter(
        "votings",
        "group = {:g} && status != 'deleted'",
        "",
        0,
        0,
        { g: g.id },
      ).length;
    } catch (er) {}
    try {
      cem = e.app.findRecordById("users", g.get("created_by")).get("email");
    } catch (er) {}
    return {
      id: g.id,
      name: g.get("name"),
      group_code: g.get("group_code"),
      members_count: mc,
      votings_count: vc,
      creator_email: cem,
      created_at: g.getString("created"),
    };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/admin-feedback", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const fb = e.app.findRecordsByFilter(
    "feedback",
    "id != ''",
    "-created",
    100,
    0,
    {},
  );
  const out = fb.map((f) => {
    let nm = "",
      em = "";
    try {
      const p = e.app.findFirstRecordByFilter("profiles", "user = {:u}", {
        u: f.get("user"),
      });
      nm = (
        (p.get("first_name") || "") +
        " " +
        (p.get("last_name") || "")
      ).trim();
    } catch (er) {}
    try {
      em = e.app.findRecordById("users", f.get("user")).get("email");
    } catch (er) {}
    return {
      id: f.id,
      text: f.get("text"),
      status: f.get("status"),
      reply: f.get("reply") || "",
      replied_at: f.getString("replied_at") || null,
      user_name: nm,
      user_email: em,
      user_id: f.get("user"),
      created_at: f.getString("created"),
    };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/feedback-status", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const b = e.requestInfo().body;
  let f;
  try {
    f = e.app.findRecordById("feedback", b.feedback_id);
  } catch (er) {
    return e.json(400, { error: "not_found" });
  }
  f.set("status", b.status);
  e.app.save(f);
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/reply-feedback", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const b = e.requestInfo().body;
  const fid = b.feedback_id;
  const reply = (b.reply || "").trim();
  if (!reply) return e.json(400, { error: "reply_required" });
  let f;
  try {
    f = e.app.findRecordById("feedback", fid);
  } catch (er) {
    return e.json(400, { error: "feedback_not_found" });
  }
  e.app.runInTransaction((tx) => {
    const fresh = tx.findRecordById("feedback", fid);
    fresh.set("reply", reply);
    fresh.set("replied_at", new Date().toISOString());
    fresh.set("status", "done");
    tx.save(fresh);
    L.notify(
      tx,
      fresh.get("user"),
      "feedback_reply",
      "Відповідь на ваше звернення: " + reply,
      { feedback_id: fid },
    );
  });
  return e.json(200, { data: true });
});

// freeze_targets: only the freeze author may add real non-admin members as targets
onRecordCreateRequest((e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) throw new BadRequestError("not_authenticated");
  let v;
  try {
    v = e.app.findRecordById("votings", e.record.get("voting"));
  } catch (er) {
    throw new BadRequestError("voting_not_found");
  }
  if (v.get("type") !== "freeze" || v.get("status") !== "active")
    throw new BadRequestError("not_active_freeze");
  if (v.get("created_by") !== e.auth.id)
    throw new BadRequestError("not_proposer");
  const tm = L.membership(e.app, v.get("group"), e.record.get("user"));
  if (!tm) throw new BadRequestError("target_not_member");
  if (tm.get("role") === "admin")
    throw new BadRequestError("cannot_target_admin");
  // Anti-harassment: no two concurrent active proposals for the same member.
  const dupes = e.app.findRecordsByFilter(
    "freeze_targets",
    "user = {:u} && voting != {:v} && voting.type = 'freeze' && voting.status = 'active' && voting.group = {:g}",
    "",
    1,
    0,
    { u: e.record.get("user"), v: v.id, g: v.get("group") },
  );
  if (dupes.length) throw new BadRequestError("already_proposed");
  e.next();
}, "freeze_targets");

// ===== Freeze (exclude-from-count) =====
onRecordCreateRequest((e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) throw new BadRequestError("not_authenticated");
  e.record.set("user", e.auth.id);
  let v;
  try {
    v = e.app.findRecordById("votings", e.record.get("voting"));
  } catch (er) {
    throw new BadRequestError("voting_not_found");
  }
  if (v.get("type") !== "freeze" || v.get("status") !== "active")
    throw new BadRequestError("not_active_freeze");
  if (!L.membership(e.app, v.get("group"), e.auth.id))
    throw new BadRequestError("not_member");
  e.next();
}, "freeze_objections");

onRecordAfterCreateSuccess((e) => {
  try {
    const L = require(`${__hooks}/lib.js`);
    const v = e.app.findRecordById("votings", e.record.get("voting"));
    if (v.get("status") !== "active") {
      e.next();
      return;
    }
    const gid = v.get("group");
    const uid = e.record.get("user");
    const isTarget =
      e.app.findRecordsByFilter(
        "freeze_targets",
        "voting = {:v} && user = {:u}",
        "",
        1,
        0,
        { v: v.id, u: uid },
      ).length > 0;
    // The target objecting = proof they are present -> instant cancel. Otherwise need 2 distinct.
    if (isTarget || L.distinctObjections(e.app, v.id) >= 2) {
      v.set("status", "completed");
      v.set("result", "rejected");
      v.set("completed_at", new Date().toISOString());
      e.app.save(v);
      const adm = L.adminOf(e.app, gid);
      if (adm)
        L.notify(
          e.app,
          adm.get("user"),
          "freeze_result",
          "Виключення скасовано: учасники заперечили",
          { group_id: gid, voting_id: v.id },
        );
    }
  } catch (er) {}
  e.next();
}, "freeze_objections");

routerAdd("POST", "/api/spilka/restore-me", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const m = L.membership(e.app, e.requestInfo().body.group_id, e.auth.id);
  if (!m) return e.json(400, { error: "not_member" });
  if (m.get("is_frozen")) {
    m.set("is_frozen", false);
    m.set("frozen_until", "");
    e.app.save(m);
    const h = new Record(e.app.findCollectionByNameOrId("group_history"));
    h.set("group", m.get("group"));
    h.set("action", "member_self_restored");
    h.set("details", { user: e.auth.id });
    e.app.save(h);
  }
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/set-frozen", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body;
  const gid = b.group_id,
    targetUid = b.user_id,
    frozen = !!b.frozen;
  // Exclusion is ONLY possible through a freeze voting (5-day objection window,
  // instant-cancel, ≥2-active floor guard). This route is restore-only, otherwise
  // an admin could bypass every safeguard with one direct request.
  if (frozen) return e.json(400, { error: "exclusion_only_via_voting" });
  if (!L.isAdmin(e.app, gid, e.auth.id))
    return e.json(403, { error: "not_admin" });
  const m = L.membership(e.app, gid, targetUid);
  if (!m) return e.json(400, { error: "not_member" });
  if (m.get("is_frozen")) {
    m.set("is_frozen", false);
    m.set("frozen_until", "");
    e.app.save(m);
    const h = new Record(e.app.findCollectionByNameOrId("group_history"));
    h.set("group", gid);
    h.set("action", "member_restored");
    // The id, not the literal string "admin" — the client resolves this field to a
    // name, so the initiator simply vanished from that line of the journal.
    h.set("details", { user: targetUid, by: e.auth.id });
    e.app.save(h);
  }
  return e.json(200, { data: true });
});

// A house must never be left without an administrator. Membership rows cascade with
// the user record, so an admin deleting their own account took the last admin with
// them and nobody could approve newcomers, change roles, restore an excluded
// neighbour, rename the house or dissolve it — recoverable only by hand in the
// database. `leave-group` already refuses this; the account-deletion path did not.
onRecordDeleteRequest((e) => {
  try {
    const L = require(`${__hooks}/lib.js`);
    const mine = e.app.findRecordsByFilter(
      "group_members",
      "user = {:u} && role = 'admin'",
      "",
      0,
      0,
      { u: e.record.id },
    );
    for (const m of mine) {
      const admins = e.app.findRecordsByFilter(
        "group_members",
        "group = {:g} && role = 'admin'",
        "",
        0,
        0,
        { g: m.get("group") },
      );
      const others = e.app.findRecordsByFilter(
        "group_members",
        "group = {:g}",
        "",
        0,
        0,
        { g: m.get("group") },
      );
      if (admins.length <= 1 && others.length > 1)
        throw new BadRequestError("admin_must_transfer_first");
    }
  } catch (er) {
    if (er instanceof BadRequestError) throw er;
  }
  e.next();
}, "users");

cronAdd("complete_expired", "* * * * *", () => {
  const L = require(`${__hooks}/lib.js`);
  L.completeExpired($app);
});

onBootstrap((e) => {
  e.next();
  try {
    e.app
      .db()
      .newQuery(
        // Must match the index that is actually in production, which also excludes
        // excluded members — otherwise a rebuilt-from-scratch server would quietly
        // get a stricter index and start refusing new owners of a sold flat.
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_voter_apartment ON group_members (`group`, apartment) WHERE is_observer = 0 AND is_frozen = 0 AND apartment != ''",
      )
      .execute();
  } catch (er) {}
  // Backfill quorum snapshots for active votings created before snapshots existed
  // (or saved as 0), so the live-count fallback in completeExpired can't let a
  // mid-vote exclusion shrink the denominator and flip the result.
  try {
    const L = require(`${__hooks}/lib.js`);
    const act = e.app.findRecordsByFilter(
      "votings",
      "status = 'active'",
      "",
      0,
      0,
      {},
    );
    for (const v of act) {
      if (v.get("voter_snapshot")) continue;
      const n = L.activeVoters(e.app, v.get("group"));
      if (n > 0) {
        v.set("voter_snapshot", n);
        e.app.save(v);
      }
    }
  } catch (er) {}
});
