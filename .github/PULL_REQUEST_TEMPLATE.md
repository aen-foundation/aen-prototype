## What and why

<!-- What does this change, and what problem does it solve? -->

## Checklist

- [ ] My commits are signed off (`git commit -s`), see CONTRIBUTING.md
- [ ] `pnpm check` and `pnpm test` pass
- [ ] A protocol change starts in `spec/` (schema + a valid or invalid example) before the code
- [ ] A fixed hole has a test that fails without the fix, and `docs/threat-model.md` is updated
- [ ] No keys, tokens or personal data are included
- [ ] I did not loosen a safety rule (user confirmation, JSON only, same-origin URLs, no card data)
