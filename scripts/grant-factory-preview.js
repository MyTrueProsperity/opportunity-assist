"use strict";
// Local browser validation only. In-memory database and stubbed AI; no production connection.
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path");
const { createTestRepo, OWNER, OTHER } = require("../tests/helpers/grant-db");
const { testPack } = require("../tests/helpers/grant-seed");
const { makeHandler } = require("../netlify/functions/grant-factory");
const { service } = require("../netlify/lib/grant-factory/service");
(async () => {
  const { repo, owner, pg } = await createTestRepo();
  await pg.query(
    "insert into gf_members(org_id,user_id,role) values($1,$2,'GRANT_MANAGER')",
    [OTHER, OWNER],
  );
  const ai = {
    enabled: false,
    async call() {
      throw Object.assign(
        Error(
          "This local preview uses no live AI. Manual workflows and seeded evidence are available.",
        ),
        { status: 503 },
      );
    },
  };
  await service(repo, ai).handle(owner, { action: "seed", pack: testPack() });
  const handler = makeHandler({ repo, ai });
  const root = path.resolve(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "app.html"), "utf8");
  const css = app.match(/<style>([\s\S]*?)<\/style>/)[1];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1:8794");
      if (url.pathname === "/.netlify/functions/grant-factory") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4500000) throw Error("Too large");
        }
        const out = await handler({
          httpMethod: req.method,
          headers: req.headers,
          body,
        });
        res.writeHead(out.statusCode, out.headers);
        res.end(out.body);
        return;
      }
      if (url.pathname.startsWith("/assets/")) {
        const p = path.resolve(root, "." + url.pathname);
        if (!p.startsWith(path.join(root, "assets") + path.sep))
          throw Error("Invalid path");
        res.setHeader(
          "Content-Type",
          p.endsWith(".css") ? "text/css" : "text/javascript",
        );
        res.end(fs.readFileSync(p));
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grant Factory · Local validation</title><style>' +
          css +
          '</style><link rel="stylesheet" href="/assets/grant-factory.css"></head><body><div style="background:#fff1d8;padding:8px 24px;font-size:13px">LOCAL VALIDATION · isolated data · live AI disabled</div><div class="layout"><aside class="sidebar"><div class="side-brand"><span class="brand-mark sm">OA</span><strong>Opportunity Assist</strong></div><nav><button class="nav-link">Dashboard</button><button class="nav-link">Funding Radar</button><button class="nav-link">Capture Pipeline</button><button class="nav-link active">✍️ Grant Factory</button></nav></aside><main class="main" id="main"></main></div><script src="/assets/grant-factory-limits.js"></script><script src="/assets/grant-factory.js"></script><script>OAGrantFactory.mount(document.getElementById("main"),{auth:{getSession:async()=>({data:{session:{access_token:"test"}}})}})</script></body></html>',
      );
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });
  server.listen(8794, "127.0.0.1", () =>
    console.log("Grant Factory local preview: http://127.0.0.1:8794"),
  );
})();
