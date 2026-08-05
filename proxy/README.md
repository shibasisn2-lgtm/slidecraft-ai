# SlideCraft AI — proxy

A tiny Cloudflare Worker that holds the Anthropic API key server-side and proxies deck-generation requests from the SlideCraft AI front-end. Included here for transparency and so the deployment can be reproduced.

**Deployed at:** `https://slidecraft-proxy.shibasisn2.workers.dev`

## Redeploy / update

```bash
npm install
npx wrangler login                      # one-time browser auth
npx wrangler secret put ANTHROPIC_API_KEY   # paste your Claude API key when prompted
npx wrangler deploy
```

`wrangler.toml` also configures a Workers KV namespace (`RATE_LIMIT_KV`) used for a simple per-IP hourly rate limit — create your own with `npx wrangler kv namespace create RATE_LIMIT_KV` and update the `id` in `wrangler.toml` if you fork this.

No secrets are stored in this repo — `ANTHROPIC_API_KEY` lives only in Cloudflare's encrypted secret store.
