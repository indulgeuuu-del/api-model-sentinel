'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
});
if (listed.status !== 0) throw Error('Run checks inside the source Git checkout');
const files = [...new Set(listed.stdout.trim().split(/\r?\n/).filter(Boolean))];
let errors = 0;
for (const file of files) {
  const absolute = path.join(root, file);
  if (!fs.statSync(absolute).isFile()) continue;
  if (/\.(cjs|js)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(file + ': ' + result.stderr);
      errors++;
    }
  }
  if (/\.(png|jpg|zip|tgz|ico)$/.test(file)) continue;
  const source = fs.readFileSync(absolute, 'utf8');
  const patterns = [
    /(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{20,}/,
    /[CE]:[\\/]Users[\\/]\d{4,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  for (const pattern of patterns)
    if (pattern.test(source)) {
      console.error(file + ': potential secret or personal path; inspect before publishing');
      errors++;
    }
  if (/(?:^|\/)(?:data|outputs|node_modules)\/|\.(?:dpapi|enc|key|log)$/.test(file)) {
    console.error(file + ': private/runtime file is in the publishable tree');
    errors++;
  }
}
const manifest = require('../package.json');
for (const file of manifest.files)
  if (!fs.existsSync(path.join(root, file))) {
    console.error('Missing distribution entry: ' + file);
    errors++;
  }
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'),
  js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
for (const [, id] of js.matchAll(/\$\('([a-z][a-z0-9-]+)'\)/g))
  if (!html.includes(`id="${id}"`) && !['panel-', 'monitor-state'].includes(id)) {
    console.error('Missing panel element: ' + id);
    errors++;
  }
if (errors) process.exitCode = 1;
else
  console.log(
    `Checked syntax, panel references, release entries and secret patterns across ${files.length} source files.`,
  );
