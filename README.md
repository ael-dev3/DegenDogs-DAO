# Degen Dogs DAO Farcaster Mini App

This repo hosts the Degen Dogs DAO Mini App for Farcaster. It authenticates
users, connects their wallet, and verifies Degen Dogs ownership on Base
mainnet to gate DAO voting and initiative submissions to holders.

## What it does

- Signs in with Farcaster Quick Auth and verifies the JWT via `/api/verify`.
- Connects the Farcaster wallet provider and switches to Base if needed.
- Calls `balanceOf` on the Degen Dogs ERC-721 contract to confirm ownership.
- Provides the foundation for holder-only votes and initiative proposals.

## Structure

- `public/` static Mini App UI (compiled JS + CSS)
- `src/client/` TypeScript source for the Mini App frontend
- `deno/` Deno Deploy verifier for `/api/verify`

## Stack

- Frontend: HTML + TypeScript (Farcaster Mini App SDK)
- Backend: Deno Deploy Quick Auth verifier (optional Neynar enrichment)
- Hosting: Firebase Hosting for the UI, Deno Deploy for `/api/verify`

## Run locally

1. `npm install`
2. `npm run build`
3. `APP_DOMAIN=your.domain deno run -A deno/verify.ts`
   - Use a comma-separated list to allow multiple domains, e.g. `APP_DOMAIN=degendogs-dao.web.app,degendogs-dao.firebaseapp.com`.

If the API is hosted on a different origin, set `data-api-origin` in
`public/index.html` to that origin.

Optional: set `NEYNAR_API_KEY` (and `NEYNAR_API_BASE` if needed) to enrich the
auth response with Farcaster profile data and verified addresses.

## Deno Deploy verifier

Use Deno Deploy to host the `/api/verify` endpoint without Firebase billing.

1. Create a new Deno Deploy project and set the entrypoint to `deno/verify.ts`.
2. Add environment variables:
   - `APP_DOMAIN=degendogs-dao.web.app` (comma-separated list to allow `firebaseapp.com` too)
   - `NEYNAR_API_KEY=...` (optional)
3. Set `data-api-origin` in `public/index.html` to the Deno Deploy URL.

## Deno Deploy build settings

- App directory: `deno` (recommended; avoids `package.json` auto-node_modules)
- Entrypoint: `verify.ts`
- Install command: leave empty
- Build command: `true` (or `echo "skip build"`)
  - If the dependency cache step still complains about `node_modules`, use `deno cache --node-modules-dir=false verify.ts`

If you still see `@farcaster/quick-auth` or `typescript@5.9.3` in build logs, the app is building an older commit. Redeploy the default branch to pick up the latest changes.
