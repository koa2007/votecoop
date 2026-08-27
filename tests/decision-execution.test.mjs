// Regression tests for round 2 of the full audit (2026-08-27).
//
// The theme of every defect below is the same: the house takes a decision, the app
// stamps it "прийнято", a protocol can be printed from it — and the thing the
// residents actually voted for does not happen, or the arithmetic behind it was
// never what the screen showed. None of it is visible from the outside, which is
// why these are tests and not a note in a changelog.
//
// They run the real pb_hooks against a real PocketBase, so they fail when the hooks
// are wrong rather than when a mock is wrong.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startPocketBase, api, tryApi, makeUser } from "./harness.mjs";

let pb, base;
let admin, alice, bob, carol;
let groupId;

before(async () => {
  pb = await startPocketBase();
  base = pb.base;

  admin = await makeUser(
    base,
    pb.adminToken,
    `r2admin${Date.now()}@test.local`,
  );
  alice = await makeUser(
    base,
    pb.adminToken,
    `r2alice${Date.now()}@test.local`,
  );
  bob = await makeUser(base, pb.adminToken, `r2bob${Date.now()}@test.local`);
  carol = await makeUser(
    base,
    pb.adminToken,
    `r2carol${Date.now()}@test.local`,
  );

  const g = await api(
    base,
    "POST",
    "/api/spilka/create-group",
    { name: "вул. Друга Перевірка 2", description: "round two" },
    admin.token,
  );
  groupId = g.data.id;

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
  return api(
    base,
    "POST",
    "/api/collections/votings/records",
    {
      group: groupId,
      title: "Питання",
      type: "simple",
      status: "active",
      ends_at: new Date(Date.now() + 3600_000).toISOString(),
      ...overrides,
    },
    token,
  );
}

// ends_at has a server-side floor, so a test cannot ask for a two-second window.
// The superuser is the one caller the update hook lets move a deadline.
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

async function historyFor(votingId) {
  const rows = await api(
    base,
    "GET",
    `/api/collections/group_history/records?filter=${encodeURIComponent(`voting="${votingId}"`)}&perPage=200`,
    undefined,
    pb.adminToken,
  );
  return rows.items || [];
}

describe("a decision the system cannot carry out leaves a trace", () => {
  test("an admin change whose candidate was demoted mid-vote is recorded as not applied", async () => {
    // The sitting admin used to be able to erase the outcome of a vote to replace
    // him simply by demoting the candidate: applyEffect returned in silence, the
    // voting still read "прийнято", and nothing anywhere said the new chair had not
    // taken office.
    const v = await createVoting(admin.token, {
      title: "Змінити голову",
      type: "admin-change",
      target_member: alice.id,
    });

    await api(
      base,
      "POST",
      "/api/spilka/admin-change-role",
      { group_id: groupId, user_id: alice.id, make_observer: true },
      admin.token,
    );

    for (const u of [admin, bob, carol]) {
      await api(
        base,
        "POST",
        "/api/collections/votes/records",
        { voting: v.id, choice: "yes" },
        u.token,
      );
    }
    await expire(v.id);

    const rows = await historyFor(v.id);
    const notApplied = rows.filter((r) => r.action === "effect_not_applied");
    assert.equal(
      notApplied.length,
      1,
      "a decision that could not be executed must appear in the group history",
    );
    assert.equal(notApplied[0].details.reason, "target_became_observer");
    assert.equal(
      rows.filter((r) => r.action === "admin_change").length,
      0,
      "and it must not claim the admin changed",
    );

    // put the house back the way it was for the tests that follow
    await api(
      base,
      "POST",
      "/api/spilka/admin-change-role",
      { group_id: groupId, user_id: alice.id, make_observer: false },
      admin.token,
    );
  });

  test("a resident cannot walk out of a voting that is about them", async () => {
    // Leaving mid-vote produced the same silent no-op, with no malice involved —
    // one ordinary button. The vote must finish, or the author must withdraw it.
    const v = await createVoting(admin.token, {
      title: "Виключити мешканця",
      type: "remove-member",
      target_member: carol.id,
      removal_reason: "не сплачує внески",
    });

    const res = await tryApi(
      base,
      "POST",
      "/api/spilka/leave-group",
      { group_id: groupId },
      carol.token,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body?.error, "target_of_active_voting");

    await api(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { status: "deleted", deleted_at: new Date().toISOString() },
      admin.token,
    );
  });
});

describe("who may vote is exactly who is counted", () => {
  test("a resident demoted mid-vote can still cast the ballot they are counted for", async () => {
    // The roll is frozen at creation and is the quorum denominator. Layering the
    // live observer flag on top of it let the admin keep three neighbours in the
    // denominator while taking their ballots away — which made any voting to
    // replace him arithmetically unwinnable.
    const v = await createVoting(admin.token, { title: "Склад і права разом" });
    const created = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.ok(
      created.voter_ids.includes(bob.id),
      "bob must be in the roll to begin with",
    );

    await api(
      base,
      "POST",
      "/api/spilka/admin-change-role",
      { group_id: groupId, user_id: bob.id, make_observer: true },
      admin.token,
    );

    const ballot = await tryApi(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes" },
      bob.token,
    );
    assert.equal(
      ballot.status,
      200,
      "someone inside the frozen electorate must still be able to vote",
    );

    const after = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      after.voter_ids.length,
      created.voter_ids.length,
      "and the denominator must not have moved either",
    );

    await api(
      base,
      "POST",
      "/api/spilka/admin-change-role",
      { group_id: groupId, user_id: bob.id, make_observer: false },
      admin.token,
    );
  });

  test("a ballot arriving after the deadline is refused", async () => {
    // The gap between ends_at and the next minute-cron used to accept ballots, and
    // one late "yes" was enough to turn a rejected question into an accepted one.
    const v = await createVoting(admin.token, { title: "Після строку" });
    await api(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { ends_at: new Date(Date.now() - 60_000).toISOString() },
      pb.adminToken,
    );

    const late = await tryApi(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes" },
      alice.token,
    );
    assert.equal(late.status, 400);
    assert.match(
      JSON.stringify(late.body || {}).toLowerCase(),
      /voting_expired/,
      "and it must be refused for being late, not for some other reason",
    );

    await api(base, "POST", "/api/spilka/complete-expired", {}, admin.token);
    const closed = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      closed.result,
      "rejected",
      "and the late ballot changed nothing",
    );
  });
});

describe("a voting to expel someone needs a real neighbour on the other side", () => {
  test("a stranger cannot be put up for removal", async () => {
    const outsider = await makeUser(
      base,
      pb.adminToken,
      `r2outsider${Date.now()}@test.local`,
    );
    const res = await tryApi(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Виключити чужого",
        type: "remove-member",
        status: "active",
        target_member: outsider.id,
        removal_reason: "нікому не відомий",
        ends_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      admin.token,
    );
    assert.equal(res.status, 400);
  });

  test("the admin cannot be put up for removal", async () => {
    const res = await tryApi(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Виключити голову",
        type: "remove-member",
        status: "active",
        target_member: admin.id,
        removal_reason: "спроба",
        ends_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      alice.token,
    );
    assert.equal(res.status, 400);
  });

  test("the expelled neighbour's name survives in the history", async () => {
    // applyEffect deletes the membership before writing the row, and the client can
    // only resolve names of people still in the group — so the single most
    // consequential line in the journal used to lose its name.
    const victim = await makeUser(
      base,
      pb.adminToken,
      `r2victim${Date.now()}@test.local`,
    );
    const r = await api(
      base,
      "POST",
      "/api/spilka/submit-join",
      { group_id: groupId, apartment: "9", as_observer: false },
      victim.token,
    );
    await api(
      base,
      "POST",
      "/api/spilka/approve-join",
      { request_id: r.data },
      admin.token,
    );
    // The app writes the profile from the browser after registration; the test
    // harness only makes the account, so create it here — the name is the whole
    // point of this test.
    await api(
      base,
      "POST",
      "/api/collections/profiles/records",
      {
        user: victim.id,
        first_name: "Петро",
        last_name: "Виселенко",
        apartment: "9",
      },
      victim.token,
    );

    const v = await createVoting(admin.token, {
      title: "Виключити мешканця кв. 9",
      type: "remove-member",
      target_member: victim.id,
      removal_reason: "не сплачує внески",
    });
    for (const u of [admin, alice, bob, carol]) {
      await api(
        base,
        "POST",
        "/api/collections/votes/records",
        { voting: v.id, choice: "yes" },
        u.token,
      );
    }
    await expire(v.id);

    const rows = await historyFor(v.id);
    const removed = rows.find((x) => x.action === "member_removed");
    assert.ok(removed, "the removal must be journalled");
    assert.equal(removed.details.removed_name, "Петро Виселенко");
  });
});

describe("a proposal to exclude nobody excludes nobody, and says so", () => {
  test("a freeze voting with no targets is rejected instead of announced as an exclusion", async () => {
    // The client creates the voting first and attaches the targets in a second
    // request; a failure there was discarded without a word. Five days later the
    // whole house was told residents had been excluded from the count — when none
    // had been.
    const v = await createVoting(admin.token, {
      title: "Виключення без списку",
      type: "freeze",
    });
    await expire(v.id);

    const closed = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(closed.status, "completed");
    assert.equal(
      closed.result,
      "rejected",
      "excluding nobody must not read as an accepted exclusion",
    );

    const members = await api(
      base,
      "GET",
      `/api/collections/group_members/records?filter=${encodeURIComponent(`group="${groupId}"`)}&perPage=200`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      members.items.filter((m) => m.is_frozen).length,
      0,
      "and nobody may end up excluded",
    );
  });
});

describe("a secret ballot stays secret after the urn closes", () => {
  test("completing a secret voting does not publish who took part", async () => {
    // Turnout was hidden only while the ballot ran. In a small house, the list of
    // who voted plus a unanimous tally names every single choice — and the members
    // screen shows exactly that list.
    const before = await api(
      base,
      "POST",
      "/api/spilka/member-votes",
      { group_id: groupId },
      carol.token,
    );
    const seen = {};
    for (const row of before.data) seen[row.user_id] = row.voted_count;

    const v = await createVoting(admin.token, {
      title: "Таємне: підрядник",
      type: "secret",
    });
    await api(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes" },
      alice.token,
    );
    await api(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes" },
      bob.token,
    );
    await expire(v.id);

    const after = await api(
      base,
      "POST",
      "/api/spilka/member-votes",
      { group_id: groupId },
      carol.token,
    );
    for (const row of after.data) {
      assert.equal(
        row.voted_count,
        seen[row.user_id] || 0,
        `a completed secret ballot must not change anyone's visible turnout (${row.user_id})`,
      );
    }
  });

  test("the participation denominator comes from the server and skips ballots you had no part in", async () => {
    // The client used to divide by every voting in the group while the numerator
    // skipped secret ones, so during any secret ballot every neighbour was shown as
    // having missed a vote they had cast.
    const rows = await api(
      base,
      "POST",
      "/api/spilka/member-votes",
      { group_id: groupId },
      carol.token,
    );
    for (const row of rows.data) {
      assert.equal(
        typeof row.eligible_count,
        "number",
        "every row must carry its own denominator",
      );
      assert.ok(
        row.voted_count <= row.eligible_count,
        `nobody may show more ballots cast than they were entitled to (${row.user_id}: ${row.voted_count}/${row.eligible_count})`,
      );
    }
  });
});
