'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const MergeCore = require('../js/merge-core.js');

const TABLE_BLOCK_TYPES = [
  'append_row_to_table',
  'insert_row_to_table',
  'delete_row_from_table',
  'set_value_from_table',
  'save_current_table',
  'get_table_count',
  'get_value_from_table',
  'get_value_from_last_row',
  'calc_values_from_table',
  'open_table',
  'open_table_wait',
  'open_table_chart',
  'get_coefficient',
  'set_value_from_cell',
  'get_value_from_cell',
  'get_value_v_lookup',
];

function makeProject(tableId = 'table-old') {
  const blocks = TABLE_BLOCK_TYPES.map(type => ({ type, params: [tableId] }));
  return {
    name: 'table-reference-fixture',
    speed: 60,
    scenes: [{ id: 'scene-old', name: '장면 1' }],
    objects: [{
      id: 'object-old',
      name: '오브젝트 1',
      scene: 'scene-old',
      script: JSON.stringify(blocks),
    }],
    variables: [],
    messages: [],
    functions: [],
    tables: [{ id: tableId, name: '표 1' }],
  };
}

test('table block contract includes every EntryJS MATRIX p0 reference', () => {
  for (const blockType of TABLE_BLOCK_TYPES) {
    assert.equal(
      MergeCore._internal.refNamespace(blockType, 0),
      MergeCore.NS.TABLE,
      blockType,
    );
  }
});

test('prepareProject rewrites every table reference to the new declaration ID', () => {
  const oldTableId = 'table-old';
  const prepared = MergeCore.prepareProject(
    structuredClone(makeProject(oldTableId)),
    new MergeCore.IdAllocator(),
  );

  const newTableId = prepared.tables[0].id;
  assert.notEqual(newTableId, oldTableId);

  const blocks = JSON.parse(prepared.objects[0].script);
  assert.equal(blocks.length, TABLE_BLOCK_TYPES.length);
  for (const block of blocks) {
    assert.equal(block.params[0], newTableId, block.type);
  }

  assert.deepEqual(MergeCore.validateMerged(prepared), []);
});

test('validator rejects a dangling table reference', () => {
  const project = makeProject('declared-table');
  const blocks = JSON.parse(project.objects[0].script);
  blocks[0].params[0] = 'missing-table';
  project.objects[0].script = JSON.stringify(blocks);

  const problems = MergeCore.validateMerged(project);

  assert.ok(
    problems.some(problem => problem.includes('table 참조가 끊어졌습니다')),
    problems.join('\n'),
  );
});
