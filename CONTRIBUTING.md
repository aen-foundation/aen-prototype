# Contributing

Thanks for helping. This repository is a **prototype** for testing the AEN protocol design. The most useful contributions find holes: a way to break a rule, a missing test, a schema that is too loose or too tight, or something the threat model does not cover.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. To report a security problem privately, see [SECURITY.md](SECURITY.md).

## Ways to contribute

- **Open an issue** to report a bug, ask a question, or propose a change. For a change to the protocol itself, use the *Spec proposal* template: say what problem it solves, what the alternatives are, and what it costs.
- **Send a pull request** for a fix, a test, a conformance example, or documentation.
- **Review**: reading a proposal and saying what is wrong with it helps as much as writing code.

## Licence and sign-off

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the same as the project, including its patent grant (section 3).

We use the [Developer Certificate of Origin](DCO) instead of a contributor agreement. Sign off each commit to say you have the right to submit it:

```sh
git commit -s -m "Describe the change"
```

This adds a line `Signed-off-by: Your Name <you@example.org>` using your real name. Pull requests with unsigned commits fail the check. You keep the copyright in your contribution. (The AEN Foundation does not exist yet, so there is no foundation to assign anything to; if that changes, it will be announced and nothing will be assigned without your agreement.)

You are responsible for what you submit, including anything produced with AI tools: make sure you understand it, that it is yours to contribute, and that it does not copy code under an incompatible licence.

## How the project works

- **The schemas are the standard.** For a protocol change: edit `spec/schemas/`, add a valid or invalid example in `spec/examples/` for the rule, then change the code. A rule must never live only in TypeScript.
- **Every found hole gets a test** that fails without the fix, and `docs/threat-model.md` is updated in the same change.
- **AEN's core stays small.** Do not add per-industry schemas or business data to the core format. See `docs/spec-outline.md` (section "What AEN standardizes, and what it does not").
- **Safety rules are not for loosening** to make something convenient: user confirmation, JSON-only machine responses, same-origin URLs, no card data, no secrets in descriptors.

## Setting up

You need Node 22 or newer and pnpm.

```sh
pnpm install
pnpm check     # type-check
pnpm test      # the full test suite
pnpm demo      # a scripted end-to-end run, ends with: order.status -> ready
```

`pnpm ui` runs a chat page with Gemini as the agent. It needs your own key in a git-ignored `.env` (see `.env.example`). Never commit a key, and never paste one into an issue.

## Style

Tabs, no semicolons, single quotes, LF line endings (see `.editorconfig`). Keep changes small and focused, and explain the *why* in the pull request. Prefer the standard library and the dependencies already here; a new dependency needs a reason and a licence compatible with Apache-2.0 (`pnpm licenses list`).

## Reviews and decisions

Maintainers review contributions as time allows. See [GOVERNANCE.md](GOVERNANCE.md) for how decisions are made.
