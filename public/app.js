// Apply2Interview UI. Vanilla JS; every action goes through the host API,
// which records it as Jarvis protocol state.

const TOKEN = document.querySelector('meta[name="host-auth"]').content;
const main = document.getElementById("main");
let current = null;
let tab = "overview";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (hash) => (hash ? String(hash).replace(/^hash:/, "").slice(0, 10) : "");

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `HostAuth ${TOKEN}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.violations ? `\n${data.violations.map((v) => `• ${v.reason}`).join("\n")}` : "";
    throw new Error(`${data.error ?? response.statusText}${detail}`);
  }
  return data;
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 6000);
}

async function busy(button, fn) {
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (error) {
    toast(error.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ------------------------------------------------------------------ sidebar

async function loadSessions() {
  const { sessions } = await api("GET", "/api/sessions");
  const list = document.getElementById("sessions");
  list.innerHTML = sessions.length
    ? sessions.map((s) => `<li data-id="${esc(s.id)}" class="${current?.work_session.id === s.id ? "active" : ""}">
        <div class="title">${esc(s.title ?? "Untitled job")} <span class="pill ${esc(s.status)}">${esc(s.status)}</span></div>
        <div class="sub">${esc(s.job_url)}</div></li>`).join("")
    : '<li class="sub">No WorkSessions yet.</li>';
  list.querySelectorAll("li[data-id]").forEach((li) => li.addEventListener("click", () => open(li.dataset.id)));
  const { memory } = await api("GET", "/api/memory");
  document.getElementById("memory").innerHTML = memory.length
    ? memory.map((m) => `<li>${esc(m.memoryType)} · ${esc(m.memoryScope)}<br>${esc(JSON.stringify(m.content))}</li>`).join("")
    : '<li class="hint">Nothing yet. Memory is written only after you confirm a proposal.</li>';
}

async function open(id) {
  current = await api("GET", `/api/sessions/${id}`);
  render();
  loadSessions();
}

document.getElementById("cv-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  document.querySelector('textarea[name="master_cv"]').value = await file.text();
});

document.getElementById("new-session").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const facts = {
    name: form.get("name"),
    location: form.get("location"),
    visa: form.get("visa"),
    languages: String(form.get("languages") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...(form.get("relocate") ? { willing_to_relocate: true } : {}),
  };
  busy(event.submitter, async () => {
    current = await api("POST", "/api/sessions", { job_url: form.get("job_url"), master_cv: form.get("master_cv"), candidate_facts: facts });
    tab = "overview";
    render();
    loadSessions();
  });
});

// -------------------------------------------------------------- rendering

function render() {
  const v = current;
  const ws = v.work_session;
  const pending = v.requests.filter((r) => r.status === "pending" || r.status === "acknowledged");
  const terminal = ["completed", "failed", "cancelled", "closed"].includes(ws.status);
  main.innerHTML = `
    <section class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${esc(v.artifacts.jd?.title ?? "Job link")}${v.artifacts.jd?.company ? ` · ${esc(v.artifacts.jd.company)}` : ""}</h2>
        <span class="pill ${esc(ws.status)}">${esc(ws.status)}</span>
      </div>
      <p class="hint" style="word-break:break-all">${esc(v.job_url)}</p>
      <div class="status-bar">
        <span>WorkSession <code>${esc(ws.id)}</code></span>
        <span>revision <code>${ws.revision}</code></span>
        <span>last event <code>${short(ws.last_event_hash)}</code></span>
        <span>lock epoch <code>${v.lock_epoch}</code></span>
      </div>
      ${v.limitations.length ? `<p class="limitations">Limitations: ${v.limitations.map(esc).join(", ")}</p>` : ""}
      <div class="row" style="margin-top:10px">
        ${!terminal && !v.learning_proposed ? '<button data-act="learning">Propose learning</button>' : ""}
        ${!terminal ? '<button data-act="complete">Complete WorkSession</button>' : ""}
        ${!terminal ? '<button data-act="cancel" class="danger">Cancel</button>' : ""}
        ${terminal ? '<button data-act="export">Export evidence pack</button>' : ""}
      </div>
    </section>
    ${pending.map((r) => renderRequest(r)).join("")}
    <section class="card">
      <nav class="tabs">${["overview", "score", "cv", "email", "timeline", "evidence"].map((t) => `<button data-tab="${t}" class="${tab === t ? "on" : ""}">${t}</button>`).join("")}</nav>
      <div id="tab">${renderTab()}</div>
    </section>
    ${terminal ? renderOutcome() : ""}
  `;
  bind();
}

function renderRequest(r) {
  const action = r.requested_action.action;
  const v = current;
  let controls = "";
  if (action === "use_human_supplied_jd") {
    controls = `<textarea id="jd-text-${r.id}" rows="8" placeholder="Paste the job description exactly as you see it"></textarea>
      <div class="row"><button data-review="${r.id}" data-decision="answer">Answer with this JD</button>
      <button data-review="${r.id}" data-decision="deny" class="danger">Stop</button></div>`;
  } else if (action === "accept_cv_version") {
    const patch = v.artifacts.cv_patches.find((p) => p.ref === r.requested_action.target_ref)?.patch;
    const sections = patch?.sections ?? [];
    controls = `<p class="hint">Patch v${patch?.version}: tick the sections to keep. Unticked sections stay exactly as in your master CV.</p>
      ${sections.map((s) => `<label class="inline"><input type="checkbox" class="sec-${r.id}" value="${esc(s.section_id)}" checked> ${esc(s.section_id)} <span class="hint">(${esc(s.change)})</span></label>`).join("")}
      <div class="row">
        <button data-review="${r.id}" data-decision="approve">Accept all</button>
        <button data-review="${r.id}" data-decision="narrow">Accept ticked only</button>
        <button data-review="${r.id}" data-decision="needs_revision">Drop unticked &amp; revise</button>
        <button data-edit="${r.id}">Edit myself (takeover)</button>
        <button data-review="${r.id}" data-decision="deny" class="danger">Keep master CV</button>
      </div>
      <div id="edit-${r.id}" hidden>
        ${sections.map((s) => `<label>${esc(s.section_id)}<textarea class="edit-${r.id}" data-section="${esc(s.section_id)}" rows="6">${esc(s.after)}</textarea></label>`).join("")}
        <p class="hint">Reword freely; the truth guard refuses any fact that is not in your master CV or candidate facts.</p>
        <button data-review="${r.id}" data-decision="takeover">Save my edits</button>
      </div>`;
  } else if (action === "send_application_email") {
    const draft = v.artifacts.email_draft;
    controls = `<label>Subject<input id="email-subject-${r.id}" value="${esc(draft?.subject)}"></label>
      <label>Body<textarea id="email-body-${r.id}" rows="12">${esc(draft?.body)}</textarea></label>
      <div class="row">
        <button data-review="${r.id}" data-decision="approve">Approve this exact draft</button>
        <button data-review="${r.id}" data-decision="correct">Save my corrections</button>
        <button data-review="${r.id}" data-decision="deny" class="danger">Do not send</button>
      </div>
      <p class="hint">Approval never sends mail from this app. You get the approved draft to send yourself.</p>`;
  } else if (action === "confirm_memory") {
    const proposal = v.memory_proposals.find((m) => `memory-proposal:${m.id}` === r.requested_action.target_ref);
    controls = `<pre>${esc(JSON.stringify(proposal?.content, null, 2))}</pre>
      <div class="row"><button data-review="${r.id}" data-decision="approve">Confirm memory</button>
      <button data-review="${r.id}" data-decision="deny" class="danger">Reject</button></div>`;
  }
  return `<section class="card request">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Request · ${esc(r.type)} · ${esc(action)}</h2><span class="pill pending">${esc(r.status)}</span></div>
    <p class="why">${esc(r.reason_summary)}</p>
    <p class="meta">Blocks <b>${esc(r.blocking_scope)}</b> · risk ${esc(r.risk_class)} · if no response: ${esc(r.default_if_no_response.action)} — ${esc(r.default_if_no_response.reason)}</p>
    <ul class="options">${r.options.map((o) => `<li><b>${esc(o.label)}</b>: ${esc(o.effect)}</li>`).join("")}</ul>
    ${controls}
  </section>`;
}

function renderTab() {
  const v = current;
  const a = v.artifacts;
  if (tab === "overview") {
    const jd = a.jd;
    if (!jd) return '<p class="hint">No job description yet. The agent never invents one.</p>';
    const reqs = (list) => list.map((r) => `<li>${esc(r.text)} <span class="hint">[${esc(r.category)}${r.keywords.length ? `: ${r.keywords.map(esc).join(", ")}` : ""}]</span></li>`).join("");
    return `<p class="hint">Structured JD (schema in English, values verbatim). Language: <b>${esc(jd.language)}</b> — ${esc(jd.translation.note)}</p>
      <table><tr><th>Title</th><td>${esc(jd.title)}</td></tr><tr><th>Company</th><td>${esc(jd.company)}</td></tr>
      <tr><th>Location</th><td>${esc(jd.location)} · ${esc(jd.work_mode)}</td></tr><tr><th>Seniority</th><td>${esc(jd.seniority.level)}${jd.seniority.min_years ? `, ${jd.seniority.min_years}+ years` : ""}</td></tr>
      <tr><th>Source</th><td>${esc(jd.source.extraction)} · snapshot <span class="mono">${short(jd.source.snapshot_hash)}</span></td></tr></table>
      <h3>Must-haves</h3><ul>${reqs(jd.must_haves)}</ul>
      ${jd.nice_to_haves.length ? `<h3>Nice to have</h3><ul>${reqs(jd.nice_to_haves)}</ul>` : ""}
      ${jd.responsibilities.length ? `<h3>Responsibilities</h3><ul>${jd.responsibilities.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;
  }
  if (tab === "score") {
    const s = a.score_sheet;
    if (!s) return `<p class="hint">${v.has_master_cv ? "Not scored yet." : "No master CV was given, so nothing is scored."}</p>`;
    const p = s.apply_to_interview_pct;
    return `<div class="score-grid">
        <div class="score-box"><div class="hint">Fit score vs master CV</div><div class="big">${s.fit_score.value}<span class="hint">/100</span></div><p class="hint">${esc(s.fit_score.method)}</p></div>
        <div class="score-box"><div class="hint">apply_to_interview_pct · ${esc(p.label)}</div><div class="big">${p.value}%</div><div class="band ${esc(p.band)}">${esc(p.band.replaceAll("_", " "))}</div><p class="hint">${esc(p.disclaimer)}</p></div>
      </div>
      <h3>Formula</h3><pre>${esc(p.formula)}</pre>
      <table><tr><th>Term</th><th>Input</th><th>Points</th></tr>
        ${Object.entries(p.terms).map(([k, val]) => `<tr><td class="mono">${esc(k)}</td><td>${k in p.inputs && k !== "hard_blockers" ? p.inputs[k] : k === "hard_blocker_penalty" ? esc(p.inputs.hard_blockers.join("; ") || "none") : ""}</td><td>${val}</td></tr>`).join("")}
        <tr><th colspan="2">raw → clamped/capped</th><th>${p.raw} → ${p.value}</th></tr></table>
      ${s.unverified.length ? `<h3>Unverified (counted as 0.5)</h3><ul class="limitations">${s.unverified.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : ""}
      <h3>Requirements and evidence</h3>
      <table><tr><th>Requirement</th><th>Status</th><th>Evidence (verbatim CV lines)</th></tr>
        ${s.requirements.map((r) => `<tr><td>${esc(r.text)}<div class="hint">${esc(r.kind)} · ${esc(r.category)}</div></td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span><div class="hint">${esc(r.basis)}</div></td>
        <td>${r.evidence_quotes.length ? `<ul class="quotes">${r.evidence_quotes.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : '<span class="hint">none</span>'}</td></tr>`).join("")}</table>`;
  }
  if (tab === "cv") {
    if (!a.cv_patches.length) return '<p class="hint">No CV patch.</p>';
    const latest = a.cv_patches[a.cv_patches.length - 1].patch;
    return `<div class="row">
        ${a.accepted_cv ? `<a href="#" data-download="/api/sessions/${v.work_session.id}/cv/accepted.md">Download accepted CV (.md)</a>` : '<span class="hint">No accepted version yet.</span>'}
        <a href="#" data-download="/api/sessions/${v.work_session.id}/cv/patch.json">Download section patch (.json)</a>
      </div>
      <p class="hint">cvs_best_version v${latest.version}: section patch only, truth guard ${latest.truth_guard.passed ? "passed" : "failed"}. Unchanged: ${latest.unchanged_section_ids.map(esc).join(", ")}. ${a.cv_patches.length > 1 ? `Earlier versions stay as Contributions (${a.cv_patches.length - 1}).` : ""}</p>
      ${latest.sections.map((s) => `<h3>${esc(s.section_id)} · ${esc(s.change)} · invented: ${s.invented}</h3>
        <p class="hint">Addresses ${s.jd_requirements_addressed.map(esc).join(", ") || "—"}</p>
        <div class="diff"><div><h4>Before (master CV)</h4><pre>${esc(s.before)}</pre></div><div><h4>After</h4><pre>${esc(s.after)}</pre></div></div>`).join("")}
      ${a.accepted_cv ? `<h3>Accepted version</h3><pre>${esc(a.accepted_cv.text)}</pre>` : ""}`;
  }
  if (tab === "email") {
    const d = a.email_draft;
    if (!d) return '<p class="hint">No email draft.</p>';
    const h = a.email_handoff;
    const mailto = h ? `mailto:${encodeURIComponent(h.to ?? "")}?subject=${encodeURIComponent(h.subject)}&body=${encodeURIComponent(h.body)}` : null;
    return `<p class="hint">Language ${esc(d.language)} · ${h ? "approved for you to send" : "draft only, not approved"}${v.email_sent ? " · you marked it sent" : ""}</p>
      <table><tr><th>To</th><td>${esc(d.to ?? "—")}</td></tr><tr><th>Subject</th><td>${esc(d.subject)}</td></tr></table><pre>${esc(d.body)}</pre>
      ${h ? `<div class="row"><a href="${mailto}">Open in my mail app</a>${!v.email_sent ? '<button data-act="email-sent">I sent it</button>' : ""}</div>` : ""}`;
  }
  if (tab === "timeline") {
    return `<ul class="timeline">${v.events.map((e) => `<li><span class="seq">${e.sequence}</span>
        <span><span class="type ${e.actor_id.includes("agent") ? "actor-agent" : "actor-human"}">${esc(e.type)}</span><br><span class="hash">${short(e.previous_hash)} → ${short(e.event_hash)}</span></span>
        <span class="summary">${esc(e.payload.summary ?? `${e.payload.object_type} ${e.payload.action}`)}<br><span class="hint">${esc(e.actor_id)} · ${esc(e.timestamp)}</span></span></li>`).join("")}</ul>`;
  }
  if (tab === "evidence") {
    return `<table><tr><th>Evidence</th><th>Artifact</th><th>Hash</th><th>Captured by</th></tr>
      ${v.evidence.map((e) => `<tr><td>${esc(e.evidence_type)}<div class="hint">${esc(e.trust_label)}</div></td><td class="mono">${esc(e.artifact_ref)}</td><td class="mono">${short(e.content_hash)}</td><td>${esc(e.captured_by_actor_id)}</td></tr>`).join("")}</table>
      <h3>Policy decisions</h3><table>${v.policy_decisions.map((d) => `<tr><td class="mono">${esc(d.requested_action.action)}</td><td><span class="pill ${d.result === "allow" ? "approved" : "pending"}">${esc(d.result)}</span></td><td class="hint">${esc(d.reason)}</td></tr>`).join("")}</table>
      <h3>Contributions</h3><table>${v.contributions.map((c) => `<tr><td>${esc(c.contributor_type)}</td><td>${esc(c.contribution_type)}</td><td class="mono hint">${esc(c.event_refs.join(", "))}</td></tr>`).join("")}</table>
      <div id="export-result"></div>`;
  }
  return "";
}

function renderOutcome() {
  const reports = current.outcome_reports;
  return `<section class="card"><h2>Outcome</h2>
    <p class="hint">Record what actually happened. OutcomeReports never change the sealed WorkSession.</p>
    <div class="row"><select id="outcome"><option value="not_submitted">Not submitted</option><option value="submitted">Submitted</option><option value="interview">Interview</option><option value="rejection">Rejection</option><option value="offer">Offer</option></select>
    <input id="outcome-note" placeholder="Note (optional)" style="max-width:320px"><button data-act="outcome">Record outcome</button></div>
    ${reports.length ? `<ul>${reports.map((r) => `<li>${esc(r.received_at)} · <span class="pill">${esc(r.outcome)}</span> ${esc(r.reason)}</li>`).join("")}</ul>` : ""}</section>`;
}

function bindDownloads(scope) {
  scope.querySelectorAll("[data-download]").forEach((a) => a.addEventListener("click", async (event) => {
    event.preventDefault();
    const response = await fetch(a.dataset.download, { headers: { Authorization: `HostAuth ${TOKEN}` } });
    if (!response.ok) return toast((await response.json()).error);
    const blob = await response.blob();
    const name = (response.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "download";
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    link.click();
  }));
}

function bind() {
  const id = current.work_session.id;
  main.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(); }));
  main.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => { document.getElementById(`edit-${b.dataset.edit}`).hidden = false; }));
  bindDownloads(main);
  main.querySelectorAll("[data-review]").forEach((b) => b.addEventListener("click", () => busy(b, async () => {
    const rid = b.dataset.review;
    const decision = b.dataset.decision;
    const body = { decision };
    const ticked = [...main.querySelectorAll(`.sec-${rid}`)].filter((c) => c.checked).map((c) => c.value);
    const unticked = [...main.querySelectorAll(`.sec-${rid}`)].filter((c) => !c.checked).map((c) => c.value);
    if (decision === "narrow") body.section_ids = ticked;
    if (decision === "needs_revision") body.section_ids = unticked;
    if (decision === "answer") body.jd_text = document.getElementById(`jd-text-${rid}`).value;
    if (decision === "correct") body.email = { subject: document.getElementById(`email-subject-${rid}`).value, body: document.getElementById(`email-body-${rid}`).value };
    if (decision === "takeover") body.edited_sections = Object.fromEntries([...main.querySelectorAll(`.edit-${rid}`)].map((t) => [t.dataset.section, t.value]));
    current = await api("POST", `/api/sessions/${id}/requests/${rid}/review`, body);
    render();
    loadSessions();
  })));
  main.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => busy(b, async () => {
    const act = b.dataset.act;
    if (act === "cancel" && !confirm("Cancel this WorkSession? Pending Requests close and nothing proceeds.")) return;
    if (act === "export") {
      const result = await api("POST", `/api/sessions/${id}/export`);
      tab = "evidence";
      render();
      document.getElementById("export-result").innerHTML = `<h3>Export</h3><p>${result.files.length} files written to <span class="mono">${esc(result.dir)}</span>.
        Jarvis CLI: <b>${result.jarvis_cli.passed}/${result.jarvis_cli.total}</b> checks passed.</p>
        ${result.jarvis_cli.failures.length ? `<pre>${esc(result.jarvis_cli.failures.map((f) => `${f.command} ${f.file}\n${f.output}`).join("\n"))}</pre>` : ""}
        <a href="#" data-download="/api/sessions/${id}/export.json">Download pack as one JSON file</a>`;
      bindDownloads(document.getElementById("export-result"));
      return;
    }
    if (act === "outcome") {
      const result = await api("POST", `/api/sessions/${id}/outcome`, { outcome: document.getElementById("outcome").value, note: document.getElementById("outcome-note").value });
      current = result.view;
    } else {
      const path = { learning: "learning", complete: "complete", cancel: "cancel", "email-sent": "email-sent" }[act];
      current = await api("POST", `/api/sessions/${id}/${path}`, {});
    }
    render();
    loadSessions();
  })));
}

loadSessions().catch((error) => toast(error.message));
