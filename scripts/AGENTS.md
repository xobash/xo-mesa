## Purpose

Maintain development, verification and publication tools.

## Ownership

Owns launchers, installer checks, worker checks, notices, bundle checks, release gates and `public-files.txt`.

## Local Contracts

- The sorted, deduplicated public allowlist must match the staged tree.
- Tools must preserve unrelated files and use synthetic fixtures for tests.
- Keep generated build and acceptance output local.

## Work Guidance

Update the owning behavior check when tool contracts change.

## Verification

```sh
npm run test:bootstrap
npm run test:index
npm run test:markdown
npm run test:notices
npm run test:release
npm run build
npm run audit:public
```

## Child DOX Index

None; the folder is flat.
