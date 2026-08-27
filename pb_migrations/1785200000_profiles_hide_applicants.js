/// <reference path="../pb_data/types.d.ts" />

// While a join request was pending, the third branch of profiles.listRule/viewRule
// opened the applicant's whole profile — name, phone, address — to EVERY resident of
// the house, not just the admin who has to decide on it. The product deliberately
// hides the occupant's name in the other direction (submit-join answers "flat taken"
// without saying by whom), so this was the same information leaking the other way.
//
// The admin now reads pending applications through /api/spilka/group-requests, which
// checks that the caller really is the admin of that group.
migrate(
  (app) => {
    const c = app.findCollectionByNameOrId("profiles");
    const rule =
      '@request.auth.id != "" && (user = @request.auth.id || ' +
      "(@collection.group_members.group ?= user.group_members_via_user.group && " +
      "@collection.group_members.user ?= @request.auth.id))";
    c.listRule = rule;
    c.viewRule = rule;
    app.save(c);
  },
  (app) => {
    const c = app.findCollectionByNameOrId("profiles");
    const rule =
      '@request.auth.id != "" && (user = @request.auth.id || ' +
      "(@collection.group_members.group ?= user.group_members_via_user.group && " +
      "@collection.group_members.user ?= @request.auth.id) || " +
      "(@collection.join_requests.user ?= user && " +
      '@collection.join_requests.status ?= "pending" && ' +
      "@collection.group_members.group ?= @collection.join_requests.group && " +
      "@collection.group_members.user ?= @request.auth.id))";
    c.listRule = rule;
    c.viewRule = rule;
    app.save(c);
  },
);
