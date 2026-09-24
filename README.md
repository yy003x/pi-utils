# pi-utils

Personal everyday extensions for [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`). The package improves the interactive session without registering model providers, reading credentials, or modifying provider requests.

## Install

Primary source is GitLab; GitHub is a mirror.

```bash
pi install git:gitlab.xiaoluxue.cn/be-arch/pi-lab/pi-utils.git
```

Pin a version with a tag ref:

```bash
pi install git:gitlab.xiaoluxue.cn/be-arch/pi-lab/pi-utils.git@v2.0.0
```

Development:

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```

## Extensions

### statusline

Owns the interactive footer and keeps frequently used session data together:

- working directory, Git branch, and session name;
- context usage and auto-compaction state;
- input/output tokens, cache reads/writes, cache hit rate, and cost;
- current model and thinking level;
- the latest duration published by `turn-metrics`;
- `pi-sinan-usage`, `pi-sinan-fast`, and unrelated extension statuses when available.

Full, compact, and narrow width tiers are automatic; optional `compactAtWidth` (40–300 columns) switches to the compact tier earlier. Configure `piUtils.statusline` in global `~/.pi/agent/settings.json`, optionally overridden field-by-field by a **trusted** workspace `.pi/settings.json`:

```json
{"piUtils":{"statusline":{"showCost":true,"showDuration":true,"showCache":true,"showQuota":true,"compactAtWidth":100}}}
```

All four fields default to `true`; invalid values are ignored. `showQuota` controls usage/quota statuses, not the independent Fast-request indicator. Quota is display status only, never read from credentials.

The extension consumes display status from other extensions but does not fetch subscription data or inspect credentials. It is the only extension in this package that calls `setFooter()`.

### tool-activity

Shows ephemeral activity above the editor while Pi is working:

- agent work without an active tool;
- concurrent tool names and running duration, completed/running counts;
- agent/provider/tool/user-wait phase (extension prompt kind only; no arguments or prompt contents).

It only observes public lifecycle events. A tool error or nonzero exit alone does not establish an unresolved, urgent problem, and these events do not provide reliable severity or recovery evidence. The widget therefore shows ordinary progress without a problem alert; the original tool result remains available in Pi's tool output for diagnosis. It does not replace tools, modify arguments, or persist tool results.

### session-meta

Uses the active model's normal response to maintain interactive session metadata without an extra model request:

- current terminal title;
- one automatic session name for an unnamed session;
- a short factual recap after a final tool-free response.

A small hidden envelope is requested through a structured system-prompt section. The extension removes envelopes from streaming display and finalized assistant messages. Invalid or missing metadata is ignored without affecting the answer. Recaps are stored as display-only custom entries and are not sent back to the model. `/utils-recap` displays up to 30 validated recaps from the current branch. `/utils-recap export recaps.md` explicitly writes only those recaps to a new `.md` file directly in the workspace root; nested paths are rejected to avoid parent-symlink races, and existing files are never overwritten. This command does not export transcript content or call a model.

### turn-metrics

Measures one settled agent run from its first `agent_start` through `agent_settled`, including automatic retries and tool work. It records:

- settled elapsed time, first-token latency (when a text/thinking/tool-call delta is observed), and completion status;
- tool execution count, bounded per-tool durations, peak concurrency, retry and successful compaction counts;
- token, cache, and cost deltas.

The result is stored as a display-only custom entry and published to `statusline` through `pi-utils/turn-metrics/updated/v1`. `/utils-stats` reads validated entries from the current branch without model calls or writes.

Optional **Pi in-session** notifications are off by default. Set positive integer millisecond thresholds (1000–86400000) under `piUtils.notifications.settleMs` and/or `piUtils.notifications.userWaitMs` in the same global/trusted-project settings to notify when a run settles or a blocking extension UI is still waiting for input after the threshold. No desktop/OS notifications are used.

## Model selection

Pi 0.84.3 and later keep ordinary `/model`, Ctrl+P, and `/thinking` selections session-local. Use Ctrl+S inside the selector to persist a new default. `pi-utils` therefore does not intercept model selection or edit `defaultProvider` / `defaultModel`.

The former `pin-model` extension was removed in v2 because its behavior is now native to Pi and could undo an explicit Ctrl+S save.

## Scope

`pi-utils` is a personal package, not a harness distribution. It does not manage Pi settings, keybindings, model lists, providers, authentication, skills, or other packages.

## License

MIT
