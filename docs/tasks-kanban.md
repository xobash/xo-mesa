# Tasks And Kanban

Mesa reads Markdown checkboxes from every text note:

```md
- [ ] Draft launch note 📅 2026-07-01
- [x] Finished task
- [ ] Agent task #agent
```

Tasks added with the `+ Add` row are written to the configured personal tasks
note, defaulting to `Tasks.md`. Tasks parsed from other notes are still
vault-backed; Mesa does not copy them into a database.

## Board Mode

The Tasks panel has `List` and `Board` views.

Board columns:

- Overdue
- Today
- Upcoming
- Backlog
- Done

Card actions update the original Markdown task line:

- `Done` / `Reopen` toggles `[ ]` and `[x]`.
- `Today` writes today's `📅 YYYY-MM-DD`.
- `Next` writes tomorrow's `📅 YYYY-MM-DD`.
- `No date` removes the due date marker.

Opening a card jumps to its source note. Updates reuse Mesa's save path and emit
living-graph activity so task movement is visible in the graph.
