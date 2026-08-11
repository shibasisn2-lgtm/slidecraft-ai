# SlideCraft AI — proxy

A tiny Cloudflare Worker that:
- Holds the Anthropic API key server-side and proxies deck-generation requests from the SlideCraft AI front-end.
- Verifies each request carries a valid Google Sign-In ID token (rejects anonymous requests with 401).
- Logs each request (who, when, action, model, token usage, status) to a private Google Sheet via a service account.

Included here for transparency and so the deployment can be reproduced.

**Deployed at:** `https://slidecraft-proxy.shibasisn2.workers.dev`

## Redeploy / update

```bash
npm install
npx wrangler login                                   # one-time browser auth

npx wrangler secret put ANTHROPIC_API_KEY             # Claude API key
npx wrangler secret put GOOGLE_CLIENT_ID              # OAuth Client ID from Google Cloud Console
npx wrangler secret put GOOGLE_SHEET_ID               # the master log Sheet's ID (from its URL)
npx wrangler secret put GOOGLE_SA_EMAIL               # service account email (Sheets logging)
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY         # service account private key (PEM)

npx wrangler deploy
```

`wrangler.toml` also configures a Workers KV namespace (`RATE_LIMIT_KV`) used for a simple per-user hourly rate limit — create your own with `npx wrangler kv namespace create RATE_LIMIT_KV` and update the `id` in `wrangler.toml` if you fork this.

### Setting up Google Sign-In + Sheets logging from scratch

1. **Google Cloud project**: `gcloud projects create <id>`, then `gcloud services enable sheets.googleapis.com`.
2. **Service account** (for Sheets writes): `gcloud iam service-accounts create <name>`, then `gcloud iam service-accounts keys create key.json --iam-account=<email>`. Use `private_key` and `client_email` from the JSON for the two `GOOGLE_SA_*` secrets above, then delete the local key file.
3. **OAuth consent screen + Client ID** (for Sign-In): in Google Cloud Console → "Google Auth Platform", configure the consent screen (External, basic email/profile scopes only — no verification needed), publish it to Production, then create an OAuth Client ID (Web application) with your site's origin under "Authorized JavaScript origins". This step has no CLI equivalent — it must be done in the Console UI.
4. **Master log Sheet**: create a new Google Sheet in your own Drive, share it with the service account's email as **Editor**, and keep it otherwise private. Copy its ID from the URL for `GOOGLE_SHEET_ID`.

No secrets are stored in this repo — everything above lives only in Cloudflare's encrypted secret store.
