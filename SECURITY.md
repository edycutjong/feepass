# Security policy

FeePass is a hackathon project (BCH Blaze 2026). It moves real PUSD on Bitcoin Cash mainnet, so reports are welcome.

## Report a vulnerability

Open a private security advisory on GitHub (Security tab, "Report a vulnerability"). Please do not file a public issue for anything that could drain the sponsor pool or the starter faucet.

Include: what you did, what you expected, what happened, and the transaction id or lane if one is involved.

## Scope

- The covenant in `contracts/` (rules R1 to R8, the fixed transaction shape, the per-transaction cap C).
- The transaction builder and signed-transaction verification in `src/core/`.
- The serverless function (`api/feepass.mjs`, built from `src/server/function.ts`): the starter-PUSD claim route and its limits.

Out of scope: third-party wallets, the Electrum servers, Vercel, social engineering.

## Known, disclosed limits

See "Security properties" in the README and `docs/ARCHITECTURE.md`. In short: the sponsor pays only the miner fee plus a bounded top-up, the user's own signature binds the outputs, per-IP limits on the starter route are best effort, and the claim rules live in one serverless function without a database.

## Secrets

No key, seed or WIF is committed. CI runs gitleaks over the full history on every push.
