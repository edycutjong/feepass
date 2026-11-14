# Contributing

```
npm ci
npm run compile     # covenant artifact must match src/contracts and evidence/compile.json
npm run typecheck
npm test
npx vite build
```

Rules of the road:

- Node 22 or newer.
- Every change to `contracts/` must come with a test that fails without it, and a regenerated artifact (`npm run compile`).
- Any figure in the UI or docs must trace to a file in `evidence/` or a measured run.
- Never commit keys. Credentials belong in `~/.config/`, not in the tree.
