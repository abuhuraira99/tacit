# Contributing

Thanks for helping. Tacit stays small on purpose: no build step, no required dependencies, and everything runs locally.

## Setup

```bash
git clone https://github.com/abuhuraira99/tacit.git
cd tacit
npm install      # optional SDK only
npm test
npm run demo
```

## Ground rules

- **No new runtime dependencies** without a strong reason. Node's standard library and plain browser APIs go a long way.
- **Never use real history in tests, fixtures or screenshots.** Use `src/demo/generate.js` or a small hand-written fixture.
- **Privacy first.** Anything shown, cached or exported must go through `redact()`. Nothing leaves the machine unless the user
  turns on Refine with Claude.
- **Writes stay safe.** Changes to `apply.js` need tests for backups, allowed roots and invalid input.
- **Keep the copy plain.** Interface text is short, active and specific.

## Pull requests

1. One focused change per pull request, with a test that fails without it.
2. `npm test` passes on your machine; CI checks Linux, macOS and Windows on Node 18, 20 and 22.
3. For UI changes, include a before and after screenshot taken with `npm run demo`.

## Reporting bugs

Open an issue with your OS, Node version (`node -v`), the output of `npx tacit doctor` or `node bin/tacit.js doctor`, and
what you expected. Please don't paste prompts from your history; describe their shape instead.
