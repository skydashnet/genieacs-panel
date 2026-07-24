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

test('updater removes only known legacy Next.js build directories', () => {
  const updater = fs.readFileSync(path.join(repoDir, 'deploy', 'skygenpanel'), 'utf8');
  assert.match(updater, /frontend\/\.next/);
  assert.match(updater, /frontend\/out/);
  assert.match(updater, /Refusing symbolic-link legacy artifact/);
  assert.match(updater, /install -m 0755 "\$INSTALL_DIR\/deploy\/skygenpanel"/);
  assert.match(updater, /mv -f -- "\$cli_temp" "\$CLI_PATH"/);
  assert.doesNotMatch(updater, /git\s+-C\s+"?\$INSTALL_DIR"?\s+clean/);
  assert.match(updater, /PORTAL_PORT=5891/);
  assert.match(updater, /PORTAL_JWT_SECRET/);
});

test('map is bundled locally and centers existing assets at zoom 15', () => {
  const source = fs.readFileSync(path.join(repoDir, 'frontend', 'src', 'pages', 'network-map.tsx'), 'utf8');
  assert.match(source, /import 'leaflet\/dist\/leaflet\.css'/);
  assert.match(source, /leafletModulePromise = import\('leaflet'\)/);
  assert.match(source, /map\.setView\(/);
  assert.match(source, /Math\.min\(maxZoom, Math\.max\(minZoom, 15\)\)/);
  assert.doesNotMatch(source, /unpkg\.com/);
  assert.doesNotMatch(source, /mapView !== 'map' \|\| loading/);
});

test('deployment exposes the isolated customer portal and generates independent secrets', () => {
  const installer = fs.readFileSync(path.join(repoDir, 'deploy', 'install.sh'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(repoDir, 'Dockerfile'), 'utf8');
  assert.match(installer, /SKYGP_PORTAL_PORT:-5891/);
  assert.match(installer, /PORTAL_JWT_SECRET/);
  assert.match(installer, /Panel and customer portal ports must be different/);
  assert.match(dockerfile, /EXPOSE 5890 5891/);
});

test('global toast system owns settings notifications and suppresses duplicate spam', () => {
  const settings = fs.readFileSync(path.join(repoDir, 'frontend', 'src', 'pages', 'settings.tsx'), 'utf8');
  const toast = fs.readFileSync(path.join(repoDir, 'frontend', 'src', 'components', 'ui', 'toast.tsx'), 'utf8');
  assert.doesNotMatch(settings, /setNotification|\{notification &&/);
  assert.match(toast, /MAX_VISIBLE_TOASTS = 4/);
  assert.match(toast, /const duplicate = toastsRef\.current\.find/);
  assert.match(toast, /toast\.message === opts\.message/);
  assert.match(toast, /pointer-events-none fixed/);
  assert.match(toast, /aria-atomic="true"/);
});

test('release metadata stays synchronized with every package manifest and lockfile', () => {
  const release = JSON.parse(fs.readFileSync(
    path.join(repoDir, 'frontend', 'src', 'generated', 'release.json'),
    'utf8'
  ));
  const versionedFiles = [
    'package.json',
    'backend/package.json',
    'frontend/package.json',
    'backend/package-lock.json',
    'frontend/package-lock.json'
  ];
  for (const relativePath of versionedFiles) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, relativePath), 'utf8'));
    assert.equal(manifest.version, release.version, `${relativePath} has a different version`);
    if (manifest.packages?.['']) {
      assert.equal(manifest.packages[''].version, release.version, `${relativePath} root package is stale`);
    }
  }

  const changelog = fs.readFileSync(path.join(repoDir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, new RegExp(`^## \\[${release.version.replaceAll('.', '\\.')}\\]`, 'm'));
  assert.match(release.sourceCommit, /^[0-9a-f]{7,12}$/);
  assert.ok(Number.isInteger(release.build) && release.build > 0);
});

test('desktop sidebar remains viewport-sticky without a clipping scroll ancestor', () => {
  const appSource = fs.readFileSync(path.join(repoDir, 'frontend', 'src', 'app.tsx'), 'utf8');
  const sidebarSource = fs.readFileSync(path.join(repoDir, 'frontend', 'src', 'components', 'sidebar.tsx'), 'utf8');

  assert.match(appSource, /className="flex min-h-screen"/);
  assert.doesNotMatch(appSource, /className="flex min-h-screen overflow-[^"]+"/);
  assert.match(sidebarSource, /sticky top-0[^`]*h-screen[^`]*overflow-visible/);
  assert.doesNotMatch(sidebarSource, /sticky top-0[^`]*overflow-hidden/);
  assert.match(sidebarSource, /absolute -right-3/);
});

test('dashboard charts stay dependency-light and do not load Recharts', () => {
  const frontendManifest = JSON.parse(fs.readFileSync(path.join(repoDir, 'frontend', 'package.json'), 'utf8'));
  assert.equal(frontendManifest.dependencies.recharts, undefined);
  for (const chart of ['pie-chart.tsx', 'bar-chart.tsx', 'trend-chart.tsx']) {
    const source = fs.readFileSync(path.join(repoDir, 'frontend', 'src', 'components', 'charts', chart), 'utf8');
    assert.doesNotMatch(source, /from ['"]recharts['"]/);
  }
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
