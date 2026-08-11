/**
 * SlideCraft AI — Cloudflare Worker proxy.
 *
 * Holds the Anthropic API key server-side (as a secret) so the public
 * front-end never sees it. The browser sends a plain text prompt plus a
 * Google ID token (from "Sign in with Google"); this worker verifies the
 * token, attaches the system instruction + structured-output tool schema,
 * calls Claude, logs the activity (who / when / tokens used) to a private
 * Google Sheet via a service account, and returns the parsed slide deck.
 *
 * Abuse protection:
 *  - CORS locked to ALLOWED_ORIGIN (the GitHub Pages site).
 *  - Sign-in required — every request must carry a valid Google ID token.
 *  - Prompt length capped.
 *  - Per-user (by verified email) hourly rate limit via Workers KV.
 */

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;
const MAX_PROMPT_CHARS = 24000;
const RATE_LIMIT_PER_HOUR = 30;
const SHEET_RANGE = "Sheet1!A:K";

const ICON_KEYS = [
  "none", "growth", "idea", "target", "rocket", "team", "calendar", "check", "warning",
  "globe", "money", "gear", "book", "star", "heart", "shield", "clock", "mail", "chart",
  "question", "trophy", "handshake", "flag", "search", "tools",
];

const SLIDE_SCHEMA = {
  type: "object",
  properties: {
    deckTitle: { type: "string" },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          layout: { type: "string", enum: ["title", "section", "content"] },
          icon: { type: "string", enum: ICON_KEYS },
        },
        required: ["title", "bullets", "layout", "icon"],
      },
    },
  },
  required: ["deckTitle", "slides"],
};

const SYSTEM_INSTRUCTION = `You are a presentation design assistant. You turn a source document into a well-structured slide deck outline, and revise it on request.
Rules:
- Break content into a logical sequence of slides: one "title" slide first, optional "section" divider slides between topics, and "content" slides with bullets.
- Each slide needs: a concise title (max 8 words), 3-6 short punchy bullet points (max 12 words each, no full paragraphs), and a "layout" (title|section|content).
- Each slide also needs an "icon": pick the closest match to that slide's content from this fixed set, or "none" if nothing fits well: ${ICON_KEYS.join(", ")}. The app decides whether to actually display icons, so always pick your best match regardless.
- The very first slide must have layout "title" and only 0-1 bullets (a subtitle-like line is fine, or none).
- Match the tone/structure to any DECK STYLE instruction given in the prompt. If none is given, default to clear, professional business language.
- Keep language crisp and presentation-ready.
- When the user asks for a change, apply ONLY that change and keep everything else the same. Always return the FULL deck (every slide), never a partial list.
- Never invent a wildly different topic than the source document unless explicitly asked.
- Colors/theming are handled outside of you — never mention colors or themes in slide content.
- Always call the return_deck tool with the result. Never reply in plain text.`;

/* ================= base64url / crypto helpers ================= */

function base64urlToBytes(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function base64urlDecodeToString(base64url) {
  return new TextDecoder().decode(base64urlToBytes(base64url));
}
function bytesToBase64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlEncode(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  return bytesToBase64url(bytes);
}
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  return base64urlToBytes(b64.replace(/\+/g, "-").replace(/\//g, "_")).buffer;
}

/* ================= Google ID token verification (Sign-In) ================= */

let jwksCache = null; // { keys, expires } — best-effort, persists only within a warm isolate

async function getGoogleJwks() {
  const now = Date.now();
  if (jwksCache && jwksCache.expires > now) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  const data = await res.json();
  jwksCache = { keys: data.keys, expires: now + 3600_000 };
  return jwksCache.keys;
}

async function verifyGoogleIdToken(idToken, env) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(base64urlDecodeToString(headerB64));
  const payload = JSON.parse(base64urlDecodeToString(payloadB64));

  if (!env.GOOGLE_CLIENT_ID || payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error("Invalid audience");
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new Error("Invalid issuer");
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error("Token expired");
  if (payload.email_verified === false || payload.email_verified === "false") throw new Error("Email not verified");

  const keys = await getGoogleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Signing key not found");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", cryptoKey, base64urlToBytes(sigB64), new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error("Invalid signature");

  return { email: payload.email, name: payload.name || payload.email };
}

/* ================= Google Sheets logging (service account) ================= */

let accessTokenCache = null; // { token, expires }

async function getGoogleAccessToken(env) {
  const now = Date.now();
  if (accessTokenCache && accessTokenCache.expires > now + 60_000) return accessTokenCache.token;

  const iat = Math.floor(now / 1000);
  const claimSet = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  };
  const signingInput = `${base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64urlEncode(JSON.stringify(claimSet))}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(env.GOOGLE_SA_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const assertion = `${signingInput}.${bytesToBase64url(new Uint8Array(signature))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error("Google token exchange failed: " + JSON.stringify(tokenData));

  accessTokenCache = { token: tokenData.access_token, expires: now + tokenData.expires_in * 1000 };
  return tokenData.access_token;
}

async function logToSheet(env, row) {
  if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) return;
  try {
    const accessToken = await getGoogleAccessToken(env);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}:append?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) console.error("Sheet append failed:", res.status, await res.text());
  } catch (err) {
    console.error("Sheet logging failed:", err.message);
  }
}

function logRow({ email, name, action, status, inputTokens, outputTokens, deckTitle, errorMessage }) {
  const now = new Date();
  return [
    now.toISOString(),
    email || "",
    name || "",
    action || "",
    status || "",
    MODEL,
    inputTokens || 0,
    outputTokens || 0,
    (inputTokens || 0) + (outputTokens || 0),
    deckTitle || "",
    (errorMessage || "").slice(0, 300),
  ];
}

/* ================= HTTP plumbing ================= */

function corsHeaders(origin, allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

async function checkRateLimit(env, key) {
  if (!env.RATE_LIMIT_KV) return true; // fail-open if KV not bound
  const bucket = Math.floor(Date.now() / 3600000); // current hour
  const kvKey = `rl:${key}:${bucket}`;
  const current = parseInt((await env.RATE_LIMIT_KV.get(kvKey)) || "0", 10);
  if (current >= RATE_LIMIT_PER_HOUR) return false;
  await env.RATE_LIMIT_KV.put(kvKey, String(current + 1), { expirationTtl: 3700 });
  return true;
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response("SlideCraft AI proxy is running.", { status: 200, headers });
    }

    if (url.pathname !== "/generate" || request.method !== "POST") {
      return jsonResponse({ error: "Not found" }, 404, headers);
    }

    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return jsonResponse({ error: "Origin not allowed." }, 403, headers);
    }

    // ---- Require Google Sign-In ----
    const authHeader = request.headers.get("Authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) {
      return jsonResponse({ error: "Sign in with Google required.", code: "NO_TOKEN" }, 401, headers);
    }
    let user;
    try {
      user = await verifyGoogleIdToken(idToken, env);
    } catch (err) {
      return jsonResponse({ error: "Session expired or invalid — please sign in again.", code: "BAD_TOKEN" }, 401, headers);
    }

    const okToProceed = await checkRateLimit(env, user.email);
    if (!okToProceed) {
      ctx.waitUntil(logToSheet(env, logRow({ ...user, action: "generate", status: "rate_limited" })));
      return jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ error: "Invalid JSON body." }, 400, headers);
    }

    const prompt = (body && body.prompt) || "";
    const action = body && body.action === "chat" ? "chat" : "generate";
    if (!prompt || typeof prompt !== "string") {
      return jsonResponse({ error: "Missing 'prompt' string." }, 400, headers);
    }
    const trimmedPrompt = prompt.slice(0, MAX_PROMPT_CHARS);

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: "Server not configured (missing API key)." }, 500, headers);
    }

    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_INSTRUCTION,
          messages: [{ role: "user", content: trimmedPrompt }],
          tools: [{ name: "return_deck", description: "Return the slide deck as structured data.", input_schema: SLIDE_SCHEMA }],
          tool_choice: { type: "tool", name: "return_deck" },
        }),
      });
    } catch (err) {
      ctx.waitUntil(logToSheet(env, logRow({ ...user, action, status: "error", errorMessage: "Upstream request failed: " + err.message })));
      return jsonResponse({ error: "Upstream request failed: " + err.message }, 502, headers);
    }

    if (!anthropicRes.ok) {
      let detail = "";
      try { detail = (await anthropicRes.json())?.error?.message || ""; } catch (_) {}
      ctx.waitUntil(logToSheet(env, logRow({ ...user, action, status: "error", errorMessage: `Claude API error (${anthropicRes.status}): ${detail}` })));
      return jsonResponse({ error: `Claude API error (${anthropicRes.status}): ${detail || anthropicRes.statusText}` }, anthropicRes.status, headers);
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "return_deck");
    if (!toolUse || !toolUse.input) {
      ctx.waitUntil(logToSheet(env, logRow({ ...user, action, status: "error", errorMessage: "Model did not return a structured deck." })));
      return jsonResponse({ error: "Model did not return a structured deck." }, 502, headers);
    }

    const usage = data.usage || {};
    ctx.waitUntil(logToSheet(env, logRow({
      ...user,
      action,
      status: "ok",
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      deckTitle: toolUse.input.deckTitle,
    })));

    return jsonResponse(toolUse.input, 200, headers);
  },
};
