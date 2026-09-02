# Handoff: CAS Personal Agent prototype

## Next session focus

Establish the VPS project as the canonical development checkout, publish the accepted product specification to GitHub Issues, split it into tracer tickets, and begin the first runnable vertical slice.

## Read first

- `/data/pi-agent/cas-personal-agent/cas-personal-agent-prd-v0.3.md` — accepted MVP baseline.
- `/data/pi-agent/cas-personal-agent/CONTEXT.md` — project vocabulary and current boundaries.
- `/data/pi-agent/cas-personal-agent/docs/adr/0001-manual-edits-are-authoritative.md`
- `/data/pi-agent/cas-personal-agent/docs/adr/0002-one-fact-one-owner.md`
- `/data/pi-agent/cas-personal-agent/docs/adr/0003-hindsight-on-existing-postgres.md`
- `/data/pi-agent/cas-personal-agent/docs/adr/0004-lark-cli-event-ingress.md`

Do not repeat the product interview from scratch. These artifacts capture the agreed direction; ask the user only when a concrete unresolved choice blocks the next vertical slice.

## Product intent

This is an external work memory and attention router for a user with ADHD-related context switching and forgetting. The first proof is a low-friction loop:

1. The user dumps unstructured work/life thoughts into a Feishu bot.
2. The agent organizes them into projects, next actions, waiting-for items, scheduled events, context, and reflections.
3. It writes the relevant state to Feishu Bitable and sends actionable work to TickTick or Feishu Tasks.
4. It reminds only when something becomes due or a waiting item needs checking.
5. Manual edits in Bitable, TickTick, or Feishu Tasks are authoritative corrections and should teach future behavior.

Optimize for a fast working prototype and a short feedback loop. Avoid speculative enterprise hardening.

## Locked decisions

- Feishu bot is the MVP input/query surface; WeChat bot may come later.
- Bitable is the visible state/relationship surface, not a custom dashboard.
- Memory is configured from the beginning. Production-like prototype runs use `MEMORY_ENABLED=true`; disabling it is only for development/degraded tests.
- The first retained memories are corrections, preferences, important decisions/outcomes, and handoff facts. Raw messages stay in SQLite rather than being indiscriminately memorized.
- Explicit deadlines and meetings must also be represented in Bitable. In the MVP, meetings are rows in `行动同步` with start/end and `scheduled_event` reminders.
- TickTick owns personal actionable reminders; Feishu Tasks owns collaborative tasks. Validate whichever connector credentials are ready first; prefer TickTick if both are ready.
- WeCom Calendar was deliberately moved out of MVP to P1.
- No generic daily digest in the first prototype. Only due reminders and waiting-item follow-up are required.
- One fact has one operational owner; other systems hold references or projections.
- User-made edits in external systems outrank inferred agent state.

## Environment already prepared

- VPS SSH host alias: `pi-agent-vps`
- Linux account: `pi-agent`; home: `/data/pi-agent`
- Project path: `/data/pi-agent/cas-personal-agent`
- `git`, `node`, and `codex` are available to `pi-agent`.
- Matt Pocock's complete current skill set (37 skills from `mattpocock/skills`) is installed globally for this user's Codex under `~/.agents/skills`.
- The application code, secrets, runtime state, and services must run as `pi-agent`, separate from root. Root is only for one-time system-level provisioning when unavoidable.

## Immediate work queue

1. Inspect the referenced PRD, context, and ADR files and check repository status.
2. Run `setup-matt-pocock-skills` for this repository. The issue tracker decision is already GitHub. Prefer `AGENTS.md` for Codex. Keep docs at the repository root plus `docs/adr` unless a real need appears.
3. Create or connect the private GitHub repository `aveschien/cas-personal-agent`. At handoff time neither local nor VPS `gh` CLI is authenticated, and the connected GitHub tool cannot create repositories; repository creation may require one short user action or `gh auth login`.
4. Use `to-spec` to publish PRD v0.3 as the parent specification issue, then `to-tickets` to create blocking-aware tracer tickets.
5. Start with the smallest live slice: Feishu message event -> durable raw event -> interpretation -> proposed/confirmed action -> Bitable projection -> concise bot acknowledgement.
6. Add live memory retain/recall to that same slice before calling stage 1 complete.
7. Add due/waiting reminders and one task-system adapter next.

## Acceptance posture

Prefer runnable evidence over architectural ceremony. A slice is useful when one real Feishu message can travel through the system and the resulting Bitable/task state can be corrected manually and observed by the agent. Keep idempotency and auditability where the PRD requires them, but do not block the prototype on future multi-user, compliance, or dashboard concerns.

## Suggested skills

- `setup-matt-pocock-skills`
- `to-spec`
- `to-tickets`
- `implement`
- `tdd`
- `code-review`
- `diagnosing-bugs` when a real integration failure has a reproducible feedback loop

