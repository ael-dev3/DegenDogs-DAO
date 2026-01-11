# Degen Dogs DAO Farcaster Mini App

This repo hosts the Degen Dogs DAO Mini App for Farcaster. It authenticates
users, checks verified addresses, and connects their wallet (when available) to verify Degen Dogs ownership on Base
mainnet to gate DAO voting and initiative submissions to holders.

## What it does

- Signs in with Farcaster Quick Auth and verifies the JWT via `/api/verify`.
- Checks Farcaster-verified addresses via Base RPC to confirm ownership.
- Automatically connects the Farcaster wallet provider (when available) to check the connected wallet.
- Provides the foundation for holder-only votes and initiative proposals.

## Structure

- `public/` static Mini App UI (compiled JS + CSS)
- `src/client/` TypeScript source for the Mini App frontend
- `deno/` Deno Deploy verifier for `/api/verify`

## Stack

- Frontend: HTML + TypeScript (Farcaster Mini App SDK)
- Backend: Deno Deploy Quick Auth verifier (optional Neynar enrichment)
- Hosting: Firebase Hosting for the UI, Deno Deploy for `/api/verify`

## Build + deploy (no local hosting)

1. `npm install`
2. `npm run build`
3. `firebase deploy --only hosting`

The app is hosted on Firebase Hosting, and the `/api/verify` endpoint is hosted
on Deno Deploy. No local hosting is required.

Optional: set `NEYNAR_API_KEY` (and `NEYNAR_API_BASE` if needed) to enrich the  
auth response with Farcaster profile data and verified addresses.

## Firestore setup (posts + votes)

The Mini App can store posts and votes in Firestore. Add your Firebase web      
config to `public/index.html`:

- `data-firebase-api-key`
- `data-firebase-auth-domain`
- `data-firebase-project-id`
- `data-firebase-app-id`
- Optional: `data-firebase-messaging-sender-id`, `data-firebase-storage-bucket`

Enable Anonymous Authentication in Firebase (Authentication -> Sign-in method),
because posts/votes require an authenticated Firebase user.

If the app is hosted on Firebase Hosting, it will also try to load config from
`/__/firebase/init.json`, so you can leave the data attributes empty.

To apply the Firestore rules in `firestore.rules`, run:

`firebase deploy --only firestore`

The Spark plan should be enough for a small community.

Note: the rules allow reads for everyone and restrict writes to authenticated
users. Tighten further if you add a backend or stronger identity checks.       

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
