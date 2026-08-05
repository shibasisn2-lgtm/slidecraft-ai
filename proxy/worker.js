/**
 * SlideCraft AI — Cloudflare Worker proxy.
 *
 * Holds the Anthropic API key server-side (as a secret) so the public
 * front-end never sees it. The browser sends only a plain text prompt;
 * this worker attaches the system instruction + structured-output tool
 * schema, calls Claude, and returns the parsed slide deck JSON.
 *
 * Basic abuse protection:
 *  - CORS locked to ALLOWED_ORIGIN (the GitHub Pages site).
 *  - Prompt length capped.
 *  - Simple per-IP hourly rate limit via Workers KV.
 * This is "basic" protection, not bulletproof — a determined attacker
 * could still spoof headers from outside a browser. Good enough for a
 * small personal/demo app; not a substitute for real auth at scale.
 */

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;
const MAX_PROMPT_CHARS = 24000;
const RATE_LIMIT_PER_HOUR = 30;

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
          theme: { type: "string", enum: ["ocean", "sunset", "forest", "royal", "midnight"] },
        },
        required: ["title", "bullets", "layout", "theme"],
      },
    },
  },
  required: ["deckTitle", "slides"],
};

const SYSTEM_INSTRUCTION = `You are a presentation design assistant. You turn a source document into a colorful, well-structured slide deck outline, and revise it on request.
Rules:
- Break content into a logical sequence of slides: one "title" slide first, optional "section" divider slides between topics, and "content" slides with bullets.
- Each slide needs: a concise title (max 8 words), 3-6 short punchy bullet points (max 12 words each, no full paragraphs), a "layout" (title|section|content), and a "theme" chosen from: ocean, sunset, forest, royal, midnight. Use the SAME theme across the whole deck unless the user explicitly asks for a different one or for variety.
- The very first slide must have layout "title" and only 0-1 bullets (a subtitle-like line is fine, or none).
- Keep language crisp and presentation-ready.
- When the user asks for a change, apply ONLY that change and keep everything else the same. Always return the FULL deck (every slide), never a partial list.
- Never invent a wildly different topic than the source document unless explicitly asked.
- Always call the return_deck tool with the result. Never reply in plain text.`;

function corsHeaders(origin, allowedOrigin) {
  const allow = origin === allowedOrigin ? allowedOrigin : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return true; // fail-open if KV not bound
  const bucket = Math.floor(Date.now() / 3600000); // current hour
  const key = `rl:${ip}:${bucket}`;
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_HOUR) return false;
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3700 });
  return true;
}

export default {
  async fetch(request, env) {
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
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "Origin not allowed." }), {
        status: 403,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const okToProceed = await checkRateLimit(env, ip);
    if (!okToProceed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        status: 429,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const prompt = (body && body.prompt) || "";
    if (!prompt || typeof prompt !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'prompt' string." }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    const trimmedPrompt = prompt.slice(0, MAX_PROMPT_CHARS);

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "Server not configured (missing API key)." }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
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
          tools: [
            {
              name: "return_deck",
              description: "Return the slide deck as structured data.",
              input_schema: SLIDE_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: "return_deck" },
        }),
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upstream request failed: " + err.message }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (!anthropicRes.ok) {
      let detail = "";
      try {
        detail = (await anthropicRes.json())?.error?.message || "";
      } catch (_) {}
      return new Response(
        JSON.stringify({ error: `Claude API error (${anthropicRes.status}): ${detail || anthropicRes.statusText}` }),
        { status: anthropicRes.status, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "return_deck");
    if (!toolUse || !toolUse.input) {
      return new Response(JSON.stringify({ error: "Model did not return a structured deck." }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(toolUse.input), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  },
};
