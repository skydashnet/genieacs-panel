import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectCommits,
  createGit,
  determineBump,
  findPreviousRelease,
  pickPrevious
} from '../../scripts/prepare-release.mjs';

/**
 * Where the release script decides the last release was, and what the next
 * one is made of.
 *
 * It used to ask `git describe --tags`, and tags here are published by hand.
 * Three releases went out without one, so the script fell back to v1.14.0,
 * recomputed 1.15.0 — a heading the CHANGELOG already carried — and refused to
 * run. Every case below is a history this repository had, or one a hotfix
 * would give it, built in a throwaway repository so the answer does not depend
 * on which tags happen to exist on the machine running the suite.
 */

const scratch = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-release-'));
  scratch.push(dir);
  // One second per git call. Commits made inside the same second have no
  // defined order, and several assertions below read the order back.
  let clock = Date.UTC(2026, 0, 1) / 1000;
  const run = (...args) => {
    clock += 1;
    const when = `${clock} +0000`;
    return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Release Test',
        GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
        GIT_COMMITTER_NAME: 'Release Test',
        GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  };
  run('init', '-q');
  const commit = (subject, body) => {
    const args = ['commit', '-q', '--allow-empty', '-m', subject];
    if (body) args.push('-m', body);
    run(...args);
    return run('rev-parse', 'HEAD');
  };
  const merge = (branch, message) => run('merge', '-q', '--no-ff', '-m', message, branch);
  const { git, tryGit } = createGit(dir);
  return { run, commit, merge, git, tryGit };
}

const subjects = (commits) => commits.map((commit) => commit.subject);

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('finding the release this one follows', () => {
  it('reads it from the release commit when no tag was ever published', () => {
    const repo = makeRepo();
    repo.commit('feat: first thing');
    const release = repo.commit('chore(release): v1.4.0');
    repo.commit('fix: after the release');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.4.0');
    assert.equal(previous.ref, release);
    assert.equal(previous.source, 'release commit');
    assert.equal(previous.label, 'v1.4.0');
  });

  /** The exact failure: the only tag is releases old, the release commits are not. */
  it('does not fall back to a stale tag behind newer release commits', () => {
    const repo = makeRepo();
    repo.commit('feat: old work');
    repo.run('tag', '-a', 'v1.14.0', '-m', 'v1.14.0');
    repo.commit('feat: newer work');
    repo.commit('chore(release): v1.15.0');
    repo.commit('feat: newest work');
    const release = repo.commit('chore(release): v1.16.0');
    repo.commit('fix: pending');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.16.0');
    assert.equal(previous.ref, release);
  });

  it('takes the tag when it names a newer version than any release commit', () => {
    const repo = makeRepo();
    repo.commit('chore(release): v1.0.0');
    const tagged = repo.commit('feat: cut by hand');
    repo.run('tag', '-a', 'v2.0.0', '-m', 'v2.0.0');
    repo.commit('fix: after it');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '2.0.0');
    assert.equal(previous.ref, tagged);
    assert.equal(previous.source, 'tag');
  });

  it('ignores anything that only looks like a release commit', () => {
    const repo = makeRepo();
    repo.commit('chore(release): v1.2.0');
    repo.commit('chore(release): prepare the notes');
    repo.commit('chore(release): v1.3.0-rc.1');
    repo.commit('docs: explain the process', 'mentions chore(release): v9.9.9 in the body');

    assert.equal(findPreviousRelease(repo.tryGit).version, '1.2.0');
  });

  it('answers null when there has never been a release', () => {
    const repo = makeRepo();
    repo.commit('feat: the start');
    assert.equal(findPreviousRelease(repo.tryGit), null);
  });
});

describe('choosing between two markers of the same version', () => {
  /**
   * A tag placed on the merge that carried a release, rather than on the
   * release commit — as the hand-written instructions for v1.15.0 once did.
   * Given in both orders, because the order the candidates arrive in must not
   * be what decides.
   */
  it('prefers the release commit whichever arrives first', () => {
    const tag = { version: '1.15.0', ref: 'merge', source: 'tag' };
    const commit = { version: '1.15.0', ref: 'release', source: 'release commit' };
    assert.equal(pickPrevious([tag, commit]).ref, 'release');
    assert.equal(pickPrevious([commit, tag]).ref, 'release');
  });

  it('still lets a higher version win over the release commit', () => {
    const tag = { version: '1.16.0', ref: 'merge', source: 'tag' };
    const commit = { version: '1.15.0', ref: 'release', source: 'release commit' };
    assert.equal(pickPrevious([commit, tag]).ref, 'merge');
  });

  it('answers null for no candidates', () => {
    assert.equal(pickPrevious([]), null);
  });

  /**
   * The same history end to end. The merge the tag sits on also brought work
   * the next release documents; excluding the losing tag's ancestors along
   * with the release commit's would hide it.
   */
  it('does not let a same-version tag on the merge hide the next release\'s work', () => {
    const repo = makeRepo();
    repo.commit('feat: base');
    const release = repo.commit('chore(release): v1.15.0');
    repo.run('checkout', '-q', '-b', 'history');
    repo.commit('feat: belongs to 1.16.0');
    repo.run('checkout', '-q', 'main');
    repo.merge('history', 'Merge the history branch');
    repo.run('tag', '-a', 'v1.15.0', '-m', 'v1.15.0');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.ref, release);
    assert.deepEqual(subjects(collectCommits(repo.git, previous)), ['feat: belongs to 1.16.0']);
  });
});

describe('the commits the next release is made of', () => {
  /**
   * The history of v1.16.0: a commit merged beside the release commit rather
   * than into it. Anchored on the merge, it belongs to no release; anchored on
   * the release commit, the next one lists it.
   */
  it('lists work merged beside a release commit in the release after it', () => {
    const repo = makeRepo();
    repo.commit('feat: shipped in the last release');
    repo.run('checkout', '-q', '-b', 'security');
    repo.commit('Close the three SSRF holes');
    repo.run('checkout', '-q', 'main');
    repo.commit('chore(release): v1.16.0');
    repo.merge('security', 'Merge the security branch');
    repo.commit('feat: new after the release');

    const commits = collectCommits(repo.git, findPreviousRelease(repo.tryGit));
    assert.deepEqual(subjects(commits), ['Close the three SSRF holes', 'feat: new after the release']);
    assert.equal(determineBump(commits), 'minor');
  });

  it('lists neither merges nor release commits, and nothing already released', () => {
    const repo = makeRepo();
    repo.commit('feat: in 1.0.0');
    repo.commit('chore(release): v1.0.0');
    repo.run('checkout', '-q', '-b', 'side');
    repo.commit('fix: from a side branch');
    repo.run('checkout', '-q', 'main');
    repo.commit('feat: on main');
    repo.merge('side', 'Merge the side branch');

    const commits = collectCommits(repo.git, findPreviousRelease(repo.tryGit));
    assert.deepEqual(subjects(commits), ['fix: from a side branch', 'feat: on main']);
  });

  /**
   * A hotfix released from its own branch, then merged back after a newer
   * release was cut on main. The newest release does not contain the hotfix,
   * but the hotfix's own release does — and it must not be listed twice.
   */
  it('does not list a hotfix again once its branch is merged back', () => {
    const repo = makeRepo();
    repo.commit('feat: base');
    repo.commit('chore(release): v1.17.0');
    repo.run('checkout', '-q', '-b', 'hotfix');
    repo.run('checkout', '-q', 'main');
    repo.commit('feat: big');
    repo.commit('chore(release): v1.18.0');
    repo.run('checkout', '-q', 'hotfix');
    repo.commit('fix: urgent');
    repo.commit('chore(release): v1.17.1');
    repo.run('checkout', '-q', 'main');
    repo.merge('hotfix', 'Merge the hotfix back');
    repo.commit('fix: later');

    const previous = findPreviousRelease(repo.tryGit);
    assert.equal(previous.version, '1.18.0');
    assert.deepEqual(subjects(collectCommits(repo.git, previous)), ['fix: later']);
  });
});
