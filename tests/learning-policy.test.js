'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const MergeCore = require('../js/merge-core.js');


test('learning model from a later project is preserved', () => {
  const model = { type: 'image', classes: ['고양이', '강아지'] };

  const merged = MergeCore.mergeProjects([
    { name: '첫 작품' },
    { name: '둘째 작품', learning: model },
  ]);

  assert.deepEqual(merged.learning, model);
});

test('identical learning models with different key order are accepted', () => {
  const first = { type: 'number', options: { k: 3, labels: [1, 2] } };
  const second = { options: { labels: [1, 2], k: 3 }, type: 'number' };

  const merged = MergeCore.mergeProjects([
    { learning: first },
    { learning: second },
  ]);

  assert.deepEqual(merged.learning, first);
});

test('different learning models fail instead of losing one', () => {
  assert.throws(
    () => MergeCore.mergeProjects([
      { learning: { type: 'image' } },
      { learning: { type: 'number' } },
    ]),
    /서로 다른 AI 학습 모델/,
  );
});
