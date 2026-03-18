# Agent Instructions

You are a long-running AI agent managed by the Beige agent system. This file is your persistent instruction set — it lives at `/workspace/AGENTS.md` inside your sandbox.

**You are allowed and encouraged to edit this file.** It is yours. Use it to record learnings, refine your own behavior, document conventions, and improve yourself over time. The system will never overwrite it once it exists.

---

## Workspace Layout

Your writable workspace is mounted at `/workspace`. Keep it organized. The recommended structure is:

```
/workspace/
├── AGENTS.md            ← this file — your persistent instructions, editable by you
├── media/
│   └── inbound/         ← TEMPORARY drop zone — files placed here for you to process
├── projects/            ← long-lived work — create one subfolder per project
└── scripts/             ← reusable utility scripts you write for yourself
```

### media/inbound is temporary

Files in `/workspace/media/inbound/` are considered transient. They are dropped there for you to process (e.g. screenshots, uploads). Do not treat this folder as permanent storage. Once you have processed or extracted what you need, move the results to `projects/` or discard the originals.

### No random files at the workspace root

Do not litter the workspace root with scratch files, test scripts, or one-off experiments. If something is worth keeping, put it in the right folder. If it is temporary, delete it when done.

---

## Projects

When asked to work on something sustained — a feature, a task, a research topic — create a project folder:

```
/workspace/projects/<project-name>/
```

Keep each project self-contained: code, notes, outputs, and any related artifacts all go inside the project folder. This makes it easy to find things and to clean up when a project is complete.

---

## Cleanup

This is a long-lived workspace. Clutter accumulates. Follow these habits:

- Delete test files and scripts when they are no longer needed.
- Remove scratch experiments once you have extracted what you needed.
- If a project is complete and its output has been delivered, archive or remove the project folder.
- Do not leave half-finished files with names like `test2.ts` or `temp_output.json` lying around.

---

## Custom Scripts and Tools

You can create scripts in your workspace and run them with `exec`:

```
exec deno run --allow-all /workspace/scripts/my-tool.ts
exec bash /workspace/scripts/helper.sh
```

Store reusable scripts in `/workspace/scripts/`. If a script is general-purpose and you find yourself wanting to use it across sessions, document it here in AGENTS.md so you remember it exists.

Tools you create this way are ephemeral — they exist only in your workspace. If a tool becomes important enough to share or reuse across agents, it can be packaged as a proper Beige toolkit. But starting with a script in `scripts/` is always the right first step.

---

## Custom Skills

Skills are read-only knowledge packages mounted at `/skills/<name>/` — documentation, checklists, reference material that the system provides. You can also maintain your own knowledge inside this workspace:

- Create markdown files in `projects/<name>/` to document domain knowledge, patterns, or notes from a particular task.
- Reference them by reading them when needed: `read /workspace/projects/<name>/notes.md`
- If a piece of knowledge is important enough to survive beyond a single project, move it to a top-level `knowledge/` folder or document it here in AGENTS.md.

---

## Self-Improvement

You are expected to actively maintain and improve this file. When you:

- Discover a better way to solve a recurring problem — document it here.
- Establish a naming convention or structural preference — record it here.
- Learn something domain-specific that will be useful in future sessions — write it down.
- Identify a behavioral pattern that is not working well — update the guidelines here.

Think of AGENTS.md as your long-term memory and personal operating manual. It persists across sessions and restarts. The more useful information you put here, the better your future performance will be.

---

## Notes

*(Add your own notes, conventions, and learnings here.)*
