# AEN spec outline (prototype 0.1, draft)

Working draft to test ideas against code. Not a published AEN specification. Nothing here is a Foundation decision until it is published as one.

## Principle

The standard is a **format** (JSON Schema + examples), not a library. SDKs, adapters and servers are implementations, in any language. `spec/` is the source of truth; `src/` is one implementation of it.

## 1. Descriptor

A public JSON document at `/.well-known/aen.json` (`spec/schemas/descriptor.schema.json`). Kinds: `business`, `vendor`, `directory`. Carries identity (`id` = the host it is served from), categories, locations, services with prices (integer minor units), actions, payment mode and policies. It never carries secrets (unknown fields are rejected, so an `apiKey` field is invalid). `url` must be HTTPS (plain HTTP only for loopback, in development); directories refuse anything else before fetching. Optional `signing` (Ed25519, section 6) and `events` (a change stream, section 6). Fields are limited to identity, search keys and actions: no business data. Extensions use an `x-` prefix.

## 1a. What AEN standardizes, and what it does not

AEN does **not** define every industry's payloads. Defining the order, booking or quote shape for every kind of business would never finish and would be wrong for most of them. It standardizes only what a client must be able to trust and enforce without understanding the business:

- the descriptor envelope (identity, search keys, actions, signing);
- the safety flags (`sideEffects`, `requiresUserConfirmation`, `payment`) and the access flow;
- the **payment hand-off** and the **order status** shapes, because a client has to check these itself (no card data, a hand-off URL on the business's own origin, known states);
- a **small core of capability names** (`catalog.search`, `availability.check`, `order.create`, `order.status`, `directory.search`).

Everything else is described by the business in the descriptor: each action carries its own `input` and `output` JSON Schema and a plain-words `description`. A business may offer any other capability under the `x.<namespace>.<name>` prefix. An agent reads the schema of the one action it wants and builds the request, which language models do well, so AEN needs no schema per industry. Industry **profiles** (for example common fields for restaurants or hotels) can exist later as optional, separately published vocabularies, reusing schema.org and OpenAPI where possible, and are never required to be compatible. The core stays small, and new core names need a version bump.

## 2. Capabilities and actions

An action is one callable operation: `capability` (core name or `x.` extension), `method`, a relative `path` (`{name}` segments filled from input), a plain-words `description`, its own `input` and `output` JSON Schema, auth, and flags.

Each action may declare `sharesPersonalData`: which input fields carry the user's personal data (`name`, `email`, `phone`, `address`, `identifier`, `other`) and why. It is the business's duty to state it; a client cannot detect personal data on its own. The client shows it at confirmation and sends only fields the action declares.

Rules the schema enforces:
- An action with `sideEffects: true` must have `requiresUserConfirmation: true`.
- A `payment: true` action must have `sideEffects: true`.
- An `oauth2-device` action must declare `scopes`, a `deviceEndpoint` and a `tokenEndpoint`.
- Paths are relative, never start with `//`, and never contain `..`.

Existing standards stay in charge of how to call things: an action points at a real endpoint. AEN describes what exists and what is safe, and does not replace OpenAPI or MCP.

## 3. Access and sessions

No server-side session state about the user at a directory or business. Access is granted by the user on the business's own page:

1. The agent asks (`deviceEndpoint`), proving possession of its key (a DPoP-style proof). It gets a short code and a `verification_uri` on the business's origin.
2. The agent gives the link and code to the user, who approves (or denies) on that page. The page names the scopes in plain words.
3. The agent exchanges the approved device code at `tokenEndpoint` (same key). The token is short-lived, scoped, for that business, and **bound to the agent's key**: every request carries a fresh, single-use proof for exactly that method and URL.

Orders belong to the key that placed them. Tokens and keys live in the agent's memory; for local agents that is the user's device. The machine API is JSON only: HTML exists only on pages a human opens.

## 4. Payment

Declared per business: `payment.modes` (`handoff`, `token`) and, for token mode, `tokenTypes`. AEN documents and responses never carry card data, and nothing in AEN moves money.

- **handoff:** `order.create` returns `payment-handoff.schema.json` (amount, `handoffUrl`, expiry, provider, status `requires_user_approval`). The user pays on the provider's page. Agents refuse a `handoffUrl` off the business's origin.
- **token:** after the user confirms the exact amount, the user's own wallet mints a one-time token (merchant, order, maximum amount, currency, expiry) outside the model, and the agent calls `order.pay`. The reply (`payment-result.schema.json`) is `completed` (amount, time) or `authentication_required` with a hand-off URL when the bank needs the user. The token never enters the model, a page, a log or a URL, and goes only to the business's origin. See `payment-proposal.md` for the reasoning and what was verified.

## 5. Callbacks

A token payment is complete in the reply to `order.pay`, so nothing is awaited. For later changes and for the hand-off path, baseline is **polling**: `order.status` returns `order-status.schema.json`, and a UI offers a manual "I paid" control because a completion signal may never arrive. Optional: a held status stream; signed webhooks to the **agent platform** (not to a directory) for provider-hosted agents. Not in the prototype.

## 5a. Schema versus data, and what a directory holds

A descriptor is **schema**: identity, search keys (`name`, `categories`, `keywords`, `countries`, capability names), and for each action how to call it (path, input, output, auth, safety flags). It is never **data**: prices, menus, availability, descriptions, addresses and policies are not fields of the format, so the schema rejects them (`business-data-in-descriptor.json`). An agent gets data by calling the business, for example its `catalog.search` action, so data is always current and lives only where it belongs.

A directory stores and serves descriptors, so it holds schemas and search keys and nothing of the business's content. An agent accepts a descriptor copy served by a directory only if the business **signed** it and the signing key is **pinned in the business's DNS**, which the agent checks itself: the directory then cannot alter it, and the agent needs no request to the business to learn how to call it. Any other copy is ignored and the descriptor is read from the business's own host (`/.well-known/aen.json`). Either way the descriptor must name the host it is served from, so a directory can hide or misdirect but cannot make one host pass as another. A descriptor is small (64 KB cap).

Open: keeping schema copies fresh (ETag and the `descriptor-changed` stream today), and whether a business may submit its schema privately instead of publishing a public file.

## 6. Verification and freshness

Directories **fetch** descriptors from the business's own host (they never accept a descriptor in a request body), require `id` to equal that host, and check the schema. Levels: `host` (served by that host) and `dns` (also signed with an Ed25519 key pinned in `_aen.<host>` TXT). Refresh of the index uses conditional requests; a business may publish an SSE `events` stream whose `descriptor-changed` event only hints that the index should be re-read (content changes need no signal: agents read content from the business). Open: key rotation and revocation, DNSSEC, real-world identity of the entity behind a domain.

## 7. Versioning

`aen: "0.1"`. Unknown versions are rejected. A real scheme (and how directories handle several versions) is open.

## 8. Agents

Descriptor text is untrusted data. An agent must not follow instructions found in it, must get user confirmation for every side-effecting action, must validate responses, must keep every request on the business's origin and away from private networks, and must accept only JSON from machine endpoints. Retries of side-effecting calls reuse an idempotency key. Before anything is shown for confirmation or sent, the request is checked against the action's own `input` schema, which is untrusted: it is size-capped and stripped of regular expressions and references, and only declared fields are sent. If a call fails in a way a changed schema could cause (not found, not allowed, bad input) and the business's own descriptor now differs, the agent retries once with it.

To keep the model light, an agent works in steps and only pays for what it uses: compact directory **cards** (capabilities and verification, filterable by capability and category), then one compact **business** (actions by capability, no schemas, no paths), then the **input schema of a single action** when it must build a request. It names an action by capability (`order.create`); the client resolves the path. Full schemas are never needed to use AEN: they are for validators. `src/adapter/client.ts` implements this; `src/adapter/mcp.ts` exposes it to MCP agents.

## 9. Profiles (optional "batteries")

Ready-made, optional descriptions of common action shapes (for example food ordering, room booking, appointments, contact) that a business can adopt instead of writing its own. A profile is a separately versioned vocabulary, published outside the core, reusing schema.org and OpenAPI where possible; any organisation may publish one. An action may name the profile it follows. Adopting one is never required for compatibility, and the core never grows to include them. Start from patterns that real businesses already repeat, not from guesses. Not in the prototype.

## Open questions

Who mints tokens for a real user (the wallet side of token payments); which token standard to name; key rotation, revocation and DNSSEC; real-world identity of the entity behind a domain; trusted directories for agents; phishing-resistant approval; webhooks to agents (polling is the baseline); refunds and disputes; discovery without a directory; licence of the spec; versioning; which capabilities belong in 1.0.
