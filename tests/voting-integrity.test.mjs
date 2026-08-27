// Regression tests for the things that decide a vote: who may vote, what the
// quorum denominator is, and what a cancelled voting may turn into.
//
// Every test here was written because the corresponding defect actually shipped.
// They run the real pb_hooks against a real PocketBase, so they fail when the
// hooks are wrong — not when a mock is wrong.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startPocketBase, api, tryApi, makeUser } from "./harness.mjs";

let pb, base;
let admin, alice, bob, carol;
let groupId;

before(async () => {
  pb = await startPocketBase();
  base = pb.base;

  admin = await makeUser(base, pb.adminToken, "admin@test.local");
  alice = await makeUser(base, pb.adminToken, "alice@test.local");
  bob = await makeUser(base, pb.adminToken, "bob@test.local");
  carol = await makeUser(base, pb.adminToken, "carol@test.local");

  // admin creates the house group; the route makes them group admin
  const g = await api(
    base,
    "POST",
    "/api/spilka/create-group",
    { name: "вул. Тестова 1", description: "test house" },
    admin.token,
  );
  groupId = g.data.id;

  // three more residents join as voting members, each in their own flat
  for (const [u, apt] of [
    [alice, "1"],
    [bob, "2"],
    [carol, "3"],
  ]) {
    const r = await api(
      base,
      "POST",
      "/api/spilka/submit-join",
      { group_id: groupId, apartment: apt, as_observer: false },
      u.token,
    );
    await api(
      base,
      "POST",
      "/api/spilka/approve-join",
      { request_id: r.data },
      admin.token,
    );
  }
});

after(async () => {
  await pb?.stop();
});

async function createVoting(token, overrides = {}) {
  const endsAt = new Date(Date.now() + 3600_000).toISOString();
  return api(
    base,
    "POST",
    "/api/collections/votings/records",
    {
      group: groupId,
      title: "Ремонт даху",
      description: "",
      type: "simple",
      status: "active",
      ends_at: endsAt,
      ...overrides,
    },
    token,
  );
}

// Push a voting past its deadline. ends_at now has a server-side floor (a date in
// the past used to let anyone close a voting before people could open it), so a
// test cannot simply ask for a two-second window; it moves the deadline as
// superuser, which is the one caller the update hook lets through.
async function expire(votingId) {
  await api(
    base,
    "PATCH",
    `/api/collections/votings/records/${votingId}`,
    { ends_at: new Date(Date.now() - 60_000).toISOString() },
    pb.adminToken,
  );
  await api(base, "POST", "/api/spilka/complete-expired", {}, admin.token);
}

describe("electorate snapshot", () => {
  test("an eligible member can actually cast a vote", async () => {
    // The defect this guards: voter_ids is a json field, and a json field read
    // inside a JS hook arrives as a BYTE array, not an array of ids. Comparing
    // roll[i] === auth.id then compares a number to a string — always false —
    // so every member was rejected with not_in_electorate and no vote could be
    // cast at all. Shipped 2026-07-18, found 2026-08-26.
    const v = await createVoting(admin.token);
    const res = await tryApi(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes", comment: "" },
      alice.token,
    );
    assert.equal(
      res.status,
      200,
      `an eligible member was refused: ${JSON.stringify(res.body)}`,
    );
  });

  test("voter_ids holds the ids of eligible voters, not raw bytes", async () => {
    const v = await createVoting(admin.token);
    const fresh = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.ok(Array.isArray(fresh.voter_ids), "voter_ids should be an array");
    assert.equal(fresh.voter_ids.length, 4, "four voting members exist");
    for (const id of fresh.voter_ids) {
      assert.equal(typeof id, "string", "each entry should be a record id");
      assert.match(id, /^[a-z0-9]{15}$/);
    }
  });

  test("a member who joined after the start cannot vote", async () => {
    const v = await createVoting(admin.token);
    const dave = await makeUser(
      base,
      pb.adminToken,
      `dave${Date.now()}@test.local`,
    );
    const r = await api(
      base,
      "POST",
      "/api/spilka/submit-join",
      {
        group_id: groupId,
        apartment: `9${Date.now() % 100}`,
        as_observer: false,
      },
      dave.token,
    );
    await api(
      base,
      "POST",
      "/api/spilka/approve-join",
      { request_id: r.data },
      admin.token,
    );

    const res = await tryApi(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes" },
      dave.token,
    );
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /not_in_electorate|joined_after/i);
  });

  test("a member cannot vote twice", async () => {
    const v = await createVoting(admin.token);
    const first = await tryApi(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes" },
      bob.token,
    );
    assert.equal(first.status, 200);
    const second = await tryApi(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "no" },
      bob.token,
    );
    assert.notEqual(second.status, 200, "the second vote must be refused");
  });
});

describe("quorum", () => {
  test("a majority of the eligible electorate is accepted", async () => {
    // 4 eligible voters -> 3 yes votes must pass. With the byte-array defect the
    // denominator was the JSON text length (73), so this could never pass.
    const v = await createVoting(admin.token, { title: "Кворум ЗА" });
    for (const u of [admin, alice, bob]) {
      await api(
        base,
        "POST",
        "/api/collections/votes/records",
        { voting: v.id, choice: "yes" },
        u.token,
      );
    }
    await expire(v.id);

    const done = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(done.status, "completed");
    assert.equal(done.result, "accepted", "3 of 4 in favour must be accepted");
  });

  test("half the electorate in favour is not enough", async () => {
    const v = await createVoting(admin.token, { title: "Кворум ПОРІВНУ" });
    for (const u of [admin, alice]) {
      await api(
        base,
        "POST",
        "/api/collections/votes/records",
        { voting: v.id, choice: "yes" },
        u.token,
      );
    }
    await expire(v.id);

    const done = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(done.result, "rejected", "2 of 4 is not a majority");
  });
});

describe("a cancelled voting cannot be rewritten", () => {
  test("cancelling must not be able to change the voting type", async () => {
    // The defect this guards: the update hook only compared status/result/
    // completed_at, so `{"status":"deleted","type":"simple"}` turned a secret
    // ballot into an open one, and /voting-ballots then handed out who voted
    // how, by name and flat number.
    const v = await createVoting(admin.token, {
      type: "secret",
      title: "Таємне",
    });
    await api(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "no" },
      alice.token,
    );

    await tryApi(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { status: "deleted", type: "simple" },
      admin.token,
    );

    const after = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      after.type,
      "secret",
      "the ballot type must survive a cancellation",
    );

    const ballots = await api(
      base,
      "POST",
      "/api/spilka/voting-ballots",
      { voting_id: v.id },
      admin.token,
    );
    const others = ballots.data.filter((b) => b.user_id !== admin.id);
    assert.equal(
      others.length,
      0,
      "a secret ballot must never list other people's votes",
    );
  });

  test("a voting cannot be created already completed and accepted", async () => {
    const res = await tryApi(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Підроблене рішення",
        type: "simple",
        status: "completed",
        result: "accepted",
        completed_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      alice.token,
    );

    if (res.status === 200) {
      assert.equal(res.body.status, "active", "a new voting must start active");
      assert.ok(!res.body.result, "a new voting must have no result");
    }
  });
});

describe("record ownership", () => {
  test("a profile cannot be re-pointed at another user", async () => {
    // The defect this guards: PocketBase evaluates updateRule against the record
    // as it was BEFORE the change, so `user = @request.auth.id` let anyone move
    // their own row into somebody else's name — and profiles.deleteRule is null,
    // so the victim could not undo it.
    const mine = await api(
      base,
      "POST",
      "/api/collections/profiles/records",
      {
        user: alice.id,
        first_name: "Аліса",
        last_name: "Тест",
        apartment: "1",
        profile_completed: true,
      },
      alice.token,
    );

    const res = await tryApi(
      base,
      "PATCH",
      `/api/collections/profiles/records/${mine.id}`,
      { user: carol.id, first_name: "Підробка" },
      alice.token,
    );

    const after = await api(
      base,
      "GET",
      `/api/collections/profiles/records/${mine.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      after.user,
      alice.id,
      `profile owner changed to another user (PATCH returned ${res.status})`,
    );
  });

  test("a notification cannot be pushed into another user's inbox", async () => {
    const mine = await api(
      base,
      "GET",
      `/api/collections/notifications/records?filter=${encodeURIComponent(`user="${alice.id}"`)}&perPage=1`,
      undefined,
      pb.adminToken,
    );
    if (!mine.items.length) return; // nothing to rewrite in this run

    const id = mine.items[0].id;
    await tryApi(
      base,
      "PATCH",
      `/api/collections/notifications/records/${id}`,
      { user: carol.id, text: "Адміністратор: підтвердіть квартиру" },
      alice.token,
    );

    const after = await api(
      base,
      "GET",
      `/api/collections/notifications/records/${id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      after.user,
      alice.id,
      "a notification must stay with its owner",
    );
  });
});

describe('exclusion from the count ("dead souls")', () => {
  test("a new owner can join a flat still held by an excluded member", async () => {
    // The whole point of the feature: the flat was sold, the old resident is out
    // of the count, the new owner takes their place. The apartment-taken checks
    // did not exclude frozen members, so the new owner was refused and the ghost
    // stayed in the quorum forever.
    const ghostApt = "77";
    const ghost = await makeUser(
      base,
      pb.adminToken,
      `ghost${Date.now()}@test.local`,
    );
    const r = await api(
      base,
      "POST",
      "/api/spilka/submit-join",
      { group_id: groupId, apartment: ghostApt, as_observer: false },
      ghost.token,
    );
    await api(
      base,
      "POST",
      "/api/spilka/approve-join",
      { request_id: r.data },
      admin.token,
    );

    // mark them excluded the way a freeze voting would
    const gm = await api(
      base,
      "GET",
      `/api/collections/group_members/records?filter=${encodeURIComponent(`group="${groupId}" && user="${ghost.id}"`)}`,
      undefined,
      pb.adminToken,
    );
    await api(
      base,
      "PATCH",
      `/api/collections/group_members/records/${gm.items[0].id}`,
      { is_frozen: true },
      pb.adminToken,
    );

    const newOwner = await makeUser(
      base,
      pb.adminToken,
      `owner${Date.now()}@test.local`,
    );
    const res = await tryApi(
      base,
      "POST",
      "/api/spilka/submit-join",
      { group_id: groupId, apartment: ghostApt, as_observer: false },
      newOwner.token,
    );

    assert.equal(
      res.status,
      200,
      `the new owner of flat ${ghostApt} was refused: ${JSON.stringify(res.body)}`,
    );
  });
});
