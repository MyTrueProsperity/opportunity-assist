/* FinCap Review: editorial queue for grants shared with NationalFinCap.org.
   Admin only. Every action calls a SECURITY DEFINER database function that
   re-checks the administrator role, so hiding this screen is a convenience,
   not the security boundary. Nothing here publishes without Approve. */
(function () {
  'use strict';
  var root, sb, tab = 'pending', items = [], preview = null;
  var TABS = [['pending', 'Pending review'], ['recheck', 'Needs re-check'], ['published', 'Published'], ['closed', 'Rejected and withdrawn'], ['newsletter', 'Newsletter']];
  var STATUS_TEXT = { pending_review: 'Pending review', approved: 'Published', rejected: 'Rejected', withdrawn: 'Withdrawn' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function val(id, card) { var e = card.querySelector('[data-f="' + id + '"]'); return e ? (e.type === 'checkbox' ? e.checked : e.value) : undefined; }
  function notice(text, bad) { var n = root.querySelector('#fc-notice'); n.textContent = text; n.hidden = !text; n.style.borderColor = bad ? 'var(--bad)' : 'var(--line)'; }
  function inp(label, f, v, type, extra) {
    return '<div class="field" style="margin:0"><label for="fc-' + f + '">' + esc(label) + '</label><input id="fc-' + f + '" data-f="' + f + '" type="' + (type || 'text') + '" value="' + esc(v) + '" ' + (extra || '') + ' /></div>';
  }

  function load() {
    var status = tab === 'pending' ? 'pending_review' : tab === 'recheck' ? 'needs_review' : tab === 'published' ? 'approved' : 'all';
    root.querySelector('#fc-list').innerHTML = '<p class="hint">Loading…</p>';
    sb.rpc('fincap_admin_list', { p_status: status, p_limit: 50 }).then(function (r) {
      if (r.error) { root.querySelector('#fc-list').innerHTML = '<p class="error">' + esc(r.error.message) + '</p>'; return; }
      items = (r.data || []).filter(function (s) { return tab !== 'closed' || s.status === 'rejected' || s.status === 'withdrawn'; });
      drawList();
      autoDraft(items.filter(function (s) { return s.status === 'pending_review' && !(s.draft && s.draft.summary); }));
    });
  }

  // Ask the server to draft the public summary. Returns the text; saving is separate.
  function draftSummary(s) {
    return sb.auth.getSession().then(function (r) {
      var token = r.data.session && r.data.session.access_token;
      return fetch('/.netlify/functions/fincap-draft-summary', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ submission_id: s.id }) });
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok || !b.summary) throw new Error(b.error || 'Could not draft a summary.'); return b.summary; }); });
  }

  // Draft and save summaries one at a time for cards that have none, so the
  // editor only has to read and approve. Never overwrites anything typed.
  function autoDraft(list) {
    list.reduce(function (p, s) {
      return p.then(function () {
        var el = s._el; if (!el || !el.isConnected) return;
        var box = el.querySelector('[data-f="summary"]'), hint = el.querySelector('[data-sum-hint]');
        if (box.value.trim()) return;
        hint.textContent = 'Drafting a summary…';
        return draftSummary(s).then(function (text) {
          if (!el.isConnected || box.value.trim()) return;
          return sb.rpc('fincap_admin_edit', { p_id: s.id, p_fields: { summary: text }, p_version: s.version }).then(function (r) {
            if (r.error) throw r.error;
            s.version = r.data.version; s.problem = r.data.problem; s.draft.summary = text;
            if (!box.value.trim()) box.value = text;
            hint.textContent = 'Drafted automatically. Read it before approving; edit anything that is not right.';
            showProblem(s, el);
          });
        }).catch(function (err) { hint.textContent = (err.message || String(err)) + ' You can use "Draft summary" to try again.'; });
      });
    }, Promise.resolve());
  }

  // The last-verified date is filled in with today on screen when the source
  // has none, so that check is not a blocker once the field has a value.
  function showProblem(s, el) {
    var p = s.problem, dated = el.querySelector('[data-f="last_verified_on"]').value;
    if (p === 'A last-verified date is required.' && dated) p = null;
    el.querySelector('[data-problem]').innerHTML = p ? '<strong>Before this can be published:</strong> ' + esc(p) : 'Ready to publish.';
  }

  function drawList() {
    var list = root.querySelector('#fc-list');
    if (!items.length) { list.innerHTML = '<div class="empty">Nothing here.</div>'; return; }
    list.innerHTML = '';
    items.forEach(function (s) { list.appendChild(card(s)); });
  }

  function card(s) {
    var d = s.draft || {}, el = document.createElement('div');
    el.className = 'card'; el.style.marginBottom = '14px'; s._el = el;
    var editable = s.status === 'pending_review' || s.status === 'approved';
    var live = s.status === 'approved';
    el.innerHTML =
      '<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><h2 style="margin:0">' + esc(d.title || 'Untitled') + '</h2>' +
      '<span><span class="tag">' + esc(STATUS_TEXT[s.status] || s.status) + '</span> ' +
      (s.needs_review ? '<span class="tag s-mid">Source changed: re-verify</span> ' : '') +
      (s.has_unpublished_edits ? '<span class="tag s-mid">Edits not yet published</span>' : '') + '</span></div>' +
      '<p class="hint">Cycle ' + esc(s.cycle_key) + '. Private attribution (never shown publicly): ' + esc((s.shared_by_orgs || []).join(', ') || 'none') + '.</p>' +
      (s.needs_review_reason ? '<p class="warn-note">' + esc(s.needs_review_reason) + ' The public page still shows the last approved version until you re-approve.</p>' : '') +
      (s.decision_reason ? '<p class="hint">Last decision note: ' + esc(s.decision_reason) + '</p>' : '') +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px">' +
      inp('Title', 'title', d.title) + inp('Funder', 'funder', d.funder) + inp('Official source link', 'source_url', d.source_url, 'url') +
      inp('Amount or range', 'amount_text', d.amount_text) +
      '<div class="field" style="margin:0"><label>&nbsp;</label><label style="font-weight:400"><input type="checkbox" style="width:auto;margin-right:6px" data-f="amount_verified" ' + (d.amount_verified ? 'checked' : '') + ' /> Amount verified at the funder (unverified amounts are not published)</label></div>' +
      '<div class="field" style="margin:0"><label for="fc-deadline_kind">Deadline type</label><select id="fc-deadline_kind" data-f="deadline_kind">' +
      ['fixed', 'rolling', 'unknown'].map(function (k) { return '<option value="' + k + '"' + (d.deadline_kind === k ? ' selected' : '') + '>' + { fixed: 'Fixed date', rolling: 'Rolling (no fixed deadline)', unknown: 'Not confirmed' }[k] + '</option>'; }).join('') + '</select></div>' +
      inp('Deadline date', 'deadline', d.deadline || '', 'date') + inp('Deadline time zone', 'deadline_tz', d.deadline_tz) +
      '<div class="field" style="margin:0"><label>&nbsp;</label><label style="font-weight:400"><input type="checkbox" style="width:auto;margin-right:6px" data-f="deadline_verified" ' + (d.deadline_verified ? 'checked' : '') + ' /> Deadline verified at the funder</label></div>' +
      inp('Last verified', 'last_verified_on', d.last_verified_on || (editable ? new Date().toLocaleDateString('en-CA') : ''), 'date') +
      inp('Geography or restrictions', 'geography', d.geography) + inp('Program areas (comma separated)', 'program_areas', (d.program_areas || []).join(', ')) +
      '</div>' +
      '<div class="field" style="margin-top:10px"><label for="fc-elig">Who can apply</label><textarea id="fc-elig" data-f="eligible_applicants" rows="2">' + esc(d.eligible_applicants || '') + '</textarea></div>' +
      '<div class="field"><label for="fc-sum">Public summary (2 to 4 sentences, organization-neutral; drafted automatically when empty)</label>' +
      '<textarea id="fc-sum" data-f="summary" rows="4">' + esc(d.summary || '') + '</textarea>' +
      (editable ? '<p class="hint"><button class="btn btn-ghost btn-sm" data-a="draft">Draft summary</button> <span data-sum-hint>Writes a fresh draft from the funder\'s listing. Nothing is published until you approve.</span></p>' : '') + '</div>' +
      '<p class="hint" data-problem></p>' +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">' +
      (s.status === 'pending_review' || live ? '<button class="btn btn-ghost btn-sm" data-a="save">Save edits</button><button class="btn btn-primary btn-sm" data-a="approve">' + (live ? 'Save and re-approve' : 'Save and approve') + '</button>' : '') +
      (s.status === 'pending_review' ? '<button class="btn btn-ghost btn-sm" data-a="reject">Reject</button>' : '') +
      (live ? '<button class="btn btn-ghost btn-sm" data-a="withdraw">Withdraw</button>' : '') +
      (s.status === 'rejected' || s.status === 'withdrawn' ? '<button class="btn btn-ghost btn-sm" data-a="reopen">Reopen</button>' : '') + '</div>';
    showProblem(s, el);
    el.addEventListener('click', function (e) {
      var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a'); if (!a) return;
      run(s, el, a, e.target);
    });
    return el;
  }

  function fields(c) {
    return {
      title: val('title', c), funder: val('funder', c), source_url: val('source_url', c), amount_text: val('amount_text', c),
      amount_verified: val('amount_verified', c), deadline_kind: val('deadline_kind', c), deadline: val('deadline', c) || '',
      deadline_tz: val('deadline_tz', c), deadline_verified: val('deadline_verified', c), last_verified_on: val('last_verified_on', c) || '',
      geography: val('geography', c), eligible_applicants: val('eligible_applicants', c), summary: val('summary', c),
      program_areas: String(val('program_areas', c) || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
    };
  }

  function run(s, c, a, btn) {
    if (a === 'draft') {
      var box = c.querySelector('[data-f="summary"]');
      if (box.value.trim() && !window.confirm('Replace the current summary with a new draft?')) return;
      btn.disabled = true; btn.textContent = 'Drafting…';
      draftSummary(s).then(function (text) { box.value = text; notice('New draft added. Read it, then save or approve.'); })
        .catch(function (err) { notice(err.message || String(err), true); })
        .then(function () { btn.disabled = false; btn.textContent = 'Draft summary'; });
      return;
    }
    var reason = null;
    if (a === 'reject' || a === 'withdraw') {
      reason = window.prompt(a === 'reject' ? 'Why is this being rejected? (kept in the private audit trail)' : 'Why is this being withdrawn? (it leaves the public page and feed immediately)');
      if (!reason || !reason.trim()) return;
    }
    if (a === 'approve' && !window.confirm('Publish this to NationalFinCap.org? It will appear on the Funding Opportunities page and in newsletter exports.')) return;
    btn.disabled = true; notice('');
    var step = (a === 'save' || a === 'approve')
      ? sb.rpc('fincap_admin_edit', { p_id: s.id, p_fields: fields(c), p_version: s.version })
      : Promise.resolve({ data: { version: s.version } });
    step.then(function (r) {
      if (r.error) throw r.error;
      if (a === 'save') return r;
      return sb.rpc('fincap_admin_decide', { p_id: s.id, p_action: a, p_reason: reason, p_version: r.data.version });
    }).then(function (r) {
      if (r.error) throw r.error;
      notice(a === 'save' ? 'Saved. Nothing was published.' : 'Done: ' + a + '.'); load();
    }).catch(function (err) { btn.disabled = false; notice(err.message || String(err), true); if (/changed/.test(err.message || '')) load(); });
  }

  function nextIssueDate() {
    var d = new Date(), y = d.getFullYear(), m = d.getMonth();
    if (d.getDate() > 10) m += 1;
    return new Date(y, m, 10).toLocaleDateString('en-CA');
  }

  function drawNewsletter() {
    var list = root.querySelector('#fc-list');
    list.innerHTML =
      '<div class="card"><h2>Newsletter export</h2>' +
      '<p class="hint">Builds the list of approved, still-open opportunities for an issue. Previewing does not record or send anything.</p>' +
      '<div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px">' +
      '<div class="field" style="margin:0"><label for="fc-issue">Issue date</label><input id="fc-issue" type="date" value="' + nextIssueDate() + '" /></div>' +
      '<div class="field" style="margin:0"><label for="fc-rep">Repeat deadline reminders within (days, optional)</label><input id="fc-rep" type="number" min="0" max="60" style="width:120px" /></div>' +
      '<button class="btn btn-primary btn-sm" id="fc-prev">Preview export</button></div>' +
      '<div id="fc-out" style="margin-top:14px"></div></div>';
    list.querySelector('#fc-prev').addEventListener('click', function () {
      var issue = list.querySelector('#fc-issue').value, rep = list.querySelector('#fc-rep').value;
      if (!issue) return;
      // Call the function directly: the /api/fincap/* redirect aliases are not applied on every deploy.
      var q = '/.netlify/functions/fincap-feed?view=newsletter&issue=' + encodeURIComponent(issue) + (rep !== '' ? '&repeat_within_days=' + encodeURIComponent(rep) : '');
      var out = list.querySelector('#fc-out'); out.innerHTML = '<p class="hint">Loading…</p>';
      Promise.all([fetch(q).then(function (r) { return r.json(); }), fetch(q + '&format=md').then(function (r) { return r.text(); })]).then(function (x) {
        preview = { issue: issue, json: x[0], md: x[1] };
        out.innerHTML =
          '<p class="hint">' + x[0].items.length + ' item(s) for the issue dated ' + esc(issue) + '. ' + (x[0].held_for_recheck.length ? x[0].held_for_recheck.length + ' held for re-verification. ' : '') + (x[0].previously_included_count || 0) + ' already ran in an earlier issue.</p>' +
          '<textarea readonly rows="14" style="width:100%;font-family:monospace;font-size:.85rem" aria-label="Newsletter export">' + esc(x[1]) + '</textarea>' +
          '<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" id="fc-copy">Copy</button></div>' +
          '<hr style="margin:16px 0;border:0;border-top:1px solid var(--line)" />' +
          '<h3 style="margin:0 0 6px">After the issue is finalized</h3>' +
          '<p class="hint">Recording tells the system which items actually ran, so they are not repeated by accident. It does not send email.</p>' +
          '<label style="font-weight:400;display:block;margin:8px 0"><input type="checkbox" style="width:auto;margin-right:6px" id="fc-sent" /> The email has actually been sent</label>' +
          '<button class="btn btn-primary btn-sm" id="fc-rec"' + (x[0].items.length ? '' : ' disabled') + '>Record these items as included</button>';
        out.querySelector('#fc-copy').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(preview.md); notice('Copied.'); });
        out.querySelector('#fc-rec').addEventListener('click', function () {
          if (!window.confirm('Record ' + preview.json.items.length + ' item(s) as included in the ' + preview.issue + ' issue?')) return;
          sb.rpc('fincap_record_issue', { p_issue_date: preview.issue, p_public_ids: preview.json.items.map(function (i) { return i.id; }), p_note: null, p_sent_at: out.querySelector('#fc-sent').checked ? new Date().toISOString() : null })
            .then(function (r) { notice(r.error ? r.error.message : 'Recorded ' + r.data.items_recorded + ' item(s)' + (r.data.sent ? ' as sent.' : '. Marked as not yet sent.'), !!r.error); });
        });
      }).catch(function () { out.innerHTML = '<p class="error">The export could not be loaded.</p>'; });
    });
  }

  function mount(main, client) {
    sb = client; root = main;
    main.innerHTML = '<div class="topbar"><div><h1>FinCap Review</h1><p class="sub">Grants passed by an organization and offered to NationalFinCap.org. Nothing is public until you approve it.</p></div></div>' +
      '<div class="row" role="group" aria-label="Review views" style="gap:6px;flex-wrap:wrap;margin-bottom:12px">' +
      TABS.map(function (t) { return '<button class="btn ' + (t[0] === tab ? 'btn-primary' : 'btn-ghost') + ' btn-sm" data-t="' + t[0] + '" aria-pressed="' + (t[0] === tab) + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<p class="warn-note" id="fc-notice" role="status" hidden></p><div id="fc-list"></div>';
    main.querySelectorAll('[data-t]').forEach(function (b) { b.addEventListener('click', function () { tab = b.getAttribute('data-t'); mount(main, sb); }); });
    if (tab === 'newsletter') drawNewsletter(); else load();
  }

  window.OAFinCapReview = { mount: mount };
})();
