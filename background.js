const COGNITO_CLIENT_ID = "7jr7pnhg5mgaui7oifs9tkthc2";
const API = "https://app.jooxter.com/v4";

async function getAccessToken() {
  const cookies = await chrome.cookies.getAll({ domain: "jooxter.com" });
  const prefix = `CognitoIdentityServiceProvider.${COGNITO_CLIENT_ID}.`;
  const tokenCookie = cookies.find(
    c => c.name.startsWith(prefix) && c.name.endsWith(".accessToken")
  );
  if (!tokenCookie) {
    throw new Error("Cognito accessToken cookie not found. Are you logged into Jooxter?");
  }
  return tokenCookie.value;
}

async function apiFetch(path, init = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Client-Name": "jooxter-web",
      "X-Client-Version": "1.0.0",
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch (_) {}
  console.log("[booker-bg]", init.method || "GET", path, "→", res.status);
  return { ok: res.ok, status: res.status, body };
}

async function createBooking(payload)      { return apiFetch("/bookings", { method: "POST", body: JSON.stringify(payload) }); }
async function deleteBooking(id)           { return apiFetch(`/bookings/${id}`, { method: "DELETE" }); }
async function getResource(id)             { return apiFetch(`/resources/${id}`); }
async function getMe()                     { return apiFetch(`/users/me`); }
async function listBookings({ from, to, participantId }) {
  const qs = new URLSearchParams({
    from, to,
    participantId: String(participantId),
    status: "APPROVED,REQUESTED,FINISHED"
  });
  return apiFetch(`/bookings?${qs}`);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === "book")     sendResponse(await createBooking(msg.payload));
      else if (msg && msg.type === "delete")   sendResponse(await deleteBooking(msg.id));
      else if (msg && msg.type === "list")     sendResponse(await listBookings(msg.params));
      else if (msg && msg.type === "resource") sendResponse(await getResource(msg.id));
      else if (msg && msg.type === "me")       sendResponse(await getMe());
      else sendResponse({ ok: false, status: 0, body: "unknown message type" });
    } catch (e) {
      console.error("[booker-bg] error", e);
      sendResponse({ ok: false, status: 0, body: e.message || String(e) });
    }
  })();
  return true;
});