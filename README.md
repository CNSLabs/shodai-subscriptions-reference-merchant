# Shodai Subscription Reference Merchant

A thin merchant for wallet-paid access to one protected resource. Shodai owns Plans, subscription setup, Payments, renewal, and recovery. The merchant calls the public Subscriptions API, keeps wallet-keyed customer records and private notes in MongoDB, and decides resource access from confirmed paid periods.

## Interfaces

- `GET /subscriber-resource` serves paid customers or returns x402 offers and buyer authentication.
- `POST /subscriptions/agent-wallet/setup` verifies the buyer and forwards setup to Shodai.
- `GET /subscriptions/status` reads subscription facts and stored setup references.
- `/admin/customers` and `/admin/customers/:wallet` provide authenticated customer records and notes.
- `/dashboard` is the merchant operator UI.

The [MetaMask Agent Wallet subscription plugin](https://github.com/CNSLabs/shodai-subscriptions-agent-wallet-plugin/tree/subscriptions-service-wallet) authenticates, verifies deployed terms, installs the buyer's bounded payment permission, and cancels directly through the Agreement. The merchant needs a Shodai account API key with `subscriptions.read` and `subscriptions.write`.

## Install

Use Node.js 22.18 or newer and MongoDB. Build the matching SDK from its public source; this example uses client version `0.7.0` from the subscription service change:

```sh
git clone https://github.com/CNSLabs/agreements-api-sdk.git ../shodai-reference-sdk
git -C ../shodai-reference-sdk checkout 75d50f2f44c80258c12b011b03a4d40b9fdce24d
npm --prefix ../shodai-reference-sdk/packages/agreements-api-client install --ignore-scripts --no-package-lock
npm --prefix ../shodai-reference-sdk/packages/agreements-api-client run build
npm pack ../shodai-reference-sdk/packages/agreements-api-client --pack-destination /tmp --ignore-scripts
npm install --no-save --package-lock=false /tmp/shodai-network-agreements-api-client-0.7.0.tgz
```

The SDK source is pinned to the same commit used by this repository's CI.

## Configure and run

Copy `.env.example` to `.env` and configure:

| Variable | Value |
| --- | --- |
| `SHODAI_API_BASE_URL` | Origin of the Shodai API serving the Subscriptions API. |
| `SHODAI_API_KEY` | Merchant account credential with subscription read and write access. |
| `SUBSCRIPTION_PLAN_IDS` | Comma-separated registered Plan IDs applicable to the resource, including earlier Plans whose subscriptions still grant access. |
| `MONGODB_URI`, `MONGODB_DATABASE` | Merchant customer and notes database. |
| `PORT` | Local listening port; defaults to `8787`. |
| `PUBLIC_ORIGIN` | Externally reachable HTTPS origin, or the loopback HTTP origin for local development. |
| `OPERATOR_PASSWORD` | Dashboard password, at least 24 characters. The dashboard username is `operator`. |

Register the applicable Plans through Shodai before starting the merchant. The merchant loads their terms through the SDK. Keep your API key and operator password in the ignored `.env` file or supply the existing `SHODAI_API_KEY_FILE` and `OPERATOR_PASSWORD_FILE` options.

```sh
npm run build
npm test
npm start
```

The server listens on `127.0.0.1:8787` by default. Open `http://localhost:8787/dashboard` for customer records and notes. Give the buyer's agent the protected resource URL to discover subscription terms through the plugin.

## Adapt the example

Start with `src/app.ts` for request handlers and `src/merchant.ts` for SDK calls, Plan applicability, coverage selection, and status views. `src/store.ts` holds merchant-owned customer mapping and notes. The dashboard lives in `public/`.

Replace the example resource and customer mapping with your product. Keep Shodai credentials server-side. Shodai operates subscription deployment, collection, renewal, and recovery; this server contains no subscription worker, deployment store, signing key, or chain-read client.

## Tests

`npm test` exercises the merchant over HTTP using the real SDK against fixture API responses and an isolated MongoDB process. It covers buyer authentication, setup forwarding, paid access, closed-Plan continuation, pagination, payment outcomes, and notes-only dashboard editing. Tests require no live Shodai credential or buyer funds.
