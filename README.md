# pi-utils

Extensions for [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`).

## Install

Primary source is GitLab; GitHub is a mirror.

```bash
pi install git:gitlab.xiaoluxue.cn/be-arch/pi-lab/pi-utils.git
```

Pin a version with a tag ref:

```bash
pi install git:gitlab.xiaoluxue.cn/be-arch/pi-lab/pi-utils.git@v1.1.0
```

Development:

```bash
npm install --ignore-scripts
npm run typecheck
npm test
```

## Extensions

### pin-model

Keeps the default model fixed across sessions.

By default, every `/model` selection or `Ctrl+P` cycle writes the newly
selected model into `settings.json` (`defaultProvider`/`defaultModel`), so
the next pi session inherits it. This extension captures the values from
`settings.json` at startup as the "pin", then reverts the two fields right
after each user-initiated model switch, so the switch only applies to the
current session.

How it works:

1. On startup, reads `defaultProvider`/`defaultModel` from
   `settings.json` (respects `PI_CODING_AGENT_DIR`) and stores them as the pin.
   If the file is unreadable or not valid JSON, the extension stays loaded but
   inert and `/model-pin` reports the error — it never rewrites a broken file.
2. On `model_select` (sources `set` and `cycle`), it waits for pi's queued
   settings write to land on disk, then reverts the two fields. `restore`
   events would be reverted the same way (pi does not currently emit them).
3. On `session_shutdown`, retries the revert if the first attempt failed.

Concurrency and integrity guarantees:

- Cross-process locking uses the same on-disk protocol as pi's own
  SettingsManager (a `settings.json.lock` directory, stale after 10 seconds),
  so pi's writes and this extension's writes exclude each other.
- Writes are atomic (same-directory temp file + rename) and field-level: only
  `defaultProvider` and `defaultModel` are touched; every other field — and
  concurrent edits made by other pi processes — is preserved.
- Restore is compare-and-set: the file is only rewritten while its current
  default model equals the value this process observed being persisted. A
  second pi process that pins a different model via `/model-pin set` is never
  clobbered when this process exits.

Commands:

- `/model-pin` — show the current pinned model
- `/model-pin set` — pin the current session model as the new default (this
  one really persists to `settings.json`)

Known limitations:

- If the process is killed (SIGKILL), the shutdown fallback cannot run; normal
  exits are covered. The next model switch in another session restores the pin.
- The pin is captured per pi process at startup. Editing `settings.json`
  while pi is running requires a restart (or `/model-pin set`) to move the pin.

## License

MIT
