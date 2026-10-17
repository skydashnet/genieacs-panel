#!/usr/bin/env node

/**
 * Reads a `node --test` TAP stream and prints only what explains a failure.
 *
 * This exists because of an afternoon spent on log archaeology. A CI job that
 * fails prints the whole TAP stream — every passing subtest, its duration, its
 * YAML block — and then the database service container dumps its own log on
 * top. The three lines naming the test that actually broke sit somewhere in the
 * middle of ten thousand, and the web view will not search a log it has not
 * finished streaming. The failure was legible in principle and unreachable in
 * practice.
 *
 * Two distinctions do most of the work here, and both were learned the hard
 * way:
 *
 *   A cancelled test is NOT a failing test. When a `before` hook throws, node
 *   marks every test under it `not ok` with `cancelledByParent`. One real
 *   failure becomes three hundred, and the one that matters looks exactly like
 *   the noise. They are counted here and named by file, never quoted.
 *
 *   `# fail 0` with a non-zero exit is a process that DIED. Nothing asserted
 *   wrong; the run ended before it finished, so the tests that never got to run
 *   are reported as cancelled. That reads as "nothing failed" and means the
 *   opposite, so it gets said out loud.
 *
 * Usage: node scripts/tap-failures.mjs <tap-file>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOT_OK = /^(\s*)not ok \d+ - (.*)$/;
const COUNT = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/;

/**
 * The YAML block that follows a `not ok`, as a flat object.
 *
 * Hand-parsed rather than pulled from a YAML library: the shape node emits is
 * `key: value` and `key: |-` with an indented block, and a dependency in a
 * diagnostic script is a dependency that can break the diagnosis.
 */
function readBlock(lines, start, indent) {
  const open = `${indent}  ---`;
  const close = `${indent}  ...`;
  if (lines[start] !== open) return { fields: {}, next: start };

  // A key sits at EXACTLY this depth; anything deeper is the body of a `|-`
  // block. Matching on "looks like key: value" instead cost an hour: the first
  // line of knex's error is `Knex: run`, so the message that named the problem
  // was parsed as a field and thrown away.
  const keyDepth = indent.length + 2;
  const fields = {};
  let i = start + 1;
  let key = null;
  let folded = [];

  const flush = () => {
    if (key) fields[key] = folded.join('\n').trim();
  };

  while (i < lines.length && lines[i] !== close) {
    const line = lines[i];
    const depth = line.length - line.trimStart().length;
    const match = depth === keyDepth ? /^\s*([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(line) : null;
    if (match) {
      flush();
      [, key] = match;
      folded = match[2] === '|-' ? [] : [match[2]];
    } else if (key) {
      folded.push(line.slice(keyDepth + 2));
    }
    i += 1;
  }
  flush();
  return { fields, next: i + 1 };
}

/** `'/long/path/backend/test/x.test.js:12:3'` → `test/x.test.js:12`. */
function shortLocation(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/^'|'$/g, '');
  const match = /(?:^|\/)((?:backend\/)?test\/[^:]+):(\d+)/.exec(cleaned);
  return match ? `${match[1]}:${match[2]}` : cleaned;
}

/**
 * Strips the quotes off a scalar, and only off a scalar.
 *
 * A `|-` block is not quoted, and stripping a trailing `'` from one eats the
 * last character of a message that happens to end in a quote — which is exactly
 * how `Cannot find module 'pg'` arrived as `Cannot find module 'pg`.
 */
function unquote(value) {
  const text = String(value ?? '');
  const scalar = !text.includes('\n') && text.length > 1
    && text.startsWith("'") && text.endsWith("'");
  return scalar ? text.slice(1, -1) : text;
}

function parse(tap) {
  const lines = tap.split('\n');
  const counts = {};
  const roots = [];
  const cancelledByFile = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const count = COUNT.exec(lines[i]);
    if (count) {
      counts[count[1]] = Number(count[2]);
      continue;
    }

    const failure = NOT_OK.exec(lines[i]);
    if (!failure) continue;

    const [, indent, name] = failure;
    const { fields, next } = readBlock(lines, i + 1, indent);
    i = next - 1;

    const kind = unquote(fields.failureType);
    const where = shortLocation(fields.location);

    if (kind === 'cancelledByParent') {
      const file = (where || 'unknown').split(':')[0];
      cancelledByFile.set(file, (cancelledByFile.get(file) ?? 0) + 1);
      continue;
    }
    // A suite is `not ok` merely because something under it is. The thing
    // under it is already in this list, and repeating the parent buries it.
    if (kind === 'subtestsFailed') continue;

    roots.push({ name, kind, where, error: unquote(fields.error) });
  }

  return { counts, roots: groupRoots(roots), cancelledByFile };
}

/**
 * Collapses root failures that are the same failure said again.
 *
 * One broken `before` hook is reported once per suite in the file, so a single
 * cause arrives as sixteen entries with identical text. Repeating it sixteen
 * times buries the next cause exactly as the cancelled tests would, so they are
 * folded on file plus the first line of the message — the part that names the
 * problem — and the suites they hit are counted instead of listed.
 */
function groupRoots(roots) {
  const groups = new Map();
  for (const root of roots) {
    const file = (root.where || 'unknown').split(':')[0];
    const headline = (root.error || root.kind || '').split('\n')[0];
    const key = `${file}\u0000${headline}`;
    const seen = groups.get(key);
    if (seen) {
      seen.repeats += 1;
      continue;
    }
    groups.set(key, { ...root, repeats: 1 });
  }
  return [...groups.values()];
}

function report({ counts, roots, cancelledByFile }) {
  const out = [];
  const tally = ['tests', 'pass', 'fail', 'cancelled', 'skipped']
    .filter((key) => counts[key] !== undefined)
    .map((key) => `${key} ${counts[key]}`)
    .join('  ');
  out.push(`── node --test ──  ${tally || '(no summary line in the stream)'}`);

  if (roots.length === 0 && counts.cancelled > 0 && !counts.fail) {
    out.push('');
    out.push('Nothing asserted wrong: every test that did not pass was CANCELLED,');
    out.push('which means the run ended before it got to them. Look for a crash, an');
    out.push('unhandled rejection, or a hook that never settled — not for a bad assertion.');
  }

  if (roots.length > 0) {
    out.push('');
    out.push(`Root failures (${roots.length}) — everything else follows from these:`);
    for (const root of roots) {
      out.push('');
      const also = root.repeats > 1 ? `  (+${root.repeats - 1} more suites, same message)` : '';
      out.push(`  ✗ ${root.name}${also}`);
      if (root.where) out.push(`    ${root.where}`);
      if (root.kind) out.push(`    ${root.kind}`);
      for (const line of (root.error || '').split('\n').filter(Boolean).slice(0, 12)) {
        out.push(`    | ${line}`);
      }
    }
  }

  if (cancelledByFile.size > 0) {
    const total = [...cancelledByFile.values()].reduce((sum, n) => sum + n, 0);
    out.push('');
    out.push(`Cancelled (${total}) — consequences, not causes, by file:`);
    for (const [file, n] of [...cancelledByFile].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(n).padStart(4)}  ${file}`);
    }
  }

  if (roots.length === 0 && cancelledByFile.size === 0) {
    out.push('');
    out.push('No failing test in this stream. If the job still failed, it failed');
    out.push('outside the test run — installation, lint, or the process itself.');
  }

  return out.join('\n');
}

// Exported so the digest itself can be tested. A tool that explains failures
// is read when someone is already stuck, and one that explains them WRONGLY is
// worse than none -- two parsing bugs were found by hand before this line
// existed, and neither announced itself.
export { parse, report };

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node scripts/tap-failures.mjs <tap-file>');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`no such TAP file: ${file}`);
    process.exit(2);
  }
  console.log(report(parse(fs.readFileSync(file, 'utf8'))));
}
