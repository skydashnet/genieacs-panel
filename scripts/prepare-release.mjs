#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePaths = [
  'package.json',
  'backend/package.json',
  'frontend/package.json'
];
const lockPaths = [
  'backend/package-lock.json',
  'frontend/package-lock.json'
];
const releasePath = 'frontend/src/generated/release.json';
const changelogPath = 'CHANGELOG.md';
const repositoryUrl = 'https://github.com/tavaresbr/genieacs-panel';

/** The subject this script's own commit carries, and the one it looks for. */
const RELEASE_SUBJECT = /^chore\(release\):\s*v(\d+\.\d+\.\d+)\s*$/i;

export function createGit(cwd) {
  function git(args) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  }
  function tryGit(args) {
    try {
      return git(args);
    } catch {
      return '';
    }
  }
  return { git, tryGit };
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(
    path.join(rootDir, relativePath),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported semantic version: ${version}`);
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function bumpVersion(version, level) {
  let [major, minor, patch] = parseVersion(version);
  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

export function parseCommit(line) {
  const [hash, shortHash, date, ...subjectParts] = line.split('\u001f');
  const subject = subjectParts.join('\u001f').trim();
  const conventional = /^([a-z]+)(?:\([^)]+\))?(!)?:\s*(.+)$/i.exec(subject);
  const loose = /^(feat|fix|perf|refactor|security)\b[\s:-]+(.+)$/i.exec(subject);
  const type = (conventional?.[1] || loose?.[1] || 'other').toLowerCase();
  const breaking = Boolean(conventional?.[2]) || /BREAKING[ -]CHANGE/i.test(subject);
  const rawTitle = conventional?.[3] || loose?.[2] || subject;
  const title = rawTitle ? `${rawTitle[0].toUpperCase()}${rawTitle.slice(1)}` : shortHash;
  const category = breaking
    ? 'Breaking'
    : ({
        feat: 'New',
        fix: 'Fixed',
        perf: 'Improved',
        refactor: 'Changed',
        security: 'Security'
      }[type] || 'Maintenance');

  return { hash, shortHash, date, subject, title, type, breaking, category };
}

export function determineBump(commits) {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  return 'patch';
}

export function calculateVersionFromHistory(commits) {
  let version = '1.0.0';
  for (const commit of commits) {
    if (commit.breaking) {
      version = bumpVersion(version, 'major');
    } else if (commit.type === 'feat') {
      version = bumpVersion(version, 'minor');
    } else if (['fix', 'perf', 'refactor', 'security'].includes(commit.type)) {
      version = bumpVersion(version, 'patch');
    }
  }
  return version;
}

/**
 * The release this one follows: the highest version declared by a
 * `chore(release): vX.Y.Z` commit reachable from HEAD, or by a `v*` tag.
 *
 * The release commit is the source of truth because it is the one thing every
 * release is guaranteed to have — this script writes it. Tags are published by
 * hand, and for three releases in a row they were not: deriving from
 * `git describe --tags` alone fell back to v1.14.0, recomputed a version the
 * CHANGELOG already carried, and refused to run. A tag still counts when it is
 * the only marker, or names a newer version than any release commit.
 *
 * Anchoring on the release commit rather than the merge that carried it also
 * means a commit merged alongside a release, but not into it, is listed by the
 * next one instead of by none.
 */
export function findPreviousRelease(tryGit) {
  const candidates = [];

  const log = tryGit(['log', '--format=%H%x1f%s', '--fixed-strings', '--grep=chore(release)', 'HEAD']);
  for (const line of log ? log.split('\n') : []) {
    const [hash, subject = ''] = line.split('\u001f');
    const match = RELEASE_SUBJECT.exec(subject.trim());
    if (match) candidates.push({ version: match[1], ref: hash, source: 'release commit' });
  }

  const tag = tryGit(['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0']);
  if (tag && /^v\d+\.\d+\.\d+$/.test(tag)) {
    const ref = tryGit(['rev-list', '-n', '1', tag]);
    if (ref) candidates.push({ version: tag.slice(1), ref, source: 'tag' });
  }

  const previous = pickPrevious(candidates);
  if (!previous) return null;
  // Everything any release already shipped: every release commit, and the
  // winner even when it is a tag. A tag that lost is left out on purpose —
  // one sitting on the merge that carried its release also carries work the
  // next release documents, and excluding it would hide that work.
  const released = [...new Set([
    ...candidates.filter((c) => c.source === 'release commit').map((c) => c.ref),
    previous.ref
  ])];
  return { ...previous, label: `v${previous.version}`, released };
}

/**
 * Highest version wins; on a tie the release commit does, since it is the
 * commit that declared the version and a tag may have been placed elsewhere.
 */
export function pickPrevious(candidates) {
  const rank = (candidate) => (candidate.source === 'release commit' ? 0 : 1);
  return [...candidates].sort((a, b) => compareVersions(b.version, a.version) || rank(a) - rank(b))[0] || null;
}

/**
 * The commits the next release is made of: reachable from HEAD and from no
 * release already cut. Excluding every release, not only the latest, keeps a
 * hotfix released from a side branch out of the next release once that branch
 * is merged back.
 */
export function collectCommits(git, previous) {
  const released = previous ? (previous.released || [previous.ref]) : [];
  const logRange = released.length ? ['HEAD', '--not', ...released] : ['HEAD'];
  // Merge commits carry no release note of their own: their subject repeats the
  // branch that produced them, while the work itself is already listed by the
  // commits they bring in.
  const logOutput = git([
    'log',
    '--reverse',
    '--no-merges',
    '--format=%H%x1f%h%x1f%cs%x1f%s',
    ...logRange
  ]);
  // A release commit documents the release itself, so it is never a note in the
  // next one — which happens whenever a release is regenerated before its tag
  // exists.
  return (logOutput ? logOutput.split('\n').map(parseCommit) : [])
    .filter((commit) => !/^chore\(release\)/i.test(commit.subject));
}

export function renderChangelog(version, date, commits, compareUrl) {
  const categoryOrder = ['Breaking', 'New', 'Improved', 'Fixed', 'Changed', 'Security', 'Maintenance'];
  const groups = new Map();
  for (const commit of commits) {
    if (!groups.has(commit.category)) groups.set(commit.category, []);
    groups.get(commit.category).push(commit);
  }
  const lines = [`## [${version}] - ${date}`, ''];
  for (const category of categoryOrder) {
    const entries = groups.get(category);
    if (!entries?.length) continue;
    lines.push(`### ${category}`, '');
    for (const entry of entries) {
      lines.push(`- ${entry.title} (\`${entry.shortHash}\`)`);
    }
    lines.push('');
  }
  if (compareUrl) lines.push(`[Full comparison](${compareUrl})`, '');
  return lines.join('\n');
}

function main() {
  const { git, tryGit } = createGit(rootDir);
  const previous = findPreviousRelease(tryGit);
  const commits = collectCommits(git, previous);
  if (commits.length === 0) {
    throw new Error(`No commits found after ${previous?.label || 'repository start'}; there is nothing to release.`);
  }

  const nextVersion = previous
    ? bumpVersion(previous.version, determineBump(commits))
    : calculateVersionFromHistory(commits);
  const currentCommit = git(['rev-parse', '--short=12', 'HEAD']);
  const currentCount = Number(git(['rev-list', '--count', 'HEAD']));
  const releaseDate = new Date().toISOString().slice(0, 10);
  // Commit to commit rather than tag to tag: the link has to work on the day
  // the release is cut, whether or not anyone has published a tag since.
  const compareUrl = previous
    ? `${repositoryUrl}/compare/${previous.ref.slice(0, 12)}...${currentCommit}`
    : `${repositoryUrl}/commits/${currentCommit}`;

  for (const relativePath of packagePaths) {
    const manifest = readJson(relativePath);
    manifest.version = nextVersion;
    writeJson(relativePath, manifest);
  }
  for (const relativePath of lockPaths) {
    const lock = readJson(relativePath);
    lock.version = nextVersion;
    if (lock.packages?.['']) lock.packages[''].version = nextVersion;
    writeJson(relativePath, lock);
  }

  writeJson(releasePath, {
    version: nextVersion,
    build: currentCount + 1,
    sourceCommit: currentCommit,
    releasedAt: releaseDate,
    basedOnTag: previous?.label || 'repository start',
    compareUrl,
    changes: commits.map(({ shortHash, date, title, category }) => ({
      shortHash,
      date,
      title,
      category
    }))
  });

  const changelogFile = path.join(rootDir, changelogPath);
  const changelog = fs.readFileSync(changelogFile, 'utf8');
  if (changelog.includes(`## [${nextVersion}]`)) {
    throw new Error(`CHANGELOG.md already contains version ${nextVersion}.`);
  }
  const firstReleaseIndex = changelog.indexOf('\n## ');
  const header = firstReleaseIndex === -1 ? changelog.trimEnd() : changelog.slice(0, firstReleaseIndex).trimEnd();
  const previousReleases = firstReleaseIndex === -1 ? '' : changelog.slice(firstReleaseIndex + 1).trim();
  const releaseEntry = renderChangelog(nextVersion, releaseDate, commits, compareUrl).trim();
  fs.writeFileSync(
    changelogFile,
    `${header}\n\n${releaseEntry}${previousReleases ? `\n\n${previousReleases}` : ''}\n`
  );

  console.log(`Prepared TR69 Controle v${nextVersion} (build ${currentCount + 1}) from ${commits.length} Git commit(s), after ${previous?.label || 'repository start'} (${previous?.source || 'no previous release'}).`);
}

// `import.meta.url` is always the resolved file, so the path it was invoked by
// has to be resolved too — otherwise a symlinked checkout exits 0 having done
// nothing.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
