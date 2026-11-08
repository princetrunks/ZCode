# shrinetech-planner (Sando plugin)

Copy `mcp.example.json` to `mcp.json` and paste a Planner JWT (365-day, from `POST /api/auth/login`). `mcp.json` is gitignored.
Add the plugin dir to `~/.zcode/cli/config.json` → `plugins.dirs`. Skill and slash commands load automatically.

Commands: `/pp-status`, `/pp-ticket`, `/pp-render`, `/forge`, `/pi-mirror`, `/pp-threads` (focus threads + one thread's board; needs the Planner's
`list_focus_threads` / `thread_status` MCP tools, branch `fleet/focus-threads-20261108` of the Planner).
