'use strict';
const crypto = require('node:crypto');
const { stableEqual } = require('./util.cjs');
const ORIGINAL_PROMPT =
  '在一个黑色的袋子里放有三种口味的糖果，分别是苹果味、桃子味和西瓜味；每种糖果又有圆形和五角星形两种形状，且不同形状可以靠手感分辨。已知各种口味、各种形状的糖果数量如下：圆形苹果味7颗、圆形桃子味9颗、圆形西瓜味8颗；五角星形苹果味7颗、五角星形桃子味6颗、五角星形西瓜味4颗。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少颗糖果，才能保证手中同时拥有不同形状的苹果味和桃子味糖果？也就是说，手中有“圆形苹果味搭配五角星形桃子味”，或者有“圆形桃子味搭配五角星形苹果味”，都算满足要求。请不要联网和读取记忆内容，自行计算。\n\n只答整数';
const FAMILIES = ['candy', 'arithmetic', 'shortest-path', 'table', 'json'];
function random(seed) {
  let state = seed >>> 0;
  return (min, max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };
}
// Choose counts of both distinguishable shapes BEFORE drawing. Taste is hidden.
function candyMinimum([a, b, c, d, e, f]) {
  let best = Infinity;
  for (let rounds = 0; rounds <= a + b + c; rounds++)
    for (let stars = 0; stars <= d + e + f; stars++) {
      const canFail =
        rounds <= c ||
        stars <= f ||
        (rounds <= b + c && stars <= e + f) ||
        (rounds <= a + c && stars <= d + f);
      if (!canFail) best = Math.min(best, rounds + stars);
    }
  return best;
}
function makeProbe(pack = 'original', sequence = 0, seed = crypto.randomBytes(4).readUInt32LE()) {
  if (pack === 'original')
    return {
      id: 'candy-original',
      version: 'original-user-v1',
      family: 'candy',
      title: '糖果原题',
      grading: 'integer',
      prompt: ORIGINAL_PROMPT,
      expected: 21,
      seed: null,
    };
  const r = random(seed),
    family = FAMILIES[sequence % FAMILIES.length];
  const probe = {
    id: `${family}-${seed}`,
    version: 'generated-v1',
    family,
    title: {
      candy: '糖果变体',
      arithmetic: '运算与约束',
      'shortest-path': '最短路径',
      table: '表格筛选',
      json: '结构化指令',
    }[family],
    grading: 'integer',
    seed,
  };
  if (family === 'candy') {
    const counts = Array.from({ length: 6 }, () => r(2, 12));
    probe.prompt = `袋中有圆形苹果${counts[0]}颗、圆形桃子${counts[1]}颗、圆形西瓜${counts[2]}颗，星形苹果${counts[3]}颗、星形桃子${counts[4]}颗、星形西瓜${counts[5]}颗。形状可凭手感区分，口味不可知。你可预先分别决定取多少圆形和多少星形，每类内部任意抽取。求能保证出现“圆形苹果+星形桃子”或“圆形桃子+星形苹果”的最小总数。不联网，只答整数。`;
    probe.expected = candyMinimum(counts);
  } else if (family === 'arithmetic') {
    const a = r(13, 87),
      b = r(3, 12),
      c = r(7, 45),
      d = r(2, 8),
      e = r(11, 39);
    probe.prompt = `严格依括号与通常运算顺序计算：(${a} × ${b} - ${c}) × ${d} + ${e}。不联网，只答整数。`;
    probe.expected = (a * b - c) * d + e;
  } else if (family === 'shortest-path') {
    const edges = [];
    for (let i = 0; i < 5; i++)
      for (let j = i + 1; j < 6; j++) if (j === i + 1 || r(0, 1)) edges.push([i, j, r(2, 25)]);
    const dist = [0, Infinity, Infinity, Infinity, Infinity, Infinity];
    for (let i = 0; i < 6; i++)
      for (const [a, b, w] of edges) if (a === i) dist[b] = Math.min(dist[b], dist[a] + w);
    probe.expected = dist[5];
    probe.prompt = `有向图各边及权重：${edges.map(([a, b, w]) => `${String.fromCharCode(65 + a)}→${String.fromCharCode(65 + b)}=${w}`).join('，')}。没有其他边。A到F最短路径的总权重是多少？不联网，只答整数。`;
  } else if (family === 'table') {
    const threshold = r(30, 65),
      rows = Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        stock: r(12, 95),
        price: r(3, 21),
      }));
    probe.expected = rows
      .filter((row) => row.stock >= threshold && row.id % 2 === 1)
      .reduce((sum, row) => sum + row.stock * row.price, 0);
    probe.prompt = `数据行(id,库存,单价)：${rows.map((row) => `(${row.id},${row.stock},${row.price})`).join('；')}。只选择id为奇数且库存大于等于${threshold}的行，计算所选行“库存×单价”之和。不联网，只答整数。`;
  } else {
    const values = Array.from({ length: 7 }, () => r(1, 39)),
      cutoff = r(10, 30);
    const selected = [...new Set(values.filter((n) => n > cutoff))].sort((a, b) => a - b);
    probe.grading = 'json';
    probe.expected = { values: selected, sum: selected.reduce((s, n) => s + n, 0) };
    probe.prompt = `从数组${JSON.stringify(values)}保留严格大于${cutoff}的数，去重并升序排序。只输出JSON对象，恰好两个字段：values为结果数组，sum为该数组元素之和。不要Markdown，不联网。`;
  }
  return probe;
}
function lastInteger(text) {
  const numbers = String(text)
    .normalize('NFKC')
    .replace(/−/g, '-')
    .match(/[+-]?\d+(?:[.,/]\d+)*(?:[eE][+-]?\d+)?/g);
  if (!numbers?.length || !/^[+-]?\d+$/.test(numbers.at(-1))) return null;
  const value = Number(numbers.at(-1));
  return Number.isSafeInteger(value) ? value : null;
}
function grade(text, probe) {
  if (probe.grading === 'integer') {
    const actual = lastInteger(text);
    return {
      actual,
      verdict: actual === null ? 'inconclusive' : actual === probe.expected ? 'pass' : 'fail',
    };
  }
  try {
    const actual = JSON.parse(String(text).trim());
    return { actual, verdict: stableEqual(actual, probe.expected) ? 'pass' : 'fail' };
  } catch {
    return { actual: null, verdict: 'inconclusive' };
  }
}
module.exports = { ORIGINAL_PROMPT, FAMILIES, candyMinimum, makeProbe, lastInteger, grade };
