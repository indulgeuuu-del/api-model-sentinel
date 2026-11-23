'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ORIGINAL_PROMPT,
  candyMinimum,
  makeProbe,
  lastInteger,
  grade,
  FAMILIES,
} = require('../src/probes.cjs');

test('original prompt and answer remain the user-selected version', () => {
  assert.equal(makeProbe().prompt, ORIGINAL_PROMPT);
  assert.ok(ORIGINAL_PROMPT.includes('圆形苹果味7颗、圆形桃子味9颗、圆形西瓜味8颗'));
  assert.ok(ORIGINAL_PROMPT.endsWith('自行计算。\n\n只答整数'));
  assert.equal(candyMinimum([7, 9, 8, 7, 6, 4]), 21);
  assert.equal(grade('21', makeProbe()).verdict, 'pass');
  assert.equal(grade('28', makeProbe()).verdict, 'fail');
});

// Independent exhaustive oracle: enumerate every possible handful, then find
// a pair of shape quotas for which no losing handful exists.
function oracle(counts) {
  const bad = new Set(),
    totals = [counts[0] + counts[1] + counts[2], counts[3] + counts[4] + counts[5]];
  function enumerate(i, chosen) {
    if (i < 6) {
      for (let n = 0; n <= counts[i]; n++) enumerate(i + 1, [...chosen, n]);
      return;
    }
    if (!(chosen[0] && chosen[4]) && !(chosen[1] && chosen[3]))
      bad.add(`${chosen[0] + chosen[1] + chosen[2]},${chosen[3] + chosen[4] + chosen[5]}`);
  }
  enumerate(0, []);
  let answer = Infinity;
  for (let a = 0; a <= totals[0]; a++)
    for (let b = 0; b <= totals[1]; b++)
      if (!bad.has(`${a},${b}`)) answer = Math.min(answer, a + b);
  return answer;
}
test('candy oracle matches exhaustive small-bag enumeration', () => {
  for (let bits = 0; bits < 64; bits++) {
    const counts = Array.from({ length: 6 }, (_, i) => 1 + ((bits >> i) & 1));
    assert.equal(candyMinimum(counts), oracle(counts), counts.join(','));
  }
});
test('all generated families are reproducible and self-consistent', () => {
  for (let seed = 0; seed < 80; seed++)
    for (let i = 0; i < FAMILIES.length; i++) {
      const p = makeProbe('rotating', i, seed);
      assert.deepEqual(p, makeProbe('rotating', i, seed));
      assert.equal(p.family, FAMILIES[i]);
      assert.equal(
        grade(p.grading === 'json' ? JSON.stringify(p.expected) : String(p.expected), p).verdict,
        'pass',
      );
      if (p.family === 'arithmetic') {
        const [a, b, c, d, e] = p.prompt.match(/\d+/g).map(Number);
        assert.equal(p.expected, a * b * d - c * d + e);
      }
      if (p.family === 'shortest-path') {
        const edges = [...p.prompt.matchAll(/([A-F])→([A-F])=(\d+)/g)].map((m) => [
          m[1],
          m[2],
          +m[3],
        ]);
        const costs = (node) =>
          node === 'F'
            ? [0]
            : edges
                .filter((e) => e[0] === node)
                .flatMap(([, next, w]) => costs(next).map((v) => v + w));
        assert.equal(p.expected, Math.min(...costs('A')));
      }
      if (p.family === 'table') {
        const rows = [...p.prompt.matchAll(/\((\d+),(\d+),(\d+)\)/g)].map((m) =>
          m.slice(1).map(Number),
        );
        const threshold = +p.prompt.match(/大于等于(\d+)/)[1];
        assert.equal(
          p.expected,
          rows.reduce(
            (s, [id, stock, price]) => (id % 2 && stock >= threshold ? s + stock * price : s),
            0,
          ),
        );
      }
      if (p.family === 'json') {
        const values = JSON.parse(p.prompt.match(/\[[\d,]+\]/)[0]),
          cutoff = +p.prompt.match(/大于(\d+)/)[1];
        const sorted = values
          .filter((v, i, all) => v > cutoff && all.indexOf(v) === i)
          .sort((a, b) => a - b);
        assert.deepEqual(p.expected, { values: sorted, sum: sorted.reduce((a, b) => a + b, 0) });
      }
    }
});
test('integer extraction does not turn decimal, fraction, exponent or absent answer into an integer', () => {
  for (const text of ['21.5', '21/2', '2e1', '没有答案', '', '9007199254740992'])
    assert.equal(lastInteger(text), null, text);
  assert.equal(lastInteger('答案：２１'), 21);
  assert.equal(lastInteger('先排除28，最终答案21。'), 21);
  assert.equal(lastInteger('−2'), -2);
});
test('JSON grading checks structure and values independently of object key order', () => {
  const p = makeProbe('rotating', 4, 1);
  assert.equal(
    grade(JSON.stringify({ sum: p.expected.sum, values: p.expected.values }), p).verdict,
    'pass',
  );
  assert.equal(grade(JSON.stringify({ ...p.expected, extra: true }), p).verdict, 'fail');
  assert.equal(grade('{', p).verdict, 'inconclusive');
});
