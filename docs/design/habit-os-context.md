# CLAUDE.md - better-habit-system

This file guides Claude Code when working in this project. It complements the root `life-os/CLAUDE.md` (who Rami is, his values, tooling rules) - read that first, it always applies.

## What This Project Is

This is the workspace where Rami and Claude build his **habits operating system**: a living system for running his life more meaningfully and intentionally. Rami has years of notes, book takeaways, and video learnings about habits, focus, and systems - but they are scattered. This project is where that knowledge gets *applied*, not just accumulated.

The system covers:

- **Principles and rules** - the non-negotiables that govern decisions
- **Routines** - morning routine, night routine, and everything in between
- **Habit design** - building, tracking, and evolving habits
- **Focus and clarity** - deep work practice, eliminating brain fog, protecting attention
- **Custom software** - purpose-built tools that make the system easier to follow

The core requirement: **the system must grow with Rami.** It is not a static plan. It should evolve as he learns, as his identity shifts, and as his life changes. Treat every artifact here as versionable and revisable.

## Source Material (read these before designing anything)

### Obsidian vault (personal knowledge base)

Vault root: `/Users/rami/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian` (symlinked at `life-os/Obsidian`)

- `My Habits/My Habits.md` - habits Rami has tried, plus a brainstormed ideal day (wake up through sleep). **Slightly outdated** - use it to understand what he wants and what he has attempted, not as current truth.
- `My Resources/My Maps of Content (MOCs)/Habits.md` - the Habits MOC linking related notes
- `My Resources/My Maps of Content (MOCs)/Deep work.md` - the Deep Work MOC
- `My Inputs/My Books/Atomic Habits.md` - book notes
- `My Outputs/My Book Applications/Atomic Habits Application.md` - how he already applied Atomic Habits
- `My Greenhouse/` - many first-person essays on habits (habit stacking, environment design, weakening bad habits, habits for social expansion)
- `My Files/My Canvases/My Habits Board.canvas` - visual habits dashboard
- `Hidden/My Templates/projects/Habit Template.md` - existing per-habit note template (`#habitNote` frontmatter drives dataview queries in My Habits.md)

### Knowledge base vault (compiled learnings)

Vault root: `/Users/rami/Library/Mobile Documents/iCloud~md~obsidian/Documents/knowledge-base` (symlinked at `life-os/knowledge-base`)

- `Raw/Sources/YouTube/` - transcripts of videos Rami is learning from: habit systems ("I built a habit system as addicting as a casino"), focus and brain fog (Huberman, Buteyko method), morning routines, doing hard things. New videos land here via the YouTube triage pipeline.
- `Wiki/` - compiled, source-backed notes (Topics, Concepts, Entities, Projects, Logs) with `catalog.jsonl` as the searchable index
- `AGENTS.md` in that vault defines the rules for working there: search the Wiki first, open Raw sources only for original context, keep claims traceable to sources

Insights from these videos should be continuously incorporated into the system as Rami processes them.

## Intellectual Foundations

Build on these frameworks, and cite them when making design decisions:

- **Atomic Habits (James Clear)** - identity-based habits (every action is a vote for the person you want to become), the four laws (obvious, attractive, easy, satisfying), environment design, habit stacking. Rami already lives some of this - see his Application note.
- **Deep Work (Cal Newport)** - scheduled deep work blocks, distraction elimination, attention as the core asset. Rami's ideal day already centers on a 90-minute no-distraction morning session.
- **Psycho-Cybernetics (Maxwell Maltz)** - the self-image is the thermostat; change the identity and behavior follows. Identity chains: make change easier by first becoming, in self-image, the kind of person who does the thing. This pairs directly with Rami's own principle that identity redesign beats habit fixing.

The synthesis matters more than any single book: identity first, environment second, willpower last.

## The Software Angle

Rami is a developer and loves building custom tools and workflows for himself. Software is a first-class part of this system, with two working proofs already:

- **Intentionality tracker** - an app that tracks how intentional he is every hour of the day and renders a dashboard of trends. Seeing the data motivates more intentional hours.
- **Sleep tracking** - daily tracking that has measurably improved his consistency and sleep duration.

The pattern that works for him: **tracking creates visible feedback, visible feedback creates motivation, motivation creates consistency.** When designing part of the system, always ask whether a small custom tool (tracker, dashboard, automation, notification) would strengthen the loop. He can build these quickly, especially with AI.

But hold the counterweight: **software cannot solve everything.** Sometimes the answer is a rule, a ritual, an environment change, or an identity shift - not an app. Do not default to building; default to the simplest intervention that works, then automate what proves itself.

## Working Principles for This Project

1. **Applied over accumulated.** Every note or learning that enters the system must translate to a concrete practice, rule, or tool. No summaries for their own sake.
2. **Identity before mechanics.** Frame habits as "become the kind of person who X", then design the mechanics that make X easy.
3. **Design for the growing system.** Prefer structures that can be reviewed and revised (weekly/monthly review baked in) over one-time perfect plans.
4. **Feedback loops everywhere.** If a habit matters, it should be visible somewhere - a tracker, a dashboard, a journal prompt.
5. **Respect what exists.** Rami already has routines, templates (`#habitNote`), dataview dashboards, and tracking apps. Extend and integrate before replacing.
6. **Pull from the knowledge base.** When designing for focus, brain fog, or energy, check `knowledge-base/Raw/Sources/YouTube/` and the Wiki for what Rami has already learned before reaching for generic advice.

## Conventions

- Follows all root `life-os/CLAUDE.md` rules: `uv` for Python, `bun` for JS/TS, lowercase comments, no emojis, no em dashes, simple over clever
- Documents written here (principles, routines, reviews) should be markdown, compatible with Obsidian conventions (frontmatter, wiki-links) so they can live in or link to the vault
- When creating habit notes destined for the vault, use the existing `Habit Template.md` frontmatter so they show up in the My Habits dataview dashboard
