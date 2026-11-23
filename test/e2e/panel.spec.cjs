'use strict';
const { test: base, expect } = require('@playwright/test');
const { Engine } = require('../../src/engine.cjs');
const { MemoryStore } = require('../../src/storage.cjs');
const { createServer } = require('../../src/server.cjs');
const { demoRunner, seedDemo } = require('../../src/demo.cjs');
const { CodexGuard } = require('../../src/guard.cjs');
const test = base.extend({
  sentinel: [
    async ({ page }, use) => {
      let offset = 0;
      const guard = new CodexGuard({ demo: true }),
        engine = new Engine({
          store: new MemoryStore(),
          runner: demoRunner(),
          guard,
          now: () => Date.now() + offset,
        });
      seedDemo(engine);
      const app = createServer({ engine, guard, demo: true }),
        address = await app.listen(0),
        url = `http://127.0.0.1:${address.port}/`;
      const errors = [],
        consoleErrors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      await page.goto(url + '#token=' + engine.state.token);
      await expect(page.locator('#connection')).toHaveText('本机已连接');
      await use({
        engine,
        url,
        advance: (ms) => {
          offset += ms;
        },
        errors,
      });
      await engine.close();
      await app.close();
      expect(errors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    },
    { auto: true },
  ],
});
test('normal run, record details, probe preview, CSV and secret-free config export', async ({
  page,
  sentinel,
}) => {
  await page.getByRole('button', { name: '检测一次', exact: true }).click();
  await expect(page.locator('#latest .badge')).toHaveText('正确');
  await expect(page.locator('#latest .latest-answer')).toHaveText('21');
  await page.getByRole('button', { name: '查看完整记录' }).click();
  await expect(page.locator('#record-dialog')).toBeVisible();
  await expect(page.locator('#record-detail')).toContainText('original-user-v1');
  await page.getByLabel('关闭检测详情').click();
  await page.getByRole('tab', { name: '探针与标准答案' }).click();
  await expect(page.locator('#probe-answer')).toHaveText('21');
  await page.locator('#probe-family').selectOption('4');
  await expect(page.locator('#probe-prompt')).toContainText('JSON');
  await page.getByRole('tab', { name: '检测记录' }).click();
  const csvDownload = page.waitForEvent('download');
  await page.locator('#csv-btn').click();
  expect((await csvDownload).suggestedFilename()).toBe('sentinel-history.csv');
  const configDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出配置', exact: true }).click();
  expect((await configDownload).suggestedFilename()).toBe('sentinel-config-no-keys.json');
  expect(sentinel.engine.records()).toHaveLength(1);
});
test('timeout continues monitoring and closing the browser does not stop backend scheduling', async ({
  page,
  sentinel,
}) => {
  await page.getByRole('button', { name: '示例 · 超时模型' }).click();
  await page.getByRole('button', { name: '开启监测' }).click();
  await expect(page.locator('#latest .badge')).toHaveText('超时');
  await expect(page.locator('#monitor-state')).toHaveText('后台运行中');
  const p = sentinel.engine.state.profiles.find((p) => p.model === 'demo-timeout');
  await page.close();
  sentinel.advance(61000);
  await expect.poll(() => sentinel.engine.records(p.id).length).toBe(2);
  expect(sentinel.engine.state.runtimes[p.id].enabled).toBe(true);
});
test('automatic wrong answer pauses and records simulated desktop protection', async ({
  page,
  sentinel,
}) => {
  await page.getByRole('button', { name: '示例 · 答错模型' }).click();
  await page.getByRole('button', { name: '编辑配置' }).click();
  await page.locator('[name=guard]').check();
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.locator('#profile-dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '开启监测' }).click();
  await expect(page.locator('#latest .badge')).toHaveText('答错');
  await expect(page.locator('#monitor-state')).toHaveText('已暂停');
  await expect(page.locator('#incident')).toContainText('已确认停止 2 个本机会话');
  expect(sentinel.engine.state.incidents[0].action.demo).toBe(true);
});
test('over-budget correct answer passes and remains enabled', async ({ page }) => {
  await page.getByRole('button', { name: '示例 · 费用告警' }).click();
  await page.getByRole('button', { name: '开启监测' }).click();
  await expect(page.locator('#latest .badge')).toHaveText('正确');
  await expect(page.locator('#latest')).toContainText('超出请求预算');
  await expect(page.locator('#monitor-state')).toHaveText('后台运行中');
  await page.getByRole('button', { name: '暂停监测' }).click();
});
test('configuration editing keeps the key private, clears it explicitly, and deletes cleanly', async ({
  page,
  sentinel,
}) => {
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  const form = page.locator('#profile-form');
  await form.locator('[name=name]').fill('Custom <img src=x onerror=alert(1)>');
  await form.locator('[name=model]').fill('demo-pass');
  await form.locator('[name=baseUrl]').fill('https://example.test/v1');
  await form.locator('[name=apiKey]').fill('example-e2e-only-credential');
  await form.locator('[name=contextTag]').fill('group-a');
  await form.locator('[name=keepAwake]').uncheck();
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.locator('#profile-title')).toContainText('Custom <img');
  expect(await page.locator('#profile-title img').count()).toBe(0);
  await page.getByRole('button', { name: '编辑配置' }).click();
  await expect(form.locator('[name=apiKey]')).toHaveValue('');
  await form.locator('[name=clearApiKey]').check();
  await page.getByRole('button', { name: '保存配置' }).click();
  expect(sentinel.engine.state.profiles.at(-1).apiKey).toBe('');
  await page.getByRole('button', { name: '编辑配置' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除此配置' }).click();
  await expect(page.locator('#profile-dialog')).not.toBeVisible();
  expect(sentinel.engine.state.profiles).toHaveLength(4);
});
test('same-question comparison sends exactly two requests without protection', async ({
  page,
  sentinel,
}) => {
  await page.getByRole('tab', { name: '同题比较' }).click();
  await page.locator('#compare-btn').click();
  await expect(page.locator('#compare-result')).toContainText('答案');
  await expect.poll(() => sentinel.engine.records().length).toBe(2);
  const rows = sentinel.engine.records();
  expect(rows[0].probe).toEqual(rows[1].probe);
  expect(sentinel.engine.state.incidents).toHaveLength(0);
});
test('panel lock preserves backend monitoring and can be unlocked', async ({ page, sentinel }) => {
  await page.getByRole('button', { name: '开启监测' }).click();
  await expect(page.locator('#monitor-state')).toHaveText('后台运行中');
  await page.getByRole('button', { name: '锁定面板' }).click();
  await expect(page.locator('#auth-dialog')).toBeVisible();
  expect(sentinel.engine.state.runtimes[sentinel.engine.state.profiles[0].id].enabled).toBe(true);
  await page.locator('#auth-token').fill(sentinel.engine.state.token);
  await page.getByRole('button', { name: '连接面板', exact: true }).click();
  await expect(page.locator('#auth-dialog')).not.toBeVisible();
});
test('responsive layout has no horizontal page overflow and keyboard tabs work', async ({
  page,
}) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.getByRole('tab', { name: '运行概览' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '检测记录' })).toBeFocused();
  await expect(page.getByRole('tab', { name: '检测记录' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
