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
  // Freeze the quorum denominator at creation so later exclusions can't change THIS voting.
  e.record.set("voter_snapshot", L.activeVoters(e.app, gid));
  if (e.record.get("type") === "freeze") {
    if (m.get("role") !== "admin") throw new BadRequestError("only_admin_can_freeze");
    e.record.set("ends_at", new Date(Date.now() + 5 * 86400000).toISOString()); // fixed 5-day objection window
  }
  if (e.record.get("type") === "admin-change") {
    // An admin must be a voting member: promoting an observer would violate
    // the admin_cannot_be_observer invariant enforced everywhere else.
    const tm = L.membership(e.app, gid, e.record.get("target_member"));
    if (!tm) throw new BadRequestError("target_not_member");
    if (tm.get("is_observer")) throw new BadRequestError("observer_cannot_be_admin");
  }
  e.next();
}, "votings");
onRecordAfterCreateSuccess((e) => {
  try {
    const L = require(`${__hooks}/lib.js`);
    const gid = e.record.get("group");
    if (e.record.get("type") === "freeze") {
      L.notifyGroup(e.app, gid, null, "freeze_proposal",
        "Пропозиція виключити з підрахунку: \"" + (e.record.get("title") || "") + "\". У вас 5 днів, щоб натиснути «Не згоден».",
        { group_id: gid, voting_id: e.record.id });
    } else {
      L.notifyGroup(e.app, gid, e.record.get("created_by"), "new_voting",
        "Нове голосування: " + (e.record.get("title") || ""),
        { group_id: gid, voting_id: e.record.id });
    }
  } catch (er) {}
  e.next();
}, "votings");
onRecordCreateRequest((e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) throw new BadRequestError("not_authenticated");
  e.record.set("user", e.auth.id);
  let v; try { v = e.app.findRecordById("votings", e.record.get("voting")); } catch (er) { throw new BadRequestError("voting_not_found"); }
  if (v.get("status") !== "active") throw new BadRequestError("voting_not_active");
  const m = L.membership(e.app, v.get("group"), e.auth.id);
  if (!m) throw new BadRequestError("not_member");
  if (m.get("is_observer")) throw new BadRequestError("observer_cannot_vote");
  if (m.get("is_frozen")) throw new BadRequestError("frozen_cannot_vote");
  // Electorate integrity: only members who existed when the voting was created may vote,
  // so the set of eligible voters matches the quorum snapshot taken at creation. Without
  // this, an admin could approve new members mid-vote to push a result past a frozen (lower)
  // denominator.
  if (m.getString("created") > v.getString("created")) throw new BadRequestError("joined_after_voting_started");
  // Friendly duplicate check; the idx_vote_unique index remains the hard guarantee.
  if (e.app.findRecordsByFilter("votes", "voting = {:v} && user = {:u}", "", 1, 0, { v: v.id, u: e.auth.id }).length) throw new BadRequestError("already_voted");
  e.next();
}, "votes");
onRecordCreateRequest((e) => { if (e.auth) e.record.set("user", e.auth.id); e.next(); }, "feedback");

onRecordUpdateRequest((e) => {
  if (e.auth && e.auth.collection().name === "_superusers") { e.next(); return; }
  const L = require(`${__hooks}/lib.js`);
  const orig = e.app.findRecordById("votings", e.record.id);
  if (orig.get("status") !== "active" || e.record.get("status") !== "deleted") throw new BadRequestError("only_active_to_deleted_allowed");
  if (e.record.getString("result") || e.record.getString("completed_at")) throw new BadRequestError("cannot_set_result");
  // Only the author or a group admin may cancel a voting.
  const uid = e.auth ? e.auth.id : "";
  if (uid !== orig.get("created_by") && !L.isAdmin(e.app, orig.get("group"), uid)) throw new BadRequestError("not_allowed_to_delete");
  e.next();
}, "votings");

// ===== RPC routes =====
routerAdd("POST", "/api/spilka/create-group", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body; const name = (b.name || "").trim();
  if (!name) return e.json(400, { error: "name_required" });
  let out = null;
  e.app.runInTransaction((tx) => {
    const code = L.genCode(tx);
    const g = new Record(tx.findCollectionByNameOrId("groups"));
    g.set("name", name); g.set("description", b.description || ""); g.set("group_code", code); g.set("created_by", auth.id);
    tx.save(g);
    const m = new Record(tx.findCollectionByNameOrId("group_members"));
    m.set("group", g.id); m.set("user", auth.id); m.set("role", "admin"); m.set("is_observer", false);
    try { const p = tx.findFirstRecordByFilter("profiles", "user = {:u}", { u: auth.id }); m.set("apartment", p.get("apartment") || ""); } catch (er) {}
    tx.save(m);
    out = { id: g.id, name: g.get("name"), group_code: g.get("group_code") };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/find-group", (e) => {
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const code = (e.requestInfo().body.code || "").trim();
  try { const g = e.app.findFirstRecordByFilter("groups", "group_code = {:c}", { c: code });
    return e.json(200, { data: { id: g.id, name: g.get("name"), group_code: g.get("group_code") } });
  } catch (er) { return e.json(200, { data: null }); }
});

routerAdd("POST", "/api/spilka/my-groups", (e) => {
  const auth = e.auth; if (!auth) return e.json(401, { error: "not_authenticated" });
  const mine = e.app.findRecordsByFilter("group_members", "user = {:u}", "", 0, 0, { u: auth.id });
  const data = [];
  for (const m of mine) {
    const gid = m.get("group");
    let g; try { g = e.app.findRecordById("groups", gid); } catch (er) { continue; }
    const members = e.app.findRecordsByFilter("group_members", "group = {:g}", "", 0, 0, { g: gid });
    const active = e.app.findRecordsByFilter("votings", "group = {:g} && status = 'active'", "", 0, 0, { g: gid });
    const total = e.app.findRecordsByFilter("votings", "group = {:g} && status != 'deleted'", "", 0, 0, { g: gid });
    data.push({ group_id: gid, name: g.get("name"), description: g.get("description"), group_code: g.get("group_code"),
      created_by: g.get("created_by"), role: m.get("role"), is_observer: !!m.get("is_observer"), apartment: m.get("apartment") || "",
      members_count: members.length, active_votings_count: active.length, total_votings_count: total.length });
  }
  return e.json(200, { data: data });
});

routerAdd("POST", "/api/spilka/voter-count", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const gid = e.requestInfo().body.group_id;
  if (!L.membership(e.app, gid, e.auth.id)) return e.json(403, { error: "not_member" });
  return e.json(200, { data: L.activeVoters(e.app, gid) });
});

routerAdd("POST", "/api/spilka/voting-results", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const ids = e.requestInfo().body.voting_ids || []; const data = [];
  for (const vid of ids) {
    let vt; try { vt = e.app.findRecordById("votings", vid); } catch (er) { continue; }
    if (!L.membership(e.app, vt.get("group"), e.auth.id)) continue;
    // Do not leak a running tally of an ACTIVE secret ballot — it could sway voters.
    // Counts become available once the secret voting is completed (for the protocol).
    if (vt.get("type") === "secret" && vt.get("status") === "active") continue;
    const yes = e.app.findRecordsByFilter("votes", "voting = {:v} && choice = 'yes'", "", 0, 0, { v: vid }).length;
    const no = e.app.findRecordsByFilter("votes", "voting = {:v} && choice = 'no'", "", 0, 0, { v: vid }).length;
    const ab = e.app.findRecordsByFilter("votes", "voting = {:v} && choice = 'abstain'", "", 0, 0, { v: vid }).length;
    data.push({ voting_id: vid, yes_votes: yes, no_votes: no, abstain_votes: ab, total_votes: yes + no + ab });
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
  let vt; try { vt = e.app.findRecordById("votings", vid); } catch (er) { return e.json(400, { error: "voting_not_found" }); }
  if (!L.membership(e.app, vt.get("group"), e.auth.id)) return e.json(403, { error: "not_member" });
  const secret = vt.get("type") === "secret";
  const filter = secret ? "voting = {:v} && user = {:u}" : "voting = {:v}";
  const rows = e.app.findRecordsByFilter("votes", filter, "created", 0, 0, { v: vid, u: e.auth.id });
  const data = rows.map((r) => {
    const uid = r.get("user"); let fn = "", ln = "", apt = "";
    try { const p = e.app.findFirstRecordByFilter("profiles", "user = {:u}", { u: uid }); fn = p.get("first_name") || ""; ln = p.get("last_name") || ""; apt = p.get("apartment") || ""; } catch (er) {}
    return { id: r.id, user_id: uid, choice: r.get("choice"), comment: secret ? "" : (r.get("comment") || ""), created: r.getString("created"), first_name: fn, last_name: ln, apartment: apt };
  });
  return e.json(200, { data: data });
});

routerAdd("POST", "/api/spilka/member-votes", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const gid = e.requestInfo().body.group_id;
  if (!L.membership(e.app, gid, e.auth.id)) return e.json(403, { error: "not_member" });
  const votings = e.app.findRecordsByFilter("votings", "group = {:g} && status != 'deleted'", "", 0, 0, { g: gid });
  const counts = {};
  for (const v of votings) {
    // While a secret ballot is ACTIVE, per-member turnout ("Ivanov already voted,
    // Petrov didn't") is itself sensitive — count it only after completion.
    if (v.get("type") === "secret" && v.get("status") === "active") continue;
    const vts = e.app.findRecordsByFilter("votes", "voting = {:v}", "", 0, 0, { v: v.id });
    for (const vt of vts) { const u = vt.get("user"); counts[u] = (counts[u] || 0) + 1; } }
  return e.json(200, { data: Object.keys(counts).map((u) => ({ user_id: u, voted_count: counts[u] })) });
});

routerAdd("POST", "/api/spilka/submit-join", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body; const gid = b.group_id, apt = (b.apartment || "").trim(), asObs = !!b.as_observer;
  if (!apt) return e.json(400, { error: "apartment_required" });
  if (L.membership(e.app, gid, auth.id)) return e.json(400, { error: "already_member" });
  if (e.app.findRecordsByFilter("join_requests", "group = {:g} && user = {:u} && status = 'pending'", "", 0, 0, { g: gid, u: auth.id }).length) return e.json(400, { error: "already_pending" });
  // Do NOT leak the occupant's real name to a non-member submitting a join request.
  if (!asObs) { const c = e.app.findRecordsByFilter("group_members", "group = {:g} && is_observer = false && apartment = {:a}", "", 0, 1, { g: gid, a: apt });
    if (c.length) return e.json(400, { error: "apartment_taken" }); }
  let rid = null;
  e.app.runInTransaction((tx) => {
    const r = new Record(tx.findCollectionByNameOrId("join_requests"));
    r.set("group", gid); r.set("user", auth.id); r.set("apartment", apt); r.set("requested_as_observer", asObs); r.set("is_role_change", false); r.set("status", "pending");
    tx.save(r); rid = r.id;
    const adm = L.adminOf(tx, gid);
    if (adm) { let gn = ""; try { gn = tx.findRecordById("groups", gid).get("name"); } catch (er) {}
      L.notify(tx, adm.get("user"), "join_request", L.fullName(tx, auth.id) + ' хоче приєднатися до "' + gn + '" (кв.' + apt + (asObs ? ", спостерігач)" : ", голосуючий)"), { group_id: gid, request_id: rid, requester_id: auth.id, apartment: apt, as_observer: asObs }); }
  });
  return e.json(200, { data: rid });
});

routerAdd("POST", "/api/spilka/request-role-change", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body; const gid = b.group_id, becomeObs = !!b.become_observer;
  const m = L.membership(e.app, gid, auth.id);
  if (!m) return e.json(400, { error: "not_member" });
  if (!!m.get("is_observer") === becomeObs) return e.json(400, { error: "already_in_role" });
  const apt = m.get("apartment") || "";
  if (!apt) return e.json(400, { error: "apartment_missing_on_membership" });
  if (m.get("role") === "admin" && becomeObs) return e.json(400, { error: "admin_cannot_be_observer" });
  if (e.app.findRecordsByFilter("join_requests", "group = {:g} && user = {:u} && status = 'pending'", "", 0, 0, { g: gid, u: auth.id }).length) return e.json(400, { error: "already_pending" });
  if (!becomeObs) { const c = e.app.findRecordsByFilter("group_members", "group = {:g} && is_observer = false && apartment = {:a} && user != {:u}", "", 0, 1, { g: gid, a: apt, u: auth.id });
    if (c.length) return e.json(400, { error: "apartment_taken" }); }
  let rid = null;
  e.app.runInTransaction((tx) => {
    const r = new Record(tx.findCollectionByNameOrId("join_requests"));
    r.set("group", gid); r.set("user", auth.id); r.set("apartment", apt); r.set("requested_as_observer", becomeObs); r.set("is_role_change", true); r.set("status", "pending");
    tx.save(r); rid = r.id;
    const adm = L.adminOf(tx, gid);
    if (adm && adm.get("user") !== auth.id) L.notify(tx, adm.get("user"), "role_change_request", L.fullName(tx, auth.id) + " просить змінити роль (кв." + apt + " → " + (becomeObs ? "спостерігач)" : "голосуючий)"), { group_id: gid, request_id: rid, is_role_change: true, as_observer: becomeObs });
  });
  return e.json(200, { data: rid });
});

routerAdd("POST", "/api/spilka/approve-join", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body; const rid = b.request_id, force = !!b.force_observer;
  let req; try { req = e.app.findRecordById("join_requests", rid); } catch (er) { return e.json(400, { error: "request_not_found" }); }
  if (req.get("status") !== "pending") return e.json(400, { error: "request_not_found" });
  if (!L.isAdmin(e.app, req.get("group"), auth.id)) return e.json(403, { error: "not_admin" });
  const finalObs = !!req.get("requested_as_observer") || force; const apt = req.get("apartment") || "";
  if (!finalObs && apt) { const taken = e.app.findRecordsByFilter("group_members", "group = {:g} && is_observer = false && apartment = {:a} && user != {:u}", "", 0, 1, { g: req.get("group"), a: apt, u: req.get("user") });
    if (taken.length) return e.json(400, { error: "apartment_taken_now" }); }
  e.app.runInTransaction((tx) => {
    req.set("status", "approved"); req.set("resolved_at", new Date().toISOString()); req.set("resolved_by", auth.id); tx.save(req);
    if (req.get("is_role_change")) { const m = L.membership(tx, req.get("group"), req.get("user")); if (m) { m.set("is_observer", finalObs); tx.save(m); } }
    else {
      if (apt) { const ghosts = tx.findRecordsByFilter("group_members", "group = {:g} && is_frozen = true && apartment = {:a}", "", 0, 0, { g: req.get("group"), a: apt }); for (const gh of ghosts) tx.delete(gh); }
      const m = new Record(tx.findCollectionByNameOrId("group_members"));
      m.set("group", req.get("group")); m.set("user", req.get("user")); m.set("role", "member"); m.set("is_observer", finalObs); m.set("apartment", apt); tx.save(m); }
    L.notify(tx, req.get("user"), req.get("is_role_change") ? "role_change_approved" : "join_approved",
      req.get("is_role_change") ? ("Зміну ролі затверджено: ви тепер " + (finalObs ? "спостерігач" : "голосуючий")) : ("Заявку на приєднання прийнято" + (finalObs && !req.get("requested_as_observer") ? " (як спостерігач — кв. зайнята)" : "")),
      { group_id: req.get("group"), as_observer: finalObs });
  });
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/reject-join", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const rid = e.requestInfo().body.request_id;
  let req; try { req = e.app.findRecordById("join_requests", rid); } catch (er) { return e.json(400, { error: "request_not_found" }); }
  if (req.get("status") !== "pending") return e.json(400, { error: "request_not_found" });
  if (!L.isAdmin(e.app, req.get("group"), auth.id)) return e.json(403, { error: "not_admin" });
  req.set("status", "rejected"); req.set("resolved_at", new Date().toISOString()); req.set("resolved_by", auth.id); e.app.save(req);
  L.notify(e.app, req.get("user"), "join_rejected", "Заявку на приєднання відхилено", { group_id: req.get("group") });
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/admin-change-role", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body; const gid = b.group_id, targetUid = b.user_id, makeObs = !!b.make_observer;
  if (!L.isAdmin(e.app, gid, auth.id)) return e.json(403, { error: "not_admin" });
  const m = L.membership(e.app, gid, targetUid); if (!m) return e.json(400, { error: "not_member" });
  if (!makeObs) { const apt = m.get("apartment") || "";
    if (apt) { const taken = e.app.findRecordsByFilter("group_members", "group = {:g} && is_observer = false && apartment = {:a} && user != {:u}", "", 0, 1, { g: gid, a: apt, u: targetUid });
      if (taken.length) return e.json(400, { error: "apartment_taken:" + L.fullName(e.app, taken[0].get("user")) }); } }
  m.set("is_observer", makeObs); e.app.save(m);
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/leave-group", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  const m = L.membership(e.app, e.requestInfo().body.group_id, auth.id);
  if (!m) return e.json(400, { error: "not_member" });
  if (m.get("role") === "admin") return e.json(400, { error: "admin_must_transfer_first" });
  e.app.delete(m); return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/broadcast", (e) => {
  const L = require(`${__hooks}/lib.js`); const auth = e.auth;
  if (!auth) return e.json(401, { error: "not_authenticated" });
  if (!L.isAppAdmin(auth)) return e.json(403, { error: "not_admin" });
  const b = e.requestInfo().body; const uids = b.user_ids || [], text = (b.text || "").trim();
  if (!text) return e.json(400, { error: "text_required" });
  let n = 0; for (const uid of uids) { L.notify(e.app, uid, "admin_message", text, { from: "admin" }); n++; }
  return e.json(200, { data: n });
});

routerAdd("POST", "/api/spilka/complete-expired", (e) => {
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const L = require(`${__hooks}/lib.js`); L.completeExpired(e.app); return e.json(200, { data: true });
});

// ===== Admin / feedback =====
onRecordAfterCreateSuccess((e) => {
  try {
    const L = require(`${__hooks}/lib.js`);
    const adm = L.adminUser(e.app);
    if (adm) L.notify(e.app, adm.id, "new_feedback", "Новий відгук: " + (e.record.get("text") || "").slice(0, 80), { feedback_id: e.record.id });
  } catch (er) {}
  e.next();
}, "feedback");

routerAdd("POST", "/api/spilka/admin-stats", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d1 = new Date(now - 86400000).toISOString();
  const c = (col, f, prm) => L.cnt(e.app, col, f, prm);
  return e.json(200, { data: {
    users_total: c("users"), users_completed: c("profiles", "profile_completed = true"),
    users_last_7d: c("users", "created >= {:d}", { d: d7 }), users_last_24h: c("users", "created >= {:d}", { d: d1 }),
    groups_total: c("groups"), groups_last_7d: c("groups", "created >= {:d}", { d: d7 }),
    memberships_total: c("group_members"),
    votings_total: c("votings", "status != 'deleted'"), votings_active: c("votings", "status = 'active'"),
    votings_completed: c("votings", "status = 'completed'"), votings_accepted: c("votings", "result = 'accepted'"),
    votings_rejected: c("votings", "result = 'rejected'"), votes_total: c("votes"),
    feedback_total: c("feedback"), feedback_new: c("feedback", "status = 'new'")
  } });
});

routerAdd("POST", "/api/spilka/admin-users", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const users = e.app.findRecordsByFilter("users", "id != ''", "-created", 30, 0, {});
  const out = users.map((u) => {
    let p = null; try { p = e.app.findFirstRecordByFilter("profiles", "user = {:u}", { u: u.id }); } catch (er) {}
    let gc = 0; try { gc = e.app.findRecordsByFilter("group_members", "user = {:u}", "", 0, 0, { u: u.id }).length; } catch (er) {}
    return { id: u.id, email: u.get("email"), first_name: p ? p.get("first_name") : "", last_name: p ? p.get("last_name") : "",
      profile_completed: p ? !!p.get("profile_completed") : false, groups_count: gc, created_at: u.getString("created") };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/admin-groups", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const groups = e.app.findRecordsByFilter("groups", "id != ''", "-created", 30, 0, {});
  const out = groups.map((g) => {
    let mc = 0, vc = 0, cem = "";
    try { mc = e.app.findRecordsByFilter("group_members", "group = {:g}", "", 0, 0, { g: g.id }).length; } catch (er) {}
    try { vc = e.app.findRecordsByFilter("votings", "group = {:g} && status != 'deleted'", "", 0, 0, { g: g.id }).length; } catch (er) {}
    try { cem = e.app.findRecordById("users", g.get("created_by")).get("email"); } catch (er) {}
    return { id: g.id, name: g.get("name"), group_code: g.get("group_code"), members_count: mc, votings_count: vc, creator_email: cem, created_at: g.getString("created") };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/admin-feedback", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const fb = e.app.findRecordsByFilter("feedback", "id != ''", "-created", 100, 0, {});
  const out = fb.map((f) => {
    let nm = "", em = "";
    try { const p = e.app.findFirstRecordByFilter("profiles", "user = {:u}", { u: f.get("user") }); nm = ((p.get("first_name") || "") + " " + (p.get("last_name") || "")).trim(); } catch (er) {}
    try { em = e.app.findRecordById("users", f.get("user")).get("email"); } catch (er) {}
    return { id: f.id, text: f.get("text"), status: f.get("status"), reply: f.get("reply") || "", replied_at: f.getString("replied_at") || null,
      user_name: nm, user_email: em, user_id: f.get("user"), created_at: f.getString("created") };
  });
  return e.json(200, { data: out });
});

routerAdd("POST", "/api/spilka/feedback-status", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const b = e.requestInfo().body;
  let f; try { f = e.app.findRecordById("feedback", b.feedback_id); } catch (er) { return e.json(400, { error: "not_found" }); }
  f.set("status", b.status); e.app.save(f);
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/reply-feedback", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!L.isAppAdmin(e.auth)) return e.json(403, { error: "not_admin" });
  const b = e.requestInfo().body; const fid = b.feedback_id; const reply = (b.reply || "").trim();
  if (!reply) return e.json(400, { error: "reply_required" });
  let f; try { f = e.app.findRecordById("feedback", fid); } catch (er) { return e.json(400, { error: "feedback_not_found" }); }
  e.app.runInTransaction((tx) => {
    const fresh = tx.findRecordById("feedback", fid);
    fresh.set("reply", reply); fresh.set("replied_at", new Date().toISOString()); fresh.set("status", "done");
    tx.save(fresh);
    L.notify(tx, fresh.get("user"), "feedback_reply", "Відповідь на ваше звернення: " + reply, { feedback_id: fid });
  });
  return e.json(200, { data: true });
});

// freeze_targets: only the freeze author may add real non-admin members as targets
onRecordCreateRequest((e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) throw new BadRequestError("not_authenticated");
  let v; try { v = e.app.findRecordById("votings", e.record.get("voting")); } catch (er) { throw new BadRequestError("voting_not_found"); }
  if (v.get("type") !== "freeze" || v.get("status") !== "active") throw new BadRequestError("not_active_freeze");
  if (v.get("created_by") !== e.auth.id) throw new BadRequestError("not_proposer");
  const tm = L.membership(e.app, v.get("group"), e.record.get("user"));
  if (!tm) throw new BadRequestError("target_not_member");
  if (tm.get("role") === "admin") throw new BadRequestError("cannot_target_admin");
  // Anti-harassment: no two concurrent active proposals for the same member.
  const dupes = e.app.findRecordsByFilter("freeze_targets", "user = {:u} && voting != {:v} && voting.type = 'freeze' && voting.status = 'active' && voting.group = {:g}", "", 1, 0, { u: e.record.get("user"), v: v.id, g: v.get("group") });
  if (dupes.length) throw new BadRequestError("already_proposed");
  e.next();
}, "freeze_targets");

// ===== Freeze (exclude-from-count) =====
onRecordCreateRequest((e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) throw new BadRequestError("not_authenticated");
  e.record.set("user", e.auth.id);
  let v; try { v = e.app.findRecordById("votings", e.record.get("voting")); } catch (er) { throw new BadRequestError("voting_not_found"); }
  if (v.get("type") !== "freeze" || v.get("status") !== "active") throw new BadRequestError("not_active_freeze");
  if (!L.membership(e.app, v.get("group"), e.auth.id)) throw new BadRequestError("not_member");
  e.next();
}, "freeze_objections");

onRecordAfterCreateSuccess((e) => {
  try {
    const L = require(`${__hooks}/lib.js`);
    const v = e.app.findRecordById("votings", e.record.get("voting"));
    if (v.get("status") !== "active") { e.next(); return; }
    const gid = v.get("group"); const uid = e.record.get("user");
    const isTarget = e.app.findRecordsByFilter("freeze_targets", "voting = {:v} && user = {:u}", "", 1, 0, { v: v.id, u: uid }).length > 0;
    // The target objecting = proof they are present -> instant cancel. Otherwise need 2 distinct.
    if (isTarget || L.distinctObjections(e.app, v.id) >= 2) {
      v.set("status", "completed"); v.set("result", "rejected"); v.set("completed_at", new Date().toISOString()); e.app.save(v);
      const adm = L.adminOf(e.app, gid); if (adm) L.notify(e.app, adm.get("user"), "freeze_result", "Виключення скасовано: учасники заперечили", { group_id: gid, voting_id: v.id });
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
    m.set("is_frozen", false); m.set("frozen_until", ""); e.app.save(m);
    const h = new Record(e.app.findCollectionByNameOrId("group_history"));
    h.set("group", m.get("group")); h.set("action", "member_self_restored"); h.set("details", { user: e.auth.id }); e.app.save(h);
  }
  return e.json(200, { data: true });
});

routerAdd("POST", "/api/spilka/set-frozen", (e) => {
  const L = require(`${__hooks}/lib.js`);
  if (!e.auth) return e.json(401, { error: "not_authenticated" });
  const b = e.requestInfo().body; const gid = b.group_id, targetUid = b.user_id, frozen = !!b.frozen;
  // Exclusion is ONLY possible through a freeze voting (5-day objection window,
  // instant-cancel, ≥2-active floor guard). This route is restore-only, otherwise
  // an admin could bypass every safeguard with one direct request.
  if (frozen) return e.json(400, { error: "exclusion_only_via_voting" });
  if (!L.isAdmin(e.app, gid, e.auth.id)) return e.json(403, { error: "not_admin" });
  const m = L.membership(e.app, gid, targetUid); if (!m) return e.json(400, { error: "not_member" });
  if (m.get("is_frozen")) {
    m.set("is_frozen", false); m.set("frozen_until", ""); e.app.save(m);
    const h = new Record(e.app.findCollectionByNameOrId("group_history"));
    h.set("group", gid); h.set("action", "member_restored"); h.set("details", { user: targetUid, by: "admin" }); e.app.save(h);
  }
  return e.json(200, { data: true });
});

cronAdd("complete_expired", "* * * * *", () => { const L = require(`${__hooks}/lib.js`); L.completeExpired($app); });

onBootstrap((e) => {
  e.next();
  try { e.app.db().newQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_voter_apartment ON group_members (`group`, apartment) WHERE is_observer = 0 AND apartment != ''").execute(); } catch (er) {}
  // Backfill quorum snapshots for active votings created before snapshots existed
  // (or saved as 0), so the live-count fallback in completeExpired can't let a
  // mid-vote exclusion shrink the denominator and flip the result.
  try {
    const L = require(`${__hooks}/lib.js`);
    const act = e.app.findRecordsByFilter("votings", "status = 'active'", "", 0, 0, {});
    for (const v of act) {
      if (v.get("voter_snapshot")) continue;
      const n = L.activeVoters(e.app, v.get("group"));
      if (n > 0) { v.set("voter_snapshot", n); e.app.save(v); }
    }
  } catch (er) {}
});
