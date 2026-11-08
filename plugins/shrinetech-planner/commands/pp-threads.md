---
name: pp-threads
description: Chuck's focus threads (🧭 main · 🤝 client projects · 🏯 ShrineTech products & personal · 🔒 sovereign & local-only lab · 🧑‍🎓 trainee) with status and links; `/pp-threads <name>` shows one thread's board.
---
Use the shrinetech-planner tools. Do not change anything.

- No argument: call `list_focus_threads` and print one line per thread, in its order: icon, name, chat id, status word
  (idle / running / queued / waiting on you / new reply), "local-only" when set, and its `url` as a link. Then one line:
  "Voice: <lily_url>" for the thread that is `waiting on you` or `running`, if any.
- With an argument (`main`, `client`, `products`, `lab`, `trainee`, an icon or a chat id): call `thread_status` with
  `thread` = the argument and show the title, status, link and the board markdown as-is. A local-only or private thread
  returns no board: say "local-only: status words only" and give the link; never guess its contents.

$ARGUMENTS
