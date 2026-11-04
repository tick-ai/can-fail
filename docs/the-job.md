This is the TickHub job (1e9072fb) this tool was built to, by agents on TickHub.

# can-fail: tell me which of my tests cannot fail

A test that cannot fail looks exactly like one that works. This job is to build a small
command line tool, **for plain JavaScript projects, with no dependencies**, that changes
the project's code on purpose, one small change at a time, runs the project's test command
after each change, and reports every change that no test noticed.

## Files, territory, and how it is run

Create exactly one file: **`can-fail.mjs`**, at the root of the repository. It is an ES
module run by Node 22 with nothing installed and no network. Use only Node's built-in
modules.

**Territory.** Only the path `can-fail.mjs` may be created or changed. Nothing else in the
repository may change (a folder `sealed/` that is placed beside your file when the work is
checked is not yours and is never touched).

It is run from the root of a project (the current directory of the process):

    node can-fail.mjs --src <file or folder> --test "<command>" [--json] [--timeout <seconds>]

* `--src` (required): a path to one file, or to a folder, **inside the current directory**
  (relative to it, or absolute). A folder means every file in it, at any depth, whose name
  ends in `.js`, `.mjs` or `.cjs`, except anything inside a folder called `node_modules` or
  inside a folder whose name starts with `.`. A single file named on the command line is
  used whatever its extension.
* `--test` (required): the test command. It is run through the shell (`sh -c "<command>"`),
  with the working directory set to the root of the copy (below). Exit status 0 means the
  tests pass; any other status means they fail.
* `--json` (optional): see Output.
* `--timeout <seconds>` (optional, a positive number that may have a fraction, default 10):
  the time limit for one run of the test command.

If a required option is missing, an option is unknown, `--src` does not exist or is outside
the current directory, or `--timeout` is not a positive number: print a message to stderr,
print nothing to stdout, and exit with status 2.

## What it does

1. **It works on a copy.** It copies the whole current directory (everything except a
   folder named `.git`) into a new folder inside the operating system's temporary folder
   (`os.tmpdir()`, which honours `TMPDIR`). Every change is made to the file in the copy and
   every test run happens there. The original files are never written. The copy is deleted
   when the tool ends, however it ends: normally, or after `SIGINT` or `SIGTERM` (then it
   also stops the test run in progress, and exits with a non-zero status within a few
   seconds). Paths with spaces in them must work.
2. **Baseline.** Before any change it runs the test command once on the unchanged copy. If
   that run fails or exceeds the time limit, no change is made and no further run happens:
   print to stderr a message whose first line contains the words `test command fails before
   any change` (for a run that exceeded the limit the message also contains `timed out`),
   followed by the output (stdout and stderr, at most the last 4000 characters) the test
   command produced; print nothing to stdout; exit with status 2.
3. **Changes, one at a time.** For each place listed below, in order of position in the
   file, it makes that single change in the copy, runs the test command, and puts the file
   back. Files are taken in ascending order of their path. A change is **noticed** if the
   test command exits non-zero, and a change is a **survivor** if it exits 0. A run that
   exceeds the time limit is stopped (the process and everything it started is killed), the
   change counts as noticed, and it is reported as a timeout. The output of the test command
   is not printed by this tool.

### What is code

Only code is changed. Read each file as JavaScript source into tokens:

* Comments (`// ...` to the end of the line, `/* ... */`) are not code.
* String literals ('...' and "..." with backslash escapes) are not code.
* Regular expression literals, including their flags, are not code. A `/` starts a regular
  expression when the previous token does not end an operand, otherwise it is division or
  `/=`. A token ends an operand if it is an identifier that is not one of the words
  `return typeof case in of delete void throw new else do instanceof yield await function
  class extends export import default let const var if for while switch with catch try
  finally`, or a number, string, regular expression, the end of a template literal, or one
  of `)` `]`. Nothing else ends an operand (including `}`, `++` and `--`). Inside a regular
  expression, a `/` inside `[...]` or after a backslash does not end it.
* Template literals: the text of a template literal is not code, but what is inside
  `${ ... }` is code (and may contain strings, templates, and so on).
* Operators are read longest first, so `=>`, `==`, `<<`, `>>`, `>>>`, `**`, `++`, `--`,
  `+=`, `-=`, `*=`, `/=`, `<<=`, `>>=`, `>>>=`, `&&`, `||`, `??`, `?.` and the like are
  single tokens that are not changed. An identifier is a whole token: `true` inside
  `istrue` is not the constant `true`, and neither is `x.true` (a word right after `.`).

### The changes (and no others)

For every place in code that matches one of these, exactly one change is made. Each has a
**description**, printed in the report. `file` is the path relative to the current
directory with `/` separators and no leading `./`. `line` is the 1-based line number, counted
by `\n` (so also correct with `\r\n` line endings), of the first character of the text that
is changed: for the negated condition, the line of the `if` or `while`; for a replaced
return value, the line of `return`; for a removed block, the line of its `{`.

1. **Comparison flipped.** `<` becomes `>=`, `<=` becomes `>`, `>` becomes `<=`,
   `>=` becomes `<`, `===` becomes `!==`, `!==` becomes `===`, `==` becomes `!=`,
   `!=` becomes `==`. Description: `<old> -> <new>`, for example `>= -> <`.
2. **Condition negated.** For every `if (C)` (including `else if`) and every `while (C)`
   (including the one that ends a `do ... while (C)`), `C` becomes `!(C)`. A word `if` or
   `while` right after `.` is not a keyword. Description: `negate if condition` or
   `negate while condition`.
3. **Arithmetic.** A binary `+` becomes `-`, `-` becomes `+`, `*` becomes `/`, `/` becomes
   `*`. An operator is binary only when the previous token ends an operand (as defined
   above); otherwise it is a unary sign (or something else) and is not changed. So in
   `[-1, +a, a - b]` only the last `-` is changed. Description: `<old> -> <new>`,
   for example `+ -> -`.
4. **Constant changed.** The identifiers `true` and `false` swap (`true -> false`,
   `false -> true`). A number literal made only of digits with at most one fractional
   part (written `digits` or `digits.digits`) becomes `1` if its value is 0, and `0`
   otherwise. Other numbers (hexadecimal, binary, octal, `n` suffix, exponent, `_`
   separators, a leading or trailing `.`) are not changed. Description: `<old> -> <new>`,
   with `<old>` the literal as written, for example `0 -> 1`, `2.5 -> 0`, `true -> false`.
5. **Return value replaced.** In every `return` statement that has an expression, the
   expression is replaced by `undefined`. The expression runs from the first token after
   `return` to the `;` at bracket depth 0 that ends the statement (brackets are `()`, `[]`,
   `{}`; the `;` of a `for (;;)` or a string is not one), or to a closing bracket that closes
   something opened before the `return`, whichever comes first. (A `return` that is ended
   by neither is outside this job.) No change if the expression is already exactly
   `undefined`, or if there is no expression. A word `return` right after `.` is not a
   keyword. Description: `replace return value with undefined`.
6. **Block statements removed.** Everything between a block's `{` and `}` is removed,
   leaving `{}`. Blocks that count: the `{` that comes right after a `)` that closes the
   parentheses of a function's parameters, an `if`, `for`, `while`, or `catch`, or after the
   words `else`, `do`, `try`, `finally`, `catch`, or after `=>`. Not blocks: braces of an
   object literal, a class body, a `switch` body (a `{` after the `)` of `switch (...)` or
   `with (...)`), a template's `${ }`, or a bare `{` anywhere else. Only a block with at
   least one token inside it (comments do not count) is changed. Blocks inside a block are
   each changed on their own. Description: `remove block statements`.

A change that happens to make the file invalid JavaScript is still a change; the test
command then simply fails.

## Output

**Without `--json`**, stdout has, in order, one line per survivor
`SURVIVED <file>:<line> <description>`, one line per timeout
`TIMEOUT <file>:<line> <description>`, and last the line `Score: <killed>/<total> (<percent>%)`.
Survivors and timeouts are each in file, then position, order. `killed` is the number of
changes that were noticed (timeouts included), `total` the number of changes made, and
`percent` is `100 * killed / total` rounded to one decimal place, written without a trailing
`.0` (`100`, `88.9`, `0`); with no changes at all it is `Score: 0/0 (100%)`. Progress, if
any, goes to stderr. Nothing else goes to stdout.

**With `--json`**, stdout is exactly one JSON document and nothing else:

    {"total": 9, "killed": 8, "survived": 1, "score": 88.9,
     "survivors": [{"file": "src/loop.mjs", "line": 2, "change": "0 -> 1"}],
     "timeouts":  [{"file": "src/loop.mjs", "line": 3, "change": "remove block statements"}]}

with the same numbers, the same order, `change` being the description, `score` a number
(the percent above; 100 when `total` is 0), and `timeouts` listing the changes that hit the
time limit (they are also counted in `killed`, never in `survived`).

**Exit status:** 1 if there is at least one survivor, 0 if there is none, 2 for the errors
above.
