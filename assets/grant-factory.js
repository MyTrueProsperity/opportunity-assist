(function () {
  "use strict";
  const esc = (v) =>
    String(v == null ? "" : v).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const label = (v) => String(v || "").replace(/_/g, " ");
  const pill = (v) =>
    '<span class="gf-pill ' +
    (/APPROVED|VERIFIED|AVAILABLE|COMPLETE|SUBMITTED/.test(v)
      ? "good"
      : /FAIL|CONFLICT|EXPIRED/.test(v)
        ? "bad"
        : "warn") +
    '">' +
    esc(label(v)) +
    "</span>";
  const btn = (action, text, id = "", primary = false) =>
    '<button type="button" class="btn ' +
    (primary ? "btn-primary" : "btn-ghost") +
    ' btn-sm" data-action="' +
    action +
    '" data-id="' +
    esc(id) +
    '">' +
    esc(text) +
    "</button>";
  const options = (rows, value) =>
    rows
      .map((r) => {
        const id = Array.isArray(r) ? r[0] : r;
        const text = Array.isArray(r) ? r[1] : label(r);
        return (
          '<option value="' +
          esc(id) +
          '" ' +
          (String(id) === String(value) ? "selected" : "") +
          ">" +
          esc(text) +
          "</option>"
        );
      })
      .join("");
  const field = (name, title, value = "", type = "text") =>
    "<label>" +
    esc(title) +
    '<input name="' +
    name +
    '" type="' +
    type +
    '" value="' +
    esc(value) +
    '"></label>';
  const area = (name, title, value = "") =>
    "<label>" +
    esc(title) +
    '<textarea name="' +
    name +
    '">' +
    esc(value) +
    "</textarea></label>";
  const check = (name, title, on = false) =>
    '<label class="gf-check"><input type="checkbox" name="' +
    name +
    '" ' +
    (on ? "checked" : "") +
    ">" +
    esc(title) +
    "</label>";
  const select = (name, title, rows, value) =>
    "<label>" +
    esc(title) +
    '<select name="' +
    name +
    '">' +
    options(rows, value) +
    "</select></label>";
  const statuses = [
    "VERIFIED",
    "APPROVED",
    "PROJECTED",
    "DERIVED",
    "DRAFT",
    "NEEDS_VERIFICATION",
    "CONFLICTED",
    "EXPIRED",
    "SUPERSEDED",
    "INTERNAL_ONLY",
  ];
  const limitTypes = [
    "WORDS",
    "CHARACTERS",
    "CHARACTERS_WITH_SPACES",
    "CHARACTERS_WITHOUT_SPACES",
    "PAGES",
    "NONE",
    "ADVISORY",
  ];
  const questionTypes = [
    "NARRATIVE",
    "NUMBER",
    "DATE",
    "YES_NO",
    "MULTI_SELECT",
    "UPLOAD",
    "BUDGET",
    "CERTIFICATION",
    "SIGNATURE",
    "OTHER",
  ];
  let session = null;
  function mount(main, sb, opportunities = []) {
    if (session && session.main === main && session.root?.isConnected) return;
    const s = {
      main,
      sb,
      data: null,
      tab: "applications",
      app: null,
      appTab: "questions",
      snapshots: [],
      busy: false,
      query: "",
      unsaved: {},
      orgId: null,
    };
    session = s;
    main.innerHTML =
      '<section class="gf"><p>Loading Grant Factory…</p></section>';
    async function api(action, payload = {}) {
      const auth = await sb.auth.getSession();
      const token = auth.data.session?.access_token;
      if (!token) throw Error("Sign in again to continue.");
      const r = await fetch("/.netlify/functions/grant-factory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ action, org_id: s.orgId, ...payload }),
      });
      let data;
      try {
        data = await r.json();
      } catch {
        throw Error(
          "The server returned an unreadable response. Check the deployment and try again.",
        );
      }
      if (!r.ok) throw Error(data.error || "Request failed");
      return data;
    }
    function message(text, error = false) {
      const node = main.querySelector("#gf-message");
      if (node) {
        node.textContent = text;
        node.className = "gf-message" + (error ? " error" : "");
        // A failure triggered from a button deep in a long question list is easy to miss if
        // the message only appears at the top of the page. Bring it into view so it is
        // actually seen at the moment the action fails.
        if (text) node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    async function refresh() {
      s.data = await api("bootstrap");
      s.orgId = s.data.org_id;
      if (s.app) {
        const r = await api("get_application", { application_id: s.app.id });
        s.app = r.app;
        s.data.brain = r.brain;
        s.snapshots = r.snapshots;
      }
      render();
    }
    async function mutate(action, payload = {}) {
      const result = await api(action, {
        ...(s.app
          ? { application_id: s.app.id, revision: s.app.revision }
          : {}),
        ...payload,
      });
      if (result.blocked) {
        s.app.content.qa = result.qa;
        s.appTab = "review";
        render();
        message("Resolve the review items before final approval.", true);
        return result;
      }
      if (result.id && result.questions) s.app = result;
      await refresh();
      return result;
    }
    function programs() {
      return [
        ["", "Select a program"],
        ...s.data.brain.programs.map((p) => [p.id, p.name]),
      ];
    }
    function docs() {
      return [
        ["", "Select a document"],
        ...s.data.brain.documents.map((d) => [
          d.id,
          d.title +
            " · " +
            label(d.status) +
            (d.external_use_allowed
              ? ""
              : " · Not approved for external use yet"),
        ]),
      ];
    }
    function allowed(f) {
      return (
        ["APPROVED", "VERIFIED", "PROJECTED", "DERIVED"].includes(
          f.verification_status,
        ) &&
        f.external_use_allowed &&
        f.grant_use_allowed &&
        !f.internal_only &&
        !f.review_required &&
        f.sensitivity_level !== "RESTRICTED" &&
        (!f.expiration_date ||
          new Date(f.expiration_date + "T23:59:59Z") >= new Date()) &&
        (!f.review_date ||
          new Date(f.review_date + "T23:59:59Z") >= new Date()) &&
        (!f.effective_date || new Date(f.effective_date) <= new Date()) &&
        (!f.conflict_ids?.length || f.conflict_resolution?.resolved) &&
        (!f.application_id || f.application_id === s.app?.id)
      );
    }
    function dialog(title, html, save) {
      const old = document.querySelector("#gf-dialog");
      if (old) old.remove();
      const d = document.createElement("dialog");
      d.id = "gf-dialog";
      d.className = "gf-dialog gf";
      d.innerHTML =
        '<form class="gf-form"><div class="gf-row"><h2>' +
        esc(title) +
        '</h2><button type="button" class="btn btn-ghost btn-sm" data-close>Close</button></div><div role="alert" class="gf-message error" hidden></div>' +
        html +
        (save
          ? '<button class="btn btn-primary" type="submit">Save</button>'
          : "") +
        "</form>";
      document.body.append(d);
      d.querySelector("[data-close]").onclick = () => d.close();
      d.addEventListener("close", () => d.remove());
      if (save)
        d.querySelector("form").onsubmit = async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const submit = form.querySelector("[type=submit]");
          submit.disabled = true;
          try {
            await save(new FormData(form), form);
            d.close();
          } catch (e) {
            const error = d.querySelector("[role=alert]");
            error.hidden = false;
            error.textContent = e.message;
          } finally {
            submit.disabled = false;
          }
        };
      d.querySelectorAll('[data-action="history"]').forEach(
        (b) => (b.onclick = () => perform("history", b.dataset.id, b)),
      );
      d.showModal();
      return d;
    }
    function render() {
      if (session !== s || !main.isConnected) return;
      const d = s.data,
        b = d.brain;
      const pending = b.facts.filter((f) =>
        ["NEEDS_VERIFICATION", "CONFLICTED", "DRAFT"].includes(
          f.verification_status,
        ),
      ).length;
      main.innerHTML =
        '<section class="gf"><header class="gf-head"><div><div class="gf-eyebrow">Opportunity Assist / Funding operations</div><h1>Grant Factory</h1><p class="gf-sub">From the application to an evidence-backed draft, with your judgment at every commitment.</p></div><div>' +
        '<label>Organization<select id="gf-workspace" aria-label="Grant Factory organization">' +
        options(
          d.workspaces.map((w) => [w.org_id, w.name]),
          s.orgId,
        ) +
        "</select></label>" +
        pill(d.role) +
        (d.role === "OWNER" ? btn("seed", "Import Institute seed data") : "") +
        '</div></header><nav class="gf-tabs" aria-label="Grant Factory">' +
        [
          ["applications", "Applications"],
          ["brain", "Organization Brain"],
          ["truth", "Truth Review · " + pending],
          ["programs", "Programs"],
          ["vault", "Document Vault"],
          ["input", "Needs My Input"],
          ["help", "Help"],
        ]
          .map(
            ([id, title]) =>
              '<button type="button" data-tab="' +
              id +
              '" aria-current="' +
              (s.tab === id ? "page" : "false") +
              '">' +
              esc(title) +
              "</button>",
          )
          .join("") +
        '</nav><div id="gf-message" role="status" class="gf-message"></div><div id="gf-content"></div></section>';
      s.root = main.querySelector(".gf");
      main.querySelector("#gf-workspace").onchange = async (event) => {
        const target = event.target;
        if (
          s.busy ||
          Object.keys(s.unsaved).some(
            (id) =>
              s.unsaved[id] !==
              s.app?.answers.find((a) => a.question_id === id)?.draft_text,
          )
        ) {
          target.value = s.orgId;
          message(
            "Finish the current action and save your answers before switching organizations.",
            true,
          );
          return;
        }
        s.busy = true;
        target.disabled = true;
        try {
          const next = await api("bootstrap", { org_id: target.value });
          s.data = next;
          s.orgId = next.org_id;
          s.app = null;
          s.snapshots = [];
          s.unsaved = {};
          s.tab = "applications";
          render();
        } catch (e) {
          target.value = s.orgId;
          message(e.message, true);
        } finally {
          s.busy = false;
          target.disabled = false;
        }
      };
      const content = main.querySelector("#gf-content");
      if (s.app && s.tab === "applications") renderApplication(content);
      else if (s.tab === "applications") renderApplications(content);
      else if (["brain", "truth"].includes(s.tab)) renderBrain(content);
      else if (s.tab === "programs") renderPrograms(content);
      else if (s.tab === "vault") renderVault(content);
      else if (s.tab === "help") renderHelp(content);
      else renderInputs(content);
      main.querySelectorAll("[data-tab]").forEach(
        (b) =>
          (b.onclick = () => {
            s.tab = b.dataset.tab;
            s.app = null;
            render();
          }),
      );
      main
        .querySelectorAll("[data-action]")
        .forEach(
          (b) => (b.onclick = () => perform(b.dataset.action, b.dataset.id, b)),
        );
      main.querySelectorAll("[data-apptab]").forEach(
        (b) =>
          (b.onclick = () => {
            s.appTab = b.dataset.apptab;
            render();
          }),
      );
      const search = main.querySelector("#gf-search");
      if (search)
        search.oninput = () => {
          s.query = search.value;
          const value = s.query.toLowerCase();
          main
            .querySelectorAll("[data-search]")
            .forEach((r) => (r.hidden = !r.dataset.search.includes(value)));
        };
      main.querySelectorAll("[data-answer-text]").forEach(
        (t) =>
          (t.oninput = () => {
            const q = s.app.questions.find(
              (q) => q.id === t.dataset.answerText,
            );
            s.unsaved[q.id] = t.value;
            const c = window.OAGrantLimits.check(t.value, q);
            const n = main.querySelector('[data-count="' + q.id + '"]');
            n.className = "gf-count" + (c.over ? " over" : "");
            n.textContent = countLabel(c, q);
          }),
      );
    }
    function renderApplications(el) {
      const apps = s.data.applications;
      el.innerHTML =
        '<div class="gf-row"><h2>Your applications</h2>' +
        btn("new", "New application", "", true) +
        '</div><div class="gf-steps"><span>1 Upload & review</span><span>2 Choose strategy</span><span>3 Draft & audit</span><span>4 Human review & export</span></div>' +
        (apps.length
          ? '<div class="gf-grid">' +
            apps
              .map(
                (a) =>
                  '<article class="gf-card"><div class="gf-statusline">' +
                  pill(a.status) +
                  '</div><h3 style="margin-top:16px">' +
                  esc(a.grant_program_name) +
                  '</h3><p class="gf-meta">' +
                  esc(a.funder_name || "Funder not entered") +
                  "<br>Deadline: " +
                  esc(a.deadline || "Not confirmed") +
                  "</p>" +
                  btn("open", "Open workspace", a.id) +
                  "</article>",
              )
              .join("") +
            "</div>"
          : '<div class="gf-card gf-empty"><h3>Start with the funder’s application</h3><p>Upload a PDF, DOCX or text file, or paste the questions. Every extracted requirement stays reviewable.</p>' +
            btn("new", "Create your first application", "", true) +
            "</div>");
    }
    function renderBrain(el) {
      let facts = s.data.brain.facts;
      const groups =
        s.tab === "truth"
          ? [
              [
                "Ready for External Use",
                (f) => allowed(f) && f.verification_status !== "PROJECTED",
              ],
              ["Projected", (f) => f.verification_status === "PROJECTED"],
              [
                "Internal Only",
                (f) =>
                  f.internal_only || f.verification_status === "INTERNAL_ONLY",
              ],
              [
                "Needs Verification",
                (f) =>
                  (f.review_required ||
                    ["NEEDS_VERIFICATION", "DRAFT"].includes(
                      f.verification_status,
                    )) &&
                  f.value,
              ],
              [
                "Conflicted",
                (f) =>
                  f.verification_status === "CONFLICTED" ||
                  (f.conflict_ids?.length && !f.conflict_resolution?.resolved),
              ],
              ["Missing High-Priority Information", (f) => !f.value],
              [
                "Expired / Superseded",
                (f) =>
                  ["EXPIRED", "SUPERSEDED"].includes(f.verification_status) ||
                  (f.expiration_date &&
                    new Date(f.expiration_date + "T23:59:59Z") < new Date()),
              ],
            ]
          : [["Institutional facts", () => true]];
      el.innerHTML =
        '<div class="gf-row"><div><h2>' +
        (s.tab === "truth" ? "Truth Review" : "Organization Brain") +
        '</h2><p class="gf-note">Approved facts retain sources, use permissions and a history of changes. Planned programs remain future-facing.</p></div>' +
        btn("fact", "Add fact", "", true) +
        (s.data.role === "OWNER" ? btn("voice", "Writing voice") : "") +
        '</div><input id="gf-search" class="gf-search" aria-label="Search organization facts" placeholder="Search enrollment, John Doe, theater, board…" value="' +
        esc(s.query) +
        '">' +
        groups
          .map(
            ([title, test]) =>
              '<section class="gf-card"><h3>' +
              title +
              "</h3>" +
              facts
                .filter(test)
                .map(
                  (f) =>
                    '<div class="gf-list-row" data-search="' +
                    esc(JSON.stringify(f).toLowerCase()) +
                    '"><div class="gf-row"><button type="button" class="link" data-action="fact" data-id="' +
                    f.id +
                    '">' +
                    esc(f.display_name) +
                    "</button>" +
                    pill(f.verification_status) +
                    "</div><p>" +
                    esc(f.value || "Information needed") +
                    '</p><div class="gf-meta">' +
                    esc(f.source_reference || "No source linked") +
                    " · " +
                    esc(f.source_locator || "No locator") +
                    (f.application_id ? " · Application-specific" : "") +
                    "</div></div>",
                )
                .join("") +
              (facts.filter(test).length
                ? ""
                : '<p class="gf-note">No items in this group.</p>') +
              "</section>",
          )
          .join("");
    }
    function renderPrograms(el) {
      el.innerHTML =
        '<div class="gf-row"><h2>Program records</h2>' +
        (s.data.role === "OWNER"
          ? btn("program", "Add program", "", true)
          : "") +
        '</div><div class="gf-grid">' +
        s.data.brain.programs
          .map(
            (p) =>
              '<article class="gf-card">' +
              pill(p.status) +
              '<h3 style="margin-top:16px">' +
              esc(p.name) +
              "</h3><p>" +
              esc(p.description) +
              '</p><p class="gf-meta">' +
              esc(p.primary_geography || "Geography not entered") +
              "</p>" +
              btn("program", "View / edit", p.id) +
              "</article>",
          )
          .join("") +
        "</div>";
    }
    function renderVault(el) {
      el.innerHTML =
        '<div class="gf-row"><div><h2>Document Vault</h2><p class="gf-note">Private originals, source locators and extraction status. Expected documents remain unavailable until uploaded.</p></div>' +
        btn("upload", "Upload document", "", true) +
        '</div><div class="gf-card gf-scroll"><table><thead><tr><th>Document</th><th>Type</th><th>Availability</th><th>Extraction</th><th></th></tr></thead><tbody>' +
        s.data.brain.documents
          .map(
            (d) =>
              "<tr><td>" +
              esc(d.title) +
              '<div class="gf-meta">' +
              esc(d.filename || "User can provide") +
              "</div></td><td>" +
              esc(label(d.document_type)) +
              "</td><td>" +
              pill(d.status) +
              "</td><td>" +
              pill(d.extraction_status) +
              "</td><td>" +
              btn("document", "Inspect", d.id) +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table></div>";
    }
    function renderHelp(el) {
      el.innerHTML =
        '<div class="gf-row"><div><h2>Help</h2><p class="gf-note">How Grant Factory works and how to get a question un-stuck.</p></div></div>' +
        '<div class="gf-card"><h3>Overview</h3><p>Grant Factory turns verified facts and uploaded documents into first-draft answers for grant applications. It does the first-draft writing; you and your team do the deciding.</p><p>Facts you have verified, plus documents you have uploaded, become evidence. Evidence becomes draft answers. Draft answers get reviewed, edited and approved by a person before anything leaves the building. It will not submit an application, decide eligibility, or state a fact it cannot support: when it lacks solid evidence for a claim, it opens a Needs My Input request instead of guessing.</p></div>' +
        '<div class="gf-card gf-scroll"><h3>Where things live</h3><table><thead><tr><th>Area</th><th>What it is for</th></tr></thead><tbody>' +
        [
          [
            "Organization Brain",
            "The verified fact store: EIN, tax status, programs, mission, address and every other reusable fact the org has confirmed.",
          ],
          [
            "Truth Review",
            "The queue of gaps and unverified claims, grouped by how ready each one is to use.",
          ],
          [
            "Document Vault",
            "Source documents and their extracted text. A document also carries its own \"approved for external use\" setting, separate from any fact built from it (see below).",
          ],
          ["Programs", "The org's program records and their operating status."],
          [
            "Applications",
            "The grant-writing workspace: upload, choose strategy, draft and audit, then human review and export.",
          ],
          [
            "Needs My Input",
            "Specific facts a drafting attempt could not find solid evidence for. This is the system asking for help instead of guessing.",
          ],
        ]
          .map(
            ([name, desc]) =>
              "<tr><td>" + esc(name) + "</td><td>" + esc(desc) + "</td></tr>",
          )
          .join("") +
        "</tbody></table></div>" +
        '<div class="gf-card gf-scroll"><h3>Organization Brain: what each status means</h3><table><thead><tr><th>Status</th><th>Usable as grant evidence?</th></tr></thead><tbody>' +
        [
          ["VERIFIED", "Yes, backed by an exact quote from a specific page in an approved document."],
          ["APPROVED", "Yes, but treat as internal until a document backs it."],
          ["PROJECTED", "Yes, but must be phrased as planned, not current."],
          ["NEEDS_VERIFICATION / CONFLICTED", "No, shows as an open gap in Truth Review."],
          ["INTERNAL_ONLY / EXPIRED / SUPERSEDED", "No, blocked from grant use by design."],
        ]
          .map(
            ([status, desc]) =>
              "<tr><td>" + esc(status) + "</td><td>" + esc(desc) + "</td></tr>",
          )
          .join("") +
        "</tbody></table><p class=\"gf-note\">When adding a fact, use the exact source excerpt as it literally appears in the document's own extracted text (open the document and check \"Extracted source text\"). A paraphrase or a quote spanning a line break will not validate.</p></div>" +
        '<div class="gf-card"><h3>Two approvals, not one</h3><p>A fact needs to be verified <em>and</em> its source document needs to be separately marked "Approved for external use" in Document Vault. New documents default to not approved. If a well-verified fact still will not draft, check the document it cites first: the fact editor\'s Source document list flags any document that is not yet approved.</p></div>' +
        '<div class="gf-card"><h3>Running an application</h3><ol>' +
        [
          "Start the application with the funder's name, the grant name, and the real application document (uploaded or pasted). Link a matching Funding Radar opportunity if one exists.",
          'Review the extraction under Application source, then click "Confirm extraction review." Drafting is blocked until this is confirmed, and it resets whenever a question is added, removed or re-parsed.',
          "Choose strategy: review funder priorities, evidence gaps and themes on the Strategy & eligibility tab, then approve it.",
          '"Draft from evidence" for each question, then "Audit claims" to see a sentence-by-sentence check of what is supported.',
          "Once every answer is approved, use QA & human review, then export as DOCX, a full package, or evidence JSON.",
          "Submit it yourself through the funder's own process. Grant Factory prepares the draft; it does not send it.",
        ]
          .map((s) => "<li>" + esc(s) + "</li>")
          .join("") +
        "</ol></div>" +
        '<div class="gf-card"><h3>Before you submit</h3><ul>' +
        [
          'Extraction reviewed is confirmed on the application you are working in.',
          "Every fact the answer depends on is VERIFIED or APPROVED, and its source document is approved for external use.",
          "Audit claims has been run, and every sentence reads SUPPORTED.",
          "The Needs My Input tab is empty, or every open item there is resolved or deliberately still open.",
          "A person has read the final answer against the actual funder question and word limit.",
        ]
          .map((s) => "<li>" + esc(s) + "</li>")
          .join("") +
        "</ul></div>";
    }
    function renderInputs(el) {
      const apps = s.data.applications.filter((a) =>
        (a.inputs || []).some((i) => i.status !== "RESOLVED"),
      );
      el.innerHTML =
        '<h2>Needs My Input</h2><p class="gf-note">Your response can be used only for one application or saved to the Organization Brain. New information needs approval before drafting uses it.</p>' +
        apps
          .map(
            (a) =>
              '<article class="gf-card"><h3>' +
              esc(a.grant_program_name) +
              "</h3>" +
              (a.inputs || [])
                .filter((i) => i.status !== "RESOLVED")
                .map(
                  (i) => "<p>" + esc(i.prompt) + " " + pill(i.status) + "</p>",
                )
                .join("") +
              btn("open", "Resolve in application", a.id) +
              "</article>",
          )
          .join("") +
        (!apps.length
          ? '<div class="gf-card gf-empty">No open input requests.</div>'
          : "");
    }
    function countLabel(c, q) {
      return (
        c.words +
        " words · " +
        c.characters +
        " characters · " +
        c.characters_without_spaces +
        " without spaces" +
        (q.limit_type !== "NONE"
          ? " | Limit: " +
            (q.limit_value || "review") +
            " " +
            label(q.limit_type).toLowerCase()
          : "") +
        (c.over ? " · OVER LIMIT" : "")
      );
    }
    function renderApplication(el) {
      const app = s.app,
        a = app.content;
      const locked = ["SUBMITTED", "ARCHIVED"].includes(a.status);
      el.innerHTML =
        '<div class="gf-row"><div>' +
        btn("back", "← All applications") +
        '<h2 style="margin-top:12px">' +
        esc(a.grant_program_name) +
        '</h2><p class="gf-meta">' +
        esc(a.funder_name || "Funder not entered") +
        " · Revision " +
        app.revision +
        " · " +
        pill(a.status) +
        '</p></div><div class="gf-toolbar">' +
        btn("export-docx", "Export DOCX") +
        btn("export-zip", "Export package") +
        btn("export-json", "Evidence JSON") +
        '</div></div><div class="gf-tabs">' +
        [
          ["questions", "Questions & drafts"],
          ["strategy", "Strategy & eligibility"],
          ["attachments", "Attachments"],
          ["input", "Needs My Input"],
          ["review", "QA & human review"],
          ["history", "History"],
        ]
          .map(
            ([id, t]) =>
              '<button data-apptab="' +
              id +
              '" aria-current="' +
              (s.appTab === id ? "page" : "false") +
              '">' +
              esc(t) +
              "</button>",
          )
          .join("") +
        '</div><div id="gf-appbody"></div>';
      const box = el.querySelector("#gf-appbody");
      if (s.appTab === "questions") {
        box.innerHTML =
          '<div class="gf-card"><div class="gf-row"><h3>Application source</h3><div>' +
          btn("document", "View original & extraction", a.source_document_id) +
          (!locked
            ? btn("parse", "Run AI parser") +
              btn("question", "Add question") +
              btn(
                "confirm-parser",
                a.parser_reviewed
                  ? "Extraction reviewed ✓"
                  : "Confirm extraction review",
                "",
                true,
              )
            : "") +
          '</div></div><p class="gf-note">Check every field, question, limit and attachment against the source. AI and basic extraction can miss material.</p>' +
          (a.warnings || [])
            .map((w) => '<p class="gf-note">' + esc(w) + "</p>")
            .join("") +
          "</div>" +
          app.questions
            .map((q) => {
              const ans = app.answers.find((a) => a.question_id === q.id);
              return (
                '<article class="gf-card"><div class="gf-row"><h3>' +
                esc(q.question_number || "") +
                " " +
                esc(q.question_text) +
                "</h3>" +
                (!locked
                  ? "<div>" +
                    btn("question", "Edit question", q.id) +
                    btn("remove-question", "Remove question", q.id) +
                    "</div>"
                  : "") +
                '</div><p class="gf-meta">' +
                esc(label(q.question_type)) +
                " · " +
                (q.required ? "Required" : "Optional") +
                " · " +
                esc(q.source_locator || "Manually entered") +
                '</p><div class="gf-source">' +
                esc(q.source_quote || "") +
                "</div><label>Answer<textarea " +
                (locked ? "readonly" : "") +
                ' data-answer-text="' +
                q.id +
                '" style="min-height:150px">' +
                esc(s.unsaved[q.id] ?? ans?.draft_text ?? "") +
                '</textarea></label><p class="gf-count" data-count="' +
                q.id +
                '">' +
                esc(
                  countLabel(
                    window.OAGrantLimits.check(
                      s.unsaved[q.id] ?? ans?.draft_text ?? "",
                      q,
                    ),
                    q,
                  ),
                ) +
                "</p>" +
                (!locked && !a.parser_reviewed
                  ? '<p class="gf-note error">Drafting is blocked until extraction review is reconfirmed. Scroll up to Application source and click "Confirm extraction review."</p>'
                  : "") +
                '<div class="gf-toolbar">' +
                (!locked
                  ? btn("draft", "Draft from evidence", q.id) +
                    btn("save-answer", "Save & select evidence", q.id, true) +
                    btn("audit", "Audit claims", q.id) +
                    btn("approve-answer", "Approve answer", q.id)
                  : "") +
                pill(ans?.status || "NOT_STARTED") +
                "</div><details><summary>Why did OA say this?</summary>" +
                (ans?.evidence_ids || [])
                  .map((id) => {
                    const f = s.data.brain.facts.find((f) => f.id === id);
                    return (
                      "<p><strong>" +
                      esc(f?.display_name || "Unavailable evidence") +
                      "</strong><br>" +
                      esc(f?.value || "") +
                      '<br><span class="gf-meta">' +
                      esc(f?.source_locator || "") +
                      "</span></p>"
                    );
                  })
                  .join("") +
                "</details>" +
                (ans?.audit
                  ? "<details open><summary>Claim audit</summary>" +
                    (!ans.audit.coverage_complete
                      ? '<p class="error">The auditor did not confirm complete coverage.</p>'
                      : "") +
                    ans.audit.claims
                      .map(
                        (c) =>
                          '<div class="gf-list-row">' +
                          pill(c.status) +
                          " " +
                          esc(c.claim) +
                          '<p class="gf-note">' +
                          esc(c.reason) +
                          "</p></div>",
                      )
                      .join("") +
                    "</details>"
                  : "") +
                "</article>"
              );
            })
            .join("");
      } else if (s.appTab === "strategy") {
        const p = s.data.brain.programs.find(
          (p) => p.id === a.primary_program_id,
        );
        box.innerHTML =
          '<div class="gf-card"><div class="gf-row"><h3>Application strategy</h3>' +
          (!locked
            ? btn("application-details", "Edit details & strategy") +
              btn("strategy", "Generate strategy")
            : "") +
          "</div><p><strong>Selected program:</strong> " +
          esc(p?.name || "Not selected") +
          '</p><p class="gf-note">Request amount: ' +
          esc(a.request_amount ?? "Not set") +
          " · Deadline: " +
          esc(a.deadline || "Not confirmed") +
          "</p>" +
          (a.recommendation?.ranked || [])
            .slice(0, 3)
            .map(
              (r) =>
                '<p class="gf-note">Recommendation: ' +
                esc(r.name) +
                " — " +
                esc(r.reasons.join("; ") || "No clear keyword match") +
                "</p>",
            )
            .join("") +
          (a.strategy
            ? Object.entries(a.strategy)
                .filter(
                  ([k, v]) => typeof v === "string" && k !== "reviewed_by",
                )
                .map(
                  ([k, v]) =>
                    "<h3>" + esc(label(k)) + "</h3><p>" + esc(v) + "</p>",
                )
                .join("") +
              pill(a.strategy.approved ? "APPROVED" : "NEEDS_REVIEW")
            : "<p>Choose the program and write or generate the strategy before drafting.</p>") +
          '</div><div class="gf-card"><div class="gf-row"><h3>Eligibility requirements</h3>' +
          (!locked ? btn("eligibility-edit", "Edit requirements") : "") +
          "</div>" +
          (a.eligibility || [])
            .map(
              (r) =>
                '<div class="gf-list-row">' +
                pill(r.review?.approved ? "APPROVED" : r.status) +
                " <strong>" +
                esc(r.rule) +
                '</strong><p class="gf-note">' +
                esc(r.reason || "") +
                '</p><p class="gf-source">' +
                esc(r.source_quote || "") +
                "</p>" +
                (!locked && s.data.role === "OWNER"
                  ? btn("eligibility-review", "Executive review", r.id)
                  : "") +
                "</div>",
            )
            .join("") +
          (!(a.eligibility || []).length
            ? "<p>No eligibility rules were found. Confirm that against the original application.</p>"
            : "") +
          "</div>";
      } else if (s.appTab === "attachments") {
        box.innerHTML =
          '<div class="gf-card"><div class="gf-row"><h3>Attachment checklist</h3>' +
          (!locked ? btn("attachments-edit", "Edit checklist") : "") +
          "</div>" +
          (a.attachments || [])
            .map(
              (t) =>
                '<div class="gf-list-row"><strong>' +
                esc(t.title) +
                "</strong> " +
                pill(t.status || "MISSING") +
                '<p class="gf-note">' +
                esc(
                  s.data.brain.documents.find((d) => d.id === t.document_id)
                    ?.title || "No document selected",
                ) +
                " · " +
                (t.reviewed ? "Reviewed" : "Review needed") +
                "</p></div>",
            )
            .join("") +
          (!(a.attachments || []).length
            ? "<p>No attachments were extracted. Confirm the funder’s requirements.</p>"
            : "") +
          "</div>";
      } else if (s.appTab === "input") {
        box.innerHTML =
          "<h3>Information required for this application</h3>" +
          (!locked ? btn("refresh-inputs", "Refresh fact approvals") : "") +
          (a.inputs || [])
            .map(
              (i) =>
                '<div class="gf-card"><div class="gf-row"><h3>' +
                esc(i.prompt) +
                "</h3>" +
                pill(i.status) +
                "</div><p>" +
                esc(i.reason) +
                "</p><p>" +
                esc(i.response || "") +
                "</p>" +
                (!locked
                  ? btn("resolve-input", "Provide information", i.id)
                  : "") +
                "</div>",
            )
            .join("") +
          (!(a.inputs || []).length
            ? "<p>No missing-information requests yet. They appear when a draft cannot be supported.</p>"
            : "");
      } else if (s.appTab === "review") {
        const q = a.qa;
        box.innerHTML =
          '<div class="gf-card"><h3>QA & human review</h3><p>Final approval requires reviewed extraction and strategy, supported answers, current evidence, checked attachments and resolved input requests. Submission is recorded after a person submits through the funder’s process.</p><div class="gf-toolbar">' +
          (!locked
            ? btn("qa", "Run QA", "", true) +
              (s.data.role === "OWNER"
                ? btn("approve-application", "Executive approval") +
                  btn("submit", "Record completed submission")
                : "")
            : "") +
          "</div>" +
          (q
            ? '<div class="' +
              (q.passed ? "gf-qa-pass" : "gf-qa-fail") +
              '"><strong>' +
              (q.passed
                ? "Ready for human review"
                : "Review items to resolve") +
              '</strong><ul class="gf-error-list">' +
              q.issues.map((i) => "<li>" + esc(i.message) + "</li>").join("") +
              '</ul><div class="gf-meta">Checked ' +
              esc(q.checked_at) +
              " · Truth revision " +
              q.brain_revision +
              "</div></div>"
            : '<p class="gf-note">Run QA after reviewing the answers and attachments.</p>') +
          (a.approval
            ? "<p>Approved " +
              esc(a.approval.at) +
              "<br>" +
              esc(a.approval.note) +
              "</p>"
            : "") +
          "</div>";
      } else {
        box.innerHTML =
          '<div class="gf-card"><h3>Submission snapshots</h3><p class="gf-note">Snapshots preserve the submitted answers, facts, document versions, review results and confirmation details.</p>' +
          s.snapshots
            .map(
              (x) =>
                '<div class="gf-list-row">' +
                esc(x.created_at) +
                " · Revision " +
                x.revision +
                " " +
                btn("snapshot", "Download preserved package", x.id) +
                "</div>",
            )
            .join("") +
          (!s.snapshots.length ? "<p>No recorded submissions.</p>" : "") +
          btn("history", "View edit history", app.id) +
          "</div>";
      }
    }
    async function perform(action, id, button) {
      if (s.busy) return;
      s.busy = true;
      if (button) button.disabled = true;
      message("");
      try {
        if (
          (action === "audit" || action === "approve-answer") &&
          id &&
          s.unsaved[id] != null &&
          s.unsaved[id] !==
            s.app.answers.find((a) => a.question_id === id)?.draft_text
        )
          throw Error(
            "Save the changed answer before auditing or approving it.",
          );
        if (
          (action.startsWith("export-") ||
            ["qa", "approve-application", "submit"].includes(action)) &&
          s.app &&
          Object.keys(s.unsaved).some(
            (id) =>
              s.app.questions.some((q) => q.id === id) &&
              s.unsaved[id] !==
                s.app.answers.find((a) => a.question_id === id)?.draft_text,
          )
        )
          throw Error("Save your changed answers before continuing.");
        if (action === "seed")
          dialog(
            "Import private Institute seed data",
            '<p>This file contains the approved seed facts and original impact report. It is imported into your private workspace; it is not a public website asset. Re-importing adds missing items and preserves your edits.</p><label>Private seed file<input type="file" name="pack" accept=".json" required></label>',
            async (f) => {
              const file = f.get("pack");
              if (file.size > 4000000) throw Error("Seed file exceeds 4 MB.");
              await mutate("seed", { pack: JSON.parse(await file.text()) });
              message(
                "Institute seed data loaded. Review missing documents and restricted facts in Truth Review.",
              );
            },
          );
        else if (action === "back") {
          s.app = null;
          render();
        } else if (action === "open") {
          const r = await api("get_application", { application_id: id });
          s.app = r.app;
          s.snapshots = r.snapshots;
          s.data.brain = r.brain;
          s.tab = "applications";
          s.appTab = "questions";
          render();
        } else if (action === "new")
          dialog(
            "New application",
            field("funder", "Funder name") +
              field("title", "Grant / application name") +
              '<label>Upload application (PDF, DOCX or text; maximum 3 MB)<input type="file" name="file" accept=".pdf,.docx,.txt"></label>' +
              select(
                "source",
                "Or use an uploaded application",
                [
                  ["", "Select a document"],
                  ...s.data.brain.documents
                    .filter(
                      (d) =>
                        d.document_type === "GRANT_APPLICATION" &&
                        d.extraction_status === "COMPLETE",
                    )
                    .map((d) => [d.id, d.title]),
                ],
                "",
              ) +
              area("text", "Or paste application text") +
              select(
                "opportunity",
                "Related funding opportunity (optional)",
                [
                  ["", "No linked opportunity"],
                  ...opportunities.map((o) => [o.id, o.title]),
                ],
                "",
              ),
            async (f) => {
              let source = f.get("source");
              const file = f.get("file");
              if (file?.size) {
                const payload = await filePayload(file);
                const upload = await api("upload_document", {
                  ...payload,
                  title: f.get("title") || file.name,
                  document_type: "GRANT_APPLICATION",
                });
                if (upload.extraction_status !== "COMPLETE")
                  throw Error(
                    "Original saved in the vault, but text extraction failed: " +
                      upload.extraction_error,
                  );
                source = upload.id;
              }
              s.app = await api("new_application", {
                funder_name: f.get("funder"),
                grant_program_name: f.get("title"),
                source_document_id: source,
                text: f.get("text"),
                opportunity_id: f.get("opportunity") || null,
              });
              s.appTab = "questions";
              await refresh();
            },
          );
        else if (action === "voice")
          dialog(
            "Organization writing voice",
            area("voice", "Writing guidance", s.data.brain.voice),
            async (f) => {
              await mutate("save_voice", {
                brain_revision: s.data.brain.revision,
                voice: f.get("voice"),
              });
            },
          );
        else if (action === "fact") {
          const f = s.data.brain.facts.find((f) => f.id === id) || {
            verification_status: "NEEDS_VERIFICATION",
            sensitivity_level: "INTERNAL",
          };
          dialog(
            id ? "Fact detail & review" : "Add institutional fact",
            (id ? btn("history", "View fact history", id) : "") +
              field("key", "Fact key", f.fact_key) +
              field("name", "Display name", f.display_name) +
              area("value", "Value", f.value) +
              '<div class="two">' +
              select(
                "status",
                "Verification status",
                statuses,
                f.verification_status,
              ) +
              select("program", "Program", programs(), f.program_id) +
              "</div>" +
              select(
                "document",
                "Source document",
                docs(),
                f.source_document_id,
              ) +
              field("reference", "Source reference", f.source_reference) +
              field("locator", "Source locator", f.source_locator) +
              area("quote", "Exact source excerpt", f.source_quote) +
              '<div class="two">' +
              field("effective", "Effective date", f.effective_date, "date") +
              field("expiry", "Expiration date", f.expiration_date, "date") +
              "</div>" +
              field("review", "Review date", f.review_date, "date") +
              select(
                "sensitivity",
                "Sensitivity",
                ["PUBLIC", "INTERNAL", "RESTRICTED"],
                f.sensitivity_level,
              ) +
              check(
                "external",
                "Allowed for external use",
                f.external_use_allowed,
              ) +
              check("grant", "Allowed for grant use", f.grant_use_allowed) +
              check("internal", "Internal only", f.internal_only) +
              check(
                "required_review",
                "Application-specific review required",
                f.review_required,
              ) +
              area("language", "Language rule", f.language_rule) +
              area("notes", "Notes", f.notes) +
              (f.conflict_ids?.length
                ? check(
                    "resolve_conflict",
                    "I reviewed and resolved the conflicting evidence",
                    f.conflict_resolution?.resolved,
                  )
                : "") +
              (id
                ? '<p class="gf-note">History is retained on every save. Revision ' +
                  f.revision +
                  ". " +
                  esc(
                    f.conflict_ids?.length
                      ? "Conflicting evidence must be reconciled explicitly."
                      : "",
                  ) +
                  "</p>"
                : "") +
              (s.data.role !== "OWNER"
                ? '<p class="gf-note">Your changes will be proposed for executive approval.</p>'
                : ""),
            async (v) => {
              const result = await mutate("save_fact", {
                id: id || null,
                revision: f.revision,
                brain_revision: s.data.brain.revision,
                fact: {
                  fact_key: v.get("key"),
                  display_name: v.get("name"),
                  value: v.get("value"),
                  verification_status: v.get("status"),
                  program_id: v.get("program") || null,
                  source_document_id: v.get("document") || null,
                  source_reference: v.get("reference"),
                  source_locator: v.get("locator"),
                  source_quote: v.get("quote"),
                  effective_date: v.get("effective") || null,
                  expiration_date: v.get("expiry") || null,
                  review_date: v.get("review") || null,
                  sensitivity_level: v.get("sensitivity"),
                  external_use_allowed: v.has("external"),
                  grant_use_allowed: v.has("grant"),
                  internal_only: v.has("internal"),
                  review_required: v.has("required_review"),
                  language_rule: v.get("language"),
                  notes: v.get("notes"),
                  resolve_conflict: v.has("resolve_conflict"),
                },
              });
              if (result.warning) message(result.warning, true);
            },
          );
        } else if (action === "program") {
          const p = s.data.brain.programs.find((p) => p.id === id) || {};
          dialog(
            "Program record",
            field("name", "Name", p.name) +
              area("description", "Description", p.description) +
              select(
                "status",
                "Operating status",
                [
                  "PLANNING",
                  "PRE_LAUNCH",
                  "ACTIVE",
                  "PAUSED",
                  "COMPLETED",
                  "DISCONTINUED",
                ],
                p.status,
              ) +
              field(
                "start",
                "Projected start (retain known precision)",
                p.projected_start_date,
              ) +
              field("geo", "Geography", p.primary_geography) +
              field(
                "population",
                "Target population",
                p.target_population_summary,
              ) +
              field(
                "tags",
                "Matching terms (comma separated)",
                (p.tags || []).join(", "),
              ) +
              select(
                "parent",
                "Parent program",
                programs().filter((x) => x[0] !== id),
                p.parent_program_id,
              ),
            s.data.role === "OWNER"
              ? async (f) => {
                  await mutate("save_program", {
                    id: id || null,
                    revision: p.revision,
                    brain_revision: s.data.brain.revision,
                    program: {
                      name: f.get("name"),
                      public_name: f.get("name"),
                      description: f.get("description"),
                      status: f.get("status"),
                      projected_start_date: f.get("start"),
                      primary_geography: f.get("geo"),
                      target_population_summary: f.get("population"),
                      tags: f
                        .get("tags")
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                      parent_program_id: f.get("parent") || null,
                    },
                  });
                }
              : null,
          );
        } else if (action === "upload")
          dialog(
            "Upload a private document",
            field("title", "Document title") +
              select("type", "Document type", s.data.document_types, "OTHER") +
              '<label>File (PDF, DOCX or UTF-8 text; maximum 3 MB)<input type="file" name="file" accept=".pdf,.docx,.txt" required></label><p class="gf-note">The original is retained even if text extraction fails. Uploading a file does not approve its facts.</p>',
            async (f) => {
              const file = f.get("file");
              if (file.size > 3145728) throw Error("File exceeds 3 MB.");
              const bytes = new Uint8Array(await file.arrayBuffer());
              let binary = "";
              for (let i = 0; i < bytes.length; i += 8192)
                binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
              const r = await mutate("upload_document", {
                filename: file.name,
                title: f.get("title") || file.name,
                document_type: f.get("type"),
                base64: btoa(binary),
              });
              message(
                r.extraction_status === "FAILED"
                  ? "Original saved. Extraction failed: " + r.extraction_error
                  : "Document saved and text extracted.",
                r.extraction_status === "FAILED",
              );
            },
          );
        else if (action === "document") {
          const d = await api("document", { id });
          const modal = dialog(
            d.title,
            '<div class="gf-toolbar">' +
              (d.storage_path
                ? btn("download-document", "Download original", id) +
                  btn("propose-facts", "Extract fact proposals", id) +
                  btn("retry-extraction", "Retry text extraction", id)
                : "") +
              "</div>" +
              pill(d.status) +
              " " +
              pill(d.extraction_status) +
              (d.extraction_error
                ? '<p class="error">' + esc(d.extraction_error) + "</p>"
                : "") +
              field("title", "Title", d.title) +
              select(
                "type",
                "Document type",
                s.data.document_types,
                d.document_type,
              ) +
              select(
                "status",
                "Availability",
                [
                  "AVAILABLE",
                  "MISSING",
                  "EXPIRED",
                  "NEEDS_UPDATE",
                  "NOT_APPLICABLE",
                  "EXPECTED_DOCUMENT",
                ],
                d.status,
              ) +
              field("date", "Document date", d.document_date) +
              field("expiry", "Expiration", d.expiration_date, "date") +
              select(
                "sensitivity",
                "Sensitivity",
                ["PUBLIC", "INTERNAL", "RESTRICTED"],
                d.sensitivity_level,
              ) +
              check(
                "external",
                "Approved for external use / attachment",
                d.external_use_allowed,
              ) +
              area("notes", "Notes", d.notes) +
              "<details><summary>Extracted source text</summary>" +
              (d.blocks || [])
                .map(
                  (b) =>
                    '<p class="gf-source"><strong>' +
                    esc(b.locator) +
                    "</strong><br>" +
                    esc(b.text) +
                    "</p>",
                )
                .join("") +
              "</details>",
            s.data.role === "OWNER"
              ? async (f) => {
                  await mutate("save_document", {
                    id,
                    revision: d.revision,
                    document: {
                      title: f.get("title"),
                      document_type: f.get("type"),
                      status: f.get("status"),
                      document_date: f.get("date"),
                      expiration_date: f.get("expiry") || null,
                      sensitivity_level: f.get("sensitivity"),
                      external_use_allowed: f.has("external"),
                      notes: f.get("notes"),
                    },
                  });
                }
              : null,
          );
          modal.querySelectorAll("[data-action]").forEach(
            (b) =>
              (b.onclick = async () => {
                try {
                  b.disabled = true;
                  if (b.dataset.action === "download-document")
                    download(await api("download_document", { id }));
                  else {
                    await api(
                      b.dataset.action === "propose-facts"
                        ? "propose_facts"
                        : "retry_extraction",
                      { id, revision: d.revision },
                    );
                    modal.close();
                    await refresh();
                    message(
                      "Document operation completed. Review fact proposals in Truth Review.",
                    );
                  }
                } catch (e) {
                  const n = modal.querySelector("[role=alert]");
                  n.hidden = false;
                  n.textContent = e.message;
                } finally {
                  b.disabled = false;
                }
              }),
          );
        } else if (action === "remove-question") {
          const q = s.app.questions.find((q) => q.id === id);
          dialog(
            "Remove extracted question",
            "<p>Remove this question only after checking the original application. Its current answer will also be removed. The original document and edit history remain available.</p><p><strong>" +
              esc(q.question_text) +
              "</strong></p>" +
              check(
                "reviewed",
                "I checked the original and this field should be removed",
              ),
            async (f) => {
              if (!f.has("reviewed"))
                throw Error(
                  "Check the original application before removing this field.",
                );
              await mutate("save_questions", {
                questions: s.app.questions.filter((q) => q.id !== id),
              });
              delete s.unsaved[id];
            },
          );
        } else if (action === "question") {
          const q = s.app.questions.find((q) => q.id === id) || {
            question_type: "NARRATIVE",
            limit_type: "NONE",
            required: true,
          };
          dialog(
            "Application question",
            field("number", "Question number", q.question_number) +
              field("section", "Section", q.section) +
              area("text", "Exact question", q.question_text) +
              select("type", "Field type", questionTypes, q.question_type) +
              select("limit", "Limit type", limitTypes, q.limit_type) +
              field("max", "Limit value", q.limit_value, "number") +
              check("required", "Required", q.required) +
              field("locator", "Source locator", q.source_locator) +
              area("quote", "Exact source quote", q.source_quote) +
              field(
                "category",
                "Question category / retrieval terms",
                q.question_category,
              ),
            async (f) => {
              const next = {
                ...q,
                id: id || crypto.randomUUID(),
                question_number: f.get("number"),
                section: f.get("section"),
                question_text: f.get("text"),
                question_type: f.get("type"),
                limit_type: f.get("limit"),
                limit_value: f.get("max") ? Number(f.get("max")) : null,
                required: f.has("required"),
                source_locator: f.get("locator"),
                source_quote: f.get("quote"),
                question_category: f.get("category"),
              };
              await mutate("save_questions", {
                questions: id
                  ? s.app.questions.map((q) => (q.id === id ? next : q))
                  : s.app.questions.concat(next),
              });
            },
          );
        } else if (action === "application-details") {
          const a = s.app.content;
          dialog(
            "Application details & strategy",
            field("funder", "Funder", a.funder_name) +
              field("title", "Grant name", a.grant_program_name) +
              field("cycle", "Application cycle", a.application_cycle) +
              field(
                "deadline",
                "Deadline as stated (include time zone)",
                a.deadline,
              ) +
              field("amount", "Request amount", a.request_amount, "number") +
              select(
                "program",
                "Primary program",
                programs(),
                a.primary_program_id,
              ) +
              '<label>Supporting programs (optional)<select name="secondary" multiple>' +
              options(
                s.data.brain.programs.map((p) => [p.id, p.name]),
                null,
              ).replace(/<option value="([^"]+)"/g, (match, id) =>
                (a.secondary_program_ids || []).includes(id)
                  ? match + " selected"
                  : match,
              ) +
              "</select></label>" +
              [
                "primary_case",
                "funder_priorities",
                "alignment_points",
                "themes_to_emphasize",
                "themes_to_deemphasize",
                "likely_funding_use",
                "evidence_gaps",
              ]
                .map((k) => area(k, label(k), a.strategy?.[k]))
                .join("") +
              check(
                "approve",
                "I have reviewed this strategy",
                a.strategy?.approved,
              ),
            async (f) => {
              const strategy = {};
              for (const k of [
                "primary_case",
                "funder_priorities",
                "alignment_points",
                "themes_to_emphasize",
                "themes_to_deemphasize",
                "likely_funding_use",
                "evidence_gaps",
              ])
                strategy[k] = f.get(k);
              await mutate("save_application", {
                application: {
                  funder_name: f.get("funder"),
                  grant_program_name: f.get("title"),
                  application_cycle: f.get("cycle"),
                  deadline: f.get("deadline"),
                  request_amount: f.get("amount")
                    ? Number(f.get("amount"))
                    : null,
                  primary_program_id: f.get("program") || null,
                  secondary_program_ids: f.getAll("secondary"),
                  strategy,
                  strategy_approved: f.has("approve"),
                },
              });
            },
          );
        } else if (action === "parse" || action === "draft") {
          const has =
            action === "parse"
              ? s.app.answers.some((a) => a.draft_text)
              : s.app.answers.some((a) => a.question_id === id && a.draft_text);
          if (has)
            dialog(
              "Replace the current " +
                (action === "parse" ? "questions and drafts" : "answer") +
                "?",
              "<p>Earlier versions remain in edit history. This will replace the current " +
                (action === "parse"
                  ? "question and answer set"
                  : "answer text") +
                ".</p>",
              async () => {
                await mutate(action, {
                  question_id: id,
                  replace_confirmed: true,
                });
              },
            );
          else await mutate(action, { question_id: id });
        } else if (action === "save-answer") {
          const text = main.querySelector(
            '[data-answer-text="' + id + '"]',
          ).value;
          const a = s.app.answers.find((a) => a.question_id === id);
          const facts = s.data.brain.facts.filter(allowed);
          dialog(
            "Evidence for this answer",
            '<p>Select the facts that support this answer. A separate claim audit checks whether they support what it actually says.</p><div class="gf-evidence">' +
              facts
                .map(
                  (f) =>
                    '<label class="gf-check"><input type="checkbox" name="evidence" value="' +
                    f.id +
                    '" ' +
                    (a?.evidence_ids?.includes(f.id) ? "checked" : "") +
                    "><span><strong>" +
                    esc(f.display_name) +
                    "</strong><br>" +
                    esc(f.value) +
                    "</span></label>",
                )
                .join("") +
              "</div>" +
              check(
                "layout",
                "I checked page / ambiguous character limits in the funder format",
                a?.layout_reviewed,
              ),
            async (f) => {
              await mutate("save_answer", {
                question_id: id,
                text,
                evidence_ids: f.getAll("evidence"),
                layout_reviewed: f.has("layout"),
              });
              delete s.unsaved[id];
            },
          );
        } else if (action === "audit")
          await mutate("audit_answer", { question_id: id });
        else if (action === "approve-answer")
          dialog(
            "Review this answer",
            area(
              "note",
              "Executive commitment review (required for budget, certification or signature fields)",
            ) + check("layout", "Page / ambiguous character limits checked"),
            async (f) => {
              await mutate("approve_answer", {
                question_id: id,
                commitment_note: f.get("note"),
                layout_reviewed: f.has("layout"),
              });
            },
          );
        else if (action === "confirm-parser") await mutate("confirm_parser");
        else if (action === "strategy") await mutate("strategy");
        else if (action === "refresh-inputs") await mutate("refresh_inputs");
        else if (action === "resolve-input") {
          const i = s.app.content.inputs.find((i) => i.id === id);
          dialog(
            "Provide missing information",
            "<p>" +
              esc(i.prompt) +
              "</p>" +
              area("value", "Your response", i.response) +
              select("document", "Supporting document (optional)", docs(), "") +
              area("notes", "Source / qualification notes") +
              check(
                "brain",
                "Save for reuse in Organization Brain (otherwise this application only)",
              ) +
              (s.data.role === "OWNER"
                ? check(
                    "approve",
                    "I approve this information for this grant",
                  ) +
                  check(
                    "commitment",
                    "I have authority to confirm this institutional commitment",
                  )
                : ""),
            async (f) => {
              await mutate("resolve_input", {
                input_id: id,
                value: f.get("value"),
                source_document_id: f.get("document") || null,
                notes: f.get("notes"),
                save_to_brain: f.has("brain"),
                approve: f.has("approve"),
                commitment_verified: f.has("commitment"),
              });
            },
          );
        } else if (action === "eligibility-edit")
          dialog(
            "Edit eligibility requirements",
            '<p class="gf-note">One stated rule per line. This resets prior eligibility reviews.</p>' +
              area(
                "rules",
                "Requirements",
                (s.app.content.eligibility || []).map((r) => r.rule).join("\n"),
              ),
            async (f) => {
              await mutate("save_eligibility", {
                eligibility: f
                  .get("rules")
                  .split("\n")
                  .filter((x) => x.trim())
                  .map((rule) => ({
                    rule,
                    operator: "REVIEW",
                    source_locator: "Human review of application",
                  })),
              });
            },
          );
        else if (action === "eligibility-review")
          dialog(
            "Executive eligibility review",
            area("note", "Evidence-based eligibility finding") +
              '<div class="gf-evidence">' +
              s.data.brain.facts
                .filter(allowed)
                .map(
                  (f) =>
                    '<label class="gf-check"><input type="checkbox" name="evidence" value="' +
                    f.id +
                    '">' +
                    esc(f.display_name + " — " + f.value) +
                    "</label>",
                )
                .join("") +
              "</div>",
            async (f) => {
              await mutate("review_eligibility", {
                rule_id: id,
                note: f.get("note"),
                evidence_ids: f.getAll("evidence"),
              });
            },
          );
        else if (action === "attachments-edit") {
          const attachments = s.app.content.attachments || [];
          dialog(
            "Attachment checklist",
            attachments
              .map(
                (a, i) =>
                  '<div class="gf-card">' +
                  field("title" + i, "Requirement", a.title) +
                  select("doc" + i, "Vault document", docs(), a.document_id) +
                  select(
                    "status" + i,
                    "Status",
                    ["MISSING", "AVAILABLE", "NOT_APPLICABLE"],
                    a.status,
                  ) +
                  check("required" + i, "Required", a.required !== false) +
                  check(
                    "reviewed" + i,
                    "I checked this document/version",
                    a.reviewed,
                  ) +
                  field("reason" + i, "Not-applicable explanation", a.reason) +
                  "</div>",
              )
              .join("") +
              field("new", "Add an attachment requirement (optional)"),
            async (f) => {
              const rows = attachments.map((a, i) => ({
                ...a,
                title: f.get("title" + i),
                document_id: f.get("doc" + i) || null,
                status: f.get("status" + i),
                required: f.has("required" + i),
                reviewed: f.has("reviewed" + i),
                reason: f.get("reason" + i),
              }));
              if (f.get("new").trim())
                rows.push({
                  id: crypto.randomUUID(),
                  title: f.get("new"),
                  required: true,
                  status: "MISSING",
                  reviewed: false,
                });
              await mutate("save_attachments", { attachments: rows });
            },
          );
        } else if (action === "qa") await mutate("qa");
        else if (action === "approve-application")
          dialog(
            "Final executive approval",
            "<p>Confirm the complete application, evidence, budget, institutional statements and attachments. QA must pass before this approval is saved.</p>" +
              area("note", "Final review note"),
            async (f) => {
              await mutate("approve_application", {
                review_note: f.get("note"),
              });
            },
          );
        else if (action === "submit")
          dialog(
            "Record a completed submission",
            "<p>Use this after you have submitted through the funder’s process. This creates a permanent snapshot and locks the application.</p>" +
              area("confirmation", "Submission confirmation / receipt details"),
            async (f) => {
              await mutate("record_submission", {
                confirmation: f.get("confirmation"),
              });
            },
          );
        else if (action.startsWith("export-") || action === "snapshot")
          download(
            await api("export", {
              application_id: s.app.id,
              format:
                action === "snapshot" ? "zip" : action.replace("export-", ""),
              snapshot_id: action === "snapshot" ? id : null,
            }),
          );
        else if (action === "history") {
          const h = await api("history", { id, kind: "application" });
          dialog(
            "Record edit history",
            h
              .map(
                (r) =>
                  "<details><summary>" +
                  esc(r.created_at) +
                  " · " +
                  esc(label(r.event_type)) +
                  " · Revision " +
                  r.revision +
                  "</summary>" +
                  (r.content
                    ? '<pre class="gf-pre">' +
                      esc(JSON.stringify(r.content, null, 2)) +
                      "</pre>"
                    : "<p>Detailed history requires executive access.</p>") +
                  "</details>",
              )
              .join(""),
            null,
          );
        }
      } catch (e) {
        message(e.message, true);
      } finally {
        s.busy = false;
        if (button?.isConnected) button.disabled = false;
      }
    }
    async function filePayload(file) {
      if (file.size > 3145728) throw Error("File exceeds 3 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { filename: file.name, base64: btoa(binary) };
    }
    function download(r) {
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
    refresh().catch((e) => {
      main.innerHTML =
        '<section class="gf"><h1>Grant Factory</h1><div class="gf-message error" role="alert">' +
        esc(e.message) +
        '</div><p>Grant Factory uses an explicitly enabled private workspace for the Institute. An administrator provisions executive and grant-manager access during deployment.</p><button class="btn btn-ghost" id="gf-retry">Retry</button></section>';
      main.querySelector("#gf-retry").onclick = () => {
        session = null;
        mount(main, sb);
      };
    });
  }
  window.OAGrantFactory = { mount };
})();
