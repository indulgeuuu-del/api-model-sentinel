'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { PowerKeeper } = require('../src/power.cjs');
test('unsupported power keeper does not claim to prevent sleep', () => {
  const power = new PowerKeeper({ platform: 'linux' });
  power.set(true);
  assert.equal(power.snapshot().state, 'unsupported');
  power.close();
  assert.equal(power.snapshot().state, 'inactive');
});
test(
  'Windows sleep keeper becomes ready and releases its helper on close',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async (t) => {
    const power = new PowerKeeper();
    t.after(() => power.close());
    power.set(true);
    const helper = power.child;
    const deadline = Date.now() + 10000;
    while (power.state === 'starting' && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(power.state, 'active', power.failure || 'power helper did not initialize');
    const exit = once(helper, 'exit');
    power.close();
    await exit;
    assert.equal(power.state, 'inactive');
    assert.equal(helper.exitCode, 0);
  },
);
