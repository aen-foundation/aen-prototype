# Proposal: how AEN takes payment (draft, prototype 0.1)

A proposal to test in the prototype, not a Foundation decision. It is based on what the existing agent-commerce and tool protocols say, checked against their primary pages where reachable (see "What was verified").

## The problem

Today AEN hands the user off to the business's payment page, then has to find out that they paid. That is two extra steps (the page, and the waiting). Existing protocols avoid most of it.

## What the existing protocols do (verified)

**Agentic Commerce Protocol (ACP), checkout reference** (`agenticcommerce.dev/docs/reference/checkout`, `.../concepts/lifecycle`)
- The agent finishes with `POST /checkout_sessions/{id}/complete` carrying `payment_data`; for Stripe the credential is a Shared Payment Token (`credential.type: "spt"`).
- The reply is `CheckoutSessionWithOrder`: it must contain an `order`; success is a 200, status `completed`, with the order. So "paid" is in the same response, nothing to wait for.
- Failure: 402 payment failed, or 422 with message codes such as `payment_declined` and `requires_3ds`. A session can return to `ready_for_payment`.
- Extra bank approval: status `authentication_required` with `authentication_metadata`; the agent reports `authentication_result` with an `outcome` (`authenticated`, `denied`, `abandoned`, ...).
- Webhook headers `Signature` (HMAC) and `Timestamp` are listed. The page does not give event names or signing details.
- The page states **no rule requiring the buyer's confirmation** before `complete`; it only has approval-workflow statuses.

**ACP, delegated payment** (`agenticcommerce.dev/docs/reference/payments`)
- `POST /agentic_commerce/delegate_payment` creates a vault token (`vt_...`) with an `allowance`: `reason` (only `one_time`), `max_amount` (minor units), `currency`, `checkout_session_id`, `merchant_id`, `expires_at`.
- Not stated on the page: strict single-use enforcement, user consent capture, how scoping is enforced at redemption. In this spec the request carries card details (`payment_method`), so the caller handles card data. **AEN should not copy that part**: in AEN the token comes from the user's own wallet and the agent never sees card data.

**MCP, URL mode elicitation** (`modelcontextprotocol.io/specification/2025-11-25/client/elicitation`)
- Payments are named as a use of URL mode: sensitive data must not pass through the client or the model.
- Accepting only means consent to open the URL, not completion. The server **MAY** send `notifications/elicitation/complete` (same `elicitationId`, only to the client that started it). Clients **SHOULD** offer manual controls if it never arrives.
- Client rules: show the full URL, get consent before opening, never pre-fetch it. Server rules: no sensitive data in the URL, no pre-authenticated URLs, HTTPS, and verify that the person who opens the link is the one who started it (phishing).

## What was not verified

- **AP2** (Google): only secondary articles were read. Its own pages were not reachable at the addresses tried. Nothing in this proposal depends on AP2 details; read its spec before borrowing anything (signed mandates are the idea to check).
- ACP webhook event names, and whether Stripe's token is strictly single-use and merchant-bound (the secondary sources say yes; the ACP page does not).
- These specs are young and change. Re-read them before the Foundation publishes anything.

## Proposal

**1. Two payment modes, declared by the business** (`payment.modes` in its descriptor): `handoff` (exists) and `token` (new, optional), with `tokenTypes` naming the provider's token format (the prototype uses `test.token`). AEN does not define token formats and never reads them.

**2. Token mode in two steps**
1. `order.create` returns the amount and a hand-off page, as now.
2. The user sees a card with the exact amount and business and presses **Pay**. The user's own wallet mints a one-time token for exactly that (merchant, order, maximum amount, currency, expiry), outside the model. The agent calls `order.pay` with the token. The reply (`payment-result.schema.json`) says `completed` with the amount and time, so there is nothing to wait for.

**3. Fallback: `authentication_required`.** If the bank needs the user, the same reply carries a hand-off URL on the business's origin (like ACP's `authentication_required`); the user pays there. The "I paid on the page" button and a status check remain the fallback, as MCP recommends manual controls.

**4. Rules AEN would require**
- The token is created only after the user's confirmation of the exact amount and business, and is limited to that order, merchant, amount, currency and a short expiry, once.
- The token never enters the model's context, the browser page, logs or any URL; it is sent only to the business's own origin, in the `order.pay` body.
- A business must refuse reuse, a different order or merchant, a larger amount, an expired token, and a forged one; a token presented to the wrong party is spent.
- A business must not mark an order paid because the client says so: only its own processor's result counts.
- Idempotency keys apply to `order.pay`.

**5. Later changes** (shipped, refunded): the business sends signed webhooks to the **agent platform** (as in ACP) for provider-hosted agents; agents on a user's device use status checks or a held stream. Never through a directory. Event shapes to be defined.

**6. Out of scope for AEN:** issuing tokens, the wallet, the payment processor, card data, refunds and disputes. AEN carries an opaque string to the business and checks the shape of the reply.

## What the prototype does

`src/payments/test-wallet.ts` (test-only wallet and processor, ACP-style allowance fields), `order.pay` on the sample cafe, `payment-result.schema.json`, client validation (reply shape, hand-off URL on the business origin), UI "Pay with test wallet" button. Tests cover: one-call payment; reuse, wrong order, over-allowance, wrong merchant, expiry, forgery, and paying someone else's order; the bank-approval fallback; a business that lies about completion; the model never seeing a token (`test/token-payment.test.ts`, `test/ui-wallet.test.ts`).

## Open questions

- **Who mints tokens for a real user?** The prototype fakes the wallet. In ACP the agent platform holds the payment method and calls the provider; AEN's goal (the agent never handles card data) needs a user-side wallet or a provider that issues tokens to the user's device. This is the hardest part and needs real provider research.
- Which token standard(s) to name, and whether tokens bind to the order or only to merchant and amount.
- Webhook signing and event names; refunds and disputes; tax and shipping in the order; and who is liable when a manipulated agent orders something the user confirmed in words but not in substance.
