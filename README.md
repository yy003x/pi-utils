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
- `pi-sinan-usage` and unrelated extension statuses when available.

The extension consumes display status from other extensions but does not fetch subscription data or inspect credentials. It is the only extension in this package that calls `setFooter()`.

### tool-activity

Shows ephemeral activity above the editor while Pi is working:

- agent work without an active tool;
- concurrent tool names;
- blocking extension prompts that are waiting for user input.

It only observes public lifecycle events. It does not replace tools, modify arguments, or persist tool results.

### session-meta

Uses the active model's normal response to maintain interactive session metadata without an extra model request:

- current terminal title;
- one automatic session name for an unnamed session;
- a short factual recap after a final tool-free response.

A small hidden envelope is requested through a structured system-prompt section. The extension removes envelopes from streaming display and finalized assistant messages. Invalid or missing metadata is ignored without affecting the answer. Recaps are stored as display-only custom entries and are not sent back to the model.

### turn-metrics

Measures one settled agent run from its first `agent_start` through `agent_settled`, including automatic retries and tool work. It records:

- elapsed time;
- tool execution count;
- token, cache, and cost deltas.

The result is stored as a display-only custom entry and published to `statusline` through `pi-utils/turn-metrics/updated/v1`.

## Model selection

Pi 0.84.3 and later keep ordinary `/model`, Ctrl+P, and `/thinking` selections session-local. Use Ctrl+S inside the selector to persist a new default. `pi-utils` therefore does not intercept model selection or edit `defaultProvider` / `defaultModel`.

The former `pin-model` extension was removed in v2 because its behavior is now native to Pi and could undo an explicit Ctrl+S save.

## Scope

`pi-utils` is a personal package, not a harness distribution. It does not manage Pi settings, keybindings, model lists, providers, authentication, skills, or other packages.

## License

MIT
