const DEFAULTS = {
  resourceId: 13664,
  organizerId: 1556,
  summary: "Booked by Pierre-Henry WENDLING",
  color: "#20BF55",
  visibility: "PUBLIC"
};

// ---------- Debug log ----------
const logEl = () => document.getElementById("log");
function log(...args) {
  const msg = args
    .map(a => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())
    .join(" ");
  console.log("[booker]", ...args);
  const el = logEl();
  if (el) el.textContent += msg + "\n";
}
window.addEventListener("error", e => log("window.error:", e.message, e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", e => log("unhandledrejection:", e.reason && (e.reason.stack || e.reason.message || String(e.reason))));

// ---------- Date helpers ----------
function isoWeekOfDate(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { week: Math.ceil((((t - yearStart) / 86400000) + 1) / 7), year: t.getUTCFullYear() };
}
function mondayOfIsoWeek(year, week) {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - dow + 1);
  return monday;
}
function getParisOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUtc - date.getTime()) / 60000;
}
function parisToUtcIso(mondayUtc, dayOffset, hour, minute) {
  const t = new Date(mondayUtc);
  t.setUTCDate(t.getUTCDate() + dayOffset);
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
  const off = getParisOffsetMinutes(new Date(Date.UTC(y, m, d, 12)));
  const utc = Date.UTC(y, m, d, hour, minute) - off * 60000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function parisDayRangeForWeek(mondayUtc) {
  const fmt = (d) => {
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const off = getParisOffsetMinutes(new Date(Date.UTC(y, m, day, 12)));
    const sign = off >= 0 ? "+" : "-";
    const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
    const om = String(Math.abs(off) % 60).padStart(2, "0");
    return `${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}T00:00:00.000${sign}${oh}:${om}`;
  };
  const to = new Date(mondayUtc); to.setUTCDate(to.getUTCDate() + 7);
  return { from: fmt(mondayUtc), to: fmt(to) };
}

// ---------- UI helpers ----------
function setStatus(m, cls = "") {
  const el = document.getElementById("status");
  el.textContent = m;
  el.className = cls;
}
function fillWeeks() {
  const sel = document.getElementById("week");
  sel.innerHTML = "";
  const now = new Date();
  const limit = new Date(); limit.setDate(limit.getDate() + 30);
  for (let i = 0; i < 6; i++) {
    const ref = new Date(now); ref.setDate(now.getDate() + i * 7);
    if (ref > limit) break;
    const { week, year } = isoWeekOfDate(ref);
    const mon = mondayOfIsoWeek(year, week);
    const fri = new Date(mon); fri.setUTCDate(mon.getUTCDate() + 4);
    const fmtD = (d) => `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}`;
    const opt = document.createElement("option");
    opt.value = JSON.stringify({ week, year });
    opt.textContent = `W${week} (${fmtD(mon)} – ${fmtD(fri)})`;
    if (i === 0) opt.selected = true;
    sel.appendChild(opt);
  }
}
function allCheckboxes() { return [...document.querySelectorAll('#days input[type=checkbox]')]; }
function dayOffsetOf(cb) { return +cb.dataset.day - 1; }

function setDayBadge(cb, text) {
  const label = cb.parentElement;
  let badge = label.querySelector(".day-desk");
  if (!text) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "day-desk";
    label.appendChild(badge);
  }
  badge.textContent = `— ${text}`;
}

function setDeskBadge(name) {
  const el = document.getElementById("deskBadge");
  el.textContent = name ? `🪑 ${name}` : "Preferred desk (name not resolved)";
}
function setResourceName(text) {
  document.getElementById("resourceName").textContent = text || "—";
}

// ---------- State ----------
let existingByDay = new Map();

async function loadSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("resourceId").value = s.resourceId;
  document.getElementById("organizerId").value = s.organizerId;
  document.getElementById("summary").value = s.summary;
  log("settings loaded:", { resourceId: s.resourceId, organizerId: s.organizerId });
  return s;
}
async function saveSettings() {
  await chrome.storage.local.set({
    resourceId: +document.getElementById("resourceId").value,
    organizerId: +document.getElementById("organizerId").value,
    summary: document.getElementById("summary").value
  });
  setStatus("Settings saved.", "ok");
  await resolveResourceName();
  await refreshWeek();
}

async function send(msg) {
  const brief =
    msg.type === "list"     ? msg.params :
    msg.type === "delete"   ? { id: msg.id } :
    msg.type === "resource" ? { id: msg.id } :
    msg.type === "book"     ? { start: msg.payload.start, end: msg.payload.end, resourceId: msg.payload.resourceId } :
    msg;
  log("send →", msg.type, brief);
  let r;
  try { r = await chrome.runtime.sendMessage(msg); }
  catch (e) { log("sendMessage threw:", e.message); return { ok: false, status: 0, body: "sendMessage: " + e.message }; }
  if (!r) {
    const le = chrome.runtime.lastError;
    log("no response. lastError:", le && le.message);
    return { ok: false, status: 0, body: "no response from background" };
  }
  const preview = typeof r.body === "string"
    ? r.body.slice(0, 200)
    : Array.isArray(r.body) ? `array(${r.body.length})` : "object";
  log("recv ←", { ok: r.ok, status: r.status, bodyPreview: preview });
  return r;
}

async function resolveResourceName() {
  const id = +document.getElementById("resourceId").value;
  if (!id) { setResourceName("—"); setDeskBadge(null); return; }
  setResourceName("resolving…");
  const r = await send({ type: "resource", id });
  if (r.ok && r.body && r.body.name) {
    setResourceName(r.body.name);
    setDeskBadge(r.body.name);
    log("resolved resource", id, "→", r.body.name);
  } else {
    setResourceName(`❌ ${r.status || "?"}: ${String(r.body).slice(0, 100)}`);
    setDeskBadge(null);
  }
}

async function useJooxterPreferredDesk() {
  setStatus("Reading Jooxter profile…");
  const r = await send({ type: "me" });
  if (!r.ok) { setStatus(`❌ me: ${r.status} ${String(r.body).slice(0,160)}`, "err"); return; }
  // Look for a preferred-desk field in /v4/users/me
  const me = r.body || {};
  const candidates = [
    me.resourcePreferenceId,
    me.preferredResourceId,
    me.preferredResource && me.preferredResource.id,
    me.defaultResource && me.defaultResource.id,
    me.defaultResourceId,
    me.resourcePreference && me.resourcePreference.id
  ];
  const prefId = candidates.find(x => typeof x === "number");
  log("me keys:", Object.keys(me));
  if (!prefId) {
    setStatus("Couldn't find a preferred-desk field in your profile. Check the debug log.", "err");
    return;
  }
  document.getElementById("resourceId").value = prefId;
  await chrome.storage.local.set({ resourceId: prefId });
  await resolveResourceName();
  setStatus(`✅ Preferred desk updated to ID ${prefId}.`, "ok");
  await refreshWeek();
}

async function refreshWeek() {
  const btn = document.getElementById("apply");
  btn.disabled = true;
  setStatus("Loading…");
  try {
    const s = await chrome.storage.local.get(DEFAULTS);
    const { week, year } = JSON.parse(document.getElementById("week").value);
    const monday = mondayOfIsoWeek(year, week);
    const { from, to } = parisDayRangeForWeek(monday);
    log("refreshWeek W" + week + "/" + year, { from, to });

    const r = await send({ type: "list", params: { from, to, participantId: s.organizerId } });
    if (!r.ok) { setStatus(`❌ list: ${r.status} ${String(r.body).slice(0,160)}`, "err"); return; }

    existingByDay = new Map();
    const bookings = Array.isArray(r.body) ? r.body : (r.body && (r.body.content || r.body.data)) || [];
    log("bookings received:", bookings.length);

    for (const b of bookings) {
      if (b.cancelled) continue;
      if (!b.start || !b.start.dateTime) continue;
      const startUtc = new Date(b.start.dateTime);
      const offMin = getParisOffsetMinutes(startUtc);
      const parisLocal = new Date(startUtc.getTime() + offMin * 60000);
      const daysSinceMonday = Math.floor((Date.UTC(
        parisLocal.getUTCFullYear(), parisLocal.getUTCMonth(), parisLocal.getUTCDate()
      ) - monday.getTime()) / 86400000);
      if (daysSinceMonday < 0 || daysSinceMonday > 4) continue;

      const resId = b.resource ? b.resource.id : b.resourceId;
      const resName = b.resource ? b.resource.name : "";
      log("  booking", b.id, b.start.dateTime, "→ day=", daysSinceMonday, "desk=", resName);

      const existing = existingByDay.get(daysSinceMonday);
      if (!existing || resId === s.resourceId) {
        existingByDay.set(daysSinceMonday, { id: b.id, resourceId: resId, resourceName: resName });
      }
    }

    for (const cb of allCheckboxes()) {
      const day = dayOffsetOf(cb);
      const info = existingByDay.get(day);
      cb.checked = !!info;
      cb.dataset.initial = cb.checked ? "1" : "0";
      setDayBadge(cb, info ? info.resourceName : "");
    }

    setStatus(
      existingByDay.size === 0
        ? "No existing bookings this week."
        : `Found ${existingByDay.size} existing booking(s).`,
      "ok"
    );
  } catch (e) {
    log("refreshWeek error:", e.message, e.stack);
    setStatus("❌ " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function apply() {
  const btn = document.getElementById("apply");
  btn.disabled = true;
  setStatus("Applying…");

  try {
    const s = await chrome.storage.local.get(DEFAULTS);
    const { week, year } = JSON.parse(document.getElementById("week").value);
    const monday = mondayOfIsoWeek(year, week);
    const slot = document.getElementById("slot").value;
    let startH = 9, startM = 30, endH = 18, endM = 0;
    if (slot === "morning")   { endH = 13; endM = 0; }
    if (slot === "afternoon") { startH = 14; startM = 0; }

    const toCreate = [], toDelete = [];
    for (const cb of allCheckboxes()) {
      const day = dayOffsetOf(cb);
      const was = cb.dataset.initial === "1";
      const now = cb.checked;
      if (now && !was) toCreate.push(day);
      if (!now && was) {
        const info = existingByDay.get(day);
        if (info) toDelete.push({ day, id: info.id, resourceName: info.resourceName });
      }
    }
    log("apply plan:", { toCreate, toDelete });

    const results = [];
    for (const del of toDelete) {
      const r = await send({ type: "delete", id: del.id });
      results.push({ action: "del", day: del.day, desk: del.resourceName, ok: r.ok, info: r.ok ? "" : `${r.status}: ${String(r.body).slice(0,80)}` });
    }
    for (const day of toCreate) {
      const payload = {
        summary: s.summary, description: "",
        color: DEFAULTS.color, visibility: DEFAULTS.visibility,
        start: { dateTime: parisToUtcIso(monday, day, startH, startM) },
        end:   { dateTime: parisToUtcIso(monday, day, endH, endM) },
        resourceId: s.resourceId, organizerId: s.organizerId,
        attendees: { internal: [], external: [] }, options: []
      };
      const r = await send({ type: "book", payload });
      results.push({ action: "add", day, ok: r.ok, info: r.ok ? "" : `${r.status}: ${String(r.body).slice(0,80)}` });
    }

    const dayNames = ["Mon","Tue","Wed","Thu","Fri"];
    const lines = results.map(r => {
      const verb = r.action === "add" ? "Book" : "Unbook";
      const deskPart = r.action === "del" && r.desk ? ` (${r.desk})` : "";
      return `${r.ok ? "✅" : "❌"} ${verb} ${dayNames[r.day]}${deskPart}${r.info ? " — " + r.info : ""}`;
    });
    setStatus(lines.length ? lines.join("\n") : "Nothing to change.",
              results.some(r => !r.ok) ? "err" : "ok");

    await refreshWeek();
  } catch (e) {
    log("apply error:", e.message, e.stack);
    setStatus("❌ " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  log("popup loaded");
  fillWeeks();
  await loadSettings();
  document.getElementById("week").addEventListener("change", refreshWeek);
  document.getElementById("apply").addEventListener("click", apply);
  document.getElementById("refresh").addEventListener("click", refreshWeek);
  document.getElementById("save").addEventListener("click", saveSettings);
  document.getElementById("resolveResource").addEventListener("click", resolveResourceName);
  document.getElementById("useJooxterPref").addEventListener("click", useJooxterPreferredDesk);
  document.getElementById("clearLog").addEventListener("click", () => logEl().textContent = "");

  await resolveResourceName();
  await refreshWeek();
});