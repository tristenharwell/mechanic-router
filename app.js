/* Mobile Mechanic Route Planner
 * Static app: Leaflet map, Nominatim geocoding, OSRM drive times.
 * Customer data imported from ALLDATA Manage Online CSV exports.
 */
"use strict";

/* ---------------------------- state ---------------------------- */

const STORE_KEY = "mmr_state_v1";
const GEO_KEY = "mmr_geocache_v1";

const state = {
  settings: {
    baseAddress: "",
    baseCoord: null,          // {lat, lon}
    dayStart: "08:00",
    dayHours: 8,
    returnToBase: true,
    notifyTemplate: "Hi {first}, this is your mobile mechanic. I'm on my way for your {job} ({vehicle}). ETA about {eta}.",
  },
  customers: [],              // {id, name, address, phone, email, vehicle, lat, lon, updatedAt}
  jobs: [],                   // {id, customerId, desc, durationMin, updatedAt}
  tombstones: [],             // {id, deletedAt} — so deletions replicate across devices
};

let geocache = {};            // normalized address -> {lat, lon} | {fail: true}
let plan = null;              // {days: [...], warnings: [...]} — rebuilt on demand
let activeDay = 0;

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  scheduleSync();
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      Object.assign(state.settings, s.settings || {});
      state.customers = s.customers || [];
      state.jobs = s.jobs || [];
      state.tombstones = s.tombstones || [];
    }
    geocache = JSON.parse(localStorage.getItem(GEO_KEY) || "{}");
  } catch (e) { console.warn("Failed to load saved data", e); }
}
function touchSettings() {
  state.settings.updatedAt = Date.now();
  saveState();
}
function addTombstone(id) {
  state.tombstones.push({ id, deletedAt: Date.now() });
}
function saveGeocache() {
  localStorage.setItem(GEO_KEY, JSON.stringify(geocache));
}

const uid = () => Math.random().toString(36).slice(2, 10);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------------------- map ---------------------------- */

const DAY_COLORS = ["#1769d0", "#d05017", "#178a4c", "#8a17b8", "#b8a117", "#17a3b8", "#d01769"];

let map, planLayer;

function initMap() {
  map = L.map("map").setView([39.5, -96], 5); // continental US until we know better
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  planLayer = L.layerGroup().addTo(map);
}

/* ------------------------- geocoding ------------------------- */

const normAddr = (a) => a.trim().toLowerCase().replace(/\s+/g, " ");

function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

// Free geocoders, tried in order — some networks stall one service but not others.
const GEOCODERS = [
  {
    name: "Photon",
    url: a => "https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(a),
    parse: j => j.features && j.features.length
      ? { lat: j.features[0].geometry.coordinates[1], lon: j.features[0].geometry.coordinates[0] }
      : null,
  },
  {
    name: "US Census",
    url: a => "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(a),
    parse: j => {
      const m = j.result && j.result.addressMatches;
      return m && m.length ? { lat: m[0].coordinates.y, lon: m[0].coordinates.x } : null;
    },
  },
  {
    name: "Nominatim",
    url: a => "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(a),
    parse: j => j.length ? { lat: +j[0].lat, lon: +j[0].lon } : null,
  },
];

let lastGeocodeAt = 0;
async function geocode(address) {
  const key = normAddr(address);
  if (!key) return null;
  if (geocache[key]) return geocache[key].fail ? null : geocache[key];

  // be polite to the free services: min 700ms between lookups
  const wait = lastGeocodeAt + 700 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocodeAt = Date.now();

  let answered = false;
  for (const g of GEOCODERS) {
    try {
      const resp = await fetchWithTimeout(g.url(address), 12000);
      if (!resp.ok) continue;
      const hit = g.parse(await resp.json());
      answered = true;
      if (hit) {
        geocache[key] = hit;
        saveGeocache();
        return hit;
      }
    } catch (e) {
      console.warn(g.name + " geocoder unavailable, trying next:", e.message || e);
    }
  }
  if (answered) { // a real "no match" — cache it; network outages shouldn't be cached
    geocache[key] = { fail: true };
    saveGeocache();
  }
  return null;
}

/* --------------------------- OSRM --------------------------- */

const OSRM = "https://router.project-osrm.org";

// coords: [{lat, lon}, ...] -> seconds matrix [i][j]
async function fetchDurationMatrix(coords) {
  const path = coords.map(c => c.lon + "," + c.lat).join(";");
  const resp = await fetchWithTimeout(`${OSRM}/table/v1/driving/${path}?annotations=duration`, 20000);
  if (!resp.ok) throw new Error("Routing service error (" + resp.status + ")");
  const data = await resp.json();
  if (data.code !== "Ok") throw new Error("Routing failed: " + data.code);
  return data.durations;
}

// ordered coords -> GeoJSON line coordinates [[lat,lon],...]
async function fetchRouteGeometry(coords) {
  const path = coords.map(c => c.lon + "," + c.lat).join(";");
  const resp = await fetchWithTimeout(`${OSRM}/route/v1/driving/${path}?overview=full&geometries=geojson`, 20000);
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.code !== "Ok" || !data.routes.length) return null;
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
}

/* ---------------------- CSV import ---------------------- */

// Robust-enough CSV parser (quotes, embedded commas/newlines)
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim() !== "")) rows.push(row);
  return rows;
}

const IMPORT_FIELDS = [
  { key: "name",     label: "Name",       patterns: [/^(customer\s*)?name$/i, /company/i] },
  { key: "first",    label: "First name", patterns: [/first/i] },
  { key: "last",     label: "Last name",  patterns: [/last|surname/i] },
  { key: "address",  label: "Address",    patterns: [/^(street\s*)?address(\s*1)?$/i, /^street$/i, /addr/i] },
  { key: "city",     label: "City",       patterns: [/city|town/i] },
  { key: "stateCol", label: "State",      patterns: [/^state$|province/i] },
  { key: "zip",      label: "ZIP",        patterns: [/zip|postal/i] },
  { key: "phone",    label: "Phone",      patterns: [/^(cell|mobile|home)?\s*phone|^cell$|^mobile$/i] },
  { key: "email",    label: "Email",      patterns: [/e-?mail/i] },
  { key: "vehicle",  label: "Vehicle",    patterns: [/vehicle|^(year|make|model)$|ymm/i] },
];

let pendingCSV = null; // {headers, rows}

function autoDetectMapping(headers) {
  const mapping = {};
  for (const f of IMPORT_FIELDS) {
    const idx = headers.findIndex(h => f.patterns.some(p => p.test(h.trim())));
    mapping[f.key] = idx; // -1 = not mapped
  }
  return mapping;
}

function showMappingUI(headers, rows) {
  pendingCSV = { headers, rows };
  const mapping = autoDetectMapping(headers);
  const container = $("mapping-rows");
  container.innerHTML = "";
  for (const f of IMPORT_FIELDS) {
    const div = document.createElement("div");
    div.className = "map-row";
    const opts = ['<option value="-1">— not in file —</option>']
      .concat(headers.map((h, i) =>
        `<option value="${i}" ${mapping[f.key] === i ? "selected" : ""}>${esc(h)}</option>`));
    div.innerHTML = `<span class="map-field">${f.label}</span><select data-field="${f.key}">${opts.join("")}</select>`;
    container.appendChild(div);
  }
  $("mapping-ui").classList.remove("hidden");
  $("import-status").textContent =
    `Found ${rows.length} rows and ${headers.length} columns. Confirm the column matches below.`;
}

function runImport() {
  if (!pendingCSV) return;
  const mapping = {};
  document.querySelectorAll("#mapping-rows select").forEach(sel => {
    mapping[sel.dataset.field] = +sel.value;
  });
  const get = (row, key) => mapping[key] >= 0 ? (row[mapping[key]] || "").trim() : "";

  if (mapping.name < 0 && mapping.first < 0 && mapping.last < 0) {
    $("import-status").textContent = "⚠ Map at least a Name (or First/Last name) column.";
    return;
  }
  if (mapping.address < 0) {
    $("import-status").textContent = "⚠ Map the Address column — it's required for routing.";
    return;
  }

  let added = 0, updated = 0, skipped = 0;
  for (const row of pendingCSV.rows) {
    let name = get(row, "name") || [get(row, "first"), get(row, "last")].filter(Boolean).join(" ");
    const street = get(row, "address");
    if (!name || !street) { skipped++; continue; }
    const address = [street, get(row, "city"), [get(row, "stateCol"), get(row, "zip")].filter(Boolean).join(" ")]
      .filter(Boolean).join(", ");
    const phone = get(row, "phone");
    const email = get(row, "email");
    const vehicle = get(row, "vehicle");

    const existing = state.customers.find(c =>
      c.name.toLowerCase() === name.toLowerCase() &&
      normAddr(c.address) === normAddr(address));
    if (existing) {
      if (phone) existing.phone = phone;
      if (email) existing.email = email;
      if (vehicle) existing.vehicle = vehicle;
      existing.updatedAt = Date.now();
      updated++;
    } else {
      state.customers.push({ id: uid(), name, address, phone, email, vehicle, lat: null, lon: null, updatedAt: Date.now() });
      added++;
    }
  }
  state.customers.sort((a, b) => a.name.localeCompare(b.name));
  saveState();
  renderCustomers();
  cancelImport();
  $("import-status").textContent =
    `✓ Imported: ${added} new, ${updated} updated` + (skipped ? `, ${skipped} skipped (missing name/address)` : "") + ".";
}

function cancelImport() {
  pendingCSV = null;
  $("mapping-ui").classList.add("hidden");
  $("paste-area").classList.add("hidden");
  $("btn-parse-paste").classList.add("hidden");
  $("import-file").value = "";
}

function handleCSVText(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) {
    $("import-status").textContent = "⚠ Couldn't find data rows — the file needs a header row plus at least one customer.";
    return;
  }
  showMappingUI(rows[0].map(h => h.trim()), rows.slice(1));
}

/* ---------------------- customers & jobs UI ---------------------- */

function renderCustomers() {
  const q = $("customer-search").value.trim().toLowerCase();
  const list = $("customer-list");
  list.innerHTML = "";
  const filtered = state.customers.filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q));
  for (const c of filtered.slice(0, 200)) {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `
      <div class="li-main">
        <div class="li-title">${esc(c.name)}</div>
        <div class="li-sub">${esc(c.address)}${c.vehicle ? " · " + esc(c.vehicle) : ""}${c.phone ? " · " + esc(c.phone) : ""}</div>
      </div>
      <div class="li-actions">
        <button title="Add a job for this customer" data-act="job" data-id="${c.id}">🛠</button>
        <button title="Delete customer" data-act="del" data-id="${c.id}">✕</button>
      </div>`;
    list.appendChild(div);
  }
  $("customer-count").textContent = state.customers.length;

  const dl = $("customer-datalist");
  dl.innerHTML = state.customers.map(c => `<option value="${esc(c.name)}"></option>`).join("");
}

function renderJobs() {
  const list = $("job-list");
  list.innerHTML = "";
  for (const j of state.jobs) {
    const c = state.customers.find(c => c.id === j.customerId);
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `
      <div class="li-main">
        <div class="li-title">${esc(c ? c.name : "(deleted customer)")} — ${esc(j.desc || "job")}</div>
        <div class="li-sub">${j.durationMin} min${c ? " · " + esc(c.address) : ""}</div>
      </div>
      <div class="li-actions"><button title="Remove job" data-act="deljob" data-id="${j.id}">✕</button></div>`;
    list.appendChild(div);
  }
  $("job-count").textContent = state.jobs.length;
}

/* ------------------------- planning ------------------------- */

function minutesFromHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}
function fmtTime(minOfDay) {
  minOfDay = Math.round(minOfDay);
  let h = Math.floor(minOfDay / 60) % 24;
  const m = minOfDay % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
function fmtDur(min) {
  min = Math.round(min);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

function setProgress(text) {
  const box = $("plan-progress");
  if (text === null) box.classList.add("hidden");
  else { box.classList.remove("hidden"); $("plan-progress-text").textContent = text; }
}

// 2-opt improvement of an open path base -> order[0..n-1] (-> base if roundTrip)
function twoOpt(order, dist, baseIdx, roundTrip) {
  const cost = (ord) => {
    let t = dist[baseIdx][ord[0]];
    for (let i = 0; i < ord.length - 1; i++) t += dist[ord[i]][ord[i + 1]];
    if (roundTrip) t += dist[ord[ord.length - 1]][baseIdx];
    return t;
  };
  let best = order.slice(), bestCost = cost(best), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const cc = cost(cand);
        if (cc < bestCost - 1e-9) { best = cand; bestCost = cc; improved = true; }
      }
    }
  }
  return best;
}

async function optimizeRoutes() {
  const s = state.settings;
  const warnings = [];

  if (!s.baseAddress.trim()) { alert("Set your home base address in Settings first."); return; }
  if (!state.jobs.length) { alert("Add at least one job to schedule."); return; }

  $("btn-plan").disabled = true;
  try {
    /* 1. geocode base + all job addresses */
    setProgress("Locating home base…");
    const base = await geocode(s.baseAddress);
    if (!base) throw new Error("Couldn't find the home base address on the map. Check it in Settings.");
    s.baseCoord = base;

    const jobsToPlan = [];
    for (let i = 0; i < state.jobs.length; i++) {
      const j = state.jobs[i];
      const c = state.customers.find(c => c.id === j.customerId);
      if (!c) { warnings.push(`A job (“${j.desc}”) refers to a deleted customer — skipped.`); continue; }
      setProgress(`Locating addresses… ${i + 1}/${state.jobs.length} (${c.name})`);
      let coord = (c.lat != null) ? { lat: c.lat, lon: c.lon } : await geocode(c.address);
      if (!coord) {
        warnings.push(`Couldn't locate “${c.address}” (${c.name}) — job skipped. Fix the address and re-run.`);
        continue;
      }
      c.lat = coord.lat; c.lon = coord.lon;
      jobsToPlan.push({ job: j, cust: c, coord });
    }
    saveState();
    if (!jobsToPlan.length) throw new Error("No jobs could be located on the map.");

    /* 2. drive-time matrix (index 0 = base) */
    setProgress("Calculating drive times…");
    const coords = [base, ...jobsToPlan.map(x => x.coord)];
    const secs = await fetchDurationMatrix(coords);
    const mins = secs.map(row => row.map(v => (v == null ? 1e7 : v / 60)));

    /* 3. split into days greedily by capacity, nearest-first */
    setProgress("Optimizing routes…");
    const capacity = s.dayHours * 60;
    const unassigned = new Set(jobsToPlan.map((_, i) => i + 1)); // matrix indices
    const days = [];
    while (unassigned.size) {
      let cur = 0, used = 0;
      const order = [];
      while (true) {
        let bestIdx = -1, bestDrive = Infinity;
        for (const idx of unassigned) {
          if (mins[cur][idx] < bestDrive) { bestDrive = mins[cur][idx]; bestIdx = idx; }
        }
        if (bestIdx < 0) break;
        const dur = jobsToPlan[bestIdx - 1].job.durationMin;
        const returnLeg = s.returnToBase ? mins[bestIdx][0] : 0;
        const would = used + bestDrive + dur + returnLeg;
        if (would > capacity && order.length > 0) break;      // day full
        if (would > capacity) {
          warnings.push(`“${jobsToPlan[bestIdx - 1].cust.name}” doesn't fit in a single workday — scheduled anyway; expect overtime.`);
        }
        used += bestDrive + dur;
        order.push(bestIdx);
        unassigned.delete(bestIdx);
        cur = bestIdx;
      }
      if (!order.length) break; // safety
      days.push(twoOpt(order, mins, 0, s.returnToBase));
    }

    /* 4. build schedules with ETAs */
    const dayStart = minutesFromHHMM(s.dayStart);
    const planDays = [];
    for (const order of days) {
      let t = dayStart, prev = 0;
      let driveTotal = 0, workTotal = 0;
      const stops = [];
      for (const idx of order) {
        const drive = mins[prev][idx];
        t += drive; driveTotal += drive;
        const { job, cust, coord } = jobsToPlan[idx - 1];
        stops.push({
          job, cust, coord,
          driveMin: drive,
          arrive: t,
          depart: t + job.durationMin,
        });
        workTotal += job.durationMin;
        t += job.durationMin;
        prev = idx;
      }
      let returnDrive = null, endTime = t;
      if (s.returnToBase) {
        returnDrive = mins[prev][0];
        endTime = t + returnDrive;
        driveTotal += returnDrive;
      }
      planDays.push({ stops, returnDrive, endTime, driveTotal, workTotal });
    }

    plan = { days: planDays, warnings, base };
    activeDay = 0;

    /* 5. fetch route geometry for each day (best effort) */
    for (let d = 0; d < planDays.length; d++) {
      setProgress(`Drawing routes… day ${d + 1}/${planDays.length}`);
      const pts = [base, ...planDays[d].stops.map(st => st.coord)];
      if (s.returnToBase) pts.push(base);
      try { planDays[d].geometry = await fetchRouteGeometry(pts); }
      catch { planDays[d].geometry = null; }
    }

    setProgress(null);
    renderPlan();
  } catch (err) {
    setProgress(null);
    console.error(err);
    alert("Route planning failed: " + err.message);
  } finally {
    $("btn-plan").disabled = false;
  }
}

/* ------------------- cross-device sync (GitHub) ------------------- */
/* The app's private repo is the sync store: every device pushes/pulls
 * state.json via the GitHub Contents API using a fine-grained token
 * that can only touch that one repo. Records merge by updatedAt;
 * tombstones replicate deletions. */

const SYNC_REPO = { owner: "tristenharwell", repo: "mechanic-router-data", path: "state.json" };
const TOKEN_KEY = "mmr_sync_token";

let syncTimer = null;
let syncing = false;

const getSyncToken = () => localStorage.getItem(TOKEN_KEY) || "";
const b64encode = (s) => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s) => decodeURIComponent(escape(atob(s.replace(/\s/g, ""))));

function setSyncStatus(text) {
  const el = $("sync-status");
  if (el) el.textContent = text;
}

function scheduleSync() {
  if (syncing || !getSyncToken()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), 4000);
}

function ghContents(method, body) {
  const url = `https://api.github.com/repos/${SYNC_REPO.owner}/${SYNC_REPO.repo}/contents/${SYNC_REPO.path}`;
  return fetchWithTimeout(url, 15000, {
    method,
    headers: {
      "Authorization": "Bearer " + getSyncToken(),
      "Accept": "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// stable stringify so "did anything change?" ignores key order
function stableStr(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStr).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStr(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

function mergeTombstones(a = [], b = []) {
  const map = new Map();
  for (const t of [...a, ...b]) {
    const prev = map.get(t.id);
    if (!prev || t.deletedAt > prev.deletedAt) map.set(t.id, t);
  }
  return [...map.values()].sort((x, y) => y.deletedAt - x.deletedAt).slice(0, 500);
}

function mergeEntities(local = [], remote = [], tombs = []) {
  const map = new Map();
  for (const e of [...remote, ...local]) {
    const prev = map.get(e.id);
    if (!prev || (e.updatedAt || 0) > (prev.updatedAt || 0)) map.set(e.id, e);
  }
  for (const t of tombs) {
    const e = map.get(t.id);
    if (e && (e.updatedAt || 0) <= t.deletedAt) map.delete(t.id);
  }
  return [...map.values()];
}

function mergeStates(local, remote) {
  const tombs = mergeTombstones(local.tombstones, remote.tombstones);
  const rs = remote.settings || {};
  return {
    settings: (local.settings.updatedAt || 0) >= (rs.updatedAt || 0) ? local.settings : rs,
    customers: mergeEntities(local.customers, remote.customers, tombs),
    jobs: mergeEntities(local.jobs, remote.jobs, tombs),
    tombstones: tombs,
  };
}

function stateSnapshot() {
  return {
    settings: state.settings,
    customers: state.customers,
    jobs: state.jobs,
    tombstones: state.tombstones,
  };
}

async function syncNow() {
  if (syncing) return;
  if (!getSyncToken()) { setSyncStatus("Paste your GitHub token above to enable sync."); return; }
  syncing = true;
  clearTimeout(syncTimer);
  setSyncStatus("Syncing…");
  try {
    /* pull */
    let remote = null, sha = null;
    const resp = await ghContents("GET");
    if (resp.status === 200) {
      const j = await resp.json();
      sha = j.sha;
      try { remote = JSON.parse(b64decode(j.content)); } catch { remote = null; }
    } else if (resp.status === 401 || resp.status === 403) {
      throw new Error("GitHub rejected the token — check it hasn't expired and can access " + SYNC_REPO.repo + ".");
    } else if (resp.status !== 404) {
      throw new Error("GitHub error " + resp.status);
    }

    /* merge remote into local */
    if (remote) {
      const merged = mergeStates(stateSnapshot(), remote);
      state.settings = merged.settings;
      state.customers = merged.customers.sort((a, b) => a.name.localeCompare(b.name));
      state.jobs = merged.jobs;
      state.tombstones = merged.tombstones;
      localStorage.setItem(STORE_KEY, JSON.stringify(state)); // save without re-triggering sync
      applySettingsToUI();
      renderCustomers();
      renderJobs();
    }

    /* push back if we have anything the remote doesn't */
    if (!remote || stableStr(stateSnapshot()) !== stableStr(remote)) {
      const put = await ghContents("PUT", {
        message: "sync " + new Date().toISOString(),
        content: b64encode(JSON.stringify(stateSnapshot(), null, 1)),
        ...(sha ? { sha } : {}),
      });
      if (put.status === 409 || put.status === 422) throw new Error("Another device synced at the same moment — press Sync now again.");
      if (!put.ok) throw new Error("GitHub push failed (" + put.status + ")");
    }
    localStorage.setItem("mmr_last_sync", String(Date.now()));
    setSyncStatus("✓ Synced " + new Date().toLocaleTimeString());
  } catch (e) {
    setSyncStatus("⚠ " + (e.name === "AbortError" ? "GitHub not reachable (offline?)" : e.message));
  } finally {
    syncing = false;
  }
}

function applySettingsToUI() {
  $("set-base").value = state.settings.baseAddress;
  $("set-start").value = state.settings.dayStart;
  $("set-hours").value = state.settings.dayHours;
  $("set-return").checked = state.settings.returnToBase;
  $("set-notify").value = state.settings.notifyTemplate;
}

/* ---------------- send-to-phone & customer notify ---------------- */

function openModal(html) {
  $("modal-content").innerHTML = html;
  $("modal-backdrop").classList.remove("hidden");
}
function closeModal() {
  $("modal-backdrop").classList.add("hidden");
  $("modal-content").innerHTML = "";
}

function qrSvg(text) {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2 });
  } catch (e) {
    console.warn("QR generation failed", e);
    return "";
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "✓ Copied";
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

// Google Maps caps directions links at 9 waypoints + origin + destination
// (11 points per link) — longer days are split into consecutive links.
function googleMapsDayUrls(day) {
  const seq = [state.settings.baseAddress, ...day.stops.map(st => st.cust.address)];
  if (state.settings.returnToBase) seq.push(state.settings.baseAddress);
  const urls = [];
  for (let i = 0; i + 1 < seq.length; i += 10) {
    const seg = seq.slice(i, i + 11);
    const params = new URLSearchParams({
      api: "1",
      travelmode: "driving",
      origin: seg[0],
      destination: seg[seg.length - 1],
    });
    if (seg.length > 2) params.set("waypoints", seg.slice(1, -1).join("|"));
    urls.push("https://www.google.com/maps/dir/?" + params.toString());
  }
  return urls;
}

function showShareModal(day, dayNum) {
  const urls = googleMapsDayUrls(day);
  const parts = urls.map((u, i) => `
    ${urls.length > 1 ? `<div class="qr-label">Part ${i + 1} of ${urls.length}</div>` : ""}
    <div class="qr-box">${qrSvg(u)}</div>
    <div class="modal-btns">
      <a class="btn-like-a" href="${esc(u)}" target="_blank" rel="noopener">Open in Google Maps</a>
      <button data-copy="${esc(u)}">Copy link</button>
    </div>
    <div class="link-line">${esc(u)}</div>`).join("<hr>");
  openModal(`
    <h3>📱 Day ${dayNum} route → your phone</h3>
    <p class="hint">Scan the QR code with your phone camera — the whole day opens in
    Google Maps navigation with every stop in order. Or copy the link and text it to yourself.</p>
    ${parts}`);
}

function fillTemplate(stop) {
  const c = stop.cust;
  return (state.settings.notifyTemplate || "")
    .replace(/\{first\}/g, c.name.split(/\s+/)[0])
    .replace(/\{name\}/g, c.name)
    .replace(/\{job\}/g, stop.job.desc || "service appointment")
    .replace(/\{eta\}/g, fmtTime(stop.arrive))
    .replace(/\{address\}/g, c.address)
    .replace(/\{vehicle\}/g, c.vehicle || "your vehicle");
}

function showNotifyModal(stop) {
  const c = stop.cust;
  const phoneDigits = (c.phone || "").replace(/[^\d+]/g, "");
  const msg = fillTemplate(stop);
  openModal(`
    <h3>💬 Notify ${esc(c.name)}</h3>
    <p class="hint">ETA ${fmtTime(stop.arrive)} · ${esc(c.phone || "no phone on file")}${c.email ? " · " + esc(c.email) : ""}</p>
    <textarea id="notify-msg" rows="4">${esc(msg)}</textarea>
    <div class="modal-btns">
      <button id="notify-copy" class="primary">Copy message</button>
      ${phoneDigits ? `<a class="btn-like-a" id="notify-sms" href="#">Text from this device</a>` : ""}
      ${c.email ? `<a class="btn-like-a" id="notify-mail" href="#">Email</a>` : ""}
    </div>
    ${phoneDigits ? `<div class="qr-label" style="margin-top:12px">…or scan with your phone to send the text from there:</div>
    <div class="qr-box" id="notify-qr"></div>` : ""}`);

  const currentMsg = () => $("notify-msg").value;
  const smsHref = () => `sms:${phoneDigits}?&body=${encodeURIComponent(currentMsg())}`;

  $("notify-copy").addEventListener("click", e => copyText(currentMsg(), e.target));
  if (phoneDigits) {
    const refreshQr = () => { $("notify-qr").innerHTML = qrSvg(smsHref()); };
    refreshQr();
    $("notify-msg").addEventListener("input", refreshQr);
    $("notify-sms").addEventListener("click", e => { e.target.href = smsHref(); });
  }
  const mail = $("notify-mail");
  if (mail) mail.addEventListener("click", e => {
    e.target.href = `mailto:${c.email}?subject=${encodeURIComponent("Your mechanic is on the way")}&body=${encodeURIComponent(currentMsg())}`;
  });
}

/* ---------------------- plan rendering ---------------------- */

function renderPlan() {
  const tabs = $("day-tabs");
  const sched = $("day-schedule");
  const warnBox = $("plan-warnings");
  tabs.innerHTML = ""; sched.innerHTML = ""; warnBox.innerHTML = "";
  $("day-actions").innerHTML = "";
  $("plan-summary").textContent = "";
  planLayer.clearLayers();
  if (!plan) return;

  for (const w of plan.warnings) {
    const div = document.createElement("div");
    div.className = "warning";
    div.textContent = "⚠ " + w;
    warnBox.appendChild(div);
  }

  plan.days.forEach((_, d) => {
    const b = document.createElement("button");
    const color = DAY_COLORS[d % DAY_COLORS.length];
    b.textContent = "Day " + (d + 1);
    if (d === activeDay) { b.classList.add("active"); b.style.background = color; b.style.borderColor = color; }
    b.onclick = () => { activeDay = d; renderPlan(); };
    tabs.appendChild(b);
  });

  const s = state.settings;
  const day = plan.days[activeDay];
  if (!day) return;
  const color = DAY_COLORS[activeDay % DAY_COLORS.length];

  const shareBtn = document.createElement("button");
  shareBtn.className = "primary";
  shareBtn.textContent = "📱 Send day to phone (Google Maps)";
  shareBtn.style.width = "100%";
  shareBtn.onclick = () => showShareModal(day, activeDay + 1);
  $("day-actions").appendChild(shareBtn);

  const mkCard = (html, cls = "") => {
    const div = document.createElement("div");
    div.className = "stop-card " + cls;
    div.style.borderLeftColor = color;
    div.innerHTML = html;
    sched.appendChild(div);
  };

  mkCard(`<div class="stop-head"><span class="stop-num">🏠 Leave home base</span>
          <span class="stop-time">${fmtTime(minutesFromHHMM(s.dayStart))}</span></div>
          <div class="stop-sub">${esc(s.baseAddress)}</div>`, "base");

  day.stops.forEach((st, i) => {
    mkCard(`<div class="stop-head"><span class="stop-num" style="color:${color}">#${i + 1}</span>
            <span>${esc(st.cust.name)}</span>
            <span class="stop-time">${fmtTime(st.arrive)}–${fmtTime(st.depart)}</span></div>
            <div class="stop-sub">${esc(st.job.desc || "Job")} · ${fmtDur(st.job.durationMin)}
            ${st.cust.vehicle ? " · " + esc(st.cust.vehicle) : ""}${st.cust.phone ? " · ☎ " + esc(st.cust.phone) : ""}</div>
            <div class="stop-sub">${esc(st.cust.address)}</div>
            <div class="drive-note">🚗 ${fmtDur(st.driveMin)} drive from previous stop</div>
            <div class="stop-actions">
              <button data-nav="${i}">🧭 Navigate</button>
              <button data-notify="${i}">💬 Notify customer</button>
            </div>`);
  });

  if (day.returnDrive != null) {
    mkCard(`<div class="stop-head"><span class="stop-num">🏠 Back at home base</span>
            <span class="stop-time">${fmtTime(day.endTime)}</span></div>
            <div class="drive-note">🚗 ${fmtDur(day.returnDrive)} drive home</div>`, "base");
  }

  $("plan-summary").textContent =
    `Day ${activeDay + 1}: ${day.stops.length} stops · ${fmtDur(day.workTotal)} wrenching · ` +
    `${fmtDur(day.driveTotal)} driving · done ${fmtTime(day.endTime)}` +
    (plan.days.length > 1 ? ` — ${plan.days.length} days total` : "");

  /* map */
  const baseIcon = L.divIcon({ className: "", html: '<div class="base-marker">🏠</div>', iconSize: [28, 28], iconAnchor: [14, 14] });
  L.marker([plan.base.lat, plan.base.lon], { icon: baseIcon })
    .bindPopup("Home base<br>" + esc(s.baseAddress)).addTo(planLayer);

  const bounds = [[plan.base.lat, plan.base.lon]];
  day.stops.forEach((st, i) => {
    const icon = L.divIcon({
      className: "",
      html: `<div class="num-marker" style="background:${color}">${i + 1}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
    L.marker([st.coord.lat, st.coord.lon], { icon })
      .bindPopup(`<b>#${i + 1} ${esc(st.cust.name)}</b><br>${esc(st.job.desc || "")}<br>` +
                 `${esc(st.cust.address)}<br>ETA ${fmtTime(st.arrive)}`)
      .addTo(planLayer);
    bounds.push([st.coord.lat, st.coord.lon]);
  });

  if (day.geometry) {
    L.polyline(day.geometry, { color, weight: 4, opacity: 0.75 }).addTo(planLayer);
  } else {
    const pts = [[plan.base.lat, plan.base.lon], ...day.stops.map(st => [st.coord.lat, st.coord.lon])];
    if (s.returnToBase) pts.push([plan.base.lat, plan.base.lon]);
    L.polyline(pts, { color, weight: 3, dashArray: "6 6", opacity: 0.7 }).addTo(planLayer);
  }
  map.fitBounds(bounds, { padding: [40, 40] });
}

/* ------------------------- wiring ------------------------- */

function wireUI() {
  // collapsible panels
  document.querySelectorAll(".panel-header").forEach(h => {
    h.addEventListener("click", () => {
      const body = $(h.dataset.toggle);
      body.classList.toggle("hidden");
      h.classList.toggle("collapsed");
    });
  });

  // settings
  applySettingsToUI();
  $("set-base").addEventListener("change", e => {
    state.settings.baseAddress = e.target.value;
    state.settings.baseCoord = null;
    touchSettings();
  });
  $("set-start").addEventListener("change", e => { state.settings.dayStart = e.target.value; touchSettings(); });
  $("set-hours").addEventListener("change", e => { state.settings.dayHours = +e.target.value || 8; touchSettings(); });
  $("set-return").addEventListener("change", e => { state.settings.returnToBase = e.target.checked; touchSettings(); });
  $("set-notify").addEventListener("change", e => { state.settings.notifyTemplate = e.target.value; touchSettings(); });

  // sync
  $("sync-token").value = getSyncToken();
  $("sync-token").addEventListener("change", e => {
    const v = e.target.value.trim();
    if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
    if (v) syncNow();
  });
  $("btn-sync").addEventListener("click", () => syncNow());

  // import
  $("import-file").addEventListener("change", e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => handleCSVText(reader.result);
    reader.readAsText(f);
  });
  $("btn-paste-csv").addEventListener("click", () => {
    $("paste-area").classList.remove("hidden");
    $("btn-parse-paste").classList.remove("hidden");
    $("paste-area").focus();
  });
  $("btn-parse-paste").addEventListener("click", () => handleCSVText($("paste-area").value));
  $("btn-do-import").addEventListener("click", runImport);
  $("btn-cancel-import").addEventListener("click", () => { cancelImport(); $("import-status").textContent = ""; });

  // customers
  $("customer-search").addEventListener("input", renderCustomers);
  $("customer-list").addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const c = state.customers.find(c => c.id === btn.dataset.id);
    if (!c) return;
    if (btn.dataset.act === "del") {
      if (!confirm(`Delete customer "${c.name}"? Their pending jobs will be removed too.`)) return;
      addTombstone(c.id);
      state.jobs.filter(j => j.customerId === c.id).forEach(j => addTombstone(j.id));
      state.customers = state.customers.filter(x => x.id !== c.id);
      state.jobs = state.jobs.filter(j => j.customerId !== c.id);
      saveState(); renderCustomers(); renderJobs();
    } else if (btn.dataset.act === "job") {
      $("job-customer").value = c.name;
      $("job-desc").focus();
    }
  });
  $("btn-add-customer").addEventListener("click", () => {
    const name = $("cust-name").value.trim();
    const address = $("cust-address").value.trim();
    if (!name || !address) { alert("Name and address are required."); return; }
    state.customers.push({
      id: uid(), name, address,
      phone: $("cust-phone").value.trim(),
      email: $("cust-email").value.trim(),
      vehicle: $("cust-vehicle").value.trim(),
      lat: null, lon: null,
      updatedAt: Date.now(),
    });
    state.customers.sort((a, b) => a.name.localeCompare(b.name));
    saveState(); renderCustomers();
    ["cust-name", "cust-address", "cust-phone", "cust-email", "cust-vehicle"].forEach(id => $(id).value = "");
  });

  // jobs
  $("btn-add-job").addEventListener("click", () => {
    const name = $("job-customer").value.trim();
    const cust = state.customers.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!cust) { alert("Pick an existing customer (import or add them first)."); return; }
    const durationMin = +$("job-duration").value || 60;
    state.jobs.push({ id: uid(), customerId: cust.id, desc: $("job-desc").value.trim(), durationMin, updatedAt: Date.now() });
    saveState(); renderJobs();
    $("job-customer").value = ""; $("job-desc").value = "";
  });
  $("job-list").addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (btn && btn.dataset.act === "deljob") {
      addTombstone(btn.dataset.id);
      state.jobs = state.jobs.filter(j => j.id !== btn.dataset.id);
      saveState(); renderJobs();
    }
  });
  $("btn-clear-jobs").addEventListener("click", () => {
    if (state.jobs.length && confirm("Remove all jobs from the schedule?")) {
      state.jobs.forEach(j => addTombstone(j.id));
      state.jobs = []; saveState(); renderJobs();
    }
  });

  // plan
  $("btn-plan").addEventListener("click", optimizeRoutes);
  $("btn-print").addEventListener("click", () => window.print());
  $("day-schedule").addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn || !plan) return;
    const day = plan.days[activeDay];
    if (!day) return;
    if (btn.dataset.nav !== undefined) {
      const st = day.stops[+btn.dataset.nav];
      window.open("https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" +
        encodeURIComponent(st.cust.address), "_blank", "noopener");
    } else if (btn.dataset.notify !== undefined) {
      showNotifyModal(day.stops[+btn.dataset.notify]);
    }
  });

  // modal
  $("modal-close").addEventListener("click", closeModal);
  $("modal-backdrop").addEventListener("click", e => { if (e.target.id === "modal-backdrop") closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
  $("modal-content").addEventListener("click", e => {
    const btn = e.target.closest("button[data-copy]");
    if (btn) copyText(btn.dataset.copy, btn);
  });
}

/* ------------------------- init ------------------------- */

loadState();
initMap();
wireUI();
renderCustomers();
renderJobs();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW registration failed", e));
}

if (getSyncToken()) syncNow(); // pull latest from other devices on launch
