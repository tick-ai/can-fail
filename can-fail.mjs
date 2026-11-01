// can-fail: change a project's code on purpose, one small change at a time, run its tests
// after each change, and report every change that no test noticed.
// One self-contained ES module; Node 22, built-in modules only, no network.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const USAGE = 'usage: node can-fail.mjs --src <file or folder> --test "<command>" [--json] [--timeout <seconds>]';

class UsageError extends Error {}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { src: null, test: null, json: false, timeout: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--src' || arg === '--test' || arg === '--timeout') {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      const value = argv[++i];
      if (arg === '--src') opts.src = value;
      else if (arg === '--test') opts.test = value;
      else {
        if (!/^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value)) throw new UsageError('--timeout must be a positive number');
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError('--timeout must be a positive number');
        opts.timeout = seconds;
      }
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  if (opts.src === null) throw new UsageError('--src is required');
  if (opts.test === null) throw new UsageError('--test is required');
  return opts;
}

// ---------------------------------------------------------------- tokenizer

const WORDS = new Set(
  (
    'return typeof case in of delete void throw new else do instanceof yield await function class extends ' +
    'export import default let const var if for while switch with catch try finally'
  ).split(' '),
);

const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<', '>>', '**',
];

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$‌‍]/u;

/** Whether a token ends an operand (so a following `/` divides and a following `+` is binary). */
function endsOperand(tok) {
  if (tok === null) return false;
  switch (tok.t) {
    case 'id':
      return !WORDS.has(tok.v);
    case 'num':
    case 'str':
    case 're':
      return true;
    case 'tpl':
      return tok.closed;
    case 'p':
      return tok.v === ')' || tok.v === ']';
    default:
      return false;
  }
}

function tokenize(src) {
  const tokens = [];
  const n = src.length;
  const stack = []; // 'brace' | 'tpl'
  let prev = null;
  let i = 0;

  const add = (t, s, e, extra) => {
    const tok = { t, v: src.slice(s, e), s, e, ...extra };
    tokens.push(tok);
    prev = tok;
    return tok;
  };

  // Scans template text from `from` (a backtick or the `}` closing a substitution).
  const template = (from) => {
    let j = from + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
      } else if (c === '`') {
        j++;
        add('tpl', from, j, { closed: true });
        return j;
      } else if (c === '$' && src[j + 1] === '{') {
        j += 2;
        stack.push('tpl');
        add('tpl', from, j, { closed: false });
        return j;
      } else {
        j++;
      }
    }
    add('tpl', from, n, { closed: true });
    return n;
  };

  if (src.startsWith('#!')) {
    while (i < n && src[i] !== '\n') i++;
  }

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === c) {
          j++;
          break;
        } else if (src[j] === '\n') break;
        else j++;
      }
      j = Math.min(j, n);
      add('str', i, j);
      i = j;
      continue;
    }
    if (c === '`') {
      i = template(i);
      continue;
    }
    if (c === '}' && stack[stack.length - 1] === 'tpl') {
      stack.pop();
      i = template(i);
      continue;
    }
    if (c === '/' && !endsOperand(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') j += 2;
        else if (d === '\n') break;
        else if (d === '[') {
          inClass = true;
          j++;
        } else if (d === ']') {
          inClass = false;
          j++;
        } else if (d === '/' && !inClass) {
          j++;
          break;
        } else j++;
      }
      j = Math.min(j, n);
      while (j < n && ID_PART.test(src[j])) j++;
      add('re', i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && /[xXbBoO]/.test(src[i + 1] ?? '')) {
        j += 2;
        while (j < n && /[0-9a-zA-Z_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === '.') {
          j++;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
        if (/[eE]/.test(src[j] ?? '') && /[0-9]|[+-][0-9]/.test(src.slice(j + 1, j + 3))) {
          j += 2;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
        if (src[j] === 'n') j++;
      }
      add('num', i, j);
      i = j;
      continue;
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (ID_START.test(ch) || (c === '#' && ID_START.test(String.fromCodePoint(src.codePointAt(i + 1) ?? 0)))) {
      let j = i + (c === '#' ? 1 : ch.length);
      while (j < n) {
        const pc = String.fromCodePoint(src.codePointAt(j));
        if (!ID_PART.test(pc)) break;
        j += pc.length;
      }
      add('id', i, j);
      i = j;
      continue;
    }
    // punctuation, longest first
    let op = null;
    for (const p of PUNCT) {
      if (src.startsWith(p, i)) {
        op = p;
        break;
      }
    }
    if (op === '?.' && /[0-9]/.test(src[i + 2] ?? '')) op = null;
    if (op === null) op = c;
    if (op === '{') stack.push('brace');
    else if (op === '}' && stack[stack.length - 1] === 'brace') stack.pop();
    add('p', i, i + op.length);
    i += op.length;
  }
  return tokens;
}

// ------------------------------------------------------------------ changes

const FLIP = {
  '<': '>=', '<=': '>', '>': '<=', '>=': '<', '===': '!==', '!==': '===', '==': '!=', '!=': '==',
};
const ARITH = { '+': '-', '-': '+', '*': '/', '/': '*' };
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const BLOCK_WORDS = new Set(['else', 'do', 'try', 'finally', 'catch']);

/** Every change to make in one file's source: { anchor, line, change, edits: [[start, end, text]...] }. */
function findChanges(src) {
  const T = tokenize(src);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  // matching brackets
  const match = new Array(T.length).fill(-1);
  const open = [];
  for (let k = 0; k < T.length; k++) {
    const tok = T[k];
    if (tok.t !== 'p') continue;
    if (OPEN.has(tok.v)) open.push(k);
    else if (CLOSE.has(tok.v) && open.length > 0) {
      const o = open.pop();
      match[o] = k;
      match[k] = o;
    }
  }

  const isWord = (k, word) => k >= 0 && k < T.length && T[k].t === 'id' && T[k].v === word && !(k > 0 && T[k - 1].t === 'p' && T[k - 1].v === '.');
  const isPunct = (k, v) => k >= 0 && k < T.length && T[k].t === 'p' && T[k].v === v;

  // class bodies are not blocks
  const classBodies = new Set();
  for (let k = 0; k < T.length; k++) {
    if (!isWord(k, 'class')) continue;
    let depth = 0;
    for (let j = k + 1; j < T.length; j++) {
      if (T[j].t !== 'p') continue;
      if (T[j].v === '{' && depth === 0) {
        classBodies.add(j);
        break;
      }
      if (OPEN.has(T[j].v)) depth++;
      else if (CLOSE.has(T[j].v)) depth--;
    }
  }

  const changes = [];
  const push = (at, change, edits) => changes.push({ anchor: T[at].s, line: lineAt(T[at].s), change, edits });

  for (let k = 0; k < T.length; k++) {
    const tok = T[k];
    const before = k > 0 ? T[k - 1] : null;
    if (tok.t === 'p') {
      if (FLIP[tok.v] !== undefined) {
        push(k, `${tok.v} -> ${FLIP[tok.v]}`, [[tok.s, tok.e, FLIP[tok.v]]]);
      } else if (ARITH[tok.v] !== undefined && endsOperand(before)) {
        push(k, `${tok.v} -> ${ARITH[tok.v]}`, [[tok.s, tok.e, ARITH[tok.v]]]);
      } else if (tok.v === '{') {
        let block = false;
        if (classBodies.has(k)) block = false;
        else if (isPunct(k - 1, '=>')) block = true;
        else if (before !== null && before.t === 'id' && BLOCK_WORDS.has(before.v) && isWord(k - 1, before.v)) block = true;
        else if (isPunct(k - 1, ')')) {
          const o = match[k - 1];
          block = !(o > 0 && (isWord(o - 1, 'switch') || isWord(o - 1, 'with')));
        }
        const close = match[k];
        if (block && close > k + 1) push(k, 'remove block statements', [[tok.e, T[close].s, '']]);
      }
    } else if (tok.t === 'id') {
      const afterDot = isPunct(k - 1, '.');
      if (afterDot) continue;
      if ((tok.v === 'if' || tok.v === 'while') && isPunct(k + 1, '(') && match[k + 1] > k + 1) {
        const o = T[k + 1];
        const c = T[match[k + 1]];
        push(k, `negate ${tok.v} condition`, [[o.e, o.e, '!('], [c.s, c.s, ')']]);
      } else if (tok.v === 'true' || tok.v === 'false') {
        const to = tok.v === 'true' ? 'false' : 'true';
        push(k, `${tok.v} -> ${to}`, [[tok.s, tok.e, to]]);
      } else if (tok.v === 'return') {
        let depth = 0;
        let j = k + 1;
        let ended = false;
        for (; j < T.length; j++) {
          const t = T[j];
          if (t.t !== 'p') continue;
          if (OPEN.has(t.v)) depth++;
          else if (CLOSE.has(t.v)) {
            if (depth === 0) {
              ended = true;
              break;
            }
            depth--;
          } else if (t.v === ';' && depth === 0) {
            ended = true;
            break;
          }
        }
        if (ended && j > k + 1 && !(j === k + 2 && T[k + 1].t === 'id' && T[k + 1].v === 'undefined')) {
          push(k, 'replace return value with undefined', [[T[k + 1].s, T[j - 1].e, 'undefined']]);
        }
      }
    } else if (tok.t === 'num' && /^\d+(\.\d+)?$/.test(tok.v)) {
      const to = /^0+(\.0+)?$/.test(tok.v) ? '1' : '0';
      push(k, `${tok.v} -> ${to}`, [[tok.s, tok.e, to]]);
    }
  }
  // stable sort by position
  return changes.map((c, i) => ({ c, i })).sort((a, b) => a.c.anchor - b.c.anchor || a.i - b.i).map((x) => x.c);
}

function applyEdits(src, edits) {
  let out = src;
  for (const [s, e, text] of [...edits].sort((a, b) => b[0] - a[0] || b[1] - a[1])) {
    out = out.slice(0, s) + text + out.slice(e);
  }
  return out;
}

// -------------------------------------------------------------------- files

function inside(base, target) {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function listSources(cwd, srcArg) {
  const abs = resolve(cwd, srcArg);
  let info;
  try {
    info = statSync(abs);
  } catch {
    throw new UsageError(`--src ${JSON.stringify(srcArg)} does not exist`);
  }
  let real;
  let realCwd;
  try {
    real = realpathSync(abs);
    realCwd = realpathSync(cwd);
  } catch {
    throw new UsageError(`--src ${JSON.stringify(srcArg)} cannot be read`);
  }
  if (!inside(cwd, abs) || !inside(realCwd, real)) throw new UsageError(`--src ${JSON.stringify(srcArg)} is outside the current directory`);
  const rels = [];
  const rel = (p) => relative(cwd, p).split(sep).join('/');
  if (info.isFile()) {
    rels.push(rel(abs));
  } else if (info.isDirectory()) {
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const st = statSync(full);
            isFile = st.isFile();
          } catch {
            isFile = false;
          }
        }
        if (isDir) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          walk(full);
        } else if (isFile && /\.(js|mjs|cjs)$/.test(entry.name)) {
          rels.push(rel(full));
        }
      }
    };
    walk(abs);
  } else {
    throw new UsageError(`--src ${JSON.stringify(srcArg)} is neither a file nor a folder`);
  }
  return rels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function copyTree(from, to, skipReal) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      let real = null;
      try {
        real = realpathSync(src);
      } catch {
        /* unreadable */
      }
      if (real !== null && real === skipReal) continue;
      copyTree(src, dst, skipReal);
    } else if (entry.isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(src), dst);
      } catch {
        /* skip */
      }
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
    }
  }
}

// ------------------------------------------------------------------ running

let current = null; // the test run in progress
let copyRoot = null;

function killGroup(child) {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function cleanup() {
  killGroup(current);
  current = null;
  if (copyRoot !== null) {
    const root = copyRoot;
    copyRoot = null;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  }
}

function runTest(command, cwd, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let output = '';
    let timedOut = false;
    let settled = false;
    const take = (chunk) => {
      output += chunk;
      if (output.length > 16000) output = output.slice(-8000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child);
      if (current === child) current = null;
      child.stdout.destroy();
      child.stderr.destroy();
      resolveRun({ ok: code === 0 && !timedOut, timedOut, output: output.slice(-4000), code, signal });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, Math.min(timeoutMs, 2 ** 31 - 1));
    child.on('error', () => finish(1, null));
    child.on('exit', (code, signal) => {
      // give the output a moment to drain, then settle
      const wait = setTimeout(() => finish(code, signal), 300);
      child.on('close', () => {
        clearTimeout(wait);
        finish(code, signal);
      });
    });
  });
}

// --------------------------------------------------------------------- main

const percentOf = (killed, total) => (total === 0 ? 100 : Math.round((1000 * killed) / total) / 10);

async function main() {
  let opts;
  let cwd;
  let files;
  try {
    opts = parseArgs(process.argv.slice(2));
    cwd = process.cwd();
    files = listSources(cwd, opts.src);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`can-fail: ${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  process.on('exit', cleanup);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(signal, () => {
      cleanup();
      process.exit(code);
    });
  }

  copyRoot = mkdtempSync(join(tmpdir(), 'can-fail-'));
  let skipReal = null;
  try {
    skipReal = realpathSync(copyRoot);
  } catch {
    /* none */
  }
  copyTree(cwd, copyRoot, skipReal);
  const timeoutMs = opts.timeout * 1000;

  const baseline = await runTest(opts.test, copyRoot, timeoutMs);
  if (!baseline.ok) {
    const head = baseline.timedOut
      ? `can-fail: the test command fails before any change: it timed out after ${opts.timeout} seconds`
      : 'can-fail: the test command fails before any change';
    process.stderr.write(`${head}\n${baseline.output}\n`);
    cleanup();
    process.exitCode = 2;
    return;
  }

  const survivors = [];
  const timeouts = [];
  let total = 0;
  let killed = 0;

  for (const rel of files) {
    let original;
    try {
      original = readFileSync(join(cwd, rel));
    } catch {
      continue;
    }
    const text = original.toString('utf8');
    const changes = findChanges(text);
    if (changes.length === 0) continue;
    const target = join(copyRoot, rel);
    // never write through a link into the original project
    try {
      if (lstatSync(target).isSymbolicLink()) {
        unlinkSync(target);
        writeFileSync(target, original);
      }
    } catch {
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, original);
    }
    for (const change of changes) {
      writeFileSync(target, applyEdits(text, change.edits));
      let result;
      try {
        result = await runTest(opts.test, copyRoot, timeoutMs);
      } finally {
        writeFileSync(target, original);
      }
      total++;
      const entry = { file: rel, line: change.line, change: change.change };
      if (result.timedOut) {
        killed++;
        timeouts.push(entry);
      } else if (result.ok) {
        survivors.push(entry);
      } else {
        killed++;
      }
    }
  }

  const score = percentOf(killed, total);
  let out;
  if (opts.json) {
    out = `${JSON.stringify({ total, killed, survived: survivors.length, score, survivors, timeouts })}\n`;
  } else {
    const lines = [];
    for (const s of survivors) lines.push(`SURVIVED ${s.file}:${s.line} ${s.change}`);
    for (const s of timeouts) lines.push(`TIMEOUT ${s.file}:${s.line} ${s.change}`);
    lines.push(`Score: ${killed}/${total} (${score}%)`);
    out = `${lines.join('\n')}\n`;
  }
  cleanup();
  process.stdout.write(out);
  process.exitCode = survivors.length > 0 ? 1 : 0;
}

main().catch((error) => {
  cleanup();
  process.stderr.write(`can-fail: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
