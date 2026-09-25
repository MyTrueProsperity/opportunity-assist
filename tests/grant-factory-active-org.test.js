"use strict";
// Grant Factory opens in the user's active Opportunity Assist organization
// when they are a Grant Factory member of it, and never in one they are not.
const test = require("node:test");
const assert = require("node:assert/strict");
const { repository } = require("../netlify/lib/grant-factory/repository");

const USER = "11111111-1111-4111-8111-111111111111";
const MTP = "44444444-4444-4444-8444-444444444444";
const INST = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";

function repoFor({ activeOrg, gfMembers }) {
  const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_PUBLISHABLE_KEY: "pub" };
  const fetcher = async (url) => {
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b), headers: new Map() });
    if (url.endsWith("/auth/v1/user")) return ok({ id: USER });
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    if (table === "profiles") return ok([{ org_id: activeOrg }]);
    if (table === "gf_members") return ok(gfMembers.map((org_id) => ({ org_id, user_id: USER, role: "OWNER" })));
    if (table === "organizations") return ok(gfMembers.map((id) => ({ id, name: id === INST ? "Institute of Bright Minds" : "Other" })));
    throw Error("unexpected " + url);
  };
  return repository(env, fetcher);
}
const event = { headers: { authorization: "Bearer token" } };

test("Grant Factory defaults to the active organization when the user is a member there", async () => {
  const ctx = await repoFor({ activeOrg: INST, gfMembers: [OTHER, INST] }).context(event);
  assert.equal(ctx.org_id, INST);
});

test("an explicit Grant Factory workspace choice is honored only for member workspaces", async () => {
  const repo = repoFor({ activeOrg: MTP, gfMembers: [INST] });
  assert.equal((await repo.context(event, INST)).org_id, INST);
  await assert.rejects(repo.context(event, MTP), /do not have Grant Factory access/);
});

test("an active organization without Grant Factory membership falls back to a member workspace, never to itself", async () => {
  const ctx = await repoFor({ activeOrg: MTP, gfMembers: [INST] }).context(event);
  assert.equal(ctx.org_id, INST);
  assert.deepEqual(ctx.workspaces.map((w) => w.org_id), [INST]);
});
