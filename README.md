# x402 Work Proxy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dominant-strategies/x402-work-proxy)

A Cloudflare Worker that sits in front of any site or API and charges the routes you choose in
**proof of work** instead of money.

- **Buyers** (agents, crawlers, scripts) need no account, card or wallet. They answer HTTP 402 by
  solving a small mining job.
- **You** need only a QUAI address. The hosted facilitator at [x402.qu.ai](https://x402.qu.ai)
  issues each job for your address and settles each answer once. You run no node, verifier or
  database.

It works like Cloudflare's [x402 Payment-Gated Proxy](https://github.com/cloudflare/templates/tree/main/x402-proxy-template),
with the x402 v2 `work` scheme in place of USDC.

```
client ──▶ Worker ──▶ protected route? ──no──▶ your origin
                         │yes
                         ├─ valid access cookie? ──yes──▶ your origin
                         ├─ PAYMENT-SIGNATURE? ── settle at x402.qu.ai ──▶ your origin + receipt + cookie
                         └─ otherwise: 402 with a work job in PAYMENT-REQUIRED
```

## What it's for

- **Charging agents and crawlers for an API or content**, with nothing for them to sign up for.
- **Turning bot defence into income.** Proof-of-work walls against scrapers normally throw the
  work away. Here every answer is a share of a real mining job, and answers that meet the
  network's difficulty become block rewards paid to your address.
- **Pricing a free tier in work instead of rate limits.** Abuse gets expensive, and honest users
  pay in a fraction of a second.

What you earn is probabilistic: you're paid when an answer is good enough for the network. Over
many requests the expected value matches the price, but a small site sees lumpy payouts. Treat
the proxy mainly as access control that pays.

## Set up

1. Click **Deploy to Cloudflare** (or clone the repo and run `npm install`).
2. In `wrangler.jsonc`, set:

   | Variable | Default | Meaning |
   | --- | --- | --- |
   | `PAY_TO` | placeholder; must be set | Your Cyprus-1 QUAI address (`0x00…`), where rewards go |
   | `PRICE` | `4096` | Expected guesses per access. A CPU makes millions of SHA-256d guesses a second, so 4,096 takes milliseconds |
   | `PROFILE` | `quai/sha256d-v1` | Or `monero/randomx-v1`, with a Monero `PAY_TO` |
   | `PROTECTED_PATTERNS` | none | Comma-separated: `/premium/*` (a prefix), `/report` (exact), `*` (everything) |
   | `ORIGIN_URL` | none | Your site or API, e.g. `https://api.example.com` |
   | `ACCESS_SECONDS` | `3600` | How long one payment grants access. `0` charges every request |

3. Set a secret to sign access cookies. Without it, every request pays.

   ```sh
   npx wrangler secret put JWT_SECRET   # 32+ random characters
   ```

4. Deploy and check the setup:

   ```sh
   npx wrangler deploy
   curl https://<your-worker>/__x402/health
   ```

`/__x402/protected` is always protected and serves a demo response, so you can try a payment
before setting `ORIGIN_URL`.

## Paying it

With the Node client (no account or wallet):

```sh
npm install https://x402.qu.ai/x402-work-client-0.4.0.tgz
npx x402-work pay https://<your-worker>/__x402/protected
```

```js
import { payWithWork } from 'x402-work-client';
const { response, payment } = await payWithWork('https://<your-worker>/premium/report');
// response.headers.get('set-cookie') grants access for ACCESS_SECONDS
```

A browser gets a short page explaining the payment, with a 402 status and the job still in the
`PAYMENT-REQUIRED` header. Solving in the browser is not built yet.

## Behaviour

- **Jobs are bound to the route** (origin and path, not the query string), so one price covers a
  route.
- **The proxy strips its own headers before forwarding.** The payment header and the access
  cookie never reach your origin, and other cookies pass through.
- **The cookie is HMAC-signed**, bound to the Worker's host, and `HttpOnly; Secure;
  SameSite=Lax`. No state is stored.
- **A rejected or replayed proof** gets a fresh 402 that says why.
- **If the facilitator is unreachable** or has no live work source, the proxy answers 503 with
  `Retry-After`. Nothing is charged, and nothing reaches your origin.
- **A placeholder or malformed `PAY_TO`** is refused, and `/__x402/health` reports it.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit JWT_SECRET
npx wrangler dev --var "PAY_TO:0x00…your address"
npm test                          # bun test: routing, payment and cookie cases
npm run typecheck
```

`src/seller.ts` is the seller half of [x402-work-client](https://x402.qu.ai/docs/sell) 0.4.0,
ported to TypeScript. It uses only `fetch`, so it runs on Workers without Node APIs.

MIT licensed.
