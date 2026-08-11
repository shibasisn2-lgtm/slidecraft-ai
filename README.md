# 🎨 SlideCraft AI

Chat your Word document into a colorful, ready-to-download PowerPoint — free, and no sign-up needed to use it.

**Live app:** _(added after deployment)_

## How it works

1. **Upload a `.docx` file** — the app reads its text locally in your browser (the file itself is never uploaded anywhere).
2. **Style your deck** — pick a deck type (Business / Pitch / Academic / Minimal, which shapes the AI's tone), toggle icons and decorative shapes on/off, and pick a color scheme — five presets, or "Custom" with your own primary/accent color pickers. Colors and toggles apply instantly, even to an already-generated deck, with no AI call needed.
3. **Click "Generate slide outline"** — a small proxy server sends your document to Claude (Anthropic's AI), which turns it into a well-structured slide deck (title, sections, bullet content, and a fitting icon per slide).
4. **Chat to refine it, slide by slide** — e.g. "make slide 3 shorter", "add a slide about next steps", "combine slides 2 and 3".
5. **Download the `.pptx`** — click the download button to get a real PowerPoint file with your chosen colors, icons, and decorative accent shapes baked in.

## Architecture

This is a static site (`index.html` / `styles.css` / `app.js`) hosted free on **GitHub Pages**, plus a tiny **Cloudflare Worker** proxy (`slidecraft-proxy`, see the sibling `slidecraft-proxy/` project) that holds the Anthropic API key server-side and forwards generation requests to Claude. This means:

- Visitors never need their own API key or account — the app just works.
- The API key is never present in any code the browser downloads, so it can't be scraped from the public site.
- The proxy applies basic abuse protection: a fixed allowed origin (this site only), a request-size cap, and a per-IP hourly rate limit.

## Privacy

- Your document's text is read locally in your browser and sent only to the proxy to generate slide content — never stored on any server.
- The proxy does not log or persist document content; it forwards the prompt to Claude and returns the structured result.

## Tech

- [mammoth.js](https://github.com/mwilliamson/mammoth.js) — extracts text from `.docx` in-browser.
- [PptxGenJS](https://gitbrent.github.io/PptxGenJS/) — builds the `.pptx` file in-browser.
- [Claude API](https://www.anthropic.com/api) (Haiku model) — structured tool-call output drives the slide content and revisions.
- [Cloudflare Workers](https://workers.cloudflare.com/) — free serverless proxy that keeps the API key private.

## Run locally

Just open `index.html` in a browser, or serve the folder with any static file server. It will call the deployed Cloudflare Worker proxy (see `PROXY_URL` in `app.js`).

## Limitations

- Uses a small/fast model tier by design (fast + cheap) — output quality is good for outlines but won't match a professional designer.
- Visuals are icons (from a curated emoji-style set) and colorful geometric accent shapes — no AI-generated illustrations or real photos, to keep the app free and key-free for visitors.
- `.docx` input only (not `.doc`, `.pdf`, or `.txt`) for now.
- Rate-limited to protect the shared API key from abuse — heavy use may hit the per-IP hourly cap.
