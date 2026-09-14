# Summaryception

- Browser-only SillyTavern extension for recursive layered summarization.
- Summarized messages stay visible in chat but are hidden from model context.

## Work Rules

- Preserve unrelated changes.
- Do not add migration shims or legacy constants.
- New defaults apply to all users without stored-value detection.

## Commands

- `npm test` runs the suite.
- The pre-commit hook runs the type gate, formats the whole repo, then stages every change. Keep the tree free of unrelated edits before a commit.

## Documentation

- Domain glossary: `CONTEXT.md`
- Decisions: `docs/adr/`
- Conditional source guidance: `src/AGENTS.md`
- Conditional test guidance: `tests/AGENTS.md`

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues (vadash/Extension-Summaryception) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
