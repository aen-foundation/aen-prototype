# AEN prototype

A **prototype** of the Agent Exchange Network (AEN) protocol: JSON Schemas for the format, a TypeScript reference implementation, and a draft threat model. It exists to test the design and find holes. It is **not a published specification**, not production software, and must not be deployed.

AEN is an open-engineering project, initiated by Nibub LLC, so that AI agents, businesses and digital services can discover and interact with one another. The intention is for a non-profit, the AEN Foundation, to become its home; it has not been established yet. See [aen.foundation](https://aen.foundation).

## What is here

| Path | What |
|---|---|
| `spec/` | The JSON Schemas and valid/invalid example documents (the conformance set) |
| `src/` | Reference code: validator, sample business, directory, agent client (also an MCP server), Gemini chat UI, test-only wallet |
| `test/` | Conformance, security ("attack") tests, end-to-end flows |
| `docs/` | `spec-outline.md`, `threat-model.md`, `payment-proposal.md` |

## Try it

Requires Node 22 or newer and pnpm.

```sh
pnpm install
pnpm test      # the full suite
pnpm demo      # search, user approval, order, payment, status, with a scripted agent
pnpm ui        # chat page with Gemini as the agent (needs GEMINI_API_KEY in .env, see .env.example)
```

## Get involved

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md). How decisions are made: [GOVERNANCE.md](GOVERNANCE.md).

## Licence

[Apache License 2.0](LICENSE). Names and logos are not covered by that licence: see [TRADEMARKS.md](TRADEMARKS.md).
