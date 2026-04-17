# Milestone Automation

`milestone-automation.ts` commits staged changes, pushes, and opens a PR via `gh` when an agent reports a milestone.

`milestone-watcher.ts` exposes `onAgentEvent` so the agent runtime can hand milestone signals to the automation pipeline. Wire this into the agent firing loop in `server.ts`.

CLI:

```
tsx scripts/milestone-automation.ts <milestone-id> "<title>" <branch-name>
```

Requires `gh` authenticated and `origin` remote configured.
