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

## Run locally

1. `npm install`
2. `npm run build`
3. `APP_DOMAIN=your.domain npm start`

If the API is hosted on a different origin, set `data-api-origin` in
`public/index.html` to that origin.
