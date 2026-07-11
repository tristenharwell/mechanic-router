/* Mobile Mechanic Route Planner
 * Static PWA: Google Maps Platform (map display, address autocomplete,
 * traffic-aware drive times via Routes API), Supabase login + per-account
 * cloud sync. Customer data imported from ALLDATA Manage Online CSV exports.
 */
"use strict";

/* Public client-side config: the Maps key is website-restricted to this
 * app's URLs, and the Supabase publishable key is guarded by Row Level
 * Security — neither grants access beyond what the app itself can do. */
const CONFIG = {
  supabaseUrl: "https://vnxeobxnfozaypjhltsa.supabase.co",
  supabaseAnonKey: "sb_publishable_s-QTeNxcox4dy2uyP3rPpw_UwBuv_uT",
  gmapsKey: "AIzaSyAN5gMd1EpaQ3XmeQWulSAbSFrJ8hwucZM",
};

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

let map = null;
let planOverlays = [];   // markers + polylines currently on the map
let infoWindow = null;
let gmapsReadyResolve;
const gmapsReady = new Promise(r => { gmapsReadyResolve = r; });

window.__gmapsReady = () => gmapsReadyResolve();
window.gm_authFailure = () => {
  setMapNotice("Google Maps rejected the API key — check that the key allows this site and the Maps JavaScript API is enabled.");
};

function loadGoogleMaps() {
  const s = document.createElement("script");
  s.src = "https://maps.googleapis.com/maps/api/js?key=" + CONFIG.gmapsKey +
    "&libraries=places,geometry&v=weekly&loading=async&callback=__gmapsReady";
  s.async = true;
  s.onerror = () => setMapNotice("Couldn't load Google Maps — check the internet connection.");
  document.head.appendChild(s);
}

function setMapNotice(text) {
  let el = $("map-notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "map-notice";
    $("map").appendChild(el);
  }
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

async function initMap() {
  await gmapsReady;
  map = new google.maps.Map($("map"), {
    center: { lat: 39.5, lng: -96 }, // continental US until we know better
    zoom: 5,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
  });
  infoWindow = new google.maps.InfoWindow();
  attachAutocomplete();
}

function clearOverlays() {
  planOverlays.forEach(o => o.setMap(null));
  planOverlays = [];
}

function addStopMarker(pos, color, num, popupHtml) {
  const m = new google.maps.Marker({
    map,
    position: pos,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 14,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2.5,
    },
    label: { text: String(num), color: "#fff", fontWeight: "700", fontSize: "13px" },
  });
  m.addListener("click", () => { infoWindow.setContent(popupHtml); infoWindow.open({ map, anchor: m }); });
  planOverlays.push(m);
  return m;
}

function addBaseMarker(pos, popupHtml) {
  const m = new google.maps.Marker({
    map,
    position: pos,
    icon: {
      path: "M -11 -11 H 11 V 11 H -11 Z",
      scale: 1,
      fillColor: "#14304f",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2.5,
    },
    label: { text: "🏠", fontSize: "13px" },
    zIndex: 999,
  });
  m.addListener("click", () => { infoWindow.setContent(popupHtml); infoWindow.open({ map, anchor: m }); });
  planOverlays.push(m);
  return m;
}

/* Places autocomplete on the address inputs; picking a suggestion also
 * stores exact coordinates so geocoding can't mismatch later. */
let pendingCustCoord = null; // coords picked in the add-customer address box
function attachAutocomplete() {
  const opts = { fields: ["formatted_address", "geometry"], types: ["address"] };

  const baseAc = new google.maps.places.Autocomplete($("set-base"), opts);
  baseAc.addListener("place_changed", () => {
    const p = baseAc.getPlace();
    if (!p.geometry) return;
    state.settings.baseAddress = p.formatted_address;
    state.settings.baseCoord = { lat: p.geometry.location.lat(), lon: p.geometry.location.lng() };
    geocache[normAddr(p.formatted_address)] = state.settings.baseCoord;
    saveGeocache();
    $("set-base").value = p.formatted_address;
    touchSettings();
    map.setCenter(p.geometry.location);
    if (map.getZoom() < 10) map.setZoom(11);
  });

  const custAc = new google.maps.places.Autocomplete($("cust-address"), opts);
  custAc.addListener("place_changed", () => {
    const p = custAc.getPlace();
    if (!p.geometry) return;
    $("cust-address").value = p.formatted_address;
    pendingCustCoord = { lat: p.geometry.location.lat(), lon: p.geometry.location.lng() };
    geocache[normAddr(p.formatted_address)] = pendingCustCoord;
    saveGeocache();
  });
  $("cust-address").addEventListener("input", () => { pendingCustCoord = null; });
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

// Primary geocoder: Google (via the Maps JS API, so the website-restricted
// key works). Resolves to coords, "none" for a confirmed no-match, or null
// when the service errored and the free fallback chain should try.
function geocodeGoogle(address) {
  return new Promise(resolve => {
    try {
      new google.maps.Geocoder().geocode({ address }, (results, status) => {
        if (status === "OK" && results && results.length) {
          const loc = results[0].geometry.location;
          resolve({ lat: loc.lat(), lon: loc.lng() });
        } else {
          resolve(status === "ZERO_RESULTS" ? "none" : null);
        }
      });
    } catch { resolve(null); }
  });
}

let lastGeocodeAt = 0;
async function geocode(address) {
  const key = normAddr(address);
  if (!key) return null;
  if (geocache[key]) return geocache[key].fail ? null : geocache[key];

  // gentle pacing so bulk imports don't trip per-second quotas
  const wait = lastGeocodeAt + 250 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocodeAt = Date.now();

  await gmapsReady;
  const g = await geocodeGoogle(address);
  if (g === "none") {
    geocache[key] = { fail: true };
    saveGeocache();
    return null;
  }
  if (g) {
    geocache[key] = g;
    saveGeocache();
    return g;
  }

  // Google unavailable — fall back to the free services
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

/* ------------------- Google Routes API ------------------- */

const ROUTES_BASE = "https://routes.googleapis.com";
const wp = (c) => ({ waypoint: { location: { latLng: { latitude: c.lat, longitude: c.lon } } } });
// live traffic needs a departure time slightly in the future
const soon = () => new Date(Date.now() + 90 * 1000).toISOString();

async function routesPost(path, fieldMask, body) {
  const resp = await fetchWithTimeout(ROUTES_BASE + path, 25000, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": CONFIG.gmapsKey,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error.message; } catch {}
    throw new Error("Google Routes error " + resp.status + (detail ? ": " + detail : ""));
  }
  return resp.json();
}

const parseSecs = (d) => d ? parseFloat(String(d).replace("s", "")) : null;

// coords: [{lat, lon}, ...] -> seconds matrix [i][j], traffic-aware.
// Chunked to stay inside the API's 625-elements-per-request limit.
async function fetchDurationMatrix(coords) {
  const n = coords.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(null));
  const CHUNK = 25;
  for (let oi = 0; oi < n; oi += CHUNK) {
    for (let di = 0; di < n; di += CHUNK) {
      const origins = coords.slice(oi, oi + CHUNK);
      const dests = coords.slice(di, di + CHUNK);
      const rows = await routesPost("/distanceMatrix/v2:computeRouteMatrix",
        "originIndex,destinationIndex,duration,condition",
        {
          origins: origins.map(wp),
          destinations: dests.map(wp),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
          departureTime: soon(),
        });
      for (const cell of rows) {
        const secs = cell.condition === "ROUTE_EXISTS" ? parseSecs(cell.duration) : null;
        matrix[oi + cell.originIndex][di + cell.destinationIndex] = secs;
      }
    }
  }
  for (let i = 0; i < n; i++) matrix[i][i] = 0;
  return matrix;
}

// ordered coords -> [[lat, lon], ...] polyline following real roads
async function fetchRouteGeometry(coords) {
  if (coords.length < 2) return null;
  try {
    const data = await routesPost("/directions/v2:computeRoutes",
      "routes.polyline.encodedPolyline",
      {
        origin: wp(coords[0]).waypoint,
        destination: wp(coords[coords.length - 1]).waypoint,
        intermediates: coords.slice(1, -1).map(c => wp(c).waypoint),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: soon(),
        polylineEncoding: "ENCODED_POLYLINE",
      });
    const enc = data.routes && data.routes[0] && data.routes[0].polyline.encodedPolyline;
    if (!enc) return null;
    return google.maps.geometry.encoding.decodePath(enc).map(p => [p.lat(), p.lng()]);
  } catch (e) {
    console.warn("Route polyline unavailable:", e.message);
    return null;
  }
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

/* --------------- login + cloud sync (Supabase) --------------- */
/* Each account owns one row in the app_state table; Row Level Security
 * means an account can only ever see its own row. Records merge by
 * updatedAt; tombstones replicate deletions. */

let sb = null;
let currentUser = null;
let syncTimer = null;
let syncing = false;

function setSyncStatus(text) {
  const el = $("sync-status");
  if (el) el.textContent = text;
}

function scheduleSync() {
  if (syncing || !currentUser) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), 4000);
}

function initSupabase() {
  sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
  sb.auth.onAuthStateChange((event, session) => {
    const hadUser = !!currentUser;
    currentUser = session ? session.user : null;
    updateAuthUI();
    if (currentUser && !hadUser) syncNow();
    if (event === "SIGNED_OUT") wipeLocalData();
  });
}

function updateAuthUI() {
  $("auth-screen").classList.toggle("hidden", !!currentUser);
  $("account-info").textContent = currentUser ? "Signed in as " + currentUser.email : "";
  if (!currentUser) {
    $("auth-msg").textContent = "";
    $("auth-pass").value = "";
  }
}

function authMsg(text) { $("auth-msg").textContent = text; }

async function doSignIn() {
  const email = $("auth-email").value.trim();
  const password = $("auth-pass").value;
  if (!email || !password) { authMsg("Enter your email and password."); return; }
  authMsg("Signing in…");
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) authMsg("⚠ " + error.message);
}

async function doSignUp() {
  const email = $("auth-email").value.trim();
  const password = $("auth-pass").value;
  if (!email || !password) { authMsg("Enter an email and choose a password (8+ characters)."); return; }
  authMsg("Creating account…");
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { authMsg("⚠ " + error.message); return; }
  if (!data.session) authMsg("Account created — check your email for a confirmation link, then sign in.");
}

function wipeLocalData() {
  // shared computers shouldn't keep the previous account's customers around
  state.customers = [];
  state.jobs = [];
  state.tombstones = [];
  plan = null;
  localStorage.removeItem(STORE_KEY);
  renderCustomers();
  renderJobs();
  renderPlan();
  setSyncStatus("");
}

function friendlySyncError(error) {
  const msg = (error && error.message) || String(error);
  if (/app_state.*schema cache|relation .* does not exist|PGRST205/i.test(msg))
    return "Cloud storage table missing — run the one-time setup SQL in the Supabase dashboard.";
  if (/Failed to fetch|NetworkError|AbortError/i.test(msg))
    return "Cloud not reachable — will retry on the next change (offline?).";
  return msg;
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
  if (!sb || !currentUser) { setSyncStatus("Sign in to sync."); return; }
  syncing = true;
  clearTimeout(syncTimer);
  setSyncStatus("Syncing…");
  try {
    /* pull this account's row */
    const { data: rows, error: selErr } = await sb.from("app_state")
      .select("data, updated_at")
      .eq("user_id", currentUser.id);
    if (selErr) throw new Error(friendlySyncError(selErr));
    const row = rows && rows[0];

    /* merge remote into local */
    if (row && row.data) {
      const merged = mergeStates(stateSnapshot(), row.data);
      state.settings = merged.settings;
      state.customers = merged.customers.sort((a, b) => a.name.localeCompare(b.name));
      state.jobs = merged.jobs;
      state.tombstones = merged.tombstones;
      localStorage.setItem(STORE_KEY, JSON.stringify(state)); // save without re-triggering sync
      applySettingsToUI();
      renderCustomers();
      renderJobs();
    }

    /* push back if we have anything the cloud doesn't */
    if (!row) {
      const { error: insErr } = await sb.from("app_state")
        .insert({ user_id: currentUser.id, data: stateSnapshot(), updated_at: new Date().toISOString() });
      if (insErr) throw new Error(friendlySyncError(insErr));
    } else if (stableStr(stateSnapshot()) !== stableStr(row.data)) {
      // optimistic concurrency: only overwrite the exact version we merged with
      const { data: updated, error: updErr } = await sb.from("app_state")
        .update({ data: stateSnapshot(), updated_at: new Date().toISOString() })
        .eq("user_id", currentUser.id)
        .eq("updated_at", row.updated_at)
        .select("updated_at");
      if (updErr) throw new Error(friendlySyncError(updErr));
      if (!updated || !updated.length) {
        // another device wrote in between — re-merge on the next pass
        syncing = false;
        scheduleSync();
        return;
      }
    }
    localStorage.setItem("mmr_last_sync", String(Date.now()));
    setSyncStatus("✓ Synced " + new Date().toLocaleTimeString());
  } catch (e) {
    setSyncStatus("⚠ " + friendlySyncError(e));
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
  if (map) clearOverlays();
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
  if (!map) return;
  const basePos = { lat: plan.base.lat, lng: plan.base.lon };
  addBaseMarker(basePos, "<b>Home base</b><br>" + esc(s.baseAddress));

  const bounds = new google.maps.LatLngBounds();
  bounds.extend(basePos);
  day.stops.forEach((st, i) => {
    const pos = { lat: st.coord.lat, lng: st.coord.lon };
    addStopMarker(pos, color, i + 1,
      `<b>#${i + 1} ${esc(st.cust.name)}</b><br>${esc(st.job.desc || "")}<br>` +
      `${esc(st.cust.address)}<br>ETA ${fmtTime(st.arrive)}`);
    bounds.extend(pos);
  });

  const pathPts = day.geometry
    ? day.geometry.map(([lat, lon]) => ({ lat, lng: lon }))
    : (() => {
        const pts = [basePos, ...day.stops.map(st => ({ lat: st.coord.lat, lng: st.coord.lon }))];
        if (s.returnToBase) pts.push(basePos);
        return pts;
      })();
  planOverlays.push(new google.maps.Polyline({
    map,
    path: pathPts,
    strokeColor: color,
    strokeWeight: 4,
    strokeOpacity: day.geometry ? 0.75 : 0.45,
  }));
  map.fitBounds(bounds, 48);
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

  // account & sync
  $("btn-sync").addEventListener("click", () => syncNow());
  $("btn-signout").addEventListener("click", () => sb && sb.auth.signOut());
  $("btn-signin").addEventListener("click", doSignIn);
  $("btn-signup").addEventListener("click", doSignUp);
  $("auth-pass").addEventListener("keydown", e => { if (e.key === "Enter") doSignIn(); });

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
      lat: pendingCustCoord ? pendingCustCoord.lat : null,
      lon: pendingCustCoord ? pendingCustCoord.lon : null,
      updatedAt: Date.now(),
    });
    pendingCustCoord = null;
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
loadGoogleMaps();
initMap(); // resolves once the Maps script is ready
wireUI();
renderCustomers();
renderJobs();
initSupabase(); // shows the login screen or restores the session, then syncs

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW registration failed", e));
}
