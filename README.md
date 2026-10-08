# claude_run_status

**busy-dancer**: a Claude Code mod that shows a dancing 💃 above the prompt while Claude or any of its subagents is working, and runs `caffeinate -d -i` meanwhile so the Mac's display doesn't sleep or lock. Both stop within about a second of everything going idle.

```
  💃 ♪   Claude is working · 2 subagents · ☕ screen kept awake
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install busy-dancer --marketplace gwang-indoc/claude_run_status
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session).

## How it works

- Main conversation: busy from a turn's start until it completes (answered, interrupted or errored).
- Subagents: polls the agent list once a second and counts those `pending` or `running`, so background agents that outlive the main turn still count.
- `caffeinate -d -i` (`-d` keeps the display on, `-i` prevents idle sleep) starts when busy and is stopped when idle, when the module reloads, or at session end.

macOS only. If Claude Code crashes hard, a `caffeinate` may be left behind: `pkill caffeinate`.

## Develop

```
claude --plugin-dir .          # run it from this folder
claude plugin validate .
claude plugin test .
```

Code: `hooks/register.tsx`; state contract: `types/index.d.ts`; tests: `tests/busy.test.ts`.
