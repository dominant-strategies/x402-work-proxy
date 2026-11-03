# Testing the proxy

The local branch `test/proxy-design` contains 68 tests for the Worker's access rules, facilitator adapter, and forwarding behavior. It builds on Alan's original 16 tests. Facilitator and origin responses are mocked, so the suite runs without a deployed Worker, mining node, or payout address holding funds.

## Running the checks

The suite was validated with Bun 1.4.4. Install the locked dependencies, run the tests, and check TypeScript:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

With Bun available on your path, the existing `npm test` and `npm run typecheck` scripts also work. If Bun is not installed globally, use `npx --yes bun@1.4.4` in place of `bun` in the commands above.

For a coverage report:

```sh
bun test --coverage
```

Use a current Bun runtime. Bun 1.2.13 reports `Request.redirect` differently from Bun 1.4.4 and causes the forwarding redirect test to fail.

## Tests mapped to the design

| Design behavior | Automated checks | Test file |
| --- | --- | --- |
| Route protection | Exact and prefix matching, public routes, protection without user patterns, public health under `*`, and the paid demo | [Worker tests](../test/proxy.test.ts) |
| Payment flow | Unpaid `402`, resource binding without query parameters, accepted work before forwarding, receipts, rejected proofs, and fresh challenge terms | [Worker tests](../test/proxy.test.ts), [seller tests](../test/seller.test.ts) |
| Temporary access | Access across protected routes, no facilitator call with valid access, invalid and expired cookies, host and signing-secret checks, exact expiry, and immediate rejection when access duration is zero | [Worker tests](../test/proxy.test.ts) |
| Upstream forwarding | Query, POST body and method, payment-header stripping, unrelated cookies, manual redirects, and direct loop detection | [Worker tests](../test/proxy.test.ts) |
| Facilitator failures | `429` and `503`, missing and invalid retry delays, valid header precedence, malformed JSON or envelopes, strict boolean settlement outcomes, and missing payment headers | [Seller tests](../test/seller.test.ts), [Worker tests](../test/proxy.test.ts) |
| Ambiguous settlement | A transport failure returns `503`, does not reach the origin, and reports that the settlement outcome is unknown | [Seller tests](../test/seller.test.ts), [Worker tests](../test/proxy.test.ts) |
| Delivery after settlement | Origin HTTP errors preserve the receipt and cookie; origin transport errors propagate without another payment call | [Worker tests](../test/proxy.test.ts) |

## Regression fixes

New tests reproduce these defects in Alan's original implementation:

1. Setting `ACCESS_SECONDS=0` still allowed an existing cookie to bypass payment.
2. Missing `Retry-After` became zero and prevented JSON or default retry delays from being used. Invalid JSON delays were also accepted.
3. Malformed facilitator responses could cause exceptions, produce incomplete challenges, or grant access for a string `"true"` rather than a boolean `true`.
4. A lost settlement response incorrectly claimed that nothing was charged.

The fixes align those behaviors with the access contract and explicit error handling. Envelope validation checks the fields this adapter consumes; it is not a complete x402 protocol validator or a mining verifier.

## Integration checks and open decisions

Mocked tests cannot establish that the live facilitator correctly binds proofs to resources, prevents replay, enforces profile and price, or submits valid mining work. Those require tests against a controlled facilitator and real client. A Cloudflare runtime check should also exercise streaming requests, cookies, and redirects in deployment.

Origin access restrictions, caching policy, per-route pricing or quotas, and recovery after settled work fails to deliver content remain design decisions. The origin-failure tests record the current settlement-before-delivery behavior; they do not provide refunds, durable receipts, or proof reuse. See the [design review](proxy-design-review.md) for the full questions.
