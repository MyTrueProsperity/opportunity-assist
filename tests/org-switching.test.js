"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { coreDb, BILL, OTHER_USER, NEW_USER, MTP, INSTITUTE, STRANGER_ORG } = require("./helpers/core-db");

async function grantInstitute(pg) {
  // Explicit authorization, as an administrator would record it (service SQL).
  await pg.query("insert into public.org_memberships(org_id,user_id,role,granted_note) values($1,$2,'OWNER','test grant')", [INSTITUTE, BILL]);
}

test("existing profile assignments are backfilled as memberships", async () => {
  const { pg } = await coreDb();
  const rows = (await pg.query("select org_id,user_id,role from org_memberships order by user_id")).rows;
  assert.deepEqual(rows, [
    { org_id: MTP, user_id: BILL, role: "OWNER" },
    { org_id: STRANGER_ORG, user_id: OTHER_USER, role: "OWNER" },
  ]);
});

test("organization access is explicit: the Institute is not inferred from created_by", async () => {
  const { as } = await coreDb();
  // Bill created both organizations long ago. Without a membership row the
  // Institute is neither listed nor selectable.
  const listed = await as(BILL, ({ q }) => q("select id from my_organizations()"));
  assert.deepEqual(listed.map((r) => r.id), [MTP]);
  await assert.rejects(as(BILL, ({ q }) => q("select set_active_org($1)", [INSTITUTE])), /not authorized/);
});

test("a user with two authorized organizations can list and switch between them", async () => {
  const { pg, as } = await coreDb();
  await grantInstitute(pg);
  const before = await as(BILL, ({ q }) => q("select name, role, active from my_organizations()"));
  assert.deepEqual(before, [
    { name: "Institute of Bright Minds", role: "OWNER", active: false },
    { name: "My True Prosperity, LLC", role: "OWNER", active: true },
  ]);
  await as(BILL, ({ q }) => q("select set_active_org($1)", [INSTITUTE]));
  const after = await as(BILL, ({ q }) => q("select current_org_id() id"));
  assert.equal(after[0].id, INSTITUTE);
  const org = await as(BILL, ({ q }) => q("select name from organizations"));
  assert.deepEqual(org, [{ name: "Institute of Bright Minds" }], "only the active organization is readable");
  await as(BILL, ({ q }) => q("select set_active_org($1)", [MTP]));
  assert.equal((await as(BILL, ({ q }) => q("select current_org_id() id")))[0].id, MTP);
});

test("switching to an unauthorized organization is rejected, including a direct profile update", async () => {
  const { as } = await coreDb();
  await assert.rejects(as(BILL, ({ q }) => q("select set_active_org($1)", [STRANGER_ORG])), /not authorized/);
  await assert.rejects(as(BILL, ({ q }) => q("update profiles set org_id=$1 where id=$2", [STRANGER_ORG, BILL])), /not authorized/);
  await assert.rejects(as(OTHER_USER, ({ q }) => q("select set_active_org($1)", [MTP])), /not authorized/);
  // Nothing changed.
  assert.equal((await as(BILL, ({ q }) => q("select current_org_id() id")))[0].id, MTP);
  // A user cannot move someone else's profile.
  const moved = await as(OTHER_USER, ({ q }) => q("update profiles set org_id=$1 where id=$2 returning id", [STRANGER_ORG, BILL]));
  assert.equal(moved.length, 0);
});

test("membership rows cannot be written by signed-in users", async () => {
  const { as } = await coreDb();
  await assert.rejects(as(OTHER_USER, ({ q }) => q("insert into org_memberships(org_id,user_id,role) values($1,$2,'OWNER')", [MTP, OTHER_USER])), /permission denied/);
  const visible = await as(OTHER_USER, ({ q }) => q("select org_id from org_memberships"));
  assert.deepEqual(visible, [{ org_id: STRANGER_ORG }], "users see only their own memberships");
});

test("onboarding: a new user can claim an organization they just created, once", async () => {
  const { as } = await coreDb();
  const [org] = await as(NEW_USER, ({ q }) => q("insert into organizations(name,created_by) values('New Org',$1) returning id", [NEW_USER]));
  await as(NEW_USER, ({ q }) => q("update profiles set org_id=$1 where id=$2", [org.id, NEW_USER]));
  const mine = await as(NEW_USER, ({ q }) => q("select id, role, active from my_organizations()"));
  assert.deepEqual(mine, [{ id: org.id, role: "OWNER", active: true }]);
  // Another user cannot claim it afterwards even by forging created_by on a new org id.
  await assert.rejects(as(OTHER_USER, ({ q }) => q("select set_active_org($1)", [org.id])), /not authorized/);
});

test("fit scores stay with the organization they were calculated for and do not leak on switch", async () => {
  const { pg, as } = await coreDb();
  await grantInstitute(pg);
  const [opp] = (await pg.query("insert into opportunities(title) values('Youth grant') returning id")).rows;
  await as(BILL, ({ q }) => q("insert into fit_scores(org_id,opportunity_id,headline_score) values($1,$2,40)", [MTP, opp.id]));
  await as(BILL, ({ q }) => q("select set_active_org($1)", [INSTITUTE]));
  assert.deepEqual(await as(BILL, ({ q }) => q("select headline_score from fit_scores")), [], "MTP scores are hidden while the Institute is active");
  await assert.rejects(as(BILL, ({ q }) => q("insert into fit_scores(org_id,opportunity_id,headline_score) values($1,$2,90)", [MTP, opp.id])), /row-level security/);
  await as(BILL, ({ q }) => q("insert into fit_scores(org_id,opportunity_id,headline_score) values($1,$2,80)", [INSTITUTE, opp.id]));
  await as(BILL, ({ q }) => q("select set_active_org($1)", [MTP]));
  assert.deepEqual(await as(BILL, ({ q }) => q("select headline_score from fit_scores")), [{ headline_score: 40 }]);
  assert.deepEqual(await as(OTHER_USER, ({ q }) => q("select headline_score from fit_scores")), [], "other tenants see nothing");
});

test("single-organization users keep working unchanged", async () => {
  const { as } = await coreDb();
  assert.equal((await as(OTHER_USER, ({ q }) => q("select current_org_id() id")))[0].id, STRANGER_ORG);
  const orgs = await as(OTHER_USER, ({ q }) => q("select name from organizations"));
  assert.deepEqual(orgs, [{ name: "Unrelated Nonprofit" }]);
  await as(OTHER_USER, ({ q }) => q("update profiles set full_name='Pat' where id=$1", [OTHER_USER]));
});
