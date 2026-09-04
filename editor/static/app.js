/* greenroom frontend: vanilla JS, one render() per state change */

const S = {
  view: "home",
  projects: [],
  library: [],
  templates: [],
  folders: [],
  project: null,
  sel: 0,
  drawer: null,        // {folder, assignTo}
  libCollection: null, // active library collection filter; new items inherit it
  hinge: null,         // {photoAsset, file, kind, ...} while modal open
  formats: [],         // app + audience pairs from the server
  campaigns: [],       // pushed in by Logan HQ, see the message listener below
  upload: null,        // {files, rows:[{format, campaign}]} while the flow is open
  uploading: null,     // {name, pct}
  toast: null,
  pollTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(path, opts = {}, retry = true) {
  if (opts.json) {
    opts.body = JSON.stringify(opts.json);
    opts.headers = { "Content-Type": "application/json" };
    delete opts.json;
    opts.method = opts.method || "POST";
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  let r;
  try {
    r = await fetch(path, { ...opts, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (retry) {
      await new Promise((res) => setTimeout(res, 900));
      return api(path, opts, false);
    }
    throw new Error("could not reach the app, try again in a second");
  }
  clearTimeout(timer);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

window.addEventListener("unhandledrejection", (e) => {
  console.error("unhandled", e.reason);
  toast((e.reason && e.reason.message) || "Something went wrong, try that again");
});

function toast(msg, ms = 2600) {
  const el = document.getElementById("toast-root");
  el.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.innerHTML = ""; }, ms);
}

function debounce(fn, ms) {
  let t = null, pending = null;
  const run = () => {
    clearTimeout(t);
    t = null;
    const args = pending;
    pending = null;
    return args ? fn(...args) : undefined;
  };
  const wrapped = (...a) => { pending = a; clearTimeout(t); t = setTimeout(run, ms); };
  // anything that acts on the SAVED project has to flush first. Dragging the cutout
  // and hitting Render straight after used to export the placement from before the
  // drag, because the save was still sitting in the debounce.
  wrapped.flush = () => (t ? run() : undefined);
  return wrapped;
}

/* ---------------- data ---------------- */

async function loadState() {
  const st = await api("api/state");
  S.projects = st.projects;
  S.library = st.library;
  S.templates = st.templates;
  S.folders = st.folders;
  S.formats = st.formats || [];
  // the apps come from the formats, so a new deal needs no code change here
  S.apps = st.apps || [];
  S.audiences = st.audiences || [];
  S.music = st.music || [];
}

function normalizeProject(p) {
  if (!p.hook) p.hook = { text: "", y: 0.45, size: 85 };
  if (!p.music) p.music = { enabled: true, file: "gymnopedie1.mp3", volume: 0.07 };
  if (!p.captions) p.captions = { enabled: true, size: 84, y: 0.8 };
  if (!p.cutWords) p.cutWords = [];
  if (p.app === undefined) p.app = "";
  if (p.format === undefined) p.format = "";
  if (!p.campaign) p.campaign = { id: "", name: "" };
  if (p.downloaded === undefined) p.downloaded = false;
  if (p.posted === undefined) p.posted = false;
  return p;
}

async function openProject(pid) {
  // Cards and automatic refills can be rebuilt while the videos page is already
  // open. Refresh the library before resolving the project's asset ids, otherwise
  // every newly generated card looks like a blank checkerboard until a hard reload.
  await loadState();
  S.project = normalizeProject(await api(`api/projects/${pid}`));
  S.view = "editor";
  S.sel = 0;
  render();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(S.pollTimer);
  const p = S.project;
  const busyHome = S.view === "home" && S.projects.some((x) => ["queued", "processing", "rendering"].includes(x.status));
  const previewing = p && p.preview && p.preview.status === "running";
  const busyEditor = S.view === "editor" && p &&
    (["queued", "processing", "rendering", "uploading"].includes(p.status) || previewing);
  if (!busyHome && !busyEditor) return;
  S.pollTimer = setTimeout(async () => {
    try {
      if (S.view === "editor" && p) {
        const key = (x) => x.status + x.progress + JSON.stringify(x.preview || {});
        const before = key(p);
        S.project = normalizeProject(await api(`api/projects/${p.id}`));
        if (key(S.project) !== before) render();
      } else {
        // and do not repaint at all when nothing moved. The editor branch above
        // already diffed; the home one repainted every 1.5s regardless, which is
        // what made the library scroll fight back.
        const key = (l) => l.map((x) => `${x.id}${x.status}${x.progress}`).join();
        const before = key(S.projects);
        await loadState();
        if (key(S.projects) !== before) render();
      }
    } catch (e) {}
    schedulePoll();
  }, 1500);
}

/* ---------------- uploads ---------------- */

function pickVideo() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "video/*";
  inp.multiple = true;
  inp.onchange = () => inp.files.length && openUploadFlow([...inp.files]);
  inp.click();
}

// ---- upload flow: every video gets a format and a campaign before it queues ----

function openUploadFlow(files) {
  files = files.filter((f) => f.type.startsWith("video") || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
  if (!files.length) { toast("Those are not video files"); return; }
  const lastFormat = localStorage.getItem("gr_lastFormat") || (S.formats[0] || {}).id || "";
  const lastCampaign = localStorage.getItem("gr_lastCampaign") || "";
  S.upload = {
    files,
    rows: files.map(() => ({ format: lastFormat, campaign: lastCampaign,
                            audience: localStorage.getItem("gr_lastAudience") || "" })),
  };
  render();
}

/** Copy row 1 down the list, for a batch that is all one series. */
function uploadApplyAll() {
  readUploadRows();                       // pick up edits BEFORE overwriting them
  const first = { ...S.upload.rows[0] };
  S.upload.rows = S.upload.rows.map(() => ({ ...first }));
  render();
}

/** Pull the selects back into state so a re-render does not lose what he picked. */
function readUploadRows() {
  S.upload.rows.forEach((row, i) => {
    const f = $(`#up-format-${i}`);
    const a = $(`#up-audience-${i}`);
    const c = $(`#up-campaign-${i}`);
    if (f) row.format = f.value;
    if (a) row.audience = a.value;
    if (c) row.campaign = c.value;
  });
}

function startUpload() {
  readUploadRows();
  const { files, rows } = S.upload;
  if (rows.some((r) => !r.format)) { toast("Pick a format for each video"); return; }
  // a format that owns its own photos is not about a group; everything else needs
  // one, or the hook comes out with a blank where the audience word should be
  const needsAud = (r) => {
    const f = S.formats.find((x) => x.id === r.format);
    return !(f && f.collection) && !r.audience;
  };
  if (rows.some(needsAud)) { toast("Pick who each video is about"); return; }
  localStorage.setItem("gr_lastFormat", rows[0].format);
  localStorage.setItem("gr_lastAudience", rows[0].audience || "");
  localStorage.setItem("gr_lastCampaign", rows[0].campaign || "");
  S.upload = null;
  uploadVideos(files, rows);
}

function uploadModal() {
  const multi = S.upload.files.length > 1;
  const formatOpts = (sel) => S.formats.map((f) =>
    `<option value="${f.id}" ${f.id === sel ? "selected" : ""}>${esc(f.name)}</option>`).join("");
  const campaignOpts = (sel) => `<option value="">No campaign</option>` + S.campaigns.map((c) =>
    `<option value="${esc(c.id)}" ${c.id === sel ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  // formats that own a pile of photos are not about a group, so they need no audience
  const audienceOpts = (sel, fid) => {
    const f = S.formats.find((x) => x.id === fid);
    if (f && f.collection) return `<option value="">not about a group</option>`;
    return `<option value="">pick who</option>` + S.audiences.map((a) =>
      `<option value="${esc(a.id)}" ${a.id === sel ? "selected" : ""}>${esc(a.label)}</option>`).join("");
  };
  const rows = S.upload.files.map((f, i) => `
    <div class="up-row">
      <div class="up-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <select id="up-format-${i}" onchange="readUploadRows()">${formatOpts(S.upload.rows[i].format)}</select>
      <select id="up-audience-${i}" onchange="readUploadRows()">${audienceOpts(S.upload.rows[i].audience, S.upload.rows[i].format)}</select>
      <select id="up-campaign-${i}" onchange="readUploadRows()">${campaignOpts(S.upload.rows[i].campaign)}</select>
    </div>`).join("");
  return `
  <div class="modal-veil" onclick="if(event.target===this){S.upload=null;render()}">
    <div class="modal" style="width:660px">
      <h2>${multi ? `${S.upload.files.length} videos` : "New video"}</h2>
      <p style="color:var(--muted);margin-bottom:14px">
        The format decides the hook and the app tag, who it is about decides the images.
      </p>
      ${!S.campaigns.length ? `<p class="note-warn">Campaigns load from Logan HQ. Open Greenroom from the HQ sidebar to tag videos to a campaign.</p>` : ""}
      <div class="up-row up-head">
        <div class="up-name">File</div><div>Format</div><div>Who it is about</div><div>Campaign</div>
      </div>
      ${rows}
      ${multi ? `<button class="ghost" style="margin-top:10px" onclick="uploadApplyAll()">Use the first row for all ${S.upload.files.length}</button>` : ""}
      <div class="actions">
        <button onclick="S.upload=null;render()">Cancel</button>
        <button class="primary" onclick="startUpload()">${multi ? `Queue ${S.upload.files.length} videos` : "Start"}</button>
      </div>
    </div>
  </div>`;
}

function uploadOne(file, label, opts) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", file.name.replace(/\.[^.]+$/, ""));
    if (opts && opts.format) fd.append("format", opts.format);
    // without this the hook renders with a blank where the audience word goes
    if (opts && opts.audience) fd.append("audience", opts.audience);
    if (opts && opts.campaign) {
      const c = S.campaigns.find((x) => x.id === opts.campaign);
      fd.append("campaignId", opts.campaign);
      fd.append("campaignName", c ? c.name : "");
    }
    const xhr = new XMLHttpRequest();
    S.uploading = { name: label, pct: 0 };
    render();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        S.uploading.pct = Math.round((e.loaded / e.total) * 100);
        const bar = $("#upl-bar");
        if (bar) bar.style.width = S.uploading.pct + "%";
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(xhr.responseText || "upload failed"));
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.open("POST", "api/projects");
    xhr.send(fd);
  });
}

function pickAppendClip() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "video/*";
  inp.onchange = () => inp.files.length && appendClip(inp.files[0]);
  inp.click();
}

async function appendClip(file) {
  // deliberately NOT through api(): that aborts after 12 seconds, and an aborted
  // POST of a several hundred MB clip gets re-sent, so the clip lands twice
  const fd = new FormData();
  fd.append("file", file);
  toast("Uploading the clip");
  const body = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    S.uploading = { name: file.name, pct: 0 };
    render();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) { S.uploading.pct = Math.round((e.loaded / e.total) * 100); render(); }
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(JSON.parse(xhr.responseText))
      : reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.open("POST", `api/projects/${S.project.id}/append`);
    xhr.send(fd);
  }).finally(() => { S.uploading = null; });
  S.project = normalizeProject(body);
  render();
  schedulePoll();
}

async function uploadVideos(files, rows) {
  files = files.filter((f) => f.type.startsWith("video") || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
  if (!files.length) {
    toast("Those are not video files");
    return;
  }
  let first = null;
  for (let i = 0; i < files.length; i++) {
    const label = files.length > 1 ? `${files[i].name} (${i + 1} of ${files.length})` : files[i].name;
    try {
      const p = await uploadOne(files[i], label, rows ? rows[i] : null);
      if (!first) first = p;
      await loadState();
      render();
    } catch (e) {
      toast(`Upload failed: ${files[i].name}`);
    }
  }
  S.uploading = null;
  if (files.length === 1 && first) {
    await openProject(first.id);
  } else {
    toast(`${files.length} videos queued, they process one after another`);
    await loadState();
    render();
  }
  schedulePoll();
}

async function uploadAsset(file, folder) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("folder", folder);
  if (S.libCollection) fd.append("collection", S.libCollection);
  try {
    await api("api/library", { method: "POST", body: fd });
    await loadState();
    render();
    toast("Added to library");
  } catch (e) {
    toast("Could not add: " + e.message);
  }
}

/* ---------------- scene edits ---------------- */

const pushScenes = debounce(async () => {
  const p = S.project;
  try {
    const resp = await api(`api/projects/${p.id}/scenes`, { json: { scenes: p.scenes } });
    p.rev = resp.rev;   // keep local object references alive (mid-drag state stays valid)
  } catch (e) {
    toast("Save failed: " + e.message);
  }
}, 450);

function updateScene(patch, rerender = true) {
  const sc = S.project.scenes[S.sel];
  Object.assign(sc, patch);
  pushScenes();
  if (rerender) render();
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function selScene(i) {
  const p = S.project;
  if (!p || !p.scenes.length) return;
  S.sel = clamp(i, 0, p.scenes.length - 1);
  render();
}

document.addEventListener("keydown", (e) => {
  if (S.view !== "editor" || !S.project || S.drawer || S.hinge || S.previewOpen) return;
  const t = e.target;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "AUDIO", "VIDEO"].includes(t.tagName))) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); selScene(S.sel - 1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); selScene(S.sel + 1); }
});

async function toggleCutRange(lo, hi) {
  const p = S.project;
  const cur = new Set(p.cutWords || []);
  const cutting = !cur.has(lo);
  for (let i = lo; i <= hi; i++) cutting ? cur.add(i) : cur.delete(i);
  S.project = normalizeProject(await api(`api/projects/${p.id}/cuts`, { json: { cutWords: [...cur] } }));
  render();
}

async function restoreAllCuts() {
  S.project = normalizeProject(await api(`api/projects/${S.project.id}/cuts`, { json: { cutWords: [] } }));
  render();
  toast("All cuts restored");
}

async function autoCut() {
  S.project = normalizeProject(await api(`api/projects/${S.project.id}/cuts`, { json: { auto: true } }));
  render();
  toast("Auto cut applied");
}

function sceneKeptWords(p, sc) {
  const cutSet = new Set(p.cutWords || []);
  const out = [];
  for (let i = sc.start; i <= (sc.end ?? p.words.length - 1); i++) {
    if (!cutSet.has(i)) out.push(p.words[i].w);
  }
  return out;
}

async function assignAsset(assetId) {
  const d = S.drawer || {};
  const idx = d.assignTo != null ? d.assignTo : S.sel;
  S.sel = idx;
  const sc = S.project.scenes[idx];
  const asset = S.library.find((a) => a.id === assetId);
  if (d.target === "overlay") {
    if (asset && asset.type !== "image") {
      toast("Overlays need an image");
      return;
    }
    sc.overlayAsset = assetId;
    if (!sc.overlayWord) {
      // his format: the app store shot comes in when he says the app name
      const words = sceneKeptWords(S.project, sc);
      const app = String(S.project.app || "").trim().toLowerCase();
      const hit = app && words.find((w) => w.toLowerCase().includes(app));
      sc.overlayWord = (hit || words[0] || "").replace(/[.,?!;:]+$/, "");
    }
  } else {
    sc.asset = assetId;
    if (asset && asset.type === "video") sc.hideHead = true;
  }
  S.drawer = null;
  render();   // close instantly, the save syncs in the background
  try {
    const resp = await api(`api/projects/${S.project.id}/scenes`, { json: { scenes: S.project.scenes } });
    S.project.rev = resp.rev;
    render();
  } catch (e) {
    toast("Save failed: " + e.message);
  }
}

async function toggleBreak(wordIdx) {
  if (wordIdx === 0) return;
  const p = S.project;
  const has = p.breaks.includes(wordIdx);
  const breaks = has ? p.breaks.filter((b) => b !== wordIdx) : [...p.breaks, wordIdx];
  S.project = normalizeProject(await api(`api/projects/${p.id}/breaks`, { json: { breaks } }));
  S.sel = Math.min(S.sel, S.project.scenes.length - 1);
  render();
}

/**
 * Merge a scene into the one before it, which is what deleting a scene means here.
 *
 * Scenes are not stored as objects that can be removed: they are the gaps between
 * breaks, so a scene disappears by dropping the break that opens it. Cutting words
 * can leave a scene holding one word, which is too short to cut to and renders as a
 * flash, and until now the only way out was hunting for the right word in the Words
 * tab and clicking it to merge.
 *
 * Scene 1 has no scene before it, so instead its FOLLOWING break goes: scene 2's
 * words come back into scene 1. Either way one fewer scene, nothing orphaned.
 */
async function deleteScene(i) {
  const p = S.project;
  if (!p.scenes || p.scenes.length < 2) {
    toast("A video needs at least one scene");
    return;
  }
  const opener = p.scenes[i].start;
  // scene 1 opens at word 0, and break 0 always exists, so drop the next one instead
  const drop = i === 0 ? p.scenes[1].start : opener;
  const breaks = p.breaks.filter((b) => b !== drop);
  S.project = normalizeProject(await api(`api/projects/${p.id}/breaks`, { json: { breaks } }));
  S.sel = Math.max(0, Math.min(i === 0 ? 0 : i - 1, S.project.scenes.length - 1));
  toast(i === 0 ? "Merged into scene 1" : `Merged into scene ${i}`);
  render();
}

/** Delete a scene outright: the words go too, so the section leaves the video. */
async function removeScene(i) {
  const p = S.project;
  if (!p.scenes || p.scenes.length < 2) {
    toast("A video needs at least one scene");
    return;
  }
  const sc = p.scenes[i];
  const n = sc.end - sc.start + 1;
  if (!confirm(`Delete scene ${i + 1} and cut its ${n} word${n === 1 ? "" : "s"} out of the video?`)) return;
  // one call, because cutting and dropping the break separately would have the
  // second working off scene indices the first had already shifted
  S.project = normalizeProject(await api(`api/projects/${p.id}/scenes/${i}/remove`, { json: {} }));
  S.sel = Math.max(0, Math.min(i, S.project.scenes.length - 1));
  toast("Scene deleted");
  render();
}

const pushSettings = debounce(async (body) => {
  const resp = await api(`api/projects/${S.project.id}/settings`, { json: body });
  if (body.gapCut !== undefined || body.reproposeScenes) {
    S.project = normalizeProject(resp);
    render();
  } else {
    S.project.rev = resp.rev;
    // the hook on the stage is a server rendered sprite keyed on rev, so without
    // this it keeps showing the old text until something else redraws
    if (body.hook !== undefined) render();
  }
}, 500);

/* ---------------- render actions ---------------- */

/**
 * Re-run the pipeline over a video that is already processed.
 *
 * The DM inbox and the stat cards are drawn once, when the video is first built,
 * from whatever was in the library at that moment. Add photos to an audience
 * afterwards and the finished video still carries the empty inbox it was born
 * with, which is what its own warning means by "add some and rebuild". The
 * endpoint for that already existed, nothing ever called it.
 */
async function rebuildProject() {
  await flushEdits();
  // /cards, not /reprocess: reprocess rebuilds the matte, which is slow and does
  // not touch the inbox at all
  const rebuilt = await api(`api/projects/${S.project.id}/cards`, { method: "POST" });
  // /cards creates brand new library rows. The project response contains their ids,
  // but the editor's old library snapshot cannot resolve them until it is refreshed.
  await loadState();
  S.project = normalizeProject(rebuilt);
  toast(S.project.warning ? S.project.warning : "Inbox and cards rebuilt");
  render();
}

async function startPreviewVideo() {
  await flushEdits();
  S.project = normalizeProject(await api(`api/projects/${S.project.id}/preview`, { method: "POST" }));
  S.previewOpen = true;
  render();
  schedulePoll();
}

function viewPreviewModal() {
  if (!S.previewOpen || !S.project) return "";
  const p = S.project;
  const pv = p.preview || {};
  let body;
  if (pv.status === "done" && pv.file) {
    body = `<video controls autoplay playsinline src="files/projects/${p.id}/${pv.file}?v=${pv.rev}"
              style="width:300px;max-width:80vw;border-radius:14px;display:block;margin:0 auto"></video>`;
  } else if (pv.status === "error") {
    body = `<p style="color:var(--danger)">Preview failed: ${esc(pv.error || "unknown")}</p>`;
  } else {
    body = `<p style="color:var(--muted)">Building a quick preview of the full edit, under a minute. Reopening it later is instant until you change something.</p>
      <div class="progress" style="margin-top:14px"><i style="width:${Math.round((pv.progress || 0) * 100)}%"></i></div>`;
  }
  return `
  <div class="modal-veil" onclick="if(event.target===this){S.previewOpen=false;render()}">
    <div class="modal" style="width:360px">
      <h2>Preview</h2>
      ${body}
      <div class="actions"><button onclick="S.previewOpen=false;render()">Close</button></div>
    </div>
  </div>`;
}

/** Make sure every pending edit has reached the server before we act on the saved
 *  project. Both of these are debounced, so an edit can still be in flight. */
async function flushEdits() {
  try {
    await Promise.all([pushScenes.flush(), pushSettings.flush()].filter(Boolean));
  } catch (e) {
    toast("Save failed, not rendering: " + e.message);
    throw e;
  }
}

async function startRender() {
  await flushEdits();
  const p = S.project;
  const missing = p.scenes
    .map((s, i) => (!s.asset && !s.hideHead ? i + 1 : null))
    .filter((x) => x != null);
  if (missing.length &&
      !confirm(`Scenes ${missing.join(", ")} have no background yet (they will render with a placeholder). Render anyway?`)) {
    return;
  }
  await api(`api/projects/${p.id}/render`, { method: "POST" });
  S.project.status = "rendering";
  S.project.progress = 0;
  render();
  schedulePoll();
}

async function saveTemplate() {
  const name = prompt("Template name?");
  if (!name) return;
  await api("api/templates", { json: { name, fromProject: S.project.id } });
  await loadState();
  render();
  toast("Template saved");
}

async function applyTemplate(tid) {
  if (!tid) return;
  S.project = normalizeProject(await api(`api/projects/${S.project.id}/apply_template`, { json: { template: tid } }));
  render();
  toast("Template applied");
}

async function deleteProject(pid) {
  if (!confirm("Delete this project and its renders?")) return;
  await api(`api/projects/${pid}`, { method: "DELETE" });
  await loadState();
  render();
}

/* ---------------- hinge modal ---------------- */

function openHinge(assignTo = null) {
  // your liked photo is basically always the same: remember the last one used,
  // fall back to a generated photo from the app folder
  const remembered = localStorage.getItem("gr_topPhoto") || "";
  const topDefault = (remembered && S.library.some((a) => a.id === remembered))
    ? remembered
    : ((S.library.find((a) => a.folder === "app" && /generated/i.test(a.name)) || {}).id || "");
  S.hinge = { kind: "like", name: "", age: "", promptLabel: "Would you rather",
              promptAnswer: "give me all your money", photoAsset: "", file: null,
              message: "majestic ahhh", pronouns: "she/her/hers",
              topPhotoAsset: topDefault, topFile: null, coverFace: false, topFilter: "app",
              filter: S.project ? suggestCollection(S.project) : (S.libCollection || ""),
              busy: false, assignTo };
  render();
}

function hingePickHer(id) { S.hinge.photoAsset = id; S.hinge.file = null; render(); }
function hingePickTop(id) {
  S.hinge.topPhotoAsset = id;
  S.hinge.topFile = null;
  localStorage.setItem("gr_topPhoto", id);
  render();
}

async function submitHinge() {
  const h = S.hinge;
  if (!h.name.trim()) return toast("Give them a name");
  if (!h.file && !h.photoAsset) return toast("Pick or upload a photo");
  h.busy = true;
  render();
  const fd = new FormData();
  for (const k of ["kind", "name", "age", "promptLabel", "promptAnswer", "photoAsset",
                   "message", "pronouns", "topPhotoAsset"]) fd.append(k, h[k] || "");
  fd.append("coverFace", h.coverFace ? "1" : "0");
  if (S.libCollection) fd.append("collection", S.libCollection);
  if (h.file) fd.append("photo", h.file);
  if (h.topFile) fd.append("topPhoto", h.topFile);
  try {
    const item = await api("api/card", { method: "POST", body: fd });
    await loadState();
    const assignTo = h.assignTo;
    S.hinge = null;
    if (assignTo != null && S.project) {
      S.drawer = { folder: "hinge", assignTo };
      await assignAsset(item.id);
      toast(`Card for ${item.name} made and set on scene ${assignTo + 1}`);
    } else {
      if (S.drawer) S.drawer.folder = "hinge";
      render();
      toast(`Card for ${item.name} added to library`);
    }
  } catch (e) {
    h.busy = false;
    render();
    toast("Card failed: " + e.message);
  }
}

/* ---------------- views ---------------- */

function statusChip(st) {
  const labels = { uploading: "uploading", queued: "waiting in queue", processing: "processing",
                   ready: "ready to edit", rendering: "rendering", done: "rendered", error: "error" };
  return `<span class="chip ${st}">${labels[st] || st}</span>`;
}



function projectCard(p, showStatus) {
  const doneBtn = p.status === "done"
    ? (p.posted
      ? `<button class="ghost" onclick="event.stopPropagation(); markPosted('${p.id}', false)">not done</button>`
      : `<button class="ghost" onclick="event.stopPropagation(); markPosted('${p.id}', true)">mark done</button>`)
    : "";
  return `
    <div class="project-card ${p.posted ? "dimmed" : ""}" onclick="openProject('${p.id}')">
      <div class="card-top">
        <h3>${esc(p.name)}</h3>
        ${doneBtn}
        <button class="ghost danger" onclick="event.stopPropagation(); deleteProject('${p.id}')">delete</button>
      </div>
      <div class="meta">
        ${showStatus ? statusChip(p.status) : ""}
        ${p.app ? `<span class="chip app-${esc(p.app)}">${esc(p.app)}</span>` : ""}
        ${p.format ? `<span class="chip format">${esc(formatLabel(p.format))}</span>` : ""}
        ${p.campaign && p.campaign.name ? `<span class="chip campaign">${esc(p.campaign.name)}</span>` : ""}
        ${p.duration ? `<span class="dur">${Math.round(p.duration)}s raw${p.outDuration ? `, ${Math.round(p.outDuration)}s final` : ""}</span>` : ""}
      </div>
      ${["queued", "processing", "rendering"].includes(p.status)
        ? `<div class="progress"><i style="width:${Math.round((p.progress || 0) * 100)}%"></i></div>` : ""}
    </div>`;
}

function viewHome() {
  const buckets = [
    ["working on it", (p) => ["uploading", "queued", "processing", "rendering"].includes(p.status), true],
    ["ready to edit", (p) => p.status === "ready", false],
    ["rendered, grab these", (p) => p.status === "done" && !p.downloaded && !p.posted, false],
    ["downloaded", (p) => p.status === "done" && p.downloaded && !p.posted, false],
    ["done", (p) => p.posted, false],
    ["errored", (p) => p.status === "error", true],
  ];
  const sections = buckets.map(([title, match, showStatus]) => {
    const items = S.projects.filter(match);
    if (!items.length) return "";
    return `<h2 class="stage-title">${title} (${items.length})</h2>
      <div class="projects-grid">${items.map((p) => projectCard(p, showStatus)).join("")}</div>`;
  }).join("");
  const cards = sections;

  return `
  <div class="wrap">
    <div class="page-head">
      <div>
        <h1>Greenroom</h1>
        <p>Talking head videos, minus the editing</p>
      </div>
      <div class="page-head-actions">
        <button onclick="openCards()">Backgrounds</button>
        <button onclick="S.drawer={folder:'backgrounds',assignTo:null};render()">Library</button>
        <button class="primary" onclick="pickVideo()">New video</button>
      </div>
    </div>
    ${S.uploading ? `
      <div class="panel" style="margin-bottom:16px">
        Uploading ${esc(S.uploading.name)}
        <div class="progress"><i id="upl-bar" style="width:${S.uploading.pct}%"></i></div>
      </div>` : `
      <div class="drop" id="drop" onclick="pickVideo()">
        Drop one or more raw recordings here (or click). Each becomes its own video, they process one after another, and you can edit any finished one while the rest wait.
      </div>`}
    ${S.projects.length ? cards : `<div class="empty">No videos yet</div>`}
  </div>`;
}

/** Opening the library from inside a video scopes it to that video's format, so the
 *  green screen images on offer are only the ones for this series. The collection
 *  chips are still there to widen it back out. */
function openLibrary(folder, assignTo, target) {
  const coll = S.project ? suggestCollection(S.project) : "";
  // only backgrounds live in a collection; app shots never do, so scoping the
  // overlay picker by one leaves it permanently empty
  S.libCollection = target === "overlay" ? "" : (coll || S.libCollection || "");
  // and land on the folder that actually holds the pictures for this video. Taking
  // the FIRST folder with any match at all meant a furry video opened on dating
  // cards, because there happen to be three of those and folder order puts them
  // ahead of the 28 actual furry photos. Most matches wins instead.
  const count = (f) => S.library.filter((a) => a.folder === f
    && (!S.libCollection || a.collection === S.libCollection)).length;
  if (!count(folder)) {
    const best = (S.folders || []).slice().sort((a, b) => count(b) - count(a))[0];
    if (best && count(best)) folder = best;
  }
  S.drawer = { folder, assignTo, target };
  render();
}

function formatLabel(fid) {
  const f = S.formats.find((x) => x.id === fid);
  return f ? f.name : fid;
}

function suggestCollection(p) {
  // the chosen format owns this; the transcript scan is only for videos with no format
  const byFormat = (S.formats.find((f) => f.id === p.format) || {}).collection;
  if (byFormat) return byFormat;
  const byAud = (S.audiences.find((a) => a.id === p.audience) || {}).collection;
  if (byAud) return byAud;
  const text = (p.words || []).map((w) => w.w.toLowerCase()).join(" ");
  if (/femboy/.test(text)) return "trans/femboy";
  if (/furr/.test(text)) return "furrys";
  if (/torta/.test(text)) return "torta";
  return S.libCollection || "";
}

/** `reapply` clears the hook so the format writes a fresh one and reshuffles images. */
async function setFormat(fid, reapply) {
  S.project.format = fid;
  render();
  S.project = normalizeProject(await api(`api/projects/${S.project.id}/settings`,
    { json: { format: fid, reapply: !!reapply } }));
  render();
}

async function setCampaign(id) {
  const c = S.campaigns.find((x) => x.id === id);
  S.project.campaign = { id, name: c ? c.name : "" };
  render();
  S.project = normalizeProject(await api(`api/projects/${S.project.id}/settings`,
    { json: { campaign: S.project.campaign } }));
  render();
}

async function markPosted(pid, val) {
  await api(`api/projects/${pid}/settings`, { json: { posted: val } });
  await loadState();
  render();
}

async function fillScenes() {
  const coll = $("#fillcoll") ? $("#fillcoll").value : "";
  if (!coll) { toast("Pick a collection first"); return; }
  S.project = normalizeProject(await api(`api/projects/${S.project.id}/fill`, { json: { collection: coll } }));
  render();
  toast(`Every scene filled from ${coll}, click again to reshuffle`);
}

/** Replace a scene's background with a grid of photos, four up by default. Click
 *  again for a different four. */
async function makeCollage(i) {
  const coll = ($("#fillcoll") && $("#fillcoll").value) || "";
  S.project = normalizeProject(
    await api(`api/projects/${S.project.id}/collage`, { json: { scene: i, collection: coll, count: 4 } }),
  );
  render();
  toast("Photo grid made, click again for a different four");
}

/**
 * Match every scene to the kind of photo its line is asking for, then fill from
 * that. The keyword scan only ever caught lines that happened to use the same word
 * as the tag, so most scenes came back random and had to be fixed by hand.
 *
 * This runs inside Logan HQ, same origin, so it can reach HQ's own endpoint and its
 * stored passcode. Standalone on localhost there is no key, so it says so and the
 * plain fill still works.
 */
async function smartFill() {
  const coll = $("#fillcoll") ? $("#fillcoll").value : "";
  if (!coll) { toast("Pick a collection first"); return; }
  const pass = (() => { try { return localStorage.getItem("ugc-hq-passcode") || ""; } catch (e) { return ""; } })();
  if (!pass) { toast("Open this from Logan HQ to match photos to the script"); return; }

  toast("Reading the script");
  const { lines, shotTypes } = await api(`api/projects/${S.project.id}/lines`);
  // the matcher runs on Claude too, so it goes on whoever's key is set, same as scripts
  const aikey = (() => { try { return localStorage.getItem("ugc-hq-anthropic-key") || ""; } catch (e) { return ""; } })();
  const r = await fetch("/api/shots", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", "x-passcode": pass },
                           aikey ? { "x-anthropic-key": aikey } : {}),
    body: JSON.stringify({ lines, shotTypes }),
  });
  const raw = await r.text();
  let data = {};
  try { data = JSON.parse(raw); } catch (e) { /* an error page, not json */ }
  if (!r.ok || data.error) throw new Error(data.error || `Could not match the photos (${r.status})`);

  S.project = normalizeProject(
    await api(`api/projects/${S.project.id}/fill`, { json: { collection: coll, plan: data.plan } }),
  );
  render();
  const named = (data.plan || []).filter(Boolean).length;
  const unmet = (S.project.unmet || []);
  toast(unmet.length
    ? `Matched ${named} of ${lines.length}. You have no photos for: ${unmet.join(", ")}`
    : `Matched ${named} of ${lines.length} scenes to the script`);
}

function sceneWords(p, sc) {
  const cutSet = new Set(p.cutWords || []);
  return p.words.slice(sc.start, (sc.end ?? p.words.length - 1) + 1)
    .filter((w, k) => !cutSet.has(sc.start + k)).map((w) => w.w).join(" ");
}

function sceneFirstWord(p, sc) {
  const cutSet = new Set(p.cutWords || []);
  for (let i = sc.start; i <= (sc.end ?? p.words.length - 1); i++) {
    if (!cutSet.has(i)) return p.words[i].w.replace(/[.,?!;:]+$/, "");
  }
  return "";
}

function overlayWordOptions(p, sc) {
  const norm = (w) => w.replace(/[.,?!;:]+$/, "");
  const sel = norm(String(sc.overlayWord || "")).toLowerCase();
  const seen = new Set();
  return sceneKeptWords(p, sc).map((w) => {
    const v = norm(w);
    const key = v.toLowerCase();
    if (seen.has(key)) return "";
    seen.add(key);
    return `<option value="${esc(v)}" ${key === sel ? "selected" : ""}>${esc(v)}</option>`;
  }).join("");
}

function stageHtml(p, sc) {
  let bg = '<div class="checker"></div>';
  if (sc && sc.asset) {
    const a = S.library.find((x) => x.id === sc.asset);
    if (a) {
      const src = `files/library/${a.folder}/${a.file}`;
      bg = a.type === "video"
        ? `<video class="stage-bg" src="${src}" muted playsinline preload="metadata"></video>`
        : `<img class="stage-bg" src="${src}" alt="">`;
    }
  }
  const person = sc && !sc.hideHead
    ? `<div class="person-box" id="pbox">
         <img id="pimg" src="api/projects/${p.id}/person_sprite/${S.sel}?v=${sc.start}" draggable="false" alt="">
         <div class="phandle" id="phandle"></div>
       </div>` : "";
  let overlay = "";
  if (sc && sc.overlayAsset) {
    const a = S.library.find((x) => x.id === sc.overlayAsset);
    if (a && a.type === "image") {
      overlay = `<div class="overlay-box" id="obox">
        <img id="oimg" src="files/library/${a.folder}/${a.file}" draggable="false" alt="">
        <div class="phandle" id="ohandle"></div>
      </div>`;
    }
  }
  const cap = p.captions.enabled && sc
    ? `<div class="stage-caption" id="scap">${esc(sceneFirstWord(p, sc))}</div>` : "";
  const hook = (S.sel === 0 && p.hook && p.hook.text.trim())
    ? `<img class="stage-hook" id="shook" draggable="false" alt=""
         src="api/projects/${p.id}/hook_sprite?rev=${p.rev || 0}">` : "";
  return `<div class="stage" id="stage">${bg}${person}${overlay}${hook}${cap}</div>`;
}

function setupStage() {
  const stage = $("#stage");
  if (!stage || !S.project) return;
  const sc = S.project.scenes[S.sel];
  if (!sc) return;
  const pbox = $("#pbox"), pimg = $("#pimg"), handle = $("#phandle"), cap = $("#scap");
  const dims = () => {
    const r = stage.getBoundingClientRect();
    return { sw: r.width, sh: r.height, top: r.top };
  };

  function layoutPerson() {
    if (!pbox || !pimg.naturalWidth) return;
    const { sw, sh } = dims();
    const wpx = sc.headScale * sw;
    const hpx = wpx * pimg.naturalHeight / pimg.naturalWidth;
    pbox.style.width = wpx + "px";
    pbox.style.height = hpx + "px";
    pbox.style.left = ((sw - wpx) / 2 + sc.headX * sw) + "px";
    pbox.style.top = (sh - hpx + sc.headY * sh) + "px";
  }
  function layoutCaption() {
    if (!cap) return;
    const { sw, sh } = dims();
    cap.style.top = (S.project.captions.y * sh) + "px";
    const fpx = S.project.captions.size / 1080 * sw;
    cap.style.fontSize = fpx + "px";
    cap.style.webkitTextStroke = (fpx * 0.13).toFixed(1) + "px #111";
    cap.style.transform = "translateY(-50%)";
  }

  let drag = null;
  if (pbox) {
    pimg.onload = layoutPerson;
    if (pimg.complete) layoutPerson();
    pbox.addEventListener("pointerdown", (e) => {
      if (e.target === handle) return;
      e.preventDefault();
      try { pbox.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { kind: "move", x: e.clientX, y: e.clientY, hx: sc.headX, hy: sc.headY };
      pbox.classList.add("sel");
    });
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { kind: "scale", x: e.clientX, s: sc.headScale };
      pbox.classList.add("sel");
    });
    const move = (e) => {
      if (!drag) return;
      const { sw, sh } = dims();
      if (drag.kind === "move") {
        sc.headX = clamp(drag.hx + (e.clientX - drag.x) / sw, -0.6, 0.6);
        sc.headY = clamp(drag.hy + (e.clientY - drag.y) / sh, -0.5, 0.5);
      } else if (drag.kind === "scale") {
        sc.headScale = clamp(drag.s + 2 * (e.clientX - drag.x) / sw, 0.4, 1.6);
      }
      layoutPerson();
    };
    const up = () => {
      if (drag && drag.kind !== "cap") {
        drag = null;
        pbox.classList.remove("sel");
        pushScenes();
      }
    };
    pbox.addEventListener("pointermove", move);
    handle.addEventListener("pointermove", move);
    pbox.addEventListener("pointerup", up);
    handle.addEventListener("pointerup", up);
    pbox.addEventListener("dblclick", () => {
      sc.headScale = 1; sc.headX = 0; sc.headY = 0;
      layoutPerson();
      pushScenes();
    });
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      sc.headScale = clamp(sc.headScale * (1 - e.deltaY * 0.0008), 0.4, 1.6);
      layoutPerson();
      pushScenes();
    }, { passive: false });
  }
  const obox = $("#obox"), oimg = $("#oimg"), ohandle = $("#ohandle");
  function layoutOverlay() {
    if (!obox || !oimg.naturalWidth) return;
    const { sw, sh } = dims();
    const wpx = (sc.overlayScale ?? 0.62) * sw;
    const hpx = wpx * oimg.naturalHeight / oimg.naturalWidth;
    obox.style.width = wpx + "px";
    obox.style.height = hpx + "px";
    obox.style.left = ((sw - wpx) / 2 + (sc.overlayX ?? 0) * sw) + "px";
    obox.style.top = ((sc.overlayY ?? 0.42) * sh - hpx / 2) + "px";
  }
  if (obox) {
    oimg.onload = layoutOverlay;
    if (oimg.complete) layoutOverlay();
    obox.addEventListener("pointerdown", (e) => {
      if (e.target === ohandle) return;
      e.preventDefault();
      try { obox.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { kind: "omove", x: e.clientX, y: e.clientY, ox: sc.overlayX ?? 0, oy: sc.overlayY ?? 0.42 };
    });
    ohandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { ohandle.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { kind: "oscale", x: e.clientX, s: sc.overlayScale ?? 0.62 };
    });
    const omove = (e) => {
      if (!drag) return;
      const { sw, sh } = dims();
      if (drag.kind === "omove") {
        sc.overlayX = clamp(drag.ox + (e.clientX - drag.x) / sw, -0.5, 0.5);
        sc.overlayY = clamp(drag.oy + (e.clientY - drag.y) / sh, 0.05, 0.95);
      } else if (drag.kind === "oscale") {
        sc.overlayScale = clamp(drag.s + 2 * (e.clientX - drag.x) / sw, 0.2, 1.0);
      } else {
        return;
      }
      layoutOverlay();
    };
    const oup = () => {
      if (drag && (drag.kind === "omove" || drag.kind === "oscale")) {
        drag = null;
        pushScenes();
      }
    };
    obox.addEventListener("pointermove", omove);
    ohandle.addEventListener("pointermove", omove);
    obox.addEventListener("pointerup", oup);
    ohandle.addEventListener("pointerup", oup);
    obox.addEventListener("dblclick", () => {
      sc.overlayScale = 0.62; sc.overlayX = 0; sc.overlayY = 0.42;
      layoutOverlay();
      pushScenes();
    });
    obox.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sc.overlayScale = clamp((sc.overlayScale ?? 0.62) * (1 - e.deltaY * 0.0008), 0.2, 1.0);
      layoutOverlay();
      pushScenes();
    }, { passive: false });
  }
  const shook = $("#shook");
  function layoutHook() {
    if (!shook || !shook.naturalWidth) return;
    const { sw, sh } = dims();
    const hk = S.project.hook;
    const hw = shook.naturalWidth / 1080 * sw;
    const hh = shook.naturalHeight / shook.naturalWidth * hw;
    shook.style.width = hw + "px";
    shook.style.left = ((sw - hw) / 2) + "px";
    shook.style.top = (hk.y * sh - hh / 2) + "px";
  }
  if (shook) {
    shook.onload = layoutHook;
    if (shook.complete) layoutHook();
    shook.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { shook.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { kind: "hook" };
    });
    shook.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "hook") return;
      const d2 = dims();
      S.project.hook.y = clamp((e.clientY - d2.top) / d2.sh, 0.08, 0.9);
      layoutHook();
    });
    shook.addEventListener("pointerup", () => {
      if (drag && drag.kind === "hook") {
        drag = null;
        pushSettings({ hook: S.project.hook });
      }
    });
    layoutHook();
  }
  if (cap) {
    cap.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { cap.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { kind: "cap" };
    });
    cap.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "cap") return;
      const d = dims();
      S.project.captions.y = clamp((e.clientY - d.top) / d.sh, 0.2, 0.92);
      layoutCaption();
    });
    cap.addEventListener("pointerup", () => {
      if (drag && drag.kind === "cap") {
        drag = null;
        pushSettings({ captions: S.project.captions });
      }
    });
  }
  layoutCaption();
}

function outStarts(p) {
  // out-time start of every kept word, mirroring the renderer's caption timing
  const starts = [];
  const cut = new Set(p.cutWords || []);
  let acc = 0;
  for (const [s0, e0, fw, lw] of p.segments) {
    for (let i = fw; i <= lw; i++) {
      if (cut.has(i)) continue;
      starts.push([acc + Math.max(p.words[i].s, s0) - s0, i]);
    }
    acc += e0 - s0;
  }
  return starts;
}

function setupTranscript() {
  const el = $("#transcript");
  if (!el) return;
  let sel = null;
  const wordAt = (t) => (t.classList && t.classList.contains("w")) ? +t.dataset.i : null;

  const voice = $("#voice");
  if (voice && S.tmode === "listen") {
    const starts = outStarts(S.project);
    let timer = null;
    let lastIdx = null;
    const paint = () => {
      const t = voice.currentTime;
      let lo = 0, hi = starts.length - 1, j = 0;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (starts[m][0] <= t + 0.02) { j = m; lo = m + 1; } else { hi = m - 1; }
      }
      const idx = starts.length ? starts[j][1] : null;
      if (idx === lastIdx) return;
      lastIdx = idx;
      el.querySelectorAll(".w.playing").forEach((n) => n.classList.remove("playing"));
      if (idx != null) {
        const n = el.querySelector(`.w[data-i="${idx}"]`);
        if (n) {
          n.classList.add("playing");
          n.scrollIntoView({ block: "nearest" });
        }
      }
    };
    voice.addEventListener("play", () => { clearInterval(timer); timer = setInterval(paint, 90); });
    voice.addEventListener("pause", () => clearInterval(timer));
    voice.addEventListener("ended", () => clearInterval(timer));
    voice.addEventListener("seeked", paint);
    el.addEventListener("click", (e) => {
      if (S.tmode !== "listen") return;
      const i = wordAt(e.target);
      if (i == null) return;
      const hit = starts.find((s) => s[1] >= i);
      if (hit) {
        voice.currentTime = Math.max(0, hit[0] - 0.05);
        voice.play();
      }
    });
  }
  el.addEventListener("pointerdown", (e) => {
    if (S.tmode !== "cuts") return;
    const i = wordAt(e.target);
    if (i == null) return;
    e.preventDefault();
    sel = { a: i, b: i };
    e.target.classList.add("selrange");
  });
  el.addEventListener("pointerover", (e) => {
    if (!sel) return;
    const i = wordAt(e.target);
    if (i == null) return;
    sel.b = i;
    const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
    el.querySelectorAll(".w").forEach((n) =>
      n.classList.toggle("selrange", +n.dataset.i >= lo && +n.dataset.i <= hi));
  });
  document.onpointerup = () => {
    if (!sel) return;
    const { a, b } = sel;
    sel = null;
    toggleCutRange(Math.min(a, b), Math.max(a, b)).catch((err) => { toast(err.message); render(); });
  };
  el.addEventListener("click", (e) => {
    if (S.tmode === "cuts" || S.tmode === "listen") return;
    const i = wordAt(e.target);
    if (i != null) toggleBreak(i).catch((err) => { toast(err.message); render(); });
  });
}

function assetThumb(assetId) {
  const a = S.library.find((x) => x.id === assetId);
  if (!a) return null;
  return a.thumb ? `files/library/${a.folder}/${a.thumb}` : null;
}

function viewEditor() {
  const p = S.project;
  const busy = ["queued", "processing", "uploading"].includes(p.status);
  if (busy) {
    return `
    <div class="topbar">
      ${backButton()}
      <h1>${esc(p.name)}</h1>
      ${statusChip(p.status)}
    </div>
    <div class="wrap">
      <div class="panel">
        <h2>${p.appendSrc ? "Adding your clip to the end" : "Processing your video"}</h2>
        <p style="color:var(--muted)">${p.appendSrc
          ? "Adding your new clip to the end: transcript, dead space cut, and the high quality cutout, then it lands as the last scene. A short clip takes a couple of minutes."
          : "Transcribing, finding dead space, and running the high quality cutout frame by frame at full frame rate. This is the slow part, a one minute video takes a few minutes. You only wait once per upload."}</p>
        <div class="progress" style="margin-top:14px"><i style="width:${Math.round((p.progress || 0) * 100)}%"></i></div>
      </div>
    </div>`;
  }
  if (p.status === "error") {
    return `
    <div class="topbar">${backButton()}<h1>${esc(p.name)}</h1>${statusChip("error")}</div>
    <div class="wrap"><div class="panel">Something broke: ${esc(p.error)}</div></div>`;
  }

  const sc = p.scenes[S.sel] || p.scenes[0];
  const cut = (p.duration - p.outDuration).toFixed(1);
  const cutSet = new Set(p.cutWords || []);
  const tab = S.etab || "scenes";
  const rendering = p.status === "rendering";
  const templates = S.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");

  const scenes = p.scenes.map((s, i) => {
    const at = assetThumb(s.asset);
    const open = i === S.sel;
    const controls = open ? `
      <div class="controls scene-controls" onclick="event.stopPropagation()">
        <div class="row">
          <button style="flex:1" onclick="openLibrary('backgrounds', ${i})">
            ${s.asset ? "Change background" : "Choose background"}
          </button>
          ${s.asset ? `<button onclick="updateScene({asset:null})">Clear</button>` : ""}
          <button onclick="makeCollage(${i})">Photo grid</button>
          <button onclick="openHinge(${i})">Dating card</button>
        </div>
        <label class="switch"><input type="checkbox" ${s.hideHead ? "checked" : ""}
          onchange="updateScene({hideHead:this.checked})"> Hide my cutout in this scene</label>
        <div class="row">
          <button onclick="openLibrary('app', ${i}, 'overlay')">
            ${s.overlayAsset ? "Change overlay" : "Add overlay"}
          </button>
          ${s.overlayAsset ? `<button onclick="updateScene({overlayAsset:null})">Clear</button>` : ""}
        </div>
        <div class="row">
          <button class="danger" onclick="deleteScene(${i})"
            title="${i === 0 ? "Bring scene 2's words into this one" : `Merge these words into scene ${i}`}"
            ${p.scenes.length < 2 ? "disabled" : ""}>
            Keep words, merge into ${i === 0 ? 2 : i}
          </button>
          <button class="danger" onclick="removeScene(${i})"
            title="Cut these words out of the video and drop the scene"
            ${p.scenes.length < 2 ? "disabled" : ""}>
            Delete scene and its words
          </button>
        </div>
        ${s.overlayAsset ? `
        <div class="row"><span class="lbl">Comes in at</span>
          <select onchange="updateScene({overlayWord:this.value},false)">
            ${overlayWordOptions(p, s)}
          </select></div>
        <div class="row"><span class="lbl">Stays for</span>
          <input type="number" min="1.5" step="0.5" value="${s.overlayDuration ?? 1.5}" style="width:90px"
            onchange="updateScene({overlayDuration:Math.max(1.5,+this.value||1.5)},false)">
          <span style="color:var(--muted)">seconds, drag it on the preview to place it</span></div>` : ""}
        <label class="field" style="margin-bottom:2px"><span>Scene label</span>
          <input type="text" value="${esc(s.label || "")}" onchange="updateScene({label:this.value},false)"></label>
      </div>` : "";
    return `
    <div class="scene-item ${open ? "sel" : ""}" onclick="S.sel=${i};render()">
      <img class="thumb" src="files/projects/${p.id}/thumbs/w${s.start}.jpg" loading="lazy" alt="">
      <div class="body">
        <div class="title">Scene ${i + 1} ${s.label ? `<span class="chip">${esc(s.label)}</span>` : ""}
          ${s.hideHead ? '<span class="chip">no head</span>' : ""}</div>
        <div class="words">${esc(sceneWords(p, s))}</div>
      </div>
      ${at ? `<img class="asset-badge" src="${at}" alt="">`
           : `<div class="asset-none" title="no background yet">+</div>`}
      ${controls}
    </div>`;
  }).join("");

  let sceneIdx = 0;
  const transcript = p.words.map((w, i) => {
    let pre = "";
    if (p.breaks.includes(i)) {
      sceneIdx += 1;
      pre = `${i > 0 ? '<span class="brk"></span>' : ""}<span class="scene-tag">Scene ${sceneIdx}</span>`;
    }
    return `${pre}<span class="w ${cutSet.has(i) ? "cut" : ""}" data-i="${i}">${esc(w.w)}</span>`;
  }).join(" ");

  const scenesTab = `
      <div class="panel">
        <div class="row-gap" style="margin-bottom:12px">
          <select id="fillcoll" style="width:180px">
            <option value="">pick collection</option>
            ${[...new Set(S.library.map((a) => a.collection).filter(Boolean))].sort().map((c) =>
              `<option value="${esc(c)}" ${suggestCollection(p) === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
          </select>
          <button onclick="smartFill()">Match photos to the script</button>
          <button onclick="fillScenes()">Random fill</button>
          <span class="hint" style="margin-bottom:0">match reads each line and picks a fitting photo, random just shuffles</span>
        </div>
        <div class="scene-list">${scenes}</div>
        <div class="row-gap" style="margin-top:16px; padding-top:14px; border-top:1px solid var(--line)">
          <select style="width:190px" onchange="applyTemplate(this.value); this.value=''">
            <option value="">Apply a template</option>${templates}
          </select>
          <button onclick="saveTemplate()">Save this layout as a template</button>
          <span class="grow"></span>
          <button onclick="pickAppendClip()" title="record one more bit and stitch it on as the last scene">Add a clip to the end</button>
        </div>
      </div>`;

  const wordsTab = `
      <div class="panel">
        <div class="tmode">
          <div class="seg">
            <button class="${(!S.tmode || S.tmode === "scenes") ? "on" : ""}" onclick="S.tmode='scenes';render()">Split scenes</button>
            <button class="${S.tmode === "cuts" ? "on" : ""}" onclick="S.tmode='cuts';render()">Cut words</button>
            <button class="${S.tmode === "listen" ? "on" : ""}" onclick="S.tmode='listen';render()">Listen</button>
          </div>
          ${cutSet.size ? `<span class="chip">${cutSet.size} words cut</span>
            <button class="ghost" onclick="restoreAllCuts()">Restore all</button>` : ""}
          ${S.tmode === "cuts" ? `<button class="ghost" onclick="autoCut()">Rerun auto cut</button>` : ""}
        </div>
        <div class="hint">${S.tmode === "cuts"
          ? "Click a word to cut it from the video, or drag across a few to cut a chunk. Crossed out words are already cut (retakes and fillers get caught automatically), click one to bring it back."
          : S.tmode === "listen"
            ? "This is the edited audio, exactly what the final video sounds like. Words light up as they play. Click any word to jump the audio there."
            : "Click any word to start a new scene there. Click a word right after a divider to merge it back."}</div>
        ${S.tmode === "listen" ? `<audio id="voice" controls preload="auto" style="width:100%;margin-bottom:12px"
          src="api/projects/${p.id}/audio_preview?rev=${p.rev || 0}"></audio>` : ""}
        <div class="transcript" id="transcript">${transcript}</div>
      </div>`;

  const styleTab = `
      <div class="panel">
        <div class="style-sec">
          <h3>Hook text</h3>
          <div class="hint" style="margin-bottom:0">Type it in the box under the preview, drag it on the preview to set where it sits.</div>
          <div class="controls" style="margin-top:10px">
            <div class="row"><span class="lbl">Size</span>
              <input type="range" min="44" max="96" step="2" value="${p.hook.size}"
                oninput="this.nextElementSibling.value=this.value"
                onchange="S.project.hook.size=+this.value; pushSettings({hook:S.project.hook}); setupStage()">
              <output>${p.hook.size}</output></div>
          </div>
        </div>
        <div class="style-sec">
          <h3>Word captions</h3>
          <label class="switch"><input type="checkbox" ${p.captions.enabled ? "checked" : ""}
            onchange="S.project.captions.enabled=this.checked; pushSettings({captions:S.project.captions})"> Captions on, one word at a time</label>
          <div class="controls" style="margin-top:10px">
            <div class="row"><span class="lbl">Size</span>
              <input type="range" min="56" max="120" step="2" value="${p.captions.size}"
                oninput="this.nextElementSibling.value=this.value"
                onchange="S.project.captions.size=+this.value; pushSettings({captions:S.project.captions}); setupStage()">
              <output>${p.captions.size}</output></div>
            <div class="row"><span class="lbl">Position</span>
              <span style="color:var(--muted)">drag the caption on the preview</span></div>
          </div>
        </div>
        <div class="style-sec">
          <h3>Background music</h3>
          <label class="switch"><input type="checkbox" ${p.music.enabled ? "checked" : ""}
            onchange="S.project.music.enabled=this.checked; pushSettings({music:S.project.music})"> Quiet music under the voice</label>
          <div class="controls" style="margin-top:10px">
            <div class="row"><span class="lbl">Track</span>
              <select onchange="S.project.music.file=this.value; pushSettings({music:S.project.music})">
                ${(S.music || []).map((m) => `<option value="${esc(m)}" ${p.music.file === m ? "selected" : ""}>${esc(m.replace(/\.[^.]+$/, "").replace(/[_]/g, " "))}</option>`).join("")}
              </select></div>
            <div class="row"><span class="lbl">Volume</span>
              <input type="range" min="0.02" max="0.25" step="0.01" value="${p.music.volume}"
                oninput="this.nextElementSibling.value=this.value"
                onchange="S.project.music.volume=+this.value; pushSettings({music:S.project.music})">
              <output>${p.music.volume}</output></div>
          </div>
          <div class="hint" style="margin:8px 0 0">Hear it in Preview. Drop more mp3s into greenroom/music to add tracks.</div>
        </div>
        <div class="style-sec">
          <h3>Dead space</h3>
          <div class="controls" style="margin-top:6px">
            <div class="row"><span class="lbl">Cut pauses over</span>
              <input type="range" min="0.2" max="1.2" step="0.05" value="${p.gapCut}"
                oninput="this.nextElementSibling.value=this.value+'s'"
                onchange="pushSettings({gapCut:+this.value})">
              <output>${p.gapCut}s</output></div>
          </div>
        </div>
        <div class="style-sec">
          <h3>Format</h3>
          <div class="row-gap">
            <select style="width:200px" onchange="setFormat(this.value)">
              <option value="" ${!p.format ? "selected" : ""}>no format</option>
              ${S.formats.map((f) => `<option value="${f.id}" ${p.format === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
            </select>
            <button class="ghost" onclick="setFormat(S.project.format, true)" ${!p.format ? "disabled" : ""}>Redo hook and images</button>
          </div>
          <span class="hint">The format sets the app tag, the hook and which library collection the scenes are filled from.</span>
        </div>
        <div class="style-sec">
          <h3>Who it is about</h3>
          <div class="row-gap">
            <select style="width:200px" onchange="S.project.audience=this.value; pushSettings({audience:this.value})">
              <option value="" ${!p.audience ? "selected" : ""}>not about a group</option>
              ${S.audiences.map((a) => `<option value="${esc(a.id)}" ${p.audience === a.id ? "selected" : ""}>${esc(a.label)}</option>`).join("")}
            </select>
          </div>
          <span class="hint">Fills {aud} in the hook and picks which images the scenes come from. Leave it alone for a format that has its own photos.</span>
        </div>
        <div class="style-sec">
          <h3>Hook look</h3>
          <div class="row-gap">
            <select style="width:200px" onchange="S.project.hook.style=this.value; pushSettings({hook:{...S.project.hook, style:this.value}})">
              <option value="bg" ${(p.hook.style || "bg") === "bg" ? "selected" : ""}>White on red</option>
              <option value="outline" ${p.hook.style === "outline" ? "selected" : ""}>Outlined text, no box</option>
            </select>
          </div>
          <span class="hint">A red block covers a photo grid, so grid formats use the outline.</span>
        </div>
        <div class="style-sec">
          <h3>Campaign</h3>
          <div class="row-gap">
            <select style="width:200px" onchange="setCampaign(this.value)">
              <option value="" ${!p.campaign.id ? "selected" : ""}>No campaign</option>
              ${S.campaigns.map((c) => `<option value="${esc(c.id)}" ${p.campaign.id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
            </select>
            ${!S.campaigns.length && p.campaign.name
              ? `<span class="chip campaign">${esc(p.campaign.name)}</span>` : ""}
          </div>
          <span class="hint">${S.campaigns.length ? "Campaigns come from Logan HQ." : "Open Greenroom from the Logan HQ sidebar to load your campaigns."}</span>
        </div>
        <div class="style-sec">
          <h3>App</h3>
          <div class="row-gap">
            <select style="width:140px" onchange="S.project.app=this.value; pushSettings({app:this.value})">
              <option value="" ${!p.app ? "selected" : ""}>no app</option>
              ${[...new Set([...(S.apps || []), ...(p.app ? [p.app] : [])])]
                .map((a) => `<option value="${esc(a)}" ${p.app === a ? "selected" : ""}>${esc(a)}</option>`)
                .join("")}
            </select>
            <span class="hint" style="margin-bottom:0">set by the format, override it here if you need to</span>
          </div>
        </div>
      </div>`;

  /* Logan HQ's own header already carries the name and the state, so repeating
     them here gave every video two titles stacked on top of each other. Embedded,
     this bar is actions only. Standalone it still needs its own identity, and the
     title stays editable there. */
  return `
  ${EMBEDDED ? "" : `
  <div class="topbar">
    ${backButton()}
    <h1 class="grow-title" contenteditable="true" onblur="S.project.name=this.textContent.trim();pushSettings({name:S.project.name})" spellcheck="false">${esc(p.name)}</h1>
    ${statusChip(p.status)}
    <span class="dur-note" style="color:var(--muted)">${p.outDuration}s final (${cut}s cut)</span>
    ${p.warning ? `<button onclick="rebuildProject()" title="${esc(p.warning)}">Rebuild</button>` : ""}
    ${p.renders && p.renders.length ? `<a href="api/projects/${p.id}/download" download><button>Download</button></a>` : ""}
    <button class="primary" onclick="startRender()" ${rendering ? "disabled" : ""}>
      ${rendering ? `Rendering ${Math.round((p.progress || 0) * 100)}%` : "Render"}
    </button>
  </div>`}
  <div class="wrap editor">
    <div class="stage-rail">
      <div class="panel stage-panel">
        ${p.scenes.length ? `<div class="pager">
          <button class="ghost" ${S.sel === 0 ? "disabled" : ""} onclick="selScene(S.sel-1)" title="previous scene, or press the left arrow key">&#8592;</button>
          <span class="lbl">Scene ${S.sel + 1} of ${p.scenes.length}</span>
          <button class="ghost" ${S.sel >= p.scenes.length - 1 ? "disabled" : ""} onclick="selScene(S.sel+1)" title="next scene, or press the right arrow key">&#8594;</button>
        </div>` : ""}
        ${stageHtml(p, sc)}
        <div class="preview-note">Drag things to place them, corner dot or scroll resizes, double click resets.</div>
        <label class="field hook-field">
          <span>Hook text, shows on scene 1</span>
          <textarea rows="2" placeholder="leave empty for none"
            oninput="S.project.hook.text=this.value"
            onchange="pushSettings({hook:S.project.hook}); render()">${esc(p.hook.text)}</textarea>
        </label>
      </div>
    </div>
    <div class="workspace">
      <div class="etabs">
        <div class="seg">
          <button class="${tab === "scenes" ? "on" : ""}" onclick="S.etab='scenes';render()">Scenes</button>
          <button class="${tab === "words" ? "on" : ""}" onclick="S.etab='words';render()">Words${cutSet.size ? ` (${cutSet.size} cut)` : ""}</button>
          <button class="${tab === "style" ? "on" : ""}" onclick="S.etab='style';render()">Style</button>
        </div>
      </div>
      ${tab === "scenes" ? scenesTab : tab === "words" ? wordsTab : styleTab}
    </div>
  </div>`;
}

function viewDrawer() {
  if (!S.drawer) return "";
  const folder = S.drawer.folder;
  const tabs = S.folders.map((f) =>
    `<button class="${f === folder ? "on" : ""}" onclick="S.drawer.folder='${f}';render()">${f === "hinge" ? "dating cards" : f}</button>`).join("");
  const collections = browseCollections();
  const colChips = `
    <div class="tabs" style="margin-top:2px">
      <button class="${!S.libCollection ? "on" : ""}" onclick="setLibCollection('')">everything</button>
      ${collections.map((c) => `<button class="${S.libCollection === c ? "on" : ""}"
        onclick="setLibCollection('${encodeURIComponent(c)}')">${esc(c)}</button>`).join("")}
      <button class="ghost" onclick="newCollection()">new collection</button>
    </div>`;
  const items = S.library.filter((a) => a.folder === folder &&
    (!S.libCollection || a.collection === S.libCollection));
  const assigning = S.drawer.assignTo != null;
  const grid = items.map((a) => `
    <div class="lib-item" onclick="${assigning ? `assignAsset('${a.id}')` : ""}">
      ${a.type === "video" ? '<span class="kind">video</span>' : ""}
      <div class="acts">
        <button title="put in a collection"
          onclick="event.stopPropagation(); tagAsset('${a.id}')">tag</button>
        ${a.recipe ? `<button title="redo this card with the current style"
          onclick="event.stopPropagation(); remakeCard('${a.id}')">redo</button>` : ""}
        <button title="remove" onclick="event.stopPropagation(); removeAsset('${a.id}')">x</button>
      </div>
      <img src="${a.thumb ? `files/library/${a.folder}/${a.thumb}?v=${Math.round(a.added || 0)}` : ""}" loading="lazy" alt="">
      <div class="nm">${esc(a.name)}${a.collection && !S.libCollection
        ? ` <span style="color:#aab1bb">${esc(a.collection)}</span>` : ""}</div>
    </div>`).join("");
  return `
  <div class="drawer-veil" onclick="closeDrawer()"></div>
  <div class="drawer">
    <header>
      <h2>${assigning ? (S.drawer.target === "overlay"
            ? `Pick overlay for scene ${S.drawer.assignTo + 1}`
            : `Pick for scene ${S.drawer.assignTo + 1}`) : "Library"}</h2>
      ${folder === "hinge" ? `<button onclick="openHinge(${assigning ? S.drawer.assignTo : null})">New dating card</button>` : ""}
      <button onclick="uploadToFolder('${folder}')">Add files</button>
      <button class="ghost" onclick="S.drawer=null;render()">close</button>
    </header>
    <div class="tabs">${tabs}</div>
    ${colChips}
    ${items.length ? `<div class="lib-grid">${grid}</div>`
                   : `<div class="empty">Nothing in ${folder === "hinge" ? "dating cards" : folder}${S.libCollection ? ` for ${esc(S.libCollection)}` : ""} yet. New uploads and cards land in the selected collection.</div>`}
  </div>`;
}

/* Background cards on their own, with no video behind them.
   Some of these get cut by hand elsewhere, but the backgrounds are still generated
   from the numbers he says. Without this the only way to get them was to create a
   throwaway project and ingest footage just to bin the video afterwards. Paste the
   script, read the numbers back, take the images. */
function openCards() {
  S.cards = { text: "", audience: (S.audiences[0] || {}).id || "",
              busy: false, out: null, error: "" };
  render();
}

async function runCards() {
  const c = S.cards;
  if (!c || c.busy) return;
  if (!c.text.trim()) { toast("Paste the script first"); return; }
  c.busy = true; c.error = ""; render();
  try {
    c.out = await api("api/cards/preview",
                      { json: { text: c.text, audience: c.audience } });
  } catch (e) {
    // the 422 here is the useful one: it means the numbers could not be read, which
    // is worth showing in full rather than as a toast that disappears
    c.error = (e && e.message) || "Could not make the cards";
    c.out = null;
  }
  c.busy = false; render();
}

function viewCards() {
  if (!S.cards) return "";
  const c = S.cards;
  const f = c.out && c.out.funnel;
  // Reading the numbers back wrong is the failure that keeps happening, so they are
  // shown next to the pictures rather than left implicit in them.
  const readback = !f ? "" : `
    <div class="panel" style="margin-bottom:10px">
      <b>What it read out of that script</b>
      <div class="card-nums">
        ${[["swiped right", f.sent], ["matched", f.opened], ["did not match", f.notOpened],
           ["replied", f.responded], ["said no", f.saidNo], ["said yes", f.saidYes],
           ["got", f.cracked]]
          .map(([k, v]) => `<span><i>${k}</i>${Number(v).toLocaleString()}</span>`).join("")}
      </div>
      <div class="hint">Match rate ${(f.opened / f.sent * 100).toFixed(1)}%. Check these
        against the script before you use them.</div>
      ${c.out.note ? `<div class="hint warn">${esc(c.out.note)}</div>` : ""}
    </div>`;
  const grid = !c.out ? "" : `
    <div class="card-grid">
      ${c.out.cards.map((x) => `
        <a class="card-out" href="${x.url}" download="${esc(x.file)}" title="Download ${esc(x.name)}">
          <img src="${x.thumb || x.url}" alt="">
          <span>${esc(x.name)}</span>
        </a>`).join("")}
    </div>
    <div class="row-gap" style="margin-top:12px">
      <a class="btn primary" href="api/cards/${c.out.token}/all.zip">Download all 5</a>
    </div>`;
  return `
  <div class="modal-veil" onclick="if(event.target===this){S.cards=null;render()}">
    <div class="modal" style="width:620px">
      <h2>Background cards</h2>
      <p class="hint">Paste a script and take the backgrounds, no video needed. Same
        images a video built in here would get.</p>
      <label class="field"><span>The script</span>
        <textarea rows="7" placeholder="I'm going on a mission to see how many..."
          oninput="S.cards.text=this.value">${esc(c.text)}</textarea></label>
      <label class="field"><span>Whose profile appears on the Hinge swipe card</span>
        <select aria-label="Whose profile appears on the Hinge swipe card" onchange="S.cards.audience=this.value">
          ${S.audiences.map((a) => `<option value="${esc(a.id)}" ${c.audience === a.id ? "selected" : ""}>${esc(a.label)}</option>`).join("")}
        </select></label>
      ${c.error ? `<div class="hint warn" style="margin-bottom:8px">${esc(c.error)}</div>` : ""}
      ${readback}
      ${grid}
      <div class="modal-actions">
        <button class="ghost" onclick="S.cards=null;render()">Close</button>
        <button class="primary" onclick="runCards()" ${c.busy ? "disabled" : ""}>
          ${c.busy ? "Drawing..." : (c.out ? "Draw again" : "Make the cards")}</button>
      </div>
    </div>
  </div>`;
}

function viewHinge() {
  if (!S.hinge) return "";
  const h = S.hinge;
  const collections = browseCollections();
  const thumbGrid = (items, selId, pick) => items.map((a) => `
    <div class="lib-item ${selId === a.id ? "sel" : ""}" onclick="${pick}('${a.id}')">
      <img src="${a.thumb ? `files/library/${a.folder}/${a.thumb}?v=${Math.round(a.added || 0)}` : ""}" loading="lazy" alt="">
      <div class="nm">${esc(a.name)}</div>
    </div>`).join("");
  const girls = S.library.filter((a) => a.folder === "people" && a.type === "image" &&
    (!h.filter || a.collection === h.filter));
  const yoursAll = S.library.filter((a) => a.type === "image" &&
    (h.topFilter ? a.folder === h.topFilter : ["app", "people", "extra"].includes(a.folder)));
  return `
  <div class="modal-veil" onclick="if(event.target===this){S.hinge=null;render()}">
    <div class="modal" style="width:560px">
      <h2>New dating app like card</h2>
      <label class="field"><span>Her comment on your photo</span>
        <input type="text" value="${esc(h.message)}" oninput="S.hinge.message=this.value"></label>
      <div class="row-gap">
        <label class="field" style="flex:1"><span>Name</span>
          <input type="text" value="${esc(h.name)}" oninput="S.hinge.name=this.value"></label>
        <label class="field" style="flex:1"><span>Pronouns</span>
          <input type="text" value="${esc(h.pronouns)}" oninput="S.hinge.pronouns=this.value"></label>
      </div>
      <div class="row-gap">
        <label class="field" style="flex:1"><span>Prompt</span>
          <input type="text" value="${esc(h.promptLabel)}" oninput="S.hinge.promptLabel=this.value"></label>
        <label class="field" style="flex:1"><span>Prompt answer</span>
          <input type="text" value="${esc(h.promptAnswer)}" oninput="S.hinge.promptAnswer=this.value"></label>
      </div>
      <label class="field"><span>Her photo ${h.file ? `(upload: ${esc(h.file.name)})` : ""}</span></label>
      <div class="tabs" style="margin-bottom:8px">
        <button class="${!h.filter ? "on" : ""}" onclick="setHingeFilter('')">everything</button>
        ${collections.map((c) => `<button class="${h.filter === c ? "on" : ""}"
          onclick="setHingeFilter('${encodeURIComponent(c)}')">${esc(c)}</button>`).join("")}
        <button class="ghost" onclick="pickHingePhoto()">upload</button>
      </div>
      <div class="lib-grid" style="max-height:240px;overflow-y:auto;margin-bottom:14px">
        ${thumbGrid(girls, h.photoAsset, "hingePickHer") || '<div class="empty">no images in this collection</div>'}
      </div>
      <label class="field"><span>Your photo up top, pick any ${h.topFile ? `(upload: ${esc(h.topFile.name)})` : ""}</span></label>
      <div class="tabs" style="margin-bottom:8px">
        <button class="${h.topFilter === "app" ? "on" : ""}" onclick="setHingeTopFilter('app')">app</button>
        <button class="${h.topFilter === "people" ? "on" : ""}" onclick="setHingeTopFilter('people')">people</button>
        <button class="${!h.topFilter ? "on" : ""}" onclick="setHingeTopFilter('')">everything</button>
        <button class="ghost" onclick="pickTopPhoto()">upload</button>
      </div>
      <div class="lib-grid" style="max-height:220px;overflow-y:auto;margin-bottom:10px">
        ${thumbGrid(yoursAll, h.topPhotoAsset, "hingePickTop") || '<div class="empty">nothing here</div>'}
      </div>
      <label class="switch" style="margin-bottom:6px"><input type="checkbox" ${h.coverFace ? "checked" : ""}
        onchange="S.hinge.coverFace=this.checked"> Cover her face with the heart</label>
      <div class="actions">
        <button onclick="S.hinge=null;render()">Cancel</button>
        <button class="primary" onclick="submitHinge()" ${h.busy ? "disabled" : ""}>
          ${h.busy ? "Making card..." : "Make card"}</button>
      </div>
    </div>
  </div>`;
}

function pickHingePhoto() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = () => {
    if (inp.files[0]) { S.hinge.file = inp.files[0]; S.hinge.photoAsset = ""; render(); }
  };
  inp.click();
}

function pickTopPhoto() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = () => {
    if (inp.files[0]) { S.hinge.topFile = inp.files[0]; S.hinge.topPhotoAsset = ""; render(); }
  };
  inp.click();
}

function uploadToFolder(folder) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.accept = folder === "inserts" ? "image/*,video/*" : "image/*,video/*";
  inp.onchange = async () => {
    for (const f of inp.files) await uploadAsset(f, folder);
  };
  inp.click();
}

/* Collections worth showing as a filter chip. Every funnel video generates its own
   "funnel p_xxxx" collection to hold that video's five stat cards, which are made and
   binned automatically. Seven of them were sitting in the chip row, outnumbering the
   real collections and pushing the pictures off the screen. They are still reachable
   under "everything". */
const browseCollections = () =>
  [...new Set(S.library.map((a) => a.collection).filter(Boolean))]
    .filter((c) => !/^funnel p_/.test(c) || c === S.libCollection)
    .sort();

function setLibCollection(enc) {
  S.libCollection = enc ? decodeURIComponent(enc) : null;
  render();
}

function setHingeTopFilter(enc) {
  S.hinge.topFilter = enc ? decodeURIComponent(enc) : "";
  render();
}

function setHingeFilter(enc) {
  S.hinge.filter = enc ? decodeURIComponent(enc) : "";
  render();
}

function newCollection() {
  const n = prompt("Collection name (e.g. torta)?");
  if (n && n.trim()) {
    S.libCollection = n.trim();
    render();
    toast(`New uploads and cards will go in ${S.libCollection}`);
  }
}

async function tagAsset(aid) {
  const item = S.library.find((a) => a.id === aid);
  const n = prompt("Collection for this (empty to remove):", item.collection || S.libCollection || "");
  if (n === null) return;
  await api(`api/library/${aid}/collection`, { json: { collection: n.trim() } });
  await loadState();
  render();
}

async function remakeCard(aid) {
  try {
    await api(`api/library/${aid}/remake`, { method: "POST" });
    await loadState();
    render();
    toast("Card redone with the current style");
  } catch (e) {
    toast(e.message);
  }
}

async function removeAsset(aid) {
  if (!confirm("Remove this from the library?")) return;
  await api(`api/library/${aid}`, { method: "DELETE" });
  await loadState();
  render();
}

function closeDrawer() {
  if (S.drawer && Date.now() - (S.drawer._at || 0) < 250) return;
  S.drawer = null;
  render();
}

function goHome() {
  S.view = "home";
  S.project = null;
  loadState().then(() => { render(); schedulePoll(); });
  render();
}

/* ---------------- root render ---------------- */

function render() {
  /* Until the deep linked video has actually arrived, S.view is still "home", so
     any repaint paints greenroom's project list. Logan HQ pushes its campaign
     list in the moment the frame loads, which is well before the fetches land, so
     opening a video flashed the old greenroom home every single time. Hold the
     skeleton until the video is in. */
  if (BOOTING_INTO_VIDEO && !BOOTED) {
    skeleton();
    return;
  }
  try {
    renderInner();
    postStatusToHQ();
  } catch (e) {
    console.error("render failed", e);
    $("#app").innerHTML = `<div class="wrap"><div class="panel">
      <h2>The editor view hit an error</h2>
      <p style="color:var(--muted)">${esc(e.message)}</p>
      <div class="row-gap" style="margin-top:12px">
        <button class="primary" onclick="location.reload()">Reload (you will come back to this video)</button>
        <button onclick="S.drawer=null;S.hinge=null;S.previewOpen=false;render()">Try to recover</button>
      </div></div></div>`;
  }
}

/* Which video to open, read once at startup. It has to be captured and frozen:
   the url is the only thing carrying it, loadState() takes a moment behind the
   Cloudflare proxy, and anything that renders in the meantime (Logan HQ posting
   the campaign list in, for one) would land on the home view and blank the hash
   before the boot ever got to read it. */
const BOOT_HASH = location.hash;
/* Whether this load is heading straight into a video. Needed as its own flag
   because render() has to know before the fetches land, and it is read by the
   message listener below, which can fire almost immediately. */
const BOOTING_INTO_VIDEO = /p=[a-z0-9_]+/.test(BOOT_HASH);

/* Opening a video used to show nothing, or briefly the old project list, until
   both fetches landed. This paints the editor's shape straight away so it reads
   as loading rather than broken. */
function skeleton() {
  const bar = `<span class="sk" style="height:14px;width:60%"></span>`;
  document.getElementById("app").innerHTML = `
    <div class="wrap">
      <div class="sk-head">
        <span class="sk" style="height:26px;width:280px"></span>
        <span class="sk" style="height:40px;width:110px;border-radius:999px"></span>
      </div>
      <div class="sk-cols">
        <div><span class="sk" style="aspect-ratio:9/16;width:100%;border-radius:14px"></span></div>
        <div>
          <span class="sk" style="height:44px;width:230px;border-radius:999px"></span>
          ${[0, 1, 2, 3].map(() => `
            <div class="sk-row">
              <span class="sk" style="height:80px;width:46px;border-radius:8px"></span>
              <div style="flex:1">
                <span class="sk" style="height:16px;width:35%"></span>
                ${bar}
              </div>
            </div>`).join("")}
        </div>
      </div>
    </div>`;
}
/* Logan HQ frames the editor and supplies its own back button in the header. Ours
   would be a second one right under it, and it goes to greenroom's own home page
   rather than back to Videos, so it is hidden whenever we are in a frame. */
const EMBEDDED = window.parent !== window;
// Inside HQ the topbar is not drawn at all, so anything that parks itself below
// it has to move up. Set on the html element rather than body because it has to
// be true before the first paint, and body does not exist yet at this point.
if (EMBEDDED) document.documentElement.classList.add("embedded");
const backButton = () => (EMBEDDED ? "" : `<button class="ghost" onclick="goHome()">&#8592; back</button>`);
let BOOTED = false;

/* render() replaces the whole document, and a fresh DOM starts at scroll zero. That
   is invisible most of the time because renders follow a click, but the poll below
   re-renders every 1.5 seconds while anything is encoding, so scrolling the library
   during a render threw the list back to the top over and over.

   Offsets are read off the old DOM and put back on the new one. Only within one
   screen, though. Changing screen files its position away and takes the new one's,
   which is what you want in both directions: opening a video from halfway down the
   list starts at the top of the video, and going back to the list puts you where
   you were rather than at the top of 47 of them. */
const SCROLLERS = [".drawer", ".stage-panel", ".modal"];
const screenKey = () =>
  [S.view, S.project && S.project.id, S.drawer && S.drawer.folder,
   S.libCollection, S.upload ? "up" : "", S.hinge ? "hinge" : "",
   S.cards ? "cards" : ""].join("|");
let LAST_SCREEN = null;
const PAGE_SCROLL = new Map();

function renderInner() {
  if (S.drawer && !S.drawer._at) S.drawer._at = Date.now();
  const key = screenKey();
  const same = key === LAST_SCREEN;
  if (!same && LAST_SCREEN !== null) PAGE_SCROLL.set(LAST_SCREEN, window.scrollY);
  LAST_SCREEN = key;
  const keep = same ? SCROLLERS.map((s) => [s, ($(s) || {}).scrollTop || 0]) : [];
  const pageY = same ? window.scrollY : (PAGE_SCROLL.get(key) || 0);
  // never touch the url until the deep link has been acted on, see BOOT_HASH
  if (BOOTED) {
    if (S.view === "editor" && S.project) {
      history.replaceState(null, "", `#p=${S.project.id}&s=${S.sel}`);
    } else if (S.view === "home") {
      history.replaceState(null, "", location.pathname);
    }
  }
  const root = $("#app");
  root.innerHTML = (S.view === "editor" && S.project ? viewEditor() : viewHome())
    + viewDrawer() + viewHinge() + viewCards() + viewPreviewModal() + (S.upload ? uploadModal() : "");

  // put the offsets back before the frame paints, so nothing visibly jumps
  keep.forEach(([sel, top]) => { const el = $(sel); if (el && top) el.scrollTop = top; });
  window.scrollTo(0, pageY);

  setupStage();
  setupTranscript();

  const drop = $("#drop");
  if (drop) {
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("hover"); };
    drop.ondragleave = () => drop.classList.remove("hover");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("hover");
      if (e.dataTransfer.files.length) openUploadFlow([...e.dataTransfer.files]);
    };
  }
}

/* expose handlers used in inline attributes */
function safe(fn) {
  return (...a) => Promise.resolve(fn(...a)).catch((e) => {
    console.error(e);
    toast(e.message || "Something went wrong");
    render();
  });
}

/* Logan HQ frames this editor at /greenroom and posts its real campaign list in, so
   the dropdowns match Campaigns without greenroom needing HQ's passcode. Running
   greenroom standalone on localhost just leaves the list empty. */
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const msg = e.data;
  if (!msg) return;

  if (msg.type === "greenroom:campaigns" && Array.isArray(msg.campaigns)) {
    S.campaigns = msg.campaigns
      .filter((c) => c && c.id)
      .map((c) => ({ id: String(c.id), name: String(c.name || c.id) }));
    render();
    return;
  }

  // HQ's overflow menu is outside this frame, so the actions it offers have to be
  // run from in here
  if (msg.type === "greenroom:command" && S.project) {
    if (msg.command === "render") safe(startRender)();
    else if (msg.command === "rebuild") safe(rebuildProject)();
  }
});

/** Tell HQ what this video is doing, so its header and menu can show it. */
function postStatusToHQ() {
  if (!EMBEDDED) return;
  const p = S.project;
  window.parent.postMessage({
    type: "greenroom:status",
    project: p ? {
      id: p.id,
      name: p.name,
      status: p.status,
      progress: p.progress || 0,
      outDuration: p.outDuration,
      warning: p.warning || "",
      hasRender: !!(p.renders && p.renders.length),
    } : null,
  }, "*");
}
if (window.parent !== window) window.parent.postMessage({ type: "greenroom:ready" }, "*");

Object.assign(window, { S, render, updateScene, pickVideo, uploadVideos, openHinge, pickHingePhoto,
  hingePickHer, hingePickTop, pickTopPhoto, closeDrawer, setupStage, pushSettings, selScene,
  setLibCollection, setHingeFilter, setHingeTopFilter,
  fillScenes: safe(fillScenes), markPosted: safe(markPosted),
  openProject: safe(openProject), deleteProject: safe(deleteProject), toggleBreak: safe(toggleBreak),
  assignAsset: safe(assignAsset), startRender: safe(startRender), saveTemplate: safe(saveTemplate),
  applyTemplate: safe(applyTemplate), submitHinge: safe(submitHinge), uploadToFolder: safe(uploadToFolder),
  removeAsset: safe(removeAsset), goHome: safe(goHome), restoreAllCuts: safe(restoreAllCuts),
  autoCut: safe(autoCut), startPreviewVideo: safe(startPreviewVideo), remakeCard: safe(remakeCard),
  pickAppendClip: safe(pickAppendClip), rebuildProject: safe(rebuildProject),
  deleteScene: safe(deleteScene),
  removeScene: safe(removeScene),
  newCollection: safe(newCollection), tagAsset: safe(tagAsset),
  openUploadFlow, uploadApplyAll, readUploadRows, startUpload, openLibrary,
  smartFill: safe(smartFill),
  setFormat: safe(setFormat), setCampaign: safe(setCampaign) });

/* Booting used to be two round trips one after the other: the whole state, then
   the project. Behind the Cloudflare proxy and the tunnel each one costs real
   latency, so the editor sat blank for both. They do not depend on each other, so
   they are fired together and the page paints after one trip rather than two. */
const bootMatch = BOOT_HASH.match(/p=([a-z0-9_]+)(?:&s=(\d+))?/);

if (bootMatch) skeleton();

Promise.all([
  loadState(),
  // tolerated rather than awaited: a bad id in the url must not sink the state too
  bootMatch ? api(`api/projects/${bootMatch[1]}`).catch(() => null) : null,
]).then(([, proj]) => {
  try {
    if (proj) {
      S.project = normalizeProject(proj);
      S.view = "editor";
      S.sel = bootMatch[2] ? Math.min(+bootMatch[2], (proj.scenes || []).length - 1 || 0) : 0;
    } else if (bootMatch) {
      // a video that will not open must still leave a usable page, not a blank one
      toast("Could not open that video");
    }
  } catch (e) {
    toast("Could not open that video");
  }
  BOOTED = true;
  render();
  schedulePoll();
});
