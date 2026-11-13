# AGENTS.md (AEN prototype)

Read `../AGENTS.md` first (the AEN master and its rules). This folder is a throwaway-quality prototype of the AEN protocol, written to test the design and find holes. It is not the standard, not the Foundation's published work, and not a product of AEN Directory.

## What it is

A format first, code second. `spec/` (JSON Schemas + valid/invalid example documents) is the standard being proposed; `src/` is one TypeScript implementation: validator, sample business (user-approved access, key-bound tokens, payment hand-off, signed descriptor, live change stream), reference directory (holds the signed schema and search keys, never data; fetches and verifies; SSRF-safe), and an agent-side client exposed as an MCP server. Design notes: `docs/spec-outline.md`, `docs/threat-model.md`.

## Layout

```
spec/schemas/              descriptor, payment-handoff, order-status (JSON Schema 2020-12)
spec/examples/valid|invalid/   conformance documents any implementation must agree with
src/validate.ts            library + CLI over the schemas
src/crypto.ts              DPoP-style proofs, Ed25519 descriptor signing, canonical JSON
src/safe-fetch.ts          fetch that refuses private addresses (also at connect time)
src/business/cafe.ts       sample business (device-flow consent, orders, idempotency, test-mode pay page, SSE)
src/directory/server.ts    holds descriptors (schema + search keys), never data: register (fetch, validate, host + DNS check), live watch, cards, serves the schema
src/adapter/client.ts      all agent-side rules; mcp.ts exposes them as MCP tools over stdio (4 tools)
src/demo.ts                scripted end-to-end run (no LLM)
src/payments/test-wallet.ts  TEST-ONLY wallet (user side) and processor (business side) for token payments
src/ui/                    chat UI with Gemini as the agent: server.ts, agent.ts (loop + the confirmation gate), index.html
test/                      conformance, crypto, e2e + guards (attacks), custom capability, token payments, MCP over stdio, UI wallet, Gemini UI against a scripted fake (a live test runs only when GEMINI_API_KEY is set)
docs/                      spec outline, threat model, payment proposal
LICENSE NOTICE DCO         Apache-2.0 (verbatim), notice, Developer Certificate of Origin
README CONTRIBUTING CODE_OF_CONDUCT SECURITY GOVERNANCE TRADEMARKS   open-source files (public-facing; keep them true)
.github/                   CI (type-check, tests, demo, DCO check on PRs), issue and PR templates
```

## Commands

- Done means: `pnpm check` (tsc) and `pnpm test` pass, and `pnpm demo` ends with `order.status -> ready`.
- `pnpm ui` (http://127.0.0.1:4200; starts a sample directory + cafe; needs `GEMINI_API_KEY` in a git-ignored `.env`, see `.env.example`; `GEMINI_MODEL` optional, default `gemini-3.8-flash`; Google retires models, so a 404 "no longer available" means pick a current one from https://aistudio.google.com/docs/models). Never print, log, commit or send the key anywhere but Gemini.
- `pnpm validate <file.json> [kind]`, `pnpm cafe`, `pnpm directory` (`ALLOW_PRIVATE=1` to register localhost), `pnpm mcp` (set `AEN_DIRECTORY_URL`; `AEN_ALLOW_PRIVATE=1` only for local demos).

## Workflow

The repo is **public** and `main` is **protected**: changes land only through a pull request whose "Type-check and test" check passes on an up-to-date branch. No direct pushes (enforced for admins too), no force-push, no deleting `main`, linear history (squash or rebase merge). Do not disable the protection to get something in.

- Branch per change (`fix/...`, `feat/...`, `docs/...`, `spec/...`), small focused commits, then `pnpm check && pnpm test`, `git push -u origin <branch>`, `gh pr create`, merge when green, delete the branch. If the branch is behind: `git fetch && git rebase origin/main && git push --force-with-lease` (only ever on your own branch).
- Commits are signed off with `git commit -s` (DCO, checked on PRs). A sign-off is the contributor's own statement: agents do not add `Signed-off-by` for a person unless the owner has said they may.
- Everything committed is public and permanent. Before committing read `git diff --cached`: no keys, tokens, `.env`, personal data, private emails or local paths. The repo-local git email is the GitHub no-reply address; keep it, and never put a personal email in a commit or a file.
- History starts at a single "Initial commit". Never rewrite or force-push `main`.

## Rules

- The schemas are the source of truth. Change a rule in `spec/` first, add a valid or invalid example for it, then change code. Never encode a rule only in TypeScript.
- Money is integer minor units. A descriptor or response never contains secrets or card data. AEN never moves money. Payment is either a hand-off to the provider's page, or a one-time token minted by the user's wallet after the user confirmed the exact amount (`order.pay`). The token must never enter the model's context, the browser page, logs or a URL, and is sent only to the business origin. In the UI the wallet is used only when the user presses Pay, with the amount the business stated. Test mode only: the wallet and processor are fakes and there are no real payment keys in this repo.
- The agent client stays strict: validate every descriptor and response, keep every URL on the business origin, require `userConfirmed` for side effects, treat descriptor text as untrusted. Do not loosen this to make a demo pass.
- Fixes for found holes get a test in `test/` that fails without the fix.
- Known gaps are listed in `docs/threat-model.md` (open: key rotation and revocation, trusted directories, phishing-resistant approval). Update that table in the same change that fixes or adds a gap. Keep `docs/spec-outline.md` in step with `spec/`.
- AEN standardizes the envelope, safety flags, payment hand-off, order status and a small core of capability names; it does not define industry payloads. Actions describe their own `input`/`output`; other capabilities use `x.<namespace>.<name>`. Do not add per-industry schemas to the core.
- In the UI the model must never be able to confirm a side effect: only the user's click releases it (`approvals` in `src/ui/agent.ts`). Do not add a model-controlled confirmation parameter.
- A directory holds the descriptor (schema + search keys) and never business data. The descriptor schema rejects `description`, `services`, `locations`, `policies` and prices; do not add business-data fields to it, and do not store anything else about a business in the directory. Data comes from calling the business (`catalog.search` for what it sells). A test fails if this is broken.
- The machine API is JSON only. HTML is allowed only on pages a human opens (approval, payment). The client and directory refuse non-JSON machine responses; keep it that way.
- Prototype only: in-memory state, no persistence, open (rate-limited) register endpoint. Do not deploy it.
- Keep `docs/payment-proposal.md` honest: what was verified against primary sources, and what was not.
- Legal status: the AEN Foundation is **not registered**; only Nibub LLC exists. Never describe the Foundation as an existing legal entity, a registered non-profit, or the owner of the copyright, names or marks in files, docs or code (use "the AEN project, initiated by Nibub LLC"; the Foundation is "planned").
- Open source: the project is licensed Apache-2.0 (copyright "Nibub LLC and the AEN contributors", chosen by the owner; a lawyer should confirm who owns the work), contributions come in under the same licence with a DCO sign-off (`git commit -s`), and names/logos are not licensed (`TRADEMARKS.md`). Do not add a dependency whose licence is incompatible with Apache-2.0 (check `pnpm licenses list`; production dependencies are MIT/BSD/ISC today). Do not change `LICENSE` (canonical text). Do not sign off commits on a person's behalf. `GOVERNANCE.md` is a placeholder until a foundation exists and publishes its own; do not invent bodies, members or policies in these files. Keep `SECURITY.md` contacts, the threat model and `CONTRIBUTING.md` in step with reality.
- Requests are checked against the action's own `input` schema (untrusted: stripped and capped), only declared fields are sent, and `sharesPersonalData` is shown at confirmation. URLs must be HTTPS (loopback excepted). Do not weaken these.
- pnpm 12 blocks install scripts: `allowBuilds` in `pnpm-workspace.yaml` approves `esbuild`. Approve nothing else without a reason.
- Do not present anything here as an AEN or Foundation specification until the Foundation publishes it.
