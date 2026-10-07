## Purpose

Render the workspace and coordinate application state.

## Ownership

Owns `App.tsx`, entry point, store facade, types and styling. Components own views; controllers own workflows; lib owns reusable logic.

## Local Contracts

- `App` may subscribe only to fields its own JSX uses or narrow lifecycle inputs needed by shell effects. High-churn `status`, `loading`, `files`, `notes`, `deepResearch`, `activePath`, `openTabs`, and `content` belong in the displaying component or a `useAppStore.subscribe` inside an effect. `App.rerender.test.tsx` enforces the shell boundary.
- Use narrow selectors and `fileFor` instead of scanning `files` for identity lookup.
- Keep heavy vendors lazy; bundle boundaries are checked during `npm run build`.
- Research relay subscriptions must clean up on effect disposal. Pi context publishing belongs to the main workspace and changes only when its context inputs change.
- Preserve theme tokens, verified saves and detached window ownership.

## Work Guidance

Keep the store facade small. Subscribe imperatively for effects that do not render data. Keep event names, context payloads and serial queue behavior compatible.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```
The rerender suite checks high-churn updates and retains a positive layout-render control.

## Child DOX Index

- `components/AGENTS.md` — React views.
- `controllers/AGENTS.md` — application workflows.
- `lib/AGENTS.md` — shared logic and regression contracts.
