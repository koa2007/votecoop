/// <reference path="../pb_data/types.d.ts" />

// Security hardening (2026-07-02):
//  - votes: a member may read ONLY their own vote row. Tallies come from the
//    server route /api/spilka/voting-results and the itemized open-ballot list
//    from /api/spilka/voting-ballots. This makes a SECRET ballot actually secret
//    at the data layer (previously any group member could read every user+choice).
//  - group_history: scope reads to the member's own group (was: any authenticated
//    user could read the history of every group in the system).
migrate((app) => {
  const votes = app.findCollectionByNameOrId("votes");
  votes.listRule = "user = @request.auth.id";
  votes.viewRule = "user = @request.auth.id";
  app.save(votes);

  const gh = app.findCollectionByNameOrId("group_history");
  const scoped = "@request.auth.id != \"\" && @collection.group_members.group ?= group && @collection.group_members.user ?= @request.auth.id";
  gh.listRule = scoped;
  gh.viewRule = scoped;
  app.save(gh);
}, (app) => {
  // down — restore the previous (looser) rules
  const votes = app.findCollectionByNameOrId("votes");
  const prev = "@request.auth.id != \"\" && @collection.group_members.group ?= voting.group && @collection.group_members.user ?= @request.auth.id";
  votes.listRule = prev;
  votes.viewRule = prev;
  app.save(votes);

  const gh = app.findCollectionByNameOrId("group_history");
  gh.listRule = "@request.auth.id != \"\"";
  gh.viewRule = "@request.auth.id != \"\"";
  app.save(gh);
});
