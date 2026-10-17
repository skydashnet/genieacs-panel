import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parse, report } from '../../scripts/tap-failures.mjs';

/**
 * The digest CI prints when a job goes red.
 *
 * Tested because of what it is FOR: it is read by someone who is already stuck,
 * and one that reads a stream wrongly sends them somewhere the bug is not.
 * Both cases below are streams this repository actually produced — the cascade
 * from a broken `before` hook, and the run that died with nothing asserted
 * wrong.
 */

/** A hook that throws: one cause, one `not ok` per suite, and the rest cancelled. */
const CASCADE = `TAP version 13
# Subtest: the settings routes
    # Subtest: hands back the four rules
    not ok 1 - hands back the four rules
      ---
      duration_ms: 0
      type: 'test'
      location: '/home/runner/work/panel/backend/test/whatsapp-alerts.test.js:129:3'
      failureType: 'cancelledByParent'
      error: 'test did not finish before its parent and was cancelled'
      code: 'ERR_TEST_FAILURE'
      ...
    # Subtest: saves what it is given
    not ok 2 - saves what it is given
      ---
      duration_ms: 0
      type: 'test'
      location: '/home/runner/work/panel/backend/test/whatsapp-alerts.test.js:145:3'
      failureType: 'cancelledByParent'
      error: 'test did not finish before its parent and was cancelled'
      code: 'ERR_TEST_FAILURE'
      ...
not ok 1 - the settings routes
  ---
  duration_ms: 10.9
  type: 'suite'
  location: '/home/runner/work/panel/backend/test/whatsapp-alerts.test.js:128:1'
  failureType: 'hookFailed'
  error: |-
    Knex: run
    $ npm install pg --save
    Cannot find module 'pg'
  code: 'ERR_TEST_FAILURE'
  ...
not ok 2 - each rule fires at its threshold
  ---
  duration_ms: 4.2
  type: 'suite'
  location: '/home/runner/work/panel/backend/test/whatsapp-alerts.test.js:214:1'
  failureType: 'hookFailed'
  error: |-
    Knex: run
    $ npm install pg --save
    Cannot find module 'pg'
  code: 'ERR_TEST_FAILURE'
  ...
# tests 4
# pass 0
# fail 2
# cancelled 2
`;

/** The shape a torn-down process leaves: nothing failed, and it still went red. */
const DIED = `TAP version 13
    not ok 1 - claims a queued message exactly once
      ---
      duration_ms: 0
      type: 'test'
      location: '/home/runner/work/panel/backend/test/whatsapp-outbox.test.js:40:3'
      failureType: 'cancelledByParent'
      error: 'test did not finish before its parent and was cancelled'
      code: 'ERR_TEST_FAILURE'
      ...
# tests 1103
# pass 1092
# fail 0
# cancelled 11
`;

const GREEN = `TAP version 13
ok 1 - everything
# tests 1466
# pass 1466
# fail 0
# cancelled 0
`;

describe('the CI failure digest', () => {
  it('keeps the cause and drops the cancellations that follow from it', () => {
    const { roots, cancelledByFile } = parse(CASCADE);

    // Two suites, one message: the second is the same failure said again.
    assert.equal(roots.length, 1);
    assert.equal(roots[0].repeats, 2);
    assert.equal(roots[0].where, 'backend/test/whatsapp-alerts.test.js:128');
    assert.equal(cancelledByFile.get('backend/test/whatsapp-alerts.test.js'), 2);
  });

  /**
   * The first line of knex's message is `Knex: run`, which an earlier version
   * read as a YAML key and threw away — losing the only line that named the
   * problem. Depth decides what a key is now, not shape.
   */
  it('keeps a folded message whose own text looks like a key', () => {
    const { roots } = parse(CASCADE);
    assert.match(roots[0].error, /Cannot find module 'pg'/);
    assert.match(roots[0].error, /^Knex: run/);
  });

  it('says out loud that a run with no failures still died', () => {
    const text = report(parse(DIED));

    assert.match(text, /CANCELLED/);
    assert.match(text, /ended before it got to them/);
    // The count has to survive: `fail 0` is what makes this one read as fine.
    assert.match(text, /cancelled 11/);
  });

  it('never quotes a cancelled test as though it were a cause', () => {
    const text = report(parse(DIED));
    assert.doesNotMatch(text, /claims a queued message exactly once/);
    assert.match(text, /whatsapp-outbox\.test\.js/);
  });

  it('does not invent a failure in a green stream', () => {
    const text = report(parse(GREEN));
    assert.match(text, /pass 1466/);
    assert.match(text, /No failing test in this stream/);
  });

  it('reads the counts even when the stream carries nothing else', () => {
    const { counts } = parse('# tests 3\n# pass 3\n# fail 0\n');
    assert.deepEqual(counts, { tests: 3, pass: 3, fail: 0 });
  });
});
