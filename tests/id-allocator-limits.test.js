'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const MergeCore = require('../js/merge-core.js');


test('IdAllocator fails after the configured ID limit', () => {
  const allocator = new MergeCore.IdAllocator({ maxIds: 1 });
  allocator.fresh();

  assert.throws(() => allocator.fresh(), MergeCore.MergeError);
});

test('IdAllocator collision loop has a finite attempt limit', () => {
  const allocator = new MergeCore.IdAllocator({ maxIds: 10 });
  allocator.reserve('aaaa');
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.throws(() => allocator.fresh(), MergeCore.MergeError);
  } finally {
    Math.random = originalRandom;
  }
});

test('reserveProjectIds handles arrays above the JavaScript argument limit', () => {
  const allocator = new MergeCore.IdAllocator({ maxIds: 10 });
  const project = { values: new Array(200000).fill(null) };

  assert.doesNotThrow(() => MergeCore.reserveProjectIds(project, allocator));
});
