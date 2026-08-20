# pi-extensions

Extensions for [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`).

## Install

```bash
pi install git:github.com/yy003x/pi-extensions
```

Pin a version with a tag ref:

```bash
pi install git:github.com/yy003x/pi-extensions@v1.0.0
```

## Extensions

### pin-model

Keeps the default model fixed across sessions.

By default, every `/model` selection or `Ctrl+P` cycle writes the newly
selected model into `settings.json` (`defaultProvider`/`defaultModel`), so
the next pi session inherits it. This extension captures the values from
`settings.json` at startup as the "pin", then reverts the file right after
each user-initiated model switch, so the switch only applies to the current
session.

How it works:

1. On startup, reads `defaultProvider`/`defaultModel` from
   `settings.json` (respects `PI_CODING_AGENT_DIR`) and stores them as the pin.
2. On `model_select` events with source `set` or `cycle`, reverts
   `settings.json` back to the pin. The revert is deferred slightly because pi
   flushes settings writes through an async queue after the event fires.
   Session restores (`restore`) are left untouched.
3. On `session_shutdown`, reverts again as a fallback in case another settings
   save flushed the switched model during the session.

Commands:

- `/model-pin` — show the current pinned model
- `/model-pin set` — pin the current session model as the new default (this
  one really persists to `settings.json`)

Known limitations:

- If the process is killed (SIGKILL), the shutdown fallback cannot run; normal
  exits are covered.
- The pin is captured per pi process at startup. Editing `settings.json`
  while pi is running requires a restart (or `/model-pin set`) to move the pin.

## License

MIT
