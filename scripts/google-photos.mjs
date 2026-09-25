import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

// Google Photos Picker API. The Library API can no longer read a user's photos,
// so the user picks photos in Google's own picker and we download only those.
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PICKER_API = "https://photospicker.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const STATE_TTL_MS = 10 * 60 * 1000;
export const GOOGLE_PHOTOS_MAX_ITEMS = 20;

function durationSeconds(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/s$/, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function googleJson(response, label) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error?.message || result.error_description || (typeof result.error === "string" ? result.error : null);
    throw Object.assign(new Error(message || `${label} failed (${response.status})`), { status: response.status === 401 ? 401 : 502 });
  }
  return result;
}

export function createGooglePhotosClient({ clientId, clientSecret, tokenFile }) {
  const states = new Map();
  let token = null;

  const configured = () => Boolean(clientId() && clientSecret());

  async function loadToken() {
    if (token) return token;
    try { token = JSON.parse(await readFile(tokenFile(), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return token;
  }

  async function saveToken(next) {
    token = next;
    await writeFile(tokenFile(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  async function disconnect() {
    token = null;
    await rm(tokenFile(), { force: true });
  }

  function authorizationUrl(redirectUri) {
    const now = Date.now();
    for (const [key, value] of states) if (value.expiresAt < now) states.delete(key);
    const state = randomBytes(24).toString("hex");
    states.set(state, { redirectUri, expiresAt: now + STATE_TTL_MS });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    }).toString();
    return url.toString();
  }

  async function exchangeCode(code, state) {
    const pending = states.get(state);
    states.delete(state);
    if (!pending || pending.expiresAt < Date.now()) throw Object.assign(new Error("The Google sign-in link expired. Try again."), { status: 400 });
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: pending.redirectUri, grant_type: "authorization_code" }),
    });
    const result = await googleJson(response, "Google sign-in");
    const previous = await loadToken();
    await saveToken({
      accessToken: result.access_token,
      refreshToken: result.refresh_token || previous?.refreshToken || null,
      expiresAt: Date.now() + (Number(result.expires_in) || 3600) * 1000,
    });
  }

  async function accessToken() {
    const current = await loadToken();
    if (!current) throw Object.assign(new Error("Connect Google Photos first."), { status: 401 });
    if (current.expiresAt - 60_000 > Date.now()) return current.accessToken;
    if (!current.refreshToken) {
      await disconnect();
      throw Object.assign(new Error("Your Google Photos connection expired. Connect again."), { status: 401 });
    }
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: current.refreshToken, grant_type: "refresh_token" }),
    });
    try {
      const result = await googleJson(response, "Google token refresh");
      await saveToken({ ...current, accessToken: result.access_token, expiresAt: Date.now() + (Number(result.expires_in) || 3600) * 1000 });
      return token.accessToken;
    } catch (error) {
      await disconnect();
      throw Object.assign(new Error("Your Google Photos connection expired. Connect again."), { status: 401, cause: error });
    }
  }

  async function picker(pathname, init = {}) {
    const response = await fetch(`${PICKER_API}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
    });
    if (init.method === "DELETE") return null;
    return googleJson(response, "Google Photos request");
  }

  function publicSession(session) {
    return {
      id: session.id,
      pickerUri: session.pickerUri,
      mediaItemsSet: Boolean(session.mediaItemsSet),
      pollInterval: durationSeconds(session.pollingConfig?.pollInterval, 3),
      timeoutIn: durationSeconds(session.pollingConfig?.timeoutIn, 1800),
    };
  }

  async function createSession() {
    return publicSession(await picker("/sessions", { method: "POST", body: JSON.stringify({ pickingConfig: { maxItemCount: String(GOOGLE_PHOTOS_MAX_ITEMS) } }) }));
  }

  async function getSession(id) {
    return publicSession(await picker(`/sessions/${encodeURIComponent(id)}`));
  }

  async function deleteSession(id) {
    await picker(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }

  async function listMediaItems(sessionId) {
    const items = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ sessionId, pageSize: "100", ...(pageToken ? { pageToken } : {}) });
      const page = await picker(`/mediaItems?${query}`);
      items.push(...(page.mediaItems || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    return items;
  }

  async function downloadPhoto(item) {
    const baseUrl = item.mediaFile?.baseUrl;
    if (!baseUrl) throw new Error("Google Photos did not return a download link");
    // "=w2048-h2048" asks Google for a JPEG that fits inside 2048px, which also covers HEIC originals.
    const response = await fetch(`${baseUrl}=w2048-h2048`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (!response.ok) throw new Error(`Google Photos download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  return {
    configured,
    async connected() { return configured() && Boolean(await loadToken()); },
    authorizationUrl,
    exchangeCode,
    disconnect,
    createSession,
    getSession,
    deleteSession,
    listMediaItems,
    downloadPhoto,
  };
}
