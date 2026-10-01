// Apply2Interview UI. Every action calls the host API, which records it as
// Jarvis protocol state (WorkSession events, Requests, Reviews, evidence).

const TOKEN = document.querySelector('meta[name="host-auth"]').content;
const BROWSER = window.A2I_BROWSER ?? null;
const main = document.getElementById("main");
let current = null;
let page = "inicio";
let cvTab = null;
let jarvisTab = "timeline";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? String(h).replace(/^hash:/, "").slice(0, 10) : "");
const BAND = { strong: "fuerte", solid: "sólida", stretch: "ajustada", weak_or_blocked: "débil o bloqueada" };
const STATUS = { active: "activa", waiting_on_human: "esperando tu decisión", completed: "completada", cancelled: "cancelada", failed: "fallida", closed: "cerrada" };

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
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 6000);
}

async function busy(fn) {
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado");
  } catch {
    toast("El navegador bloquea copiar aquí. Selecciona el texto y cópialo a mano.");
  }
}

function showText(name, text) {
  const viewer = document.getElementById("viewer");
  document.getElementById("viewer-title").textContent = name;
  viewer.querySelector("pre").textContent = text;
  viewer.hidden = false;
  viewer.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function download(path) {
  const response = await fetch(path, { headers: { Authorization: `HostAuth ${TOKEN}` } });
  if (!response.ok) return toast((await response.json()).error);
  const name = (response.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "archivo";
  if (BROWSER) return showText(name, await response.text());
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await response.blob()), download: name });
  link.click();
}

// ------------------------------------------------------------------ sidebar

async function loadSidebar() {
  const { sessions } = await api("GET", "/api/sessions");
  const list = document.getElementById("sessions");
  list.innerHTML = sessions.length
    ? sessions.map((s) => `<li data-id="${esc(s.id)}" class="${current?.work_session.id === s.id ? "on" : ""}">
        <div class="t">${esc(s.title ?? "Oferta sin título")}${BROWSER && s.job_url === BROWSER.exampleUrl ? ' <span class="muted small">(ejemplo)</span>' : ""}</div>
        <div class="s"><span class="pill ${esc(s.status)}">${esc(STATUS[s.status] ?? s.status)}</span> rev ${s.revision}</div></li>`).join("")
    : '<li class="s">Aún no hay postulaciones.</li>';
  list.querySelectorAll("li[data-id]").forEach((li) => li.addEventListener("click", () => openSession(li.dataset.id)));
  const { memory } = await api("GET", "/api/memory");
  document.getElementById("memory").innerHTML = memory.length
    ? memory.map((m) => `<li>${esc(m.memoryType)} · ${esc(m.memoryScope)}<br>${esc(JSON.stringify(m.content))}</li>`).join("")
    : '<li>Nada todavía: solo se guarda lo que confirmas.</li>';
}

async function openSession(id, nextPage) {
  current = await api("GET", `/api/sessions/${id}`);
  if (nextPage) page = nextPage;
  else if (page === "inicio") page = pending().length ? "envio" : "evaluacion";
  cvTab = null;
  render();
  loadSidebar();
}

document.getElementById("menu").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (!button) return;
  page = button.dataset.page;
  render();
});

// ------------------------------------------------------------------ helpers

const pending = () => (current?.requests ?? []).filter((r) => r.status === "pending" || r.status === "acknowledged");
const pendingFor = (action) => pending().find((r) => r.requested_action.action === action);
const terminal = () => ["completed", "failed", "cancelled", "closed"].includes(current?.work_session.status);

function renderStatus() {
  const el = document.getElementById("status");
  if (!current) return (el.innerHTML = "");
  const ws = current.work_session;
  const waiting = pending().length;
  el.innerHTML = `<span>WorkSession <b>${esc(ws.id)}</b></span>
    <span class="pill ${esc(ws.status)}">${esc(STATUS[ws.status] ?? ws.status)}</span>
    <span>revisión <b>${ws.revision}</b></span>
    <span>último evento <b>${short(ws.last_event_hash)}</b></span>
    <span>epoch <b>${current.lock_epoch}</b></span>
    ${waiting ? `<span class="pill wait">${waiting} Request${waiting > 1 ? "s" : ""} esperando</span>` : ""}`;
}

function gauge(before, after, target) {
  return `<div class="gauge" role="img" aria-label="Antes ${before}%, después ${after}%, objetivo ${target}%">
    <div class="fill" style="width:${Math.max(0, Math.min(100, after))}%"></div>
    <div class="before" style="width:${Math.max(0, Math.min(100, before))}%"></div>
    <div class="target" style="left:${target}%"></div></div>`;
}

// ------------------------------------------------------------------ pages

function render() {
  document.querySelectorAll("#menu button").forEach((b) => b.classList.toggle("on", b.dataset.page === page));
  renderStatus();
  const pages = { inicio: pageInicio, oferta: pageOferta, cvs: pageCvs, evaluacion: pageEvaluacion, envio: pageEnvio, jarvis: pageJarvis };
  if (page !== "inicio" && !current) {
    main.innerHTML = `<section class="panel"><h2>Elige o crea una postulación</h2><p class="muted">Empieza en Inicio con un enlace de oferta y hasta tres CVs.</p></section>`;
    return;
  }
  main.innerHTML = pages[page]();
  bind();
}

function pageInicio() {
  const sessions = document.querySelectorAll("#sessions li[data-id]").length;
  const best = current?.evaluation ? current.evaluation.sources.find((s) => s.label === current.evaluation.best_label) : null;
  const slot = (n, label) => `<fieldset><legend>CV ${n}</legend>
      <input name="cv${n}_label" placeholder="Nombre de esta versión" value="${esc(label)}" aria-label="Nombre del CV ${n}">
      <textarea name="cv${n}_text" rows="7" placeholder="Pega aquí el CV (texto o Markdown)" aria-label="Texto del CV ${n}"></textarea>
      <input type="file" data-cv-file="${n}" accept=".txt,.md,text/plain,text/markdown" aria-label="Cargar CV ${n}"></fieldset>`;
  return `
  <section class="stack">
    <div><h1>Una oferta. Tres CVs. Una postulación honesta.</h1>
    <p class="muted">El agente extrae la oferta completa, adapta tus tres CVs solo con tus propios datos, los evalúa contra el objetivo del ${current?.target_pct ?? 50}% y prepara el formulario y el email. Tú apruebas y envías con un clic.</p></div>
    <div class="grid3">
      <div class="metric"><div class="l">Postulaciones</div><div class="v">${sessions}</div></div>
      <div class="metric"><div class="l">Mejor % (abierta)</div><div class="v">${best ? `${best.after.pct}%` : "—"}</div></div>
      <div class="metric"><div class="l">Requests esperando</div><div class="v">${current ? pending().length : "—"}</div></div>
    </div>
  </section>
  <form id="new-session" class="panel stack">
    <div class="row between"><h2>Nueva postulación</h2>${BROWSER ? '<button type="button" class="btn ghost" id="load-example">Rellenar con el ejemplo</button>' : ""}</div>
    <label>Enlace de la oferta<input name="job_url" type="url" placeholder="https://empresa.com/empleo/123"></label>
    <label>…o pega la oferta completa (opcional)<textarea name="jd_text" rows="4" placeholder="Útil si la página pide iniciar sesión"></textarea></label>
    <div class="grid3">${slot(1, "General")}${slot(2, "Especializado")}${slot(3, "English")}</div>
    <fieldset><legend>Tus datos (se usan tal cual, nunca se inventan)</legend>
      <div class="grid3">
        <input name="name" placeholder="Nombre completo" aria-label="Nombre completo">
        <input name="email" placeholder="Email" aria-label="Email">
        <input name="phone" placeholder="Teléfono" aria-label="Teléfono">
        <input name="location" placeholder="Ubicación" aria-label="Ubicación">
        <input name="visa" placeholder="Permiso de trabajo (p. ej. Ciudadana UE)" aria-label="Permiso de trabajo">
        <input name="languages" placeholder="Idiomas, separados por comas" aria-label="Idiomas">
        <input name="linkedin" placeholder="LinkedIn" aria-label="LinkedIn">
        <input name="availability" placeholder="Disponibilidad" aria-label="Disponibilidad">
      </div>
      <label class="check"><input type="checkbox" name="relocate"> Dispuesta/o a cambiar de ciudad</label>
    </fieldset>
    <div class="row between">
      <p class="muted small">Policy: puede leer la oferta pública, puntuar, proponer secciones y redactar el email. No puede enviar ni postular sin tu clic, ni modificar tus CVs originales.</p>
      <button type="submit" class="btn primary">Preparar postulación</button>
    </div>
  </form>`;
}

function pageOferta() {
  const jd = current.artifacts.jd;
  const request = pendingFor("use_human_supplied_jd");
  const asks = request ? `<section class="panel wait stack">
      <div class="row between"><h2>No pude leer la oferta</h2><span class="pill wait">Request · context</span></div>
      <p>${esc(request.reason_summary)}</p>
      <p class="muted small">No invento la oferta. Pega el texto completo y continúo con la evaluación.</p>
      <textarea id="jd-answer" rows="10" placeholder="Pega aquí la oferta completa"></textarea>
      <div class="row"><button class="btn primary" data-review="${request.id}" data-decision="answer">Continuar con este texto</button><button class="btn danger" data-review="${request.id}" data-decision="deny">Parar</button></div>
    </section>` : "";
  if (!jd) return asks || `<section class="panel"><p class="muted">Todavía no hay oferta.</p></section>`;
  const text = esc(current.full_jd_text ?? "").replace(/^## (.*)$/gm, '<span class="h">$1</span>');
  const reqs = (list) => list.map((r) => `<tr><td>${esc(r.text)}</td><td><span class="pill">${esc(r.category)}</span></td><td class="mono">${esc(r.keywords.join(", ") || "—")}</td></tr>`).join("");
  return `${asks}
  <section class="panel stack">
    <div class="row between"><h1>${esc(jd.title ?? "Oferta")}</h1><span class="pill">${esc(jd.source.extraction)}</span></div>
    <div class="row muted small"><span>${esc(jd.company ?? "Empresa no indicada")}</span><span>·</span><span>${esc(jd.location ?? "Ubicación no indicada")} (${esc(jd.work_mode)})</span><span>·</span><span>idioma ${esc(jd.language)}</span><span>·</span><span class="mono">snapshot ${short(jd.source.snapshot_hash)}</span></div>
    <div class="grid2">
      <div><h3>Oferta completa (texto extraído)</h3><div class="jd">${text}</div></div>
      <div>
        <h3>Imprescindibles (${jd.must_haves.length})</h3><div class="table-wrap"><table>${reqs(jd.must_haves)}</table></div>
        ${jd.nice_to_haves.length ? `<h3>Se valora (${jd.nice_to_haves.length})</h3><div class="table-wrap"><table>${reqs(jd.nice_to_haves)}</table></div>` : ""}
        <h3>Palabras clave ATS</h3><p class="mono">${esc(jd.keywords.join(" · ") || "—")}</p>
        <p class="muted small" style="margin-top:10px">${esc(jd.translation.note)}</p>
      </div>
    </div>
  </section>`;
}

function pageCvs() {
  const ev = current.evaluation;
  if (!ev) return `<section class="panel"><p class="muted">${current.sources.length ? "Aún no hay versiones adaptadas." : "No añadiste ningún CV."}</p></section>`;
  const patches = current.artifacts.cv_patches;
  const tab = cvTab ?? ev.best_patch_ref;
  const entry = patches.find((p) => p.ref === tab) ?? patches[patches.length - 1];
  const p = entry.patch;
  const accepted = current.artifacts.accepted_cv;
  return `
  <section class="panel stack">
    <div class="row between"><h1>CVs adaptados</h1>${accepted ? `<button class="btn" data-download="/api/sessions/${current.work_session.id}/cv/accepted.md">${BROWSER ? "Ver" : "Descargar"} ${esc(accepted.filename)}</button>` : ""}</div>
    <p class="muted">Cada versión solo reordena tus líneas y añade datos que ya están en tus otros CVs, siempre bajo el mismo puesto y en el mismo idioma. El truth guard rechaza cualquier dato nuevo.</p>
    <nav class="tabs">${patches.map((x) => `<button data-cvtab="${esc(x.ref)}" class="${x.ref === entry.ref ? "on" : ""}">${esc(x.patch.source_label)} v${x.patch.version}${x.ref === ev.best_patch_ref ? " ★" : ""}</button>`).join("")}</nav>
    <div class="row"><span class="mono">${esc(p.filename)}</span><span class="pill">${p.score_before}% → ${p.score_after}%</span><span class="pill ok">truth guard OK</span></div>
    ${p.sections.map((s) => `<div class="stack">
      <h3>${esc(s.section_id)} · ${esc(s.change)}${s.sources_used.length ? ` · usa ${esc(s.sources_used.join(", "))}` : ""}</h3>
      <div class="diff"><div><div class="muted small">Antes</div><pre>${esc(s.before)}</pre></div><div><div class="muted small">Después</div><pre>${markAdded(s.before, s.after)}</pre></div></div>
    </div>`).join("") || '<p class="muted">Esta versión no necesitaba cambios.</p>'}
    <p class="muted small">Sin cambios: ${esc(p.unchanged_section_ids.join(", "))}</p>
  </section>
  ${accepted ? `<section class="panel go stack"><div class="row between"><h2>Versión aceptada</h2><span class="pill ok">${esc(accepted.source_label ?? "")}</span></div><pre>${esc(accepted.text)}</pre></section>` : ""}`;
}

function markAdded(before, after) {
  const have = new Set(before.split("\n").map((l) => l.trim()));
  return after.split("\n").map((l) => (have.has(l.trim()) ? esc(l) : `<span class="added">${esc(l)}</span>`)).join("\n");
}

function pageEvaluacion() {
  const ev = current.evaluation;
  const sheet = current.artifacts.score_sheet;
  if (!ev || !sheet) return `<section class="panel"><p class="muted">Sin evaluación todavía.</p></section>`;
  const best = ev.sources.find((s) => s.label === ev.best_label);
  const pct = sheet.apply_to_interview_pct;
  return `
  <section class="panel stack ${ev.reached_target ? "go" : "wait"}">
    <div class="row between"><h1>Evaluación</h1><span class="pill ${ev.reached_target ? "ok" : "wait"}">${ev.reached_target ? `objetivo ${ev.target_pct}% alcanzado` : `por debajo del ${ev.target_pct}%`}</span></div>
    <div class="grid2">
      <div class="stack">
        <div class="muted small">Mejor versión: <b>${esc(best.label)}</b> · ${esc(best.filename)}</div>
        <div class="row" style="align-items:flex-end;gap:18px"><div><div class="muted small">antes</div><div class="big muted">${best.before.pct}%</div></div><div><div class="muted small">después</div><div class="big">${best.after.pct}%</div></div><div><div class="muted small">mejora</div><div class="big" style="color:var(--mint)">${best.upgrade_pts >= 0 ? "+" : ""}${best.upgrade_pts}</div></div></div>
        ${gauge(best.before.pct, best.after.pct, ev.target_pct)}
        <p class="muted small">apply_to_interview_pct · heuristic_v1. Es una estimación calculada, no una promesa ni una opinión de un modelo. La línea ámbar es el objetivo del ${ev.target_pct}%.</p>
      </div>
      <div class="table-wrap"><table>
        <tr><th>CV</th><th>Encaje</th><th>% antes</th><th>% después</th><th>Mejora</th></tr>
        ${ev.sources.map((s) => `<tr><td>${esc(s.label)}${s.label === ev.best_label ? " ★" : ""}<div class="muted small">${esc(s.sources_used.length ? `usa ${s.sources_used.join(", ")}` : "solo sus líneas")}</div></td><td class="num">${s.before.fit}→${s.after.fit}</td><td class="num">${s.before.pct}%</td><td class="num"><span class="pill ${esc(s.after.band)}">${s.after.pct}% ${esc(BAND[s.after.band])}</span></td><td class="num">${s.upgrade_pts >= 0 ? "+" : ""}${s.upgrade_pts}</td></tr>`).join("")}
      </table></div>
    </div>
    ${ev.hard_blockers.length ? `<h3>Bloqueos</h3><ul>${ev.hard_blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    ${ev.missing_requirements.length ? `<h3>Lo que ninguno de tus CVs demuestra</h3><ul>${ev.missing_requirements.map((m) => `<li>${esc(m.text)} <span class="pill ${esc(m.status)}">${esc(m.status)}</span> <span class="muted small">${esc(m.basis)}</span></li>`).join("")}</ul><p class="muted small">Para subir más el %, añade estos datos a un CV o a tus datos solo si son ciertos.</p>` : ""}
  </section>
  <section class="panel stack">
    <h2>Fórmula (CV de origen ${esc(ev.best_label)}, antes de adaptar)</h2>
    <pre>${esc(pct.formula)}</pre>
    <div class="table-wrap"><table><tr><th>Término</th><th>Entrada</th><th>Puntos</th></tr>
      ${Object.entries(pct.terms).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="num">${k in pct.inputs && k !== "hard_blockers" ? pct.inputs[k] : k === "hard_blocker_penalty" ? esc(pct.inputs.hard_blockers.join("; ") || "ninguno") : ""}</td><td class="num">${v}</td></tr>`).join("")}
    </table></div>
    <h3>Requisitos y evidencias (líneas literales de tu CV)</h3>
    <div class="table-wrap"><table><tr><th>Requisito</th><th>Estado</th><th>Evidencia</th></tr>
      ${sheet.requirements.map((r) => `<tr><td>${esc(r.text)}<div class="muted small">${r.kind === "must" ? "imprescindible" : "se valora"} · ${esc(r.category)}</div></td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span><div class="muted small">${esc(r.basis)}</div></td><td>${r.evidence_quotes.length ? `<ul class="quotes">${r.evidence_quotes.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : '<span class="muted">—</span>'}</td></tr>`).join("")}
    </table></div>
  </section>`;
}

function pageEnvio() {
  const form = current.form;
  const cvReq = pendingFor("accept_cv_version");
  const sendReq = pendingFor("send_application_email");
  const handoff = current.artifacts.email_handoff;
  const receipt = current.email_receipt;
  const ev = current.evaluation;
  if (!form) return `${pageOferta()}`;
  const recipient = form.fields.find((f) => f.key === "recipient")?.value ?? "";
  const draft = current.artifacts.email_draft;
  const versions = ev ? ev.sources.map((s) => `<option value="${esc(s.patch_ref)}" ${s.patch_ref === ev.best_patch_ref ? "selected" : ""}>${esc(s.label)} — ${s.after.pct}% · ${esc(s.filename)}</option>`).join("") : "";
  const done = receipt || handoff;
  const action = done
    ? `<section class="panel go stack">
        <div class="row between"><h2>${receipt ? "Enviado" : "Aprobado, listo para enviar"}</h2><span class="pill ok">${receipt ? "enviado por el host" : "en tus manos"}</span></div>
        ${receipt ? `<p>Email enviado a <b>${esc(receipt.to)}</b> con ${esc(receipt.attachment?.filename ?? "sin adjunto")} (${esc(receipt.sent_at)}).</p>` : `<p>Este host no tiene correo configurado${BROWSER ? " (edición navegador)" : ""}: copia el email o ábrelo en tu app de correo y adjunta <b>${esc(handoff.attachment?.filename ?? "tu CV")}</b>.</p>
        <div class="row"><button class="btn" data-copy-email>Copiar email</button><a class="btn ghost" href="mailto:${encodeURIComponent(handoff.to ?? "")}?subject=${encodeURIComponent(handoff.subject)}&body=${encodeURIComponent(handoff.body)}">Abrir en mi correo</a>${!current.email_sent ? '<button class="btn" data-act="email-sent">Ya lo envié</button>' : '<span class="pill ok">marcado como enviado</span>'}</div>`}
      </section>`
    : sendReq
      ? `<section class="panel wait stack">
          <div class="row between"><h2>Un clic para enviar</h2><span class="pill wait">${cvReq ? "2 Requests" : "1 Request"} esperando</span></div>
          <p class="muted">Al pulsar, apruebas ${cvReq ? "la versión del CV elegida y " : ""}este email exacto. Cada aprobación queda como Review en Jarvis${current.can_send_email ? " y el host envía el email." : "; como aquí no hay correo configurado, te dejo el email listo para enviar."}</p>
          ${cvReq ? `<label>CV que se adjunta<select id="version-ref">${versions}</select></label>` : ""}
          <label>Enviar a<input id="send-to" value="${esc(recipient)}" placeholder="email de la empresa"></label>
          <div class="row"><button class="btn primary huge" data-act="approve-send">Aprobar y enviar</button><button class="btn danger" data-review="${sendReq.id}" data-decision="deny">No enviar</button></div>
        </section>`
      : `<section class="panel"><p class="muted">No hay ningún envío pendiente.</p></section>`;
  return `${action}
  <section class="panel stack">
    <div class="row between"><h2>Formulario relleno</h2>${form.missing.length ? `<span class="pill wait">faltan ${form.missing.length}</span>` : '<span class="pill ok">completo</span>'}</div>
    <p class="muted small">Copia cada campo en el portal de la empresa. Nunca se envía un formulario de Workday, LinkedIn u otro ATS sin ti.</p>
    ${form.fields.filter((f) => f.key !== "cover_letter").map((f) => `<div class="field"><div class="muted small">${esc(f.label)}<br><span class="pill ${f.source === "missing" ? "missing" : ""}">${esc({ candidate_facts: "tus datos", cv: "tu CV", job_posting: "oferta", prepared: "preparado", missing: "falta" }[f.source])}</span></div><div class="val">${esc(f.value) || '<span class="muted">—</span>'}</div><div>${f.value ? `<button class="btn ghost" data-copy-field="${esc(f.key)}">Copiar</button>` : ""}</div></div>`).join("")}
  </section>
  ${draft ? `<section class="panel stack">
    <div class="row between"><h2>Email (${esc(draft.language)})</h2><span class="pill">${draft.edited_by === "human" ? "editado por ti" : "borrador del agente"}</span></div>
    <label>Asunto<input id="email-subject" value="${esc(draft.subject)}" ${sendReq ? "" : "disabled"}></label>
    <label>Mensaje<textarea id="email-body" rows="12" ${sendReq ? "" : "disabled"}>${esc(draft.body)}</textarea></label>
    ${sendReq ? `<div class="row"><button class="btn" data-review="${sendReq.id}" data-decision="correct">Guardar mis cambios</button><span class="muted small">El email nunca incluye tu puntuación ni el %.</span></div>` : ""}
  </section>` : ""}`;
}

function pageJarvis() {
  const v = current;
  const tabs = { timeline: "Timeline", requests: "Requests", decisiones: "PolicyDecisions", evidencia: "Evidencia", aprendizaje: "Aprendizaje", exportar: "Exportar" };
  let body = "";
  if (jarvisTab === "timeline") {
    body = `<ul class="timeline">${v.events.map((e) => `<li><span class="seq">${e.sequence}</span><span><span class="ty ${e.actor_id.includes("agent") ? "agent" : "human"}">${esc(e.type)}</span><br><span class="hash">${short(e.previous_hash)} → ${short(e.event_hash)}</span></span><span class="sum">${esc(e.payload.summary ?? `${e.payload.object_type} ${e.payload.action}`)}<br><span class="muted small">${esc(e.actor_id)} · ${esc(e.timestamp)}</span></span></li>`).join("")}</ul>`;
  } else if (jarvisTab === "requests") {
    body = v.requests.map((r) => requestCard(r)).join("") || '<p class="muted">Sin Requests.</p>';
  } else if (jarvisTab === "decisiones") {
    body = `<div class="table-wrap"><table><tr><th>Acción</th><th>Resultado</th><th>Motivo</th></tr>${v.policy_decisions.map((d) => `<tr><td class="mono">${esc(d.requested_action.action)}</td><td><span class="pill ${d.result === "allow" ? "ok" : "wait"}">${esc(d.result)}</span></td><td class="muted small">${esc(d.reason)}</td></tr>`).join("")}</table></div>
      <h3>Contributions</h3><div class="table-wrap"><table>${v.contributions.map((c) => `<tr><td><span class="pill ${c.contributor_type === "agent" ? "agent" : c.contributor_type === "human" ? "ok" : ""}">${esc(c.contributor_type)}</span></td><td>${esc(c.contribution_type)}</td><td class="mono muted">${esc(c.event_refs.join(", "))}</td></tr>`).join("")}</table></div>`;
  } else if (jarvisTab === "evidencia") {
    body = `<div class="table-wrap"><table><tr><th>Evidencia</th><th>Artefacto</th><th>Hash</th><th>Capturada por</th></tr>${v.evidence.map((e) => `<tr><td>${esc(e.evidence_type)}<div class="muted small">${esc(e.trust_label)}</div></td><td class="mono">${esc(e.artifact_ref)}</td><td class="mono">${short(e.content_hash)}</td><td class="mono">${esc(e.captured_by_actor_id)}</td></tr>`).join("")}</table></div>
      ${v.limitations.length ? `<p class="small" style="color:var(--amber);margin-top:10px">Limitaciones: ${v.limitations.map(esc).join(", ")}</p>` : ""}`;
  } else if (jarvisTab === "aprendizaje") {
    body = `<p class="muted">El agente solo propone. Nada se convierte en memoria sin tu confirmación.</p>
      ${v.learning_records.map((l) => `<pre>${esc(JSON.stringify({ lesson: l.lesson_type, state: l.review_state, change: l.proposed_change }, null, 2))}</pre>`).join("")}
      ${v.memory_proposals.map((m) => `<div class="row"><span class="pill ${esc(m.status)}">${esc(m.status)}</span><span class="mono">${esc(m.memory_type)}</span></div>`).join("")}
      ${!terminal() && !v.learning_proposed ? '<button class="btn" data-act="learning">Proponer aprendizaje</button>' : ""}`;
  } else {
    body = `<p class="muted">El paquete de evidencia sigue el formato de los evidence packs de Jarvis y se valida con las mismas comprobaciones del SDK.</p>
      <div class="row">${!terminal() ? '<button class="btn" data-act="complete">Completar WorkSession</button><button class="btn danger" data-act="cancel">Cancelar</button>' : '<button class="btn" data-act="export">Exportar evidencia</button>'}</div>
      <div id="export-result"></div>
      ${terminal() ? `<h3>Resultado (OutcomeReport)</h3><div class="row"><select id="outcome" style="max-width:220px"><option value="submitted">Enviada</option><option value="not_submitted">No enviada</option><option value="interview">Entrevista</option><option value="rejection">Rechazo</option><option value="offer">Oferta</option></select><input id="outcome-note" placeholder="Nota" style="max-width:280px"><button class="btn" data-act="outcome">Registrar</button></div>
        ${v.outcome_reports.map((r) => `<p class="small">${esc(r.received_at)} · <span class="pill">${esc(r.outcome)}</span> ${esc(r.reason)}</p>`).join("")}` : ""}`;
  }
  return `<section class="panel stack">
    <div class="row between"><h1>Jarvis WorkSession</h1><span class="mono muted">${esc(v.work_session.objective)}</span></div>
    <nav class="tabs">${Object.entries(tabs).map(([k, label]) => `<button data-jtab="${k}" class="${jarvisTab === k ? "on" : ""}">${label}</button>`).join("")}</nav>
    ${body}
  </section>`;
}

function requestCard(r) {
  const open = r.status === "pending" || r.status === "acknowledged";
  const action = r.requested_action.action;
  let controls = "";
  if (open && action === "accept_cv_version") {
    const patch = current.artifacts.cv_patches.find((p) => p.ref === r.requested_action.target_ref)?.patch;
    controls = `<p class="muted small">Marca las secciones que aceptas de la versión recomendada.</p>
      ${(patch?.sections ?? []).map((s) => `<label class="check"><input type="checkbox" class="sec-${r.id}" value="${esc(s.section_id)}" checked> ${esc(s.section_id)}</label>`).join("")}
      <div class="row"><button class="btn" data-review="${r.id}" data-decision="approve">Aprobar</button><button class="btn" data-review="${r.id}" data-decision="narrow">Solo las marcadas</button><button class="btn" data-review="${r.id}" data-decision="needs_revision">Quitar no marcadas y revisar</button><button class="btn danger" data-review="${r.id}" data-decision="deny">Mantener mi CV</button></div>`;
  } else if (open && action === "confirm_memory") {
    const m = current.memory_proposals.find((x) => `memory-proposal:${x.id}` === r.requested_action.target_ref);
    controls = `<pre>${esc(JSON.stringify(m?.content, null, 2))}</pre><div class="row"><button class="btn" data-review="${r.id}" data-decision="approve">Confirmar memoria</button><button class="btn danger" data-review="${r.id}" data-decision="deny">Rechazar</button></div>`;
  } else if (open && action === "send_application_email") {
    controls = `<p class="muted small">Decide en “Formulario y envío”.</p>`;
  } else if (open && action === "use_human_supplied_jd") {
    controls = `<p class="muted small">Responde en “Oferta completa”.</p>`;
  }
  return `<div class="panel ${open ? "wait" : ""} stack" style="margin-bottom:10px">
    <div class="row between"><b>${esc(r.type)} · ${esc(action)}</b><span class="pill ${esc(r.status)}">${esc(r.status)}</span></div>
    <p>${esc(r.reason_summary)}</p>
    <p class="muted small">Bloquea <b>${esc(r.blocking_scope)}</b> · riesgo ${esc(r.risk_class)} · si no respondes: ${esc(r.default_if_no_response.reason)}</p>
    ${controls}</div>`;
}

// ------------------------------------------------------------------ events

function bind() {
  const id = current?.work_session.id;
  main.querySelectorAll("[data-cvtab]").forEach((b) => b.addEventListener("click", () => { cvTab = b.dataset.cvtab; render(); }));
  main.querySelectorAll("[data-jtab]").forEach((b) => b.addEventListener("click", () => { jarvisTab = b.dataset.jtab; render(); }));
  main.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () => download(b.dataset.download)));
  main.querySelectorAll("[data-copy-field]").forEach((b) => b.addEventListener("click", () => copyText(current.form.fields.find((f) => f.key === b.dataset.copyField).value)));
  main.querySelectorAll("[data-copy-email]").forEach((b) => b.addEventListener("click", () => {
    const h = current.artifacts.email_handoff;
    copyText(`Para: ${h.to ?? ""}\nAsunto: ${h.subject}\nAdjunto: ${h.attachment?.filename ?? ""}\n\n${h.body}`);
  }));
  main.querySelectorAll("[data-cv-file]").forEach((input) => input.addEventListener("change", async () => {
    const file = input.files[0];
    if (file) main.querySelector(`textarea[name="cv${input.dataset.cvFile}_text"]`).value = await file.text();
  }));
  const example = main.querySelector("#load-example");
  if (example) example.addEventListener("click", () => {
    const f = main.querySelector("#new-session");
    f.job_url.value = BROWSER.exampleUrl;
    BROWSER.exampleSources.forEach((s, i) => { f[`cv${i + 1}_label`].value = s.label; f[`cv${i + 1}_text`].value = s.text; });
    for (const [k, v] of Object.entries(BROWSER.exampleFacts)) if (f[k] && typeof v === "string") f[k].value = v;
    f.languages.value = BROWSER.exampleFacts.languages.join(", ");
    f.relocate.checked = Boolean(BROWSER.exampleFacts.willing_to_relocate);
  });
  const form = main.querySelector("#new-session");
  if (form) form.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = new FormData(form);
    const sources = [1, 2, 3].map((n) => ({ label: f.get(`cv${n}_label`), text: f.get(`cv${n}_text`) })).filter((s) => String(s.text).trim());
    const facts = {
      name: f.get("name"), email: f.get("email"), phone: f.get("phone"), location: f.get("location"), visa: f.get("visa"),
      linkedin: f.get("linkedin"), availability: f.get("availability"),
      languages: String(f.get("languages") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      ...(f.get("relocate") ? { willing_to_relocate: true } : {}),
    };
    busy(async () => {
      current = await api("POST", "/api/sessions", { job_url: f.get("job_url"), jd_text: f.get("jd_text"), source_cvs: sources, candidate_facts: facts });
      page = pending().some((r) => r.requested_action.action === "use_human_supplied_jd") ? "oferta" : "evaluacion";
      render();
      loadSidebar();
    });
  });
  main.querySelectorAll("[data-review]").forEach((b) => b.addEventListener("click", () => busy(async () => {
    const rid = b.dataset.review;
    const decision = b.dataset.decision;
    const body = { decision };
    const boxes = [...main.querySelectorAll(`.sec-${rid}`)];
    if (decision === "narrow") body.section_ids = boxes.filter((c) => c.checked).map((c) => c.value);
    if (decision === "needs_revision") body.section_ids = boxes.filter((c) => !c.checked).map((c) => c.value);
    if (decision === "answer") body.jd_text = main.querySelector("#jd-answer").value;
    if (decision === "correct") body.email = { subject: main.querySelector("#email-subject").value, body: main.querySelector("#email-body").value };
    current = await api("POST", `/api/sessions/${id}/requests/${rid}/review`, body);
    render();
    loadSidebar();
  })));
  main.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => busy(async () => {
    const act = b.dataset.act;
    if (act === "cancel" && b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "Pulsa otra vez para cancelar";
      return;
    }
    if (act === "approve-send") {
      current = await api("POST", `/api/sessions/${id}/approve-and-send`, { to: main.querySelector("#send-to")?.value, version_ref: main.querySelector("#version-ref")?.value });
      toast(current.email_sent ? "Enviado. Quedan dos Reviews tuyas en la WorkSession." : "Aprobado. Copia el email o ábrelo en tu correo para enviarlo.");
    } else if (act === "export") {
      const r = await api("POST", `/api/sessions/${id}/export`);
      main.querySelector("#export-result").innerHTML = `<p style="margin-top:10px">${r.files.length} archivos en el paquete (${esc(r.dir)}). ${esc(r.validator ?? "Jarvis CLI")}: <b>${r.jarvis_cli.passed}/${r.jarvis_cli.total}</b> comprobaciones superadas.</p>
        ${r.jarvis_cli.failures.length ? `<pre>${esc(r.jarvis_cli.failures.map((f) => `${f.command} ${f.file}\n${f.output}`).join("\n"))}</pre>` : ""}
        <button class="btn" id="pack-json">${BROWSER ? "Ver" : "Descargar"} el paquete como JSON</button>`;
      main.querySelector("#pack-json").addEventListener("click", () => download(`/api/sessions/${id}/export.json`));
      return;
    } else if (act === "outcome") {
      current = (await api("POST", `/api/sessions/${id}/outcome`, { outcome: main.querySelector("#outcome").value, note: main.querySelector("#outcome-note").value })).view;
    } else {
      current = await api("POST", `/api/sessions/${id}/${act}`, {});
    }
    render();
    loadSidebar();
  })));
}

document.querySelector("#viewer [data-close]").addEventListener("click", () => { document.getElementById("viewer").hidden = true; });
document.querySelector("#viewer [data-copy]").addEventListener("click", () => copyText(document.querySelector("#viewer pre").textContent));
if (BROWSER) document.getElementById("browser-note").hidden = false;

render();
loadSidebar()
  .then(async () => {
    const first = document.querySelector("#sessions li[data-id]");
    if (first && !current) await openSession(first.dataset.id, "evaluacion");
  })
  .catch((error) => toast(error.message));
