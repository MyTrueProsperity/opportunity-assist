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
      tab: "start",
      app: null,
      appTab: "questions",
      snapshots: [],
      busy: false,
      query: "",
      unsaved: {},
      orgId: null,
      researchQuery: "",
      researchPacket: "",
      researchBackground: null,
      reviewDocument: null,
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
        if (error) node.scrollIntoView({ block: "center", behavior: "smooth" });
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
          d.title + " · " + label(d.status),
        ]),
      ];
    }
    function allowed(f) {
      if (typeof f.draft_ready === "boolean") return f.draft_ready;
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
      const pending = b.facts.filter(f => !f.research && !allowed(f) && !f.internal_only && !["INTERNAL_ONLY", "SUPERSEDED"].includes(f.verification_status)).length;
      main.innerHTML =
        '<section class="gf"><header class="gf-head"><div><div class="gf-eyebrow">Opportunity Assist / Funding operations</div><h1>Grant Factory</h1><p class="gf-sub">Add your documents. Review the facts. Build your grant application.</p></div><div>' +
        '<label>Organization<select id="gf-workspace" aria-label="Grant Factory organization">' +
        options(
          d.workspaces.map((w) => [w.org_id, w.name]),
          s.orgId,
        ) +
        "</select></label>" +
        pill(d.role) +
        '</div></header><nav class="gf-tabs" aria-label="Grant Factory">' +
        [
          ["start", "Start here"],
          ["applications", "Applications"],
          ["brain", "Organization Brain"],
          ["truth", "Truth Review · " + pending],
          ["programs", "Programs"],
          ["research", "Research Library"],
          ["vault", "Document Vault"],
          ["input", "Needs My Input"],
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
          s.researchBackground = null;
          s.researchPacket = "";
          s.researchQuery = "";
          s.tab = "start";
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
      if (s.tab === "start") renderStart(content);
      else if (s.app && s.tab === "applications") renderApplication(content);
      else if (s.tab === "applications") renderApplications(content);
      else if (["brain", "truth"].includes(s.tab)) renderBrain(content);
      else if (s.tab === "programs") renderPrograms(content);
      else if (s.tab === "research") renderResearch(content);
      else if (s.tab === "vault") renderVault(content);
      else renderInputs(content);
      main.querySelectorAll("[data-tab]").forEach(
        (b) =>
          (b.onclick = () => {
            if (s.busy) return;
            s.tab = b.dataset.tab;
            s.app = null;
            s.reviewDocument = null;
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
    function renderStart(el) {
      const brain = s.data.brain;
      const uploaded = brain.documents.filter(d => d.storage_path);
      const failed = uploaded.filter(d => d.extraction_status === "FAILED");
      const ready = brain.facts.filter(f => !f.research && allowed(f));
      const pending = brain.facts.filter(f => !f.research && !allowed(f) && !f.internal_only && !["INTERNAL_ONLY", "SUPERSEDED"].includes(f.verification_status));
      const card = (number, title, text, action, button, detail) => '<article class="gf-card gf-start-card"><span class="gf-step-number">' + number + '</span><h3>' + title + '</h3><p>' + text + '</p><p class="gf-meta">' + detail + '</p>' + btn(action, button, "", true) + '</article>';
      el.innerHTML = '<section class="gf-welcome"><div class="gf-eyebrow">Your next steps</div><h2>Start with what you already have.</h2><p>Upload a business plan, impact report, or other source document. Grant Factory reads it in sections and suggests facts. You check those suggestions before they can appear in a grant.</p><p><strong>You do not need to enter every fact by hand or finish the whole library before starting an application.</strong></p></section>' +
        (failed.length ? '<div class="gf-callout"><h3>' + failed.length + ' saved document' + (failed.length === 1 ? ' needs' : 's need') + ' another reading attempt</h3><p>Your original files are safe. Long documents are now supported up to 1,000,000 characters; there is no need to split a supported document yourself.</p>' + failed.map(d => '<p>' + esc(d.title) + ' ' + btn('prepare-document', 'Read saved document', d.id) + '</p>').join('') + '</div>' : '') +
        '<div class="gf-grid">' +
        card('1', 'Add your documents', 'Keep the originals in Document Vault. Choose Read & suggest facts to process a document. You can pause and resume without losing completed sections.', 'go-vault', 'Open Document Vault', uploaded.length + ' originals saved') +
        card('2', 'Review suggested facts', 'Compare each fact with its source. Approve accurate information for grants, keep it private, or leave it for later. Plans must stay labeled as plans.', 'go-truth', 'Review facts', ready.length + ' facts usable for drafting · ' + pending.length + ' need attention') +
        card('3', 'Start a grant application', 'Upload or paste the funder’s actual questions. The application will guide you through choosing a program, drafting answers, checking claims, and exporting.', 'new', 'Start an application', s.data.applications.length + ' saved application' + (s.data.applications.length === 1 ? '' : 's')) + '</div>' +
        '<section class="gf-card"><h3>What does each step mean?</h3><p><strong>Saved:</strong> the original file is in your private vault. <strong>Read:</strong> its text is available. <strong>Suggested:</strong> facts have been pulled out for you to check. <strong>Ready for drafting:</strong> both the fact and its source meet the grant-use rules.</p><p>Research Library contains community statistics and research. Organization Brain contains facts about your organization. Grant Factory can use relevant approved information from both.</p><p>It prepares drafts and downloads. You make the final decisions and submit through the funder’s process.</p><details><summary>Existing setup and advanced tools</summary><p>Your saved documents, facts, programs and writing voice remain in place. The seed import is only for an initial setup or missing seed records.</p>' + (s.data.role === 'OWNER' ? btn('seed', 'Import Institute seed data') + btn('voice', 'Writing voice') : '') + '</details></section>';
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
      let facts = s.data.brain.facts.filter(f => !f.research);
      if (s.reviewDocument) facts = facts.filter(f => f.source_document_id === s.reviewDocument);
      const groups =
        s.tab === "truth"
          ? [
              ["Needs your attention", f => !allowed(f) && !f.internal_only && !["INTERNAL_ONLY", "SUPERSEDED"].includes(f.verification_status)],
              [
                "Ready for drafting",
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
      const visibleGroups = groups.filter(([title]) => !["Needs Verification", "Conflicted", "Missing High-Priority Information"].includes(title));
      el.innerHTML =
        '<div class="gf-row"><div><h2>' +
        (s.tab === "truth" ? "Truth Review" : "Organization Brain") +
        '</h2><p class="gf-note">Check a fact against its source, then choose whether it can be used in grants. You can leave unrelated gaps for later. Planned programs remain plans.</p></div>' +
        btn("fact", "Add fact", "", true) +
        (s.data.role === "OWNER" ? btn("voice", "Writing voice") : "") +
        '</div>' + (s.reviewDocument ? '<p>Showing facts from one document. ' + btn('go-truth', 'Show all facts') + '</p>' : '') + '<input id="gf-search" class="gf-search" aria-label="Search organization facts" placeholder="Search enrollment, John Doe, theater, board…" value="' +
        esc(s.query) +
        '">' +
        visibleGroups
          .map(
            ([title, test]) =>
              '<details class="gf-card" ' + (title === "Needs your attention" || s.tab === "brain" ? 'open' : '') + '><summary><strong>' +
              title +
              ' · ' + facts.filter(test).length + "</strong></summary>" +
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
                    (allowed(f) ? '<span class="gf-meta">Ready for drafting</span>' : '<span class="gf-meta">Not available to drafts yet</span>') +
                    "</div><p>" +
                    esc(f.value || "Information needed") +
                    '</p><div class="gf-meta">' +
                    esc(f.source_reference || "No source linked") +
                    " · " +
                    esc(f.source_locator || "No locator") +
                    (f.application_id ? " · Application-specific" : "") +
                    '</div>' + (!allowed(f) ? '<p class="gf-note">' + esc((f.draft_blockers || []).join(' ')) + '</p>' : '') + btn('review-fact', 'Review this fact', f.id) + '</div>',
                )
                .join("") +
              (facts.filter(test).length
                ? ""
                : '<p class="gf-note">No items in this group.</p>') +
              "</details>",
          )
          .join("");
    }
    function researchDetail(r) {
      const list = (title, values) => '<p><strong>' + title + '</strong></p><ul>' + (values || []).map(v => '<li>' + esc(v) + '</li>').join('') + '</ul>';
      const url = /^https?:\/\//i.test(r.source_url || '') ? '<a href="' + esc(r.source_url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.source_org) + '</a>' : esc(r.source_org);
      return '<p>' + esc(r.finding) + '</p><p><strong>Approved wording</strong><br>' + esc(r.approved_language) + '</p>' +
        '<p class="gf-meta">' + esc(r.geography) + ' · ' + esc(r.year) + ' · ' + esc(r.population) + '</p>' +
        '<p>' + url + '</p><p><strong>Method:</strong> ' + esc(r.methodology) + '</p>' +
        list('Supports',r.supports) + list('Limits',r.does_not_support) + list('Do not claim',r.prohibited_language) +
        (r.qa_flags?.length ? list('Source cautions',r.qa_flags.map(label)) : '') +
        '<p class="gf-note">Verification: ' + esc(label(r.verification_status)) + ' · ' + esc(r.last_verified || 'Not independently verified') + '. ' + esc(r.verification_scope || '') + '</p>';
    }
    function renderResearch(el) {
      const library = s.data.brain.research || { packages: [], records: [], packets: [], statistics: [], rules: [], aliases: [] };
      const packet = library.packets.find(p => p.package_version + '/' + p.packet_id === s.researchPacket);
      const ids = packet ? new Set([...(packet.priority_evidence_ids || []),...(packet.need_evidence_ids || []),...(packet.research_evidence_ids || [])]) : null;
      const query = s.researchQuery.trim().toLowerCase();
      const records = library.records.filter(r => {
        if (packet && (r.package_version !== packet.package_version || !ids.has(r.record_id))) return false;
        const alias = (library.aliases || []).find(a => a.package_version === r.package_version && a.legacy_record_id.toLowerCase() === query);
        if (alias) return r.record_id === alias.canonical_record_id;
        return !query || JSON.stringify([r.record_id,r.topic,r.finding,r.funding_tags,r.geography,r.approved_language]).toLowerCase().includes(query);
      });
      el.innerHTML = '<div class="gf-row"><div><h2>Research Library</h2><p class="gf-note">Community context and intervention research. Only verified records are eligible for drafting. Every claim still requires review.</p></div></div>' +
        (!library.packages.length ? '<p>No active research package is assigned to this workspace.</p>' :
        '<p>' + library.records.length + ' evidence records · ' + library.records.filter(r => r.external_use_status === 'VERIFIED').length + ' verified · ' + library.packets.length + ' funder packets</p>' +
        library.packages.map(p => btn('research-document','Download master volume',p.package_version)).join('') +
        '<form id="gf-research-form" class="gf-card"><div class="two">' + field('query','Search evidence or background',s.researchQuery) + select('packet','Funder packet',[['','All packets'],...library.packets.map(p=>[p.package_version + '/' + p.packet_id,p.name])],s.researchPacket) + '</div><button class="btn btn-primary" type="submit">Search</button></form>' +
        (packet ? '<section class="gf-card"><h3>' + esc(packet.name) + '</h3><p>' + esc(packet.approved_narrative) + '</p><p><strong>Limits:</strong> ' + esc(packet.prohibited_claims) + '</p><p class="gf-note">Packet language guides planning; only eligible evidence records support draft claims.</p></section>' : '') +
        '<h3>Evidence · ' + records.length + '</h3>' + records.map(r=>'<details class="gf-card"><summary>' + esc(r.record_id + ' · ' + r.topic) + ' ' + pill(r.external_use_status) + ' · ' + esc(r.geography_scope.join(', ') + ' / ' + r.evidence_domain) + '</summary>' + researchDetail(r) + '</details>').join('') +
        '<details class="gf-card"><summary>Strongest statistics</summary>' + library.statistics.filter(t=>!packet || (t.package_version === packet.package_version && packet.strongest_statistic_ids.includes(t.stat_id))).map(t=>'<div class="gf-list-row"><strong>' + esc(t.stat_id + ' · ' + t.finding) + '</strong> ' + pill(t.external_use_status) + '<p class="gf-meta">' + esc(t.geography + ' · ' + t.year + ' · ' + t.population) + '</p><p>' + esc(t.best_use) + '</p><ul>' + (t.cautions || []).map(c=>'<li>' + esc(c) + '</li>').join('') + '</ul><p>Source: ' + esc(t.source_org) + ' · Evidence ' + esc(t.record_id) + '</p></div>').join('') + '</details>' +
        '<details class="gf-card"><summary>Claim rules · ' + library.rules.length + '</summary>' + library.rules.map(r=>'<p><strong>' + esc(r.rule_id + ' · ' + r.title) + '</strong><br>' + esc(r.rule) + '</p>').join('') + '</details>' +
        '<section class="gf-card"><h3>Background research</h3><p class="gf-note">Background only. Historical prose may contain superseded wording; use the canonical records and rules for external claims.</p>' +
        (s.researchBackground ? '<p>' + s.researchBackground.total + ' matching sections</p>' + s.researchBackground.sections.map(r=>'<details><summary>' + esc(r.title || r.section_id) + '</summary><p class="gf-meta">' + esc(r.section_id + ' · ' + r.source_locator) + '</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">' + esc(r.content_markdown) + '</pre></details>').join('') + (s.researchBackground.offset > 0 ? btn('research-page','Previous sections',String(Math.max(0,s.researchBackground.offset-20))) : '') + (s.researchBackground.offset + 20 < s.researchBackground.total ? btn('research-page','More sections',String(s.researchBackground.offset+20)) : '') : '<p>Enter a search to find background sections.</p>') + '</section>');
      const form = el.querySelector('#gf-research-form');
      if (form) form.onsubmit = async event => {
        event.preventDefault();
        if (s.busy) return;
        const values = new FormData(form);
        s.researchQuery = String(values.get('query') || '').slice(0,300);
        s.researchPacket = String(values.get('packet') || '');
        await perform('research-page','0');
      };
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
      const documents = s.data.brain.documents;
      const uploaded = documents.filter(d => d.storage_path);
      const checklist = documents.filter(d => !d.storage_path);
      el.innerHTML =
        '<div class="gf-row"><div><h2>Document Vault</h2><p class="gf-note">1. Upload a file. 2. Read & suggest facts. 3. Review those facts. Your original stays private.</p></div>' +
        btn("upload", "Upload document", "", true) +
        '</div><p class="gf-note">PDF, Word (DOCX), or text · up to 3 MB per file · long documents up to 1,000,000 characters and 500 PDF pages. Large documents are read in small sections with saved progress.</p><input id="gf-search" class="gf-search" aria-label="Search documents" placeholder="Find a saved document…" value="' + esc(s.query) + '"><div class="gf-card gf-scroll"><table><thead><tr><th>Your saved documents</th><th>Reading progress</th><th>Suggested facts</th><th>Next step</th></tr></thead><tbody>' +
        uploaded
          .map(
            (d) =>
              '<tr data-search="' + esc((d.title + ' ' + d.filename).toLowerCase()) + '"><td>' +
              esc(d.title) +
              '<div class="gf-meta">' +
              esc(d.filename || "User can provide") +
              "</div></td><td>" +
              (d.extraction_status !== 'COMPLETE' ? '<strong>Needs another reading attempt</strong>' : d.document_type === 'GRANT_APPLICATION' ? 'Ready as an application source' : d.fact_extraction?.status === 'COMPLETE' ? 'All sections processed' : d.fact_extraction ? d.fact_extraction.next_batch + ' of ' + d.fact_extraction.total_batches + ' sections processed' : 'Text ready · no section progress recorded') +
              "</td><td>" + s.data.brain.facts.filter(f => f.source_document_id === d.id).length +
              "</td><td>" +
              (d.document_type !== 'GRANT_APPLICATION' && d.sensitivity_level !== 'RESTRICTED' && d.fact_extraction?.status !== 'COMPLETE' ? btn('prepare-document', d.fact_extraction ? 'Resume reading' : 'Read & suggest facts', d.id, true) : '') +
              btn('review-document', 'Review facts', d.id) + btn("document", "Details & original", d.id) +
              "</td></tr>",
          )
          .join("") +
        '</tbody></table></div><details class="gf-card"><summary>Suggested document checklist</summary><p class="gf-note">These are reminders, not additional uploads or errors. You can start a grant with the documents relevant to that application.</p>' + checklist.map(d => '<p><strong>' + esc(d.title) + '</strong> · ' + (uploaded.some(u => u.document_type === d.document_type) ? 'A document of this type is saved; check its details and date.' : 'Add when needed for an application.') + '</p>').join('') + '</details>';
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
        '</div></div>' + (!locked ? '<div class="gf-callout"><strong>Next step: </strong>' + (!a.parser_reviewed ? 'Check the questions and limits against the original, then confirm extraction review. This check is needed again after questions change.' : !a.strategy?.approved ? 'Open Strategy & eligibility. Choose your program, write or generate a strategy, and confirm that you reviewed it.' : 'Draft one answer, save edits, then audit its claims. Resolve missing information before approving and exporting.') + '<p class="gf-note">Drafts use the latest approved facts each time. You do not need to recreate an application when you update your facts.</p></div>' : '') + '<div class="gf-tabs">' +
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
                '</p><div class="gf-toolbar">' +
                (!locked
                  ? (q.question_type === 'NARRATIVE' && a.parser_reviewed && a.strategy?.approved ? btn("draft", "Draft from evidence", q.id) : '<span class="gf-note">' + (q.question_type !== 'NARRATIVE' ? 'Enter this response yourself.' : 'Complete the next step above to enable drafting.') + '</span>') +
                    btn("save-answer", "Save & select evidence", q.id, true) +
                    btn("audit", "Audit claims", q.id) +
                    btn("approve-answer", "Approve answer", q.id)
                  : "") +
                pill(ans?.status || "NOT_STARTED") +
                '</div>' + (ans?.status === 'NEEDS_INPUT' ? '<div class="gf-callout"><strong>This answer needs more information.</strong>' + (a.inputs || []).filter(i => i.question_id === q.id && i.status !== 'RESOLVED').map(i => '<p>' + esc(i.prompt) + '</p>').join('') + '<button data-apptab="input" class="btn btn-ghost btn-sm">Answer these questions</button></div>' : '') + '<details><summary>Why did OA say this?</summary>' +
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
    async function prepareDocument(id) {
      let doc = await api('document', { id });
      let paused = false;
      const modal = dialog('Read document & suggest facts', '<h3>' + esc(doc.title) + '</h3><p>Each completed section is saved. Keep this window open while reading. Closing it pauses after the current section; you can resume from Document Vault.</p><p><strong>Suggestions still need your review before grant writing can use them.</strong></p><progress id="gf-reading-progress" max="1" value="0"></progress><p id="gf-reading-status" role="status">Preparing your document…</p><div id="gf-reading-result"></div><button type="button" class="btn btn-ghost" id="gf-pause-reading">Pause after this section</button>', null);
      const status = modal.querySelector('#gf-reading-status');
      const meter = modal.querySelector('#gf-reading-progress');
      modal.querySelector('#gf-pause-reading').onclick = () => { paused = true; status.textContent = 'Finishing this section, then pausing. Completed work is saved.'; };
      modal.addEventListener('close', () => { paused = true; });
      try {
        if (doc.extraction_status !== 'COMPLETE') {
          status.textContent = 'Reading text from your saved original…';
          const read = await api('retry_extraction', { id, revision: doc.revision });
          if (read.extraction_status !== 'COMPLETE') throw Error(read.extraction_error || 'Text could not be read. The original is still saved.');
          doc = await api('document', { id });
        }
        let progress = doc.fact_extraction;
        let cursor;
        while (!paused && modal.isConnected && progress?.status !== 'COMPLETE') {
          status.textContent = progress ? 'Reading section ' + (progress.next_batch + 1) + ' of ' + progress.total_batches + '. ' + progress.proposals + ' suggestions saved so far.' : 'Reading the first section and suggesting facts…';
          const out = await api('propose_facts', { id, ...(cursor != null ? {batch_index:cursor} : {}) });
          progress = out.progress;
          cursor = progress.next_batch;
          meter.max = progress.total_batches || 1; meter.value = progress.next_batch;
        }
        if (modal.isConnected) {
          status.textContent = progress?.status === 'COMPLETE' ? 'All ' + progress.total_batches + ' sections processed. ' + progress.proposals + ' fact suggestions saved for review.' : 'Paused. Completed sections are saved. Choose Resume reading in Document Vault to continue.';
          modal.querySelector('#gf-reading-result').innerHTML = (progress?.warnings || []).map(w => '<p class="gf-note">' + esc(w) + '</p>').join('') + btn('review-document', 'Review these facts', id, true);
          modal.querySelector('[data-action="review-document"]').onclick = () => { modal.close(); s.reviewDocument = id; s.tab = 'truth'; s.app = null; render(); };
        }
      } catch (error) {
        if (modal.isConnected) {
          status.textContent = 'Reading paused. Your original and completed sections are saved.';
          const alert = modal.querySelector('[role=alert]'); alert.hidden = false;
          alert.textContent = error.message + ' Close this window and restart reading from Document Vault.';
        }
      } finally {
        if (modal.isConnected) modal.querySelector('#gf-pause-reading').hidden = true;
        await refresh();
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
        if (action === 'prepare-document') {
          await prepareDocument(id);
        } else if (action === 'go-vault' || action === 'go-truth' || action === 'review-document') {
          s.tab = action === 'go-vault' ? 'vault' : 'truth'; s.app = null;
          s.reviewDocument = action === 'review-document' ? id : null; s.query = ''; render();
        } else if (action === 'review-fact') {
          const fact = s.data.brain.facts.find(f => f.id === id);
          const source = s.data.brain.documents.find(d => d.id === fact.source_document_id);
          const modal = dialog('Review a fact for grant writing', '<h3>' + esc(fact.display_name) + '</h3><p class="gf-note">Check the meaning, dates and source. Only approve what you can stand behind. A planned program is not an achieved outcome.</p>' + area('value', 'Fact to use', fact.value) + '<div class="gf-source"><strong>' + esc(fact.source_reference || 'Source not provided') + ' · ' + esc(fact.source_locator || '') + '</strong><p>' + esc(fact.source_quote || 'No document quote is attached. Use the full fact editor if this needs a document source.') + '</p></div>' + (fact.draft_blockers || []).map(r => '<p class="gf-note">' + esc(r) + '</p>').join('') + select('decision', 'What should happen to this fact?', [['later', 'Leave for later'], ['approve', 'Approve for grant writing'], ['planned', 'Approve as a plan / projection'], ['private', 'Keep internal only']], 'later') + (source && !source.external_use_allowed && source.sensitivity_level !== 'RESTRICTED' ? check('approve_source', 'I reviewed this source and approve it for grant use and attachments. The vault file stays private.') : '') + (fact.conflict_ids?.length ? check('resolve_conflict', 'I checked the conflicting facts and explained the resolution below.', fact.conflict_resolution?.resolved) : '') + area('notes', 'Review notes (optional unless resolving a conflict)', fact.notes) + check('reviewed', 'I checked this fact and its source.') + '<p>' + btn('advanced-fact', 'Open full fact editor', id) + '</p>', async values => {
            const decision = values.get('decision');
            if (decision === 'later') return;
            if (s.data.role !== 'OWNER') throw Error('An organization owner must approve facts for grant use. You can propose changes in the full fact editor.');
            if (!values.has('reviewed')) throw Error('Confirm that you checked this fact and its source.');
            const {draft_ready, draft_blockers, ...saved} = fact;
            const permit = decision === 'approve' || decision === 'planned';
            await mutate('save_fact', { id, revision: fact.revision, brain_revision:s.data.brain.revision, approve_source: values.has('approve_source'), fact: {...saved, value:values.get('value'), verification_status:decision === 'private' ? 'INTERNAL_ONLY' : decision === 'planned' ? 'PROJECTED' : fact.source_document_id && fact.source_quote ? 'VERIFIED' : 'APPROVED', external_use_allowed:permit, grant_use_allowed:permit, internal_only:!permit, review_required:false, notes:values.get('notes'), resolve_conflict:values.has('resolve_conflict') } });
            message('Your review is saved. The readiness label shows whether anything still needs attention.');
          });
          modal.querySelector('[data-action="advanced-fact"]').onclick = () => { modal.close(); perform('fact', id); };
        } else if (action === "research-page") {
          s.researchBackground = await api("research_search", { query: s.researchQuery, offset: Number(id) });
          render();
        } else if (action === "research-document") {
          download(await api("research_document", { package_version: id }));
        } else if (action === "seed")
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
              s.tab = 'applications';
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
          if (f.research) {
            dialog("Research evidence · read only", researchDetail(f.research), async () => {});
            return;
          }
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
              await mutate("save_fact", {
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
              s.tab = 'vault'; s.app = null; s.query = ''; render();
              message(
                r.extraction_status === "FAILED"
                  ? "Original saved. Extraction failed: " + r.extraction_error
                  : "Original saved and text ready. Next, choose Read & suggest facts beside this document.",
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
                  btn("propose-facts", "Read & suggest facts", id) +
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
                  else if (b.dataset.action === 'propose-facts') {
                    modal.close();
                    await perform('prepare-document', id);
                  }
                  else {
                    const result = await api(
                      "retry_extraction",
                      { id, revision: d.revision },
                    );
                    modal.close();
                    await refresh();
                    message(
                      result.extraction_status === 'COMPLETE' ? 'Text is ready. Next, choose Read & suggest facts.' : 'The original is saved, but text could not be read: ' + result.extraction_error,
                      result.extraction_status !== 'COMPLETE',
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
