'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { chromium } = require('playwright');
const { Engine } = require('../src/engine.cjs');
const { MemoryStore } = require('../src/storage.cjs');
const { demoRunner, seedDemo } = require('../src/demo.cjs');
const { CodexGuard } = require('../src/guard.cjs');
const { createServer } = require('../src/server.cjs');
async function main() {
  const guard = new CodexGuard({ demo: true }),
    engine = new Engine({ store: new MemoryStore(), runner: demoRunner(), guard, autoPoll: false });
  seedDemo(engine);
  const normal = engine.state.profiles[0];
  for (let i = 0; i < 8; i++) await engine.run(normal.id);
  const app = createServer({ engine, guard, demo: true });
  const address = await app.listen(0),
    browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 1,
    });
    await page.goto(`http://127.0.0.1:${address.port}/#token=${engine.state.token}`);
    await page.locator('#latest .badge').waitFor();
    const dir = path.join(__dirname, '..', 'docs', 'images');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'dashboard.png'), fullPage: true });
    console.log('Saved demo-only documentation screenshot.');
  } finally {
    await browser.close();
    await engine.close();
    await app.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
