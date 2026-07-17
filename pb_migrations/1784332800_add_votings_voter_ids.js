/// <reference path="../pb_data/types.d.ts" />

// Add an immutable electorate snapshot (list of eligible voter IDs) to votings.
// The votings create hook populates it with the active (non-observer, non-frozen)
// members at creation time; the votes create hook only lets those IDs vote, and
// completeExpired uses its length as the quorum denominator. This keeps "who may
// vote" and "the denominator" in lockstep even if roles/freeze change mid-vote.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2443197760") // votings

  collection.fields.addAt(19, new Field({
    "hidden": false,
    "id": "json_voter_ids",
    "maxSize": 0,
    "name": "voter_ids",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2443197760")

  collection.fields.removeById("json_voter_ids")

  return app.save(collection)
})
