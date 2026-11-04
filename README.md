# can-fail

A test that cannot fail looks exactly like one that works. can-fail changes your code one small step at a time, runs your tests after each change, and lists every change no test noticed.

## Run it

From the root of your project:

```sh
npx can-fail --src lib --test "npm test"
```

- `--src <file or folder>` (required): the code to change. A folder means every `.js`, `.mjs` and `.cjs` file in it, at any depth, except inside `node_modules` and folders whose names start with a dot. It must be inside the current directory.
- `--test "<command>"` (required): your test command. It runs in your system's shell: `sh` on macOS and Linux, `cmd` on Windows. Exit status 0 means the tests passed.
- `--json` (optional): print the result as one JSON object instead of lines.
- `--timeout <seconds>` (optional, default 10): the limit for one run of your tests. A run that goes over it is stopped, with everything it started, and the change counts as noticed.

can-fail works on a copy of your project in your system's temporary folder. It never writes your files, and it deletes the copy when it ends.

It needs Node 22 or newer, and nothing else: no dependencies, no network.

## What it changes

One small change at a time, only in code, never in comments or strings: a comparison turned around (`<` to `>=`, `===` to `!==`), `+` and `-` swapped, `*` and `/` swapped, `true` and `false` swapped, a number turned into `0` (or `0` into `1`), a condition negated, a block emptied, a returned value replaced with `undefined`. Before the first change it runs your tests once on the unchanged copy; if they fail there, it stops and says so.

## What the output means

Each change your tests did not notice is one line:

```
SURVIVED lib/price.js:42 < -> >=
TIMEOUT lib/loop.js:7 1 -> 0
Score: 87/90 (96.7%)
```

`SURVIVED` is a change no test noticed. `TIMEOUT` is a change whose run went over the limit; it counts as noticed. The score is the changes noticed out of all changes made.

Exit codes: `0` when every change was noticed, `1` when at least one survived, `2` for a usage error or tests that fail before any change.

A surviving change is a question about your tests, not proof of a bug: some changes do not alter what the code does, and those can never be noticed. Read each one and ask what would have to be true for that line to matter, and whether any test says it.

## Where it came from

Built by agents on TickHub, as job 1e9072fb: see [docs/the-job.md](docs/the-job.md).

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0. Copyright 2026 Parsa Esmaeili. See [LICENSE](LICENSE).
