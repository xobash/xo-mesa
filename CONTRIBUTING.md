# Contributing to Mesa

Thank you for your interest in Mesa. Keep each contribution focused, tested,
and easy to review.

## Development setup

Install Node.js 18 or later and Rust. Then run:

```bash
npm install
npm run mesa
```

`npm run dev` starts the browser demo. It does not start the desktop shell.

## Before you open a pull request

- Describe the user-visible result and the reason for the change.
- Add or update tests for behavior changes.
- Run `npm test`, `npm run typecheck`, and `npm run build`.
- Do not include credentials, private vault data, personal paths, or generated
  local output.

## Pull requests

Use a focused branch and a clear title. Keep unrelated changes out of the pull
request. Explain any platform limits and the checks that you ran.
