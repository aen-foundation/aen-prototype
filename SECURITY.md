# Security policy

This repository is a **prototype** of the AEN protocol: reference code for testing the design, and a draft threat model. It is not production software and must not be deployed (see `AGENTS.md`). Security reports are still welcome, because the design is what we are trying to get right.

## What to report

- A flaw in the **design or the schemas** that lets an agent, directory, business or user be attacked (for example a way around user confirmation, a way to make a token usable by someone else, a way for a directory to impersonate a business).
- A flaw in the **reference code** that breaks a rule stated in `docs/threat-model.md`.
- Anything that exposes a secret, such as a key committed to the repository.

Known gaps are listed in `docs/threat-model.md` under **Open**; reports about those are useful but not new.

## How to report

Please **do not open a public issue** for a vulnerability.

- Email **security@aen.foundation** with what you found, how to reproduce it, and what you think the impact is.
- Or use GitHub's private vulnerability reporting for this repository, if it is enabled.

We aim to acknowledge a report within five working days and to tell you what we decided. This is a small, early project, so please treat these as intentions, not guarantees. We will credit you if you want to be credited.

Terms for good-faith research (a formal safe harbour) have not been written yet. Until they are, please keep testing to your own machines and the local sample servers in this repository, and never touch real businesses, users or payment systems.

## Supported versions

Only the current `main` branch. There are no releases yet.
