# Docs - BBMP Pothole Complaint Agent

Start with the root [`README.md`](../README.md) for setup, MCP registration and known limits.

| Document | Contents |
|---|---|
| [plan.md](plan.md) | Goals, decisions, open items and the 12 sub-tasks with status. `[~]` means built and tested with mocks/automated tests, not verified against live services |
| [skills.md](skills.md) | Copy of the skill (`.bob/skills/pothole-complaint/SKILL.md`) |
| [HLD.md](HLD.md) | High-level design: scope, components, flow, risks |
| [LLD.md](LLD.md) | Low-level design: repository layout, schema, config, MCP tool contracts, web API, error handling |

Notes
- The skill Bob actually loads is `.bob/skills/pothole-complaint/SKILL.md`. `docs/skills.md` is a documentation copy and does not take effect on its own; the `.bob` file is the source of truth.
- `docs/plan.md` is a copy of `pothole-complaint-plan.md` in the repo root. Edit the root file and re-copy.
- Items marked **(open)** are not yet decided. Decisions made by the implementer without confirmation are listed in the root README under "Known limits".
