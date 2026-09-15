# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues; use the `gh` CLI. Infer the repo from `git remote -v`.

PRs are **not** a triage surface in this repo.

## Wayfinding

Used by `/wayfinder`:

- **Map**: one issue labelled `wayfinder:map`; child tickets are GitHub sub-issues of the map.
- **Blocking**: native GitHub issue dependencies (`issue_dependencies_summary.blocked_by`); fall back to a `Blocked by: #<n>` line at the top of the child body.
- **Frontier**: open children with no open blocker and no assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment the answer, close the child, append the context pointer to the map's Decisions-so-far.
