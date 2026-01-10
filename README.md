# Degen Dogs DAO Farcaster Mini App

This repo hosts the Degen Dogs DAO Mini App for Farcaster. It authenticates
users, connects their wallet, and verifies Degen Dogs ownership on Base
mainnet to gate DAO voting and initiative submissions to holders.

## What it does

- Signs in with Farcaster Quick Auth and verifies the JWT on a small Node server.
- Connects the Farcaster wallet provider and switches to Base if needed.
- Calls `balanceOf` on the Degen Dogs ERC-721 contract to confirm ownership.
- Provides the foundation for holder-only votes and initiative proposals.

## Structure

- `public/` static Mini App UI (compiled JS + CSS)
- `src/client/` TypeScript source for the Mini App frontend
- `src/server/` TypeScript Node server for `/api/verify`
- `functions/` Firebase Functions verifier for production hosting

## Stack

- Frontend: HTML + TypeScript (Farcaster Mini App SDK)
- Backend: Node Quick Auth verifier (optional Neynar enrichment)
- Hosting: Firebase Hosting for the UI, Deno Deploy or Firebase Functions for `/api/verify`

## Run locally

1. `npm install`
2. `npm run build`
3. `APP_DOMAIN=your.domain npm start`

If the API is hosted on a different origin, set `data-api-origin` in
`public/index.html` to that origin.

Optional: set `NEYNAR_API_KEY` (and `NEYNAR_API_BASE` if needed) to enrich the
auth response with Farcaster profile data and verified addresses.

## Deno Deploy verifier

Use Deno Deploy to host the `/api/verify` endpoint without Firebase billing.

1. Create a new Deno Deploy project and set the entrypoint to `deno/verify.ts`.
2. Add environment variables:
   - `APP_DOMAIN=degendogs-dao.web.app`
   - `NEYNAR_API_KEY=...` (optional)
3. Set `data-api-origin` in `public/index.html` to the Deno Deploy URL.

## Firebase Functions verifier

Deploy the verifier so `/api/verify` works from Hosting:

1. `firebase functions:secrets:set NEYNAR_API_KEY`
2. `firebase deploy --only functions`

Then deploy Hosting with `firebase deploy --only hosting` (or run `firebase deploy`
to ship both).
