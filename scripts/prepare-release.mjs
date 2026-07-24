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

function git(args) {
  return execFileSync('git', args, {
    cwd: rootDir,
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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(
    path.join(rootDir, relativePath),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported semantic version: ${version}`);
  return match.slice(1).map(Number);
}

function bumpVersion(version, level) {
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

function parseCommit(line) {
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

function determineBump(commits) {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  return 'patch';
}

function calculateVersionFromHistory(commits) {
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

function renderChangelog(version, date, commits, compareUrl) {
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

const latestTag = tryGit(['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0']);
const logRange = latestTag ? `${latestTag}..HEAD` : 'HEAD';
const logOutput = git([
  'log',
  '--reverse',
  '--format=%H%x1f%h%x1f%cs%x1f%s',
  logRange
]);
const commits = logOutput ? logOutput.split('\n').map(parseCommit) : [];
if (commits.length === 0) {
  throw new Error(`No commits found after ${latestTag || 'repository start'}; there is nothing to release.`);
}

const nextVersion = latestTag
  ? bumpVersion(latestTag.replace(/^v/, ''), determineBump(commits))
  : calculateVersionFromHistory(commits);
const currentCommit = git(['rev-parse', '--short=12', 'HEAD']);
const currentCount = Number(git(['rev-list', '--count', 'HEAD']));
const releaseDate = new Date().toISOString().slice(0, 10);
const repositoryUrl = 'https://github.com/skydashnet/genieacs-panel';
const compareUrl = latestTag
  ? `${repositoryUrl}/compare/${latestTag}...v${nextVersion}`
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
  basedOnTag: latestTag || 'repository start',
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

console.log(`Prepared SkyGenPanel v${nextVersion} (build ${currentCount + 1}) from ${commits.length} Git commit(s).`);
