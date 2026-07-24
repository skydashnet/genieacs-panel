import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendDir = path.join(repoDir, 'backend');

test('automation shell scripts are syntactically valid', () => {
  const result = spawnSync('bash', [
    '-n',
    path.join(repoDir, 'deploy', 'install.sh'),
    path.join(repoDir, 'deploy', 'skygenpanel')
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('installer refuses a broad install directory before taking any action', () => {
  const result = spawnSync('bash', [path.join(repoDir, 'deploy', 'install.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SKYGP_DIR: '/',
      SKYGP_DATA: '/var/lib/skygenpanel-test'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Refusing unsafe install directory/);
});

test('installer rejects path ownership escapes and a root service user', () => {
  const installer = path.join(repoDir, 'deploy', 'install.sh');
  const cases = [
    {
      env: { SKYGP_DIR: '/var/lib/skygenpanel/source', SKYGP_DATA: '/var/lib/skygenpanel' },
      expected: /Install directory must not be inside the data directory/
    },
    {
      env: { SKYGP_DIR: '/opt/example/../skygenpanel', SKYGP_DATA: '/var/lib/skygenpanel' },
      expected: /must be normalized/
    },
    {
      env: { SKYGP_DIR: '/opt/skygenpanel', SKYGP_DATA: '/var/lib/skygenpanel', SKYGP_USER: 'root' },
      expected: /Refusing to run the service as root/
    }
  ];

  for (const entry of cases) {
    const result = spawnSync('bash', [installer], {
      encoding: 'utf8',
      env: { ...process.env, ...entry.env }
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, entry.expected);
  }
});

test('installer detects a regular user before attempting system changes', () => {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) return;

  const result = spawnSync('bash', [path.join(repoDir, 'deploy', 'install.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SKYGP_DIR: '/opt/skygenpanel-test',
      SKYGP_DATA: '/var/lib/skygenpanel-test'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Root privileges are required/);
  assert.match(`${result.stdout}\n${result.stderr}`, /\| sudo bash/);
});

test('installer bootstraps supported package managers and verifies official Node archives', () => {
  const installer = fs.readFileSync(path.join(repoDir, 'deploy', 'install.sh'), 'utf8');
  for (const packageManager of ['apt-get', 'dnf', 'yum', 'pacman', 'zypper']) {
    assert.match(installer, new RegExp(`command -v ${packageManager}`));
  }
  assert.match(installer, /latest-v\$\{NODE_RELEASE_LINE\}\.x/);
  assert.match(installer, /sha256sum --check --strict/);
  assert.match(installer, /node_runtime_ready/);
  assert.doesNotMatch(installer, /Node\.js not found\. Install Node\.js/);
});

test('database automation scripts load .env and reset passwords without sourcing it as shell', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-scripts-'));
  const dataDir = path.join(tempDir, 'data');
  fs.writeFileSync(path.join(tempDir, '.env'), [
    `DATA_DIR=${dataDir}`,
    'ADMIN_USERNAME=script-admin',
    'ADMIN_PASSWORD=initialPassword123'
  ].join('\n'));

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.DATA_DIR;
    delete cleanEnv.ADMIN_USERNAME;
    delete cleanEnv.ADMIN_PASSWORD;
    delete cleanEnv.RESET_PASSWORD;

    const init = spawnSync(process.execPath, [path.join(backendDir, 'scripts', 'init-db.js')], {
      cwd: tempDir,
      encoding: 'utf8',
      env: cleanEnv
    });
    assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);

    const reset = spawnSync(
      process.execPath,
      [path.join(backendDir, 'scripts', 'reset-password.js'), 'script-admin'],
      {
        cwd: tempDir,
        encoding: 'utf8',
        env: { ...cleanEnv, RESET_PASSWORD: 'updatedPassword123' }
      }
    );
    assert.equal(reset.status, 0, `${reset.stdout}\n${reset.stderr}`);

    const db = new Database(path.join(dataDir, 'panel.sqlite'), { readonly: true });
    const user = db.prepare('SELECT password FROM users WHERE username = ?').get('script-admin');
    db.close();
    assert.ok(user);
    assert.equal(bcrypt.compareSync('updatedPassword123', user.password), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
