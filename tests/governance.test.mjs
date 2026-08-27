// Who is allowed to do what to whom. These guard the rules that make the app a
// voting tool rather than an admin's control panel: an admin must be replaceable,
// a ballot must not be able to escape its own group, and losing your vote must
// leave a trace.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startPocketBase, api, tryApi, makeUser } from "./harness.mjs";

let pb, base;
let admin, alice, bob;
let groupId, otherGroupId, outsider;

const soon = () => new Date(Date.now() + 3600_000).toISOString();

before(async () => {
  pb = await startPocketBase();
  base = pb.base;

  admin = await makeUser(base, pb.adminToken, "gadmin@test.local");
  alice = await makeUser(base, pb.adminToken, "galice@test.local");
  bob = await makeUser(base, pb.adminToken, "gbob@test.local");
  outsider = await makeUser(base, pb.adminToken, "goutsider@test.local");

  const g = await api(
    base,
    "POST",
    "/api/spilka/create-group",
    { name: "вул. Тестова 2" },
    admin.token,
  );
  groupId = g.data.id;

  for (const [u, apt] of [
    [alice, "1"],
    [bob, "2"],
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

  // a second, unrelated house — the outsider's own group
  const g2 = await api(
    base,
    "POST",
    "/api/spilka/create-group",
    { name: "вул. Чужа 9" },
    outsider.token,
  );
  otherGroupId = g2.data.id;
});

after(async () => {
  await pb?.stop();
});

describe("a secret ballot stays inside its group", () => {
  test("cancelling cannot move a voting into another group", async () => {
    // Found while refuting the "type substitution" report: the update hook did
    // not compare `group` either, so one PATCH re-homed a finished secret ballot
    // into a group the attacker belonged to — and residents of an unrelated
    // house could then read who voted how, with names and flat numbers.
    const v = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Таємне",
        type: "secret",
        status: "active",
        ends_at: soon(),
      },
      admin.token,
    );
    await api(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "no", comment: "категорично проти" },
      alice.token,
    );

    const before = await tryApi(
      base,
      "POST",
      "/api/spilka/voting-ballots",
      { voting_id: v.id },
      outsider.token,
    );
    assert.equal(before.status, 403, "an outsider must not read the ballot");

    await tryApi(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { status: "deleted", type: "simple", group: otherGroupId },
      admin.token,
    );

    const fresh = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(fresh.group, groupId, "the voting must stay in its own group");
    assert.equal(fresh.type, "secret", "the ballot must stay secret");

    const after = await tryApi(
      base,
      "POST",
      "/api/spilka/voting-ballots",
      { voting_id: v.id },
      outsider.token,
    );
    assert.equal(
      after.status,
      403,
      "an outsider must still not read the ballot",
    );
  });
});

describe("the admin can be replaced", () => {
  test("an admin cannot cancel the vote to replace them", async () => {
    const v = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Зміна адміністратора",
        type: "admin-change",
        status: "active",
        target_member: alice.id,
        ends_at: soon(),
      },
      alice.token,
    );

    const res = await tryApi(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { status: "deleted" },
      admin.token,
    );
    assert.notEqual(
      res.status,
      200,
      "the admin must not be able to kill this vote",
    );

    const fresh = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(fresh.status, "active");
  });

  test("an admin cannot cancel the vote to dissolve the group", async () => {
    const v = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Розпустити групу",
        type: "delete-group",
        status: "active",
        ends_at: soon(),
      },
      bob.token,
    );

    const res = await tryApi(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { status: "deleted" },
      admin.token,
    );
    assert.notEqual(res.status, 200);
  });

  test("the person who started it may still withdraw it", async () => {
    const v = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Передумав",
        type: "admin-change",
        status: "active",
        target_member: bob.id,
        ends_at: soon(),
      },
      bob.token,
    );

    const res = await tryApi(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { status: "deleted" },
      bob.token,
    );
    assert.equal(res.status, 200, "the author must keep the right to withdraw");
  });

  test("an admin can still cancel an ordinary voting", async () => {
    const v = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Звичайне",
        type: "simple",
        status: "active",
        ends_at: soon(),
      },
      alice.token,
    );
    const res = await tryApi(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { status: "deleted" },
      admin.token,
    );
    assert.equal(res.status, 200);
  });
});

describe("losing the right to vote is visible", () => {
  test("an admin-made role change notifies the member and is recorded", async () => {
    // Without this, an admin could quietly move every resident to "observer",
    // become the only voter, carry any motion, and move everybody back — with
    // nothing on screen and nothing in the group's history.
    await api(
      base,
      "POST",
      "/api/spilka/admin-change-role",
      { group_id: groupId, user_id: alice.id, make_observer: true },
      admin.token,
    );

    const notes = await api(
      base,
      "GET",
      `/api/collections/notifications/records?filter=${encodeURIComponent(`user="${alice.id}"`)}&sort=-created&perPage=5`,
      undefined,
      pb.adminToken,
    );
    assert.ok(
      notes.items.some((n) => n.type === "role_changed_by_admin"),
      "the member must be told they can no longer vote",
    );

    const hist = await api(
      base,
      "GET",
      `/api/collections/group_history/records?filter=${encodeURIComponent(`group="${groupId}"`)}&sort=-created&perPage=5`,
      undefined,
      pb.adminToken,
    );
    assert.ok(
      hist.items.some((h) => h.action === "role_changed"),
      "the change must appear in the group history",
    );

    // put it back so later runs start clean
    await api(
      base,
      "POST",
      "/api/spilka/admin-change-role",
      { group_id: groupId, user_id: alice.id, make_observer: false },
      admin.token,
    );
  });
});

describe("the deadline is the server's call", () => {
  test("a voting cannot be created already expired", async () => {
    const res = await tryApi(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Спалити тему",
        type: "simple",
        status: "active",
        ends_at: new Date(Date.now() - 3600_000).toISOString(),
      },
      alice.token,
    );
    assert.notEqual(res.status, 200, "a deadline in the past must be refused");
  });

  test("a voting cannot be created without a deadline", async () => {
    // An empty ends_at compared as a string is "less than" now, so the minute
    // cron closed such a voting as rejected on its very first tick.
    const res = await tryApi(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Без строку",
        type: "simple",
        status: "active",
      },
      alice.token,
    );
    assert.notEqual(res.status, 200, "a missing deadline must be refused");
  });
});

describe("sweeping expired votings", () => {
  test("the sweep route does not touch other groups", async () => {
    const v = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Чуже голосування",
        type: "simple",
        status: "active",
        ends_at: soon(),
      },
      admin.token,
    );
    await api(
      base,
      "PATCH",
      `/api/collections/votings/records/${v.id}`,
      { ends_at: new Date(Date.now() - 60_000).toISOString() },
      pb.adminToken,
    );

    // the outsider belongs only to their own group, so their sweep must be a no-op here
    await api(base, "POST", "/api/spilka/complete-expired", {}, outsider.token);
    let fresh = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      fresh.status,
      "active",
      "an outsider must not close our voting",
    );

    await api(base, "POST", "/api/spilka/complete-expired", {}, admin.token);
    fresh = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      fresh.status,
      "completed",
      "a member of the group still closes it",
    );
  });
});

describe("editing a group", () => {
  test("the group admin can rename the group", async () => {
    // `groups` has no update rule, so the direct PATCH the app used to send was
    // rejected for everyone — the admin pressed "Зберегти" and got an error.
    const res = await tryApi(
      base,
      "POST",
      "/api/spilka/update-group",
      { group_id: groupId, name: "вул. Тестова 2а", description: "оновлено" },
      admin.token,
    );
    assert.equal(res.status, 200, "the admin must be able to rename their group");

    const fresh = await api(
      base,
      "GET",
      `/api/collections/groups/records/${groupId}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(fresh.name, "вул. Тестова 2а");
    assert.equal(fresh.description, "оновлено");
  });

  test("an ordinary member cannot rename the group", async () => {
    const res = await tryApi(
      base,
      "POST",
      "/api/spilka/update-group",
      { group_id: groupId, name: "Захоплено" },
      bob.token,
    );
    assert.equal(res.status, 403);
  });

  test("an outsider cannot rename someone else's group", async () => {
    const res = await tryApi(
      base,
      "POST",
      "/api/spilka/update-group",
      { group_id: groupId, name: "Чужа назва" },
      outsider.token,
    );
    assert.equal(res.status, 403);
  });
});

describe("the electorate is fixed when the voting starts", () => {
  test("someone who joins later cannot vote and does not enlarge the quorum", async () => {
    // The house rule: whoever is entitled to vote at the moment a voting is
    // created is its electorate. A resident who joins the next day votes in the
    // NEXT voting, and must not appear in this one's denominator — otherwise a
    // decision could be dragged below the threshold by people who never had a
    // say in it.
    const v = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Склад фіксується на старті",
        type: "simple",
        status: "active",
        ends_at: soon(),
      },
      admin.token,
    );

    const atStart = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    const sizeAtStart = atStart.voter_ids.length;
    assert.ok(sizeAtStart >= 2, "the house should have at least two voters");

    // a new resident moves in AFTER the voting started
    const newcomer = await makeUser(
      base,
      pb.adminToken,
      `newcomer${Date.now()}@test.local`,
    );
    const r = await api(
      base,
      "POST",
      "/api/spilka/submit-join",
      { group_id: groupId, apartment: `5${Date.now() % 100}`, as_observer: false },
      newcomer.token,
    );
    await api(
      base,
      "POST",
      "/api/spilka/approve-join",
      { request_id: r.data },
      admin.token,
    );

    // they may not vote in this one
    const attempt = await tryApi(
      base,
      "POST",
      "/api/collections/votes/records",
      { voting: v.id, choice: "yes" },
      newcomer.token,
    );
    assert.equal(attempt.status, 400, "a newcomer must not vote in a running voting");

    // and the electorate has not grown
    const afterwards = await api(
      base,
      "GET",
      `/api/collections/votings/records/${v.id}`,
      undefined,
      pb.adminToken,
    );
    assert.equal(
      afterwards.voter_ids.length,
      sizeAtStart,
      "the electorate must not change once the voting has started",
    );
    assert.ok(
      !afterwards.voter_ids.includes(newcomer.id),
      "the newcomer must not be in this voting's electorate",
    );

    // but they ARE in the next one
    const next = await api(
      base,
      "POST",
      "/api/collections/votings/records",
      {
        group: groupId,
        title: "Наступне голосування",
        type: "simple",
        status: "active",
        ends_at: soon(),
      },
      admin.token,
    );
    assert.ok(
      next.voter_ids.includes(newcomer.id),
      "a newcomer must be able to vote in votings started after they joined",
    );
  });
});
