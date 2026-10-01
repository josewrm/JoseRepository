// Apply2Interview UI. Every action calls the host API, which records it as
// Jarvis protocol state (WorkSession events, Requests, Reviews, evidence).

const TOKEN = document.querySelector('meta[name="host-auth"]').content;
const BROWSER = window.A2I_BROWSER ?? null;
const main = document.getElementById("main");
let current = null;
let page = "asistente";
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
  else if (page === "inicio") page = "mapa";
  cvTab = null;
  render();
  loadSidebar();
}

document.getElementById("menu").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (!button) return;
  page = button.dataset.page;
  if (["asistente", "empleos", "perfil"].includes(page)) Promise.all([loadJobs(), loadProfile()]).then(render, (error) => toast(error.message));
  else render();
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
  network?.destroy();
  network = null;
  const pages = { asistente: pageAsistente, empleos: pageEmpleos, perfil: pagePerfil, mapa: pageMapa, inicio: pageInicio, oferta: pageOferta, cvs: pageCvs, evaluacion: pageEvaluacion, envio: pageEnvio, jarvis: pageJarvis };
  const own = ["asistente", "empleos", "perfil"].includes(page);
  document.body.classList.toggle("wide", own);
  document.getElementById("status").style.display = own ? "none" : "";
  if (BROWSER) document.getElementById("browser-note").hidden = own;
  if (!own && page !== "inicio" && page !== "mapa" && !current) {
    main.innerHTML = `<section class="panel"><h2>Elige o crea una postulación</h2><p class="muted">Empieza en Inicio con un enlace de oferta y hasta tres CVs.</p></section>`;
    return;
  }
  if (page !== "empleos") selectedLead = null;
  main.innerHTML = pages[page]();
  bind();
  bindAssistant();
  if (page === "mapa") startMap();
  if (page === "empleos") startJobsGraph();
  if (page === "asistente") { renderChat(); startOrb(); }
}

// ------------------------------------------------------------------ graph map (graphify style)

let hiddenCommunities = new Set();
let selectedNode = null;
let network = null;

function chips() {
  const v = current;
  if (!v) return "";
  const ev = v.evaluation;
  const best = ev ? ev.sources.find((x) => x.label === ev.best_label) : null;
  const items = [
    ["oferta", "Oferta", v.artifacts.jd ? `${v.artifacts.jd.must_haves.length} req.` : pendingFor("use_human_supplied_jd") ? "pégala" : "—", Boolean(pendingFor("use_human_supplied_jd"))],
    ["cvs", "CVs", `${ev?.sources.length ?? 0}/${v.sources.length}`, Boolean(pendingFor("accept_cv_version"))],
    ["evaluacion", `Objetivo ${v.target_pct}%`, best ? `${best.before.pct}→${best.after.pct}%` : "—", Boolean(best && best.after.pct < v.target_pct)],
    ["envio", "Formulario", v.form ? `${v.form.fields.filter((f) => f.value).length}/${v.form.fields.length}` : "—", Boolean(v.form?.missing.length)],
    ["envio", "Envío", v.email_sent ? "enviado" : v.artifacts.email_handoff ? "aprobado" : pendingFor("send_application_email") ? "1 clic" : "—", Boolean(pendingFor("send_application_email"))],
    ["jarvis", "Jarvis", `rev ${v.work_session.revision}`, false],
  ];
  return `<div class="chips">${items.map(([p, t, val, wait]) => `<button class="chip ${wait ? "wait" : ""}" data-goto="${p}"><span>${esc(t)}</span><b>${esc(val)}</b></button>`).join("")}</div>`;
}

function pageMapa() {
  const g = current?.graph;
  if (!g) {
    return `<section class="graph-wrap empty-graph"><div class="explain"><div class="card-h">Sin postulación</div><p>Crea una postulación para ver su grafo: oferta, requisitos, palabras clave, líneas de tus CVs, evaluación y registro Jarvis.</p><button class="btn primary" data-goto="inicio">Nueva postulación</button></div></section>`;
  }
  return `${chips()}
  <section class="graph-wrap">
    <div id="graph" class="graph" aria-label="Grafo de la WorkSession"></div>
    <div class="overlay filter">
      <div class="card-h">Filter by community</div>
      <p class="card-p">Cada grupo detectado, con nombre y recuento. Desactiva uno para aislar el resto.</p>
      <ul class="communities">${g.communities.map((c) => `<li><label><input type="checkbox" data-community="${esc(c.id)}" ${hiddenCommunities.has(c.id) ? "" : "checked"}><i style="background:${c.color}"></i><span>${esc(c.label)}</span><b>${c.count}</b></label></li>`).join("")}</ul>
      <input id="graph-search" class="search" placeholder="Buscar nodo…" aria-label="Buscar nodo">
      <p class="card-p mono">${g.stats.nodes} nodos · ${g.stats.edges} aristas · ${g.stats.extracted_pct}% EXTRACTED</p>
    </div>
    <div class="overlay explain" id="explain" ${selectedNode ? "" : "hidden"}></div>
    <div class="overlay hint">clic: explicar · doble clic: abrir página</div>
  </section>`;
}

function explainHtml(id) {
  const g = current.graph;
  const n = g.nodes.find((x) => x.id === id);
  if (!n) return "";
  const c = g.communities.find((x) => x.id === n.community);
  const label = (nid) => g.nodes.find((x) => x.id === nid)?.label ?? nid;
  const out = g.edges.filter((e) => e.from === id).map((e) => `--&gt; ${esc(label(e.to))} [${esc(e.relation)}] <span class="${e.confidence === "EXTRACTED" ? "ex" : "inf"}">[${e.confidence}]</span>`);
  const inc = g.edges.filter((e) => e.to === id).map((e) => `&lt;-- ${esc(label(e.from))} [${esc(e.relation)}] <span class="${e.confidence === "EXTRACTED" ? "ex" : "inf"}">[${e.confidence}]</span>`);
  return `<div class="row between"><div class="card-h">Node: ${esc(n.label)}</div><button class="btn ghost" data-close-explain>×</button></div>
    <p class="card-p">${esc(n.title)}</p>
    <p class="mono">Community: <i class="sw" style="background:${c?.color}"></i>${esc(c?.label ?? "")} · Kind: ${esc(n.kind)} · Degree: ${n.degree}</p>
    <div class="conns mono">${[...out, ...inc].slice(0, 40).join("<br>") || "sin conexiones"}</div>
    <button class="btn" data-goto="${esc(n.page)}">Abrir ${esc(n.page)}</button>`;
}

function startMap() {
  const box = document.getElementById("graph");
  const g = current?.graph;
  if (!box || !g) return;
  if (!window.vis?.Network) {
    box.innerHTML = `<p class="card-p" style="padding:20px">No se pudo cargar la librería del grafo (vis-network). Comprueba la conexión a internet.</p>`;
    return;
  }
  const color = Object.fromEntries(g.communities.map((c) => [c.id, c.color]));
  const maxDeg = Math.max(1, ...g.nodes.map((n) => n.degree));
  const visible = (n) => !hiddenCommunities.has(n.community);
  const nodes = new window.vis.DataSet(g.nodes.map((n) => ({
    id: n.id,
    label: n.degree >= maxDeg * 0.18 || ["job", "cv", "evaluation", "send"].includes(n.kind) ? n.label : "",
    title: n.title,
    hidden: !visible(n),
    value: 1 + n.degree,
    color: { background: n.kind === "missing_field" ? "#555" : color[n.community], border: color[n.community], highlight: { background: "#ffffff", border: color[n.community] }, hover: { background: "#ffffff", border: color[n.community] } },
  })));
  const edges = new window.vis.DataSet(g.edges.map((e, i) => ({ id: i, from: e.from, to: e.to, dashes: e.confidence === "INFERRED" })));
  network = new window.vis.Network(box, { nodes, edges }, {
    nodes: { shape: "dot", scaling: { min: 4, max: 26 }, borderWidth: 1, font: { color: "#e8e4d8", size: 11, face: "JetBrains Mono, monospace", strokeWidth: 3, strokeColor: "#1c1f26" } },
    edges: { color: { color: "rgba(220,215,200,0.34)", highlight: "rgba(255,255,255,0.8)", hover: "rgba(255,255,255,0.6)" }, width: 0.6, smooth: false, selectionWidth: 1.5 },
    physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -38, centralGravity: 0.006, springLength: 70, springConstant: 0.06, avoidOverlap: 0.2 }, stabilization: { iterations: 260 } },
    interaction: { hover: true, tooltipDelay: 120, hideEdgesOnDrag: true },
  });
  network.once("stabilizationIterationsDone", () => network.fit({ animation: { duration: 600 } }));
  network.on("click", (params) => {
    selectedNode = params.nodes[0] ?? null;
    const panel = document.getElementById("explain");
    if (!selectedNode) return (panel.hidden = true);
    panel.innerHTML = explainHtml(selectedNode);
    panel.hidden = false;
    bindExplain();
  });
  network.on("doubleClick", (params) => {
    const n = g.nodes.find((x) => x.id === params.nodes[0]);
    if (n) { page = n.page; render(); }
  });
  main.querySelectorAll("[data-community]").forEach((box2) => box2.addEventListener("change", () => {
    if (box2.checked) hiddenCommunities.delete(box2.dataset.community);
    else hiddenCommunities.add(box2.dataset.community);
    nodes.update(g.nodes.map((n) => ({ id: n.id, hidden: !visible(n) })));
  }));
  const search = document.getElementById("graph-search");
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = search.value.trim().toLowerCase();
    const hit = g.nodes.find((n) => visible(n) && n.title.toLowerCase().includes(q));
    if (!hit) return toast("Ningún nodo coincide.");
    network.selectNodes([hit.id]);
    network.focus(hit.id, { scale: 1.4, animation: { duration: 500 } });
    selectedNode = hit.id;
    const panel = document.getElementById("explain");
    panel.innerHTML = explainHtml(hit.id);
    panel.hidden = false;
    bindExplain();
  });
  if (selectedNode) { document.getElementById("explain").innerHTML = explainHtml(selectedNode); bindExplain(); }
}

function bindExplain() {
  const panel = document.getElementById("explain");
  panel.querySelector("[data-close-explain]")?.addEventListener("click", () => { panel.hidden = true; selectedNode = null; network?.unselectAll(); });
  panel.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => { page = b.dataset.goto; render(); }));
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

// ------------------------------------------------------------------ personal assistant (orb HUD)

let jobs = { leads: [], summary: null };
let profileData = null;
let chat = [{ who: "j", text: "Hola. Dime qué empleo buscar, por ejemplo «busca SAP EWM en Madrid». Toca el micrófono o escribe." }];
let listening = false;
let speaking = false;
let voiceOut = true;
let armedEasy = false;
let orbLoop = null;
let selectedLead = null;
const LEAD_STATUS = { found: "encontrado", needs_jd: "falta la oferta", prepared: "preparado", approved: "aprobado", submitted: "enviado por ti", failed: "falló" };
const STATUS_COLOR = { found: "#4fb3ff", needs_jd: "#ffc76b", prepared: "#9fe6ff", approved: "#6fffc8", submitted: "#ffffff", failed: "#ff6d5e" };

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function loadJobs() {
  jobs = await api("GET", "/api/jobs");
  return jobs;
}
async function loadProfile() {
  profileData = await api("GET", "/api/profile");
  return profileData;
}

function say(text) {
  chat.push({ who: "j", text });
  chat = chat.slice(-30);
  if (voiceOut && "speechSynthesis" in window) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "es-ES";
      u.onstart = () => (speaking = true);
      u.onend = () => { speaking = false; quietUntil = Date.now() + 700; };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* no speech output here */ }
  }
}

async function runCommand(text) {
  if (!String(text).trim()) return;
  chat.push({ who: "u", text });
  renderChat();
  try {
    const r = await api("POST", "/api/assistant/command", { text });
    jobs = { leads: r.leads, summary: r.summary };
    say(r.reply);
    if (r.intent.kind === "show_jobs" || r.intent.kind === "open") page = r.page;
  } catch (error) {
    say(error.message);
  }
  render();
}

function statusHeadline(s) {
  if (!s || !s.has_profile) return { warn: true, t: "Configura tu perfil", d: "Guarda tus tres CVs y tus datos para que pueda adaptarlos." };
  const attention = s.needs_jd + s.failed;
  if (attention) return { warn: true, t: `${attention} empleo${attention > 1 ? "s" : ""} necesita${attention > 1 ? "n" : ""} tu atención`, d: "Falta la descripción completa: abre la postulación y pégala. No invento ofertas." };
  if (!s.total) return { warn: false, t: "Sin empleos todavía", d: "Pídeme una búsqueda por voz o con el botón Buscar." };
  return { warn: false, t: "Sin desvíos relevantes", d: `${s.total} empleos · ${s.prepared} preparados · ${s.approved} aprobados · ${s.submitted} enviados${s.best_pct != null ? ` · mejor ${s.best_pct}%` : ""}` };
}

function queueHtml() {
  const list = jobs.leads.filter((l) => l.status === "approved" || l.status === "submitted");
  if (!list.length) return '<p class="fineprint">Aún no hay CVs aprobados. Importa tus vacantes (.docx) o busca; luego un toque prepara y aprueba todo.</p>';
  const next = nextToOpen();
  const left = list.filter((l) => l.status === "approved" && l.url && !l.example && !opened.has(l.id)).length;
  const head = next
    ? `<a class="easy next" href="${esc(next.url)}" target="_blank" rel="noopener noreferrer" data-open-next="${esc(next.id)}">Abrir siguiente (${left}) ↗</a>
       <p class="fineprint">Abre «${esc(next.title)}»${next.company ? ` · ${esc(next.company)}` : ""}. En LinkedIn pulsa «Solicitud sencilla», adjunta el CV adaptado y vuelve aquí. El navegador solo deja abrir una pestaña por toque.</p>`
    : `<p class="fineprint">${list.some((l) => l.status === "approved") ? "Todas las ofertas con enlace están abiertas. Marca «Ya lo envié» en las que enviaste." : "Todo enviado."}</p>`;
  return `${head}<ul class="queue scroll">${list.map((l) => `<li class="${opened.has(l.id) ? "opened" : ""}">
      <span class="t" title="${esc(l.title)}">${esc(l.title)}</span><span class="pill ${esc(l.status)}">${esc(LEAD_STATUS[l.status])}</span>
      <span class="s">${esc(l.company ?? "")}${l.pct != null ? ` · ${l.pct}%` : ""}
        ${l.example ? '<span class="muted">ejemplo, no es oferta real</span>' : l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-opened="${esc(l.id)}">${opened.has(l.id) ? "Abierta ✓" : "Abrir Easy Apply"} ↗</a>` : '<span class="muted">sin enlace: envía por email o su web</span>'}
        ${l.status === "approved" ? `<button class="btn ghost small-btn" data-submitted="${esc(l.id)}">Ya lo envié</button>` : ""}
        ${l.ws_id ? `<button class="btn ghost small-btn" data-open-ws="${esc(l.ws_id)}">CV y formulario</button>` : ""}</span></li>`).join("")}</ul>`;
}

let opened = new Set();
try { opened = new Set(JSON.parse(localStorage.getItem("jarvis.opened") ?? "[]")); } catch { /* per-viewer convenience only */ }
const markOpened = (id) => { opened.add(id); try { localStorage.setItem("jarvis.opened", JSON.stringify([...opened])); } catch { /* ignore */ } };

function importButton() {
  return `<label class="hbtn file-btn">Importar vacantes .docx<input type="file" data-import-docx accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden></label>`;
}

function nextToOpen() {
  return jobs.leads.find((l) => l.status === "approved" && l.url && !l.example && !opened.has(l.id)) ?? null;
}

function easyButton() {
  const s = jobs.summary;
  const n = jobs.leads.filter((l) => l.status === "found" || l.status === "prepared").length;
  return `<button class="easy" data-easy ${n ? "" : "disabled"}>${armedEasy ? `Toca otra vez: aprobar ${n} CV${n === 1 ? "" : "s"}` : "Enviar todos · Easy Apply"}</button>
    <p class="fineprint">Un toque prepara lo que falte y aprueba cada CV adaptado (una Review tuya por empleo). LinkedIn no permite que una app envíe por ti: abro cada oferta y tú pulsas «Solicitud sencilla».${s?.approved ? "" : ""}</p>`;
}

function pageAsistente() {
  const s = jobs.summary;
  const h = statusHeadline(s);
  const terms = profileData?.terms ?? [];
  return `<section class="asst">
    <div class="col left">
      <div class="hpanel"><div class="hp-h">Señal <small id="sig-state">en espera</small></div><canvas class="wave" data-wave="0"></canvas><canvas class="wave" data-wave="1"></canvas></div>
      <div class="hpanel"><div class="hp-h">Métricas <small>heuristic_v1</small></div>
        <div class="kv"><div><b>${s?.total ?? 0}</b><span>encontrados</span></div><div><b>${s?.prepared ?? 0}</b><span>preparados</span></div>
        <div><b>${s?.approved ?? 0}</b><span>aprobados</span></div><div><b>${s?.submitted ?? 0}</b><span>enviados</span></div>
        <div><b>${s?.best_pct != null ? `${s.best_pct}%` : "—"}</b><span>mejor</span></div><div><b>${s?.avg_pct != null ? `${s.avg_pct}%` : "—"}</b><span>media</span></div></div></div>
      <div class="hpanel"><div class="hp-h">Perfil <small>${profileData?.profile.sources.length ?? 0}/3 CVs</small></div>
        <div class="terms">${terms.slice(0, 18).map((t) => `<span>${esc(t)}</span>`).join("") || '<span>sin CVs</span>'}</div>
        <button class="hbtn" style="margin-top:10px" data-goto="perfil">Editar perfil</button></div>
    </div>
    <div class="center">
      <div class="orb"><canvas id="orb"></canvas><div class="state" id="orb-state">${listening ? "escuchando" : "jarvis"}</div></div>
      <div class="statuscard"><div class="k">Estado del sistema</div><div class="t ${h.warn ? "warn" : ""}">${esc(h.t)}</div><div class="d">${esc(h.d)}</div>
        <div class="row"><button class="hbtn" data-say="buscar">Buscar</button><button class="hbtn" data-say="prepara todos">Preparar todos</button><button class="hbtn" data-goto="empleos">Ver grafo</button><button class="hbtn" data-say="estado">Estado</button>${importButton()}</div></div>
    </div>
    <div class="col right">
      <div class="hpanel"><div class="hp-h">Conversación <small>tú / jarvis</small></div><div class="chat" id="chat"></div></div>
      <div class="hpanel"><div class="hp-h">Easy Apply <small>LinkedIn</small></div><div class="row" style="margin-bottom:10px">${importButton()}</div>${easyButton()}<div style="margin-top:10px">${queueHtml()}</div></div>
    </div>
  </section>`;
}

function renderChat() {
  const box = document.getElementById("chat");
  if (!box) return;
  box.innerHTML = chat.map((m) => `<div class="msg ${m.who}"><span class="who">${m.who === "u" ? "TÚ" : "JARVIS"}</span><p>${esc(m.text)}</p></div>`).join("");
  box.scrollTop = box.scrollHeight;
}

// Orb: tangled glowing rings, each a circle rotated in 3D and projected.
function startOrb() {
  cancelAnimationFrame(orbLoop);
  const rings = Array.from({ length: 16 }, (_, i) => ({ ax: Math.random() * Math.PI, ay: Math.random() * Math.PI, sx: (Math.random() - 0.5) * 0.5, sy: (Math.random() - 0.5) * 0.4, r: 0.68 + Math.random() * 0.26, hue: 196 + Math.random() * 22, w: 0.6 + Math.random() * 1.4 }));
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let energy = 0.2;
  const frame = (ms) => {
    const orb = document.getElementById("orb");
    if (!orb || page !== "asistente") return;
    const t = ms / 1000;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = orb.clientWidth, hgt = orb.clientHeight;
    if (orb.width !== Math.round(w * dpr)) { orb.width = Math.round(w * dpr); orb.height = Math.round(hgt * dpr); }
    const ctx = orb.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const target = listening ? 1 : speaking ? 0.75 : 0.2;
    energy += (target - energy) * 0.06;
    const cx = w / 2, cy = hgt / 2, R = Math.min(w, hgt) * 0.36;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
    core.addColorStop(0, `rgba(170,225,255,${0.30 + energy * 0.25})`);
    core.addColorStop(0.35, "rgba(40,130,255,0.16)");
    core.addColorStop(1, "rgba(0,20,60,0)");
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, w, hgt);
    ctx.globalCompositeOperation = "lighter";
    for (const ring of rings) {
      const ax = ring.ax + (reduce ? 0 : t * ring.sx);
      const ay = ring.ay + (reduce ? 0 : t * ring.sy);
      ctx.beginPath();
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        const wob = 1 + energy * 0.06 * Math.sin(a * 5 + t * 6 + ring.hue);
        let x = Math.cos(a) * ring.r * wob, y = Math.sin(a) * ring.r * wob, z = 0;
        let y2 = y * Math.cos(ax) - z * Math.sin(ax); z = y * Math.sin(ax) + z * Math.cos(ax); y = y2;
        let x2 = x * Math.cos(ay) + z * Math.sin(ay); z = -x * Math.sin(ay) + z * Math.cos(ay); x = x2;
        const p = 2.6 / (2.6 + z);
        const px = cx + x * R * p, py = cy + y * R * p;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.strokeStyle = `hsla(${ring.hue},100%,${62 + energy * 14}%,${0.32 + energy * 0.3})`;
      ctx.lineWidth = ring.w;
      ctx.shadowColor = "rgba(79,179,255,0.9)";
      ctx.shadowBlur = 10 + energy * 14;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
    document.querySelectorAll("canvas[data-wave]").forEach((c, i) => {
      const cw = c.clientWidth, ch = c.clientHeight;
      if (c.width !== Math.round(cw * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
      const g = c.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cw, ch);
      g.strokeStyle = i ? "rgba(111,211,255,0.55)" : "rgba(159,230,255,0.95)";
      g.lineWidth = 1.4;
      g.shadowColor = "rgba(79,179,255,0.8)";
      g.shadowBlur = 6;
      g.beginPath();
      for (let x = 0; x <= cw; x += 2) {
        const amp = ch * (0.08 + energy * 0.32) * (i ? 0.7 : 1);
        const y = ch / 2 + Math.sin(x * 0.045 + t * (3 + i)) * amp * Math.sin(x * 0.011 + t) + Math.sin(x * 0.13 - t * 5) * amp * 0.25;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    });
    const st = document.getElementById("sig-state");
    if (st) st.textContent = listening ? "escuchando" : speaking ? "hablando" : "en espera";
    orbLoop = requestAnimationFrame(frame);
  };
  orbLoop = requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ jobs graph

function pageEmpleos() {
  const s = jobs.summary;
  const p = profileData?.profile.search ?? {};
  return `<section class="jobs">
    <div class="graph-wrap">
      <div id="jobs-graph" class="graph" aria-label="Grafo de empleos encontrados"></div>
      <div class="overlay hint">clic: detalles · doble clic: abrir postulación</div>
      <div class="overlay explain" id="lead-explain" ${selectedLead ? "" : "hidden"}></div>
    </div>
    <div class="right">
      <div class="hpanel"><div class="hp-h">Buscar en LinkedIn <small>ai-job-search</small></div>
        <form id="job-search" class="searchbar"><input name="query" placeholder="SAP EWM" value="${esc(p.query ?? "")}" aria-label="Qué buscar"><input name="location" placeholder="España" value="${esc(p.location ?? "")}" aria-label="Dónde"><button class="hbtn" type="submit">Buscar</button></form>
        ${BROWSER ? `<p class="fineprint">Sin servidor no hay búsqueda en vivo${BROWSER.privateEdition ? ": importa tus vacantes en .docx." : ": verás empleos de ejemplo (ficticios)."}</p>` : ""}</div>
      <div class="hpanel"><div class="hp-h">Empleos <small>${s?.total ?? 0}</small></div>
        <div class="kv"><div><b>${s?.found ?? 0}</b><span>nuevos</span></div><div><b>${s?.prepared ?? 0}</b><span>preparados</span></div><div><b>${s?.approved ?? 0}</b><span>aprobados</span></div><div><b>${s?.best_pct != null ? `${s.best_pct}%` : "—"}</b><span>mejor</span></div></div>
        <div class="row" style="margin-top:10px"><button class="hbtn" data-say="prepara todos" ${s?.found ? "" : "disabled"}>Preparar todos</button></div></div>
      <div class="hpanel"><div class="hp-h">Vacantes .docx <small>tabla + JDs</small></div><div class="row">${importButton()}</div>
        <p class="fineprint">Acepta la tabla de enlaces y el documento de descripciones completas; se unen por oferta. Sin servidor no se leen páginas de LinkedIn: usa el .docx con las descripciones.</p></div>
      <div class="hpanel"><div class="hp-h">Easy Apply <small>un toque</small></div>${easyButton()}<div style="margin-top:10px">${queueHtml()}</div></div>
      <div class="hpanel"><div class="hp-h">Leyenda</div><div class="terms">${Object.entries(LEAD_STATUS).map(([k, v]) => `<span><i class="dot" style="background:${STATUS_COLOR[k]}"></i>${esc(v)}</span>`).join("")}</div></div>
    </div>
  </section>`;
}

function leadExplain(id) {
  const l = jobs.leads.find((x) => x.id === id);
  if (!l) return "";
  return `<div class="row between"><div class="card-h">${esc(l.title)}</div><button class="btn ghost" data-close-lead>×</button></div>
    <p class="card-p">${esc(l.company ?? "")} · ${esc(l.location ?? "")}${l.date ? ` · ${esc(l.date)}` : ""}</p>
    <p class="mono">Estado: <span class="pill ${esc(l.status)}">${esc(LEAD_STATUS[l.status])}</span> · relevancia ${l.relevance}${l.pct != null ? ` · apply_to_interview ${l.pct}% (${esc(l.best_label ?? "")})` : ""}</p>
    <p class="mono">Coincide con tus CVs: ${esc(l.matched_terms.join(", ") || "—")}</p>
    ${l.note ? `<p class="card-p">${esc(l.note)}</p>` : ""}
    <div class="row" style="margin-top:8px">
      ${l.ws_id ? `<button class="btn" data-open-ws="${esc(l.ws_id)}">Abrir postulación</button>` : `<button class="btn" data-prepare-one="${esc(l.id)}">Preparar este</button>`}
      ${l.example ? "" : `<a class="btn ghost" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>`}
    </div>`;
}

function startJobsGraph() {
  const box = document.getElementById("jobs-graph");
  if (!box) return;
  if (!window.vis?.Network) {
    box.innerHTML = `<p class="card-p" style="padding:20px">No se pudo cargar la librería del grafo (vis-network).</p>`;
    return;
  }
  const leads = jobs.leads;
  const name = profileData?.profile.facts?.name ?? "Tú";
  const termSet = [...new Set(leads.flatMap((l) => l.matched_terms))];
  const nodes = [
    { id: "me", label: name, shape: "dot", value: 40, color: { background: "#dff3ff", border: "#6fd3ff" }, font: { size: 15, color: "#ffffff" }, title: "Tu perfil: 3 CVs y tus datos" },
    ...termSet.map((t) => ({ id: `term:${t}`, label: t, value: 6, color: { background: "#0a3a78", border: "#4fb3ff" }, title: `Término de tus CVs: ${t}` })),
    ...leads.map((l) => ({ id: `job:${l.id}`, label: `${l.title.slice(0, 34)}${l.pct != null ? `\n${l.pct}%` : ""}`, value: 10 + (l.pct ?? l.relevance / 2) / 3, color: { background: STATUS_COLOR[l.status], border: "#9fe6ff", highlight: { background: "#ffffff", border: "#ffffff" } }, title: `${l.title} — ${l.company ?? ""}` })),
  ];
  const edges = [
    ...leads.map((l) => ({ from: "me", to: `job:${l.id}`, width: 0.5 + l.relevance / 40, dashes: l.status === "found" })),
    ...leads.flatMap((l) => l.matched_terms.map((t) => ({ from: `job:${l.id}`, to: `term:${t}`, width: 0.5, color: { color: "rgba(79,179,255,0.25)" } }))),
  ];
  network = new window.vis.Network(box, { nodes: new window.vis.DataSet(nodes), edges: new window.vis.DataSet(edges) }, {
    nodes: { shape: "dot", scaling: { min: 5, max: 34 }, borderWidth: 1.5, shadow: { enabled: true, color: "rgba(79,179,255,0.8)", size: 16, x: 0, y: 0 }, font: { color: "#dff3ff", size: 12, face: "Rajdhani, JetBrains Mono, sans-serif", strokeWidth: 3, strokeColor: "#031026", multi: false } },
    edges: { color: { color: "rgba(111,211,255,0.4)", highlight: "#ffffff" }, smooth: false },
    physics: { solver: "forceAtlas2Based", forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.01, springLength: 110, avoidOverlap: 0.4 }, stabilization: { iterations: 220 } },
    interaction: { hover: true, tooltipDelay: 120 },
  });
  network.once("stabilizationIterationsDone", () => network.fit({ animation: { duration: 500 } }));
  const showLead = (id) => {
    const panel = document.getElementById("lead-explain");
    selectedLead = id;
    if (!id) return (panel.hidden = true);
    panel.innerHTML = leadExplain(id);
    panel.hidden = false;
    bindAssistant(panel);
    panel.querySelector("[data-close-lead]")?.addEventListener("click", () => { selectedLead = null; panel.hidden = true; });
  };
  network.on("click", (p) => showLead(String(p.nodes[0] ?? "").startsWith("job:") ? p.nodes[0].slice(4) : null));
  network.on("doubleClick", (p) => {
    const l = leads.find((x) => `job:${x.id}` === p.nodes[0]);
    if (l?.ws_id) openSession(l.ws_id, "mapa");
  });
  if (selectedLead) showLead(selectedLead);
}

// ------------------------------------------------------------------ profile

function pagePerfil() {
  const p = profileData?.profile ?? { sources: [], facts: {}, search: {} };
  const f = p.facts ?? {};
  const slot = (n) => `<fieldset><legend>CV ${n}</legend>
    <input name="cv${n}_label" placeholder="Nombre de esta versión" value="${esc(p.sources[n - 1]?.label ?? "")}" aria-label="Nombre del CV ${n}">
    <textarea name="cv${n}_text" rows="9" placeholder="Pega aquí el CV (texto o Markdown)" aria-label="Texto del CV ${n}">${esc(p.sources[n - 1]?.text ?? "")}</textarea>
    <input type="file" data-cv-file="${n}" accept=".docx,.txt,.md,text/plain,text/markdown" aria-label="Cargar CV ${n}"></fieldset>`;
  return `<form id="profile-form" class="panel stack">
    <div class="row between"><h2>Tu perfil</h2><span class="muted small">Los CVs adaptados solo usan líneas de estos tres CVs.</span></div>
    <div class="grid3">${slot(1)}${slot(2)}${slot(3)}</div>
    <fieldset><legend>Tus datos (se usan tal cual)</legend><div class="grid3">
      ${["name:Nombre completo", "email:Email", "phone:Teléfono", "location:Ubicación", "visa:Permiso de trabajo", "linkedin:LinkedIn", "availability:Disponibilidad"].map((x) => { const [k, l] = x.split(":"); return `<input name="${k}" placeholder="${l}" aria-label="${l}" value="${esc(f[k] ?? "")}">`; }).join("")}
      <input name="languages" placeholder="Idiomas, separados por comas" aria-label="Idiomas" value="${esc((f.languages ?? []).join(", "))}">
    </div></fieldset>
    <fieldset><legend>Búsqueda por defecto</legend><div class="grid3">
      <input name="query" placeholder="SAP EWM" aria-label="Qué buscar" value="${esc(p.search?.query ?? "")}">
      <input name="loc" placeholder="España" aria-label="Dónde" value="${esc(p.search?.location ?? "")}">
      <select name="remote" aria-label="Modalidad"><option value="">Cualquier modalidad</option>${["remote:Remoto", "hybrid:Híbrido", "onsite:Presencial"].map((x) => { const [k, l] = x.split(":"); return `<option value="${k}" ${p.search?.remote === k ? "selected" : ""}>${l}</option>`; }).join("")}</select>
    </div></fieldset>
    <div class="row between"><p class="muted small">Se guarda en este ${BROWSER ? "navegador" : "equipo"}. Nunca se envía nada sin tu toque.</p><button class="btn primary" type="submit">Guardar perfil</button></div>
  </form>`;
}

function bindAssistant(scope = main) {
  scope.querySelectorAll("[data-say]").forEach((b) => b.addEventListener("click", () => {
    const text = b.dataset.say === "buscar" ? `busca ${profileData?.profile.search?.query || "SAP"}${profileData?.profile.search?.location ? ` en ${profileData.profile.search.location}` : ""}` : b.dataset.say;
    busy(() => runCommand(text));
  }));
  scope.querySelectorAll("[data-open-ws]").forEach((b) => b.addEventListener("click", () => openSession(b.dataset.openWs, "mapa")));
  scope.querySelectorAll("[data-submitted]").forEach((b) => b.addEventListener("click", () => busy(async () => {
    const r = await api("POST", `/api/jobs/${b.dataset.submitted}/submitted`);
    await loadJobs();
    say(`Anotado: enviaste «${r.lead.title}». Queda en el registro Jarvis como envío tuyo.`);
    render();
  })));
  scope.querySelectorAll("[data-prepare-one]").forEach((b) => b.addEventListener("click", () => busy(async () => {
    const r = await api("POST", "/api/jobs/prepare", { ids: [b.dataset.prepareOne] });
    jobs = { leads: r.leads, summary: r.summary };
    render();
  })));
  scope.querySelectorAll("[data-import-docx]").forEach((input) => input.addEventListener("change", () => busy(async () => {
    const files = [...input.files];
    for (const file of files) {
      chat.push({ who: "u", text: `Importar ${file.name}` });
      const r = await api("POST", "/api/jobs/import-docx", { filename: file.name, data_base64: await fileBase64(file) });
      jobs = { leads: r.leads, summary: r.summary };
      say(`${file.name}: ${r.total} vacantes (${r.added} nuevas, ${r.updated} unidas), ${r.with_jd} con descripción completa.`);
    }
    const missing = jobs.leads.filter((l) => l.source === "docx" && !l.jd_text && !l.ws_id).length;
    if (missing) say(`${missing} vacantes solo tienen enlace. ${BROWSER ? "Importa también el .docx con las descripciones completas: aquí no puedo leer LinkedIn." : "Leeré su página pública al preparar."}`);
    render();
  })));
  scope.querySelectorAll("[data-open-next], [data-opened]").forEach((a) => a.addEventListener("click", () => {
    markOpened(a.dataset.openNext ?? a.dataset.opened);
    setTimeout(render, 50);
  }));
  scope.querySelectorAll("[data-easy]").forEach((b) => b.addEventListener("click", () => {
    if (!armedEasy) { armedEasy = true; render(); return; }
    armedEasy = false;
    busy(async () => {
      chat.push({ who: "u", text: "Enviar todos · Easy Apply" });
      const toPrepare = jobs.leads.filter((l) => l.status === "found").length;
      if (toPrepare) {
        toast(`Preparando ${toPrepare} vacantes: descripción, 3 CVs adaptados y evaluación…`);
        const r = await api("POST", "/api/jobs/prepare", {});
        jobs = { leads: r.leads, summary: r.summary };
      }
      const r = await api("POST", "/api/jobs/approve-all", {});
      jobs = { leads: r.leads, summary: r.summary };
      const real = r.to_open.filter((o) => !jobs.leads.find((l) => l.id === o.id)?.example);
      const pend = jobs.leads.filter((l) => l.status === "needs_jd").length;
      say(r.to_open.length ? `Aprobados ${r.to_open.length} CVs adaptados. ${real.length ? "Toca «Abrir siguiente» para ir oferta por oferta y pulsa Solicitud sencilla; luego «Ya lo envié»." : "Son ejemplos ficticios: no hay oferta real que abrir."}${pend ? ` ${pend} siguen sin descripción.` : ""}` : "No había nada preparado para aprobar.");
      render();
    });
  }));
  const search = scope.querySelector("#job-search");
  if (search) search.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = search.query.value.trim();
    if (!q) return toast("Escribe qué buscar.");
    busy(() => runCommand(`busca ${q}${search.location.value.trim() ? ` en ${search.location.value.trim()}` : ""}`));
  });
  const pf = scope.querySelector("#profile-form");
  if (pf) pf.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(pf);
    const sources = [1, 2, 3].map((n) => ({ label: f.get(`cv${n}_label`), text: f.get(`cv${n}_text`) })).filter((x) => String(x.text).trim());
    const facts = Object.fromEntries(["name", "email", "phone", "location", "visa", "linkedin", "availability"].map((k) => [k, f.get(k)]));
    facts.languages = String(f.get("languages") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    busy(async () => {
      profileData = await api("POST", "/api/profile", { source_cvs: sources, candidate_facts: facts, search: { query: f.get("query"), location: f.get("loc"), remote: f.get("remote") || undefined } });
      toast(`Perfil guardado: ${profileData.profile.sources.length} CVs.`);
      page = "asistente";
      render();
    });
  });
}

// voice: Web Speech API where the browser allows it; typing and tapping always work.
// One tap latches the mic on: it keeps listening (and restarts after pauses) until tapped again.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micLatched = false;
let quietUntil = 0;

function micUi() {
  const mic = document.getElementById("mic");
  mic.classList.toggle("on", micLatched);
  mic.setAttribute("aria-pressed", String(micLatched));
  mic.title = micLatched ? "Escuchando: toca para parar" : "Toca para hablar (se queda escuchando)";
  const st = document.getElementById("orb-state");
  if (st) st.textContent = micLatched ? "escuchando" : "jarvis";
}

function startRecognizer() {
  const input = document.getElementById("cmd-text");
  recognizer = new Recognition();
  recognizer.lang = "es-ES";
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;
  recognizer.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const said = res[0].transcript.trim();
      // Ignore what Jarvis itself is saying through the speakers.
      if (speaking || Date.now() < quietUntil) continue;
      if (!res.isFinal) { input.value = said; continue; }
      input.value = "";
      if (said) busy(() => runCommand(said));
    }
  };
  recognizer.onerror = (event) => {
    if (["not-allowed", "service-not-allowed", "audio-capture"].includes(event.error)) {
      micLatched = false;
      micUi();
      toast(event.error === "audio-capture" ? "No encuentro un micrófono." : "El micrófono está bloqueado en esta vista. Permite el micrófono o abre la versión local (npm start) en Chrome; mientras tanto escribe la orden.");
    }
    // no-speech / aborted / network: onend restarts while the mic is latched.
  };
  recognizer.onend = () => {
    listening = false;
    if (micLatched) setTimeout(() => { if (micLatched) startRecognizer(); }, 250);
    else micUi();
  };
  try {
    recognizer.start();
    listening = true;
  } catch (error) {
    micLatched = false;
    toast(`Voz no disponible: ${error.message}`);
  }
  micUi();
}

document.getElementById("mic").addEventListener("click", () => {
  if (micLatched) {
    micLatched = false;
    recognizer?.stop();
    micUi();
    return;
  }
  if (!Recognition) {
    toast("Este navegador no permite reconocimiento de voz aquí. Escribe la orden o usa los botones.");
    document.getElementById("cmd-text").focus();
    return;
  }
  micLatched = true;
  startRecognizer();
});
document.getElementById("cmd").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("cmd-text");
  const text = input.value;
  input.value = "";
  busy(() => runCommand(text));
});
document.getElementById("voice-out").addEventListener("click", (e) => {
  voiceOut = !voiceOut;
  e.currentTarget.setAttribute("aria-pressed", String(voiceOut));
  e.currentTarget.textContent = voiceOut ? "🔊" : "🔈";
  if (!voiceOut) window.speechSynthesis?.cancel();
});

function bind() {
  const id = current?.work_session.id;
  main.querySelectorAll("[data-goto]").forEach((d) => {
    const go = () => { page = d.dataset.goto; render(); };
    d.addEventListener("click", go);
    d.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  main.querySelectorAll("[data-cvtab]").forEach((b) => b.addEventListener("click", () => { cvTab = b.dataset.cvtab; render(); }));
  main.querySelectorAll("[data-jtab]").forEach((b) => b.addEventListener("click", () => { jarvisTab = b.dataset.jtab; render(); }));
  main.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () => download(b.dataset.download)));
  main.querySelectorAll("[data-copy-field]").forEach((b) => b.addEventListener("click", () => copyText(current.form.fields.find((f) => f.key === b.dataset.copyField).value)));
  main.querySelectorAll("[data-copy-email]").forEach((b) => b.addEventListener("click", () => {
    const h = current.artifacts.email_handoff;
    copyText(`Para: ${h.to ?? ""}\nAsunto: ${h.subject}\nAdjunto: ${h.attachment?.filename ?? ""}\n\n${h.body}`);
  }));
  main.querySelectorAll("[data-cv-file]").forEach((input) => input.addEventListener("change", () => busy(async () => {
    const file = input.files[0];
    if (!file) return;
    const box = main.querySelector(`textarea[name="cv${input.dataset.cvFile}_text"]`);
    box.value = /\.docx$/i.test(file.name) ? (await api("POST", "/api/profile/cv-docx", { data_base64: await fileBase64(file) })).text : await file.text();
    const label = main.querySelector(`input[name="cv${input.dataset.cvFile}_label"]`);
    if (label && !label.value) label.value = file.name.replace(/\.[^.]+$/, "").slice(0, 40);
  })));
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
      page = "mapa";
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

Promise.all([loadJobs(), loadProfile()])
  .then(() => render())
  .then(() => loadSidebar())
  .then(async () => {
    const first = document.querySelector("#sessions li[data-id]");
    if (first && !current) {
      current = await api("GET", `/api/sessions/${first.dataset.id}`);
      loadSidebar();
    }
  })
  .catch((error) => toast(error.message));
