'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const MergeCore = require('../js/merge-core.js');


const CHECKER_OBJECT_BLOCK_TYPES = [
  'check_object_property',
  'check_block_execution',
  'switch_scope',
];

function projectWithObjectRefs(refs) {
  const blocks = refs.map(([type, target]) => ({ type, params: [target] }));
  return {
    name: 'reference-integrity',
    speed: 60,
    scenes: [],
    objects: [{
      id: 'actor',
      name: 'actor',
      script: JSON.stringify(blocks),
    }],
    variables: [],
    messages: [],
    functions: [],
    tables: [],
  };
}

test('checker object contract includes all known p0 references', () => {
  for (const blockType of CHECKER_OBJECT_BLOCK_TYPES) {
    assert.equal(
      MergeCore._internal.refNamespace(blockType, 0),
      MergeCore.NS.OBJECT,
      blockType,
    );
  }
});

test('prepareProject rewrites checker object references', () => {
  const project = projectWithObjectRefs(
    CHECKER_OBJECT_BLOCK_TYPES.map(type => [type, 'target-old']),
  );
  project.objects.push({ id: 'target-old', name: 'target', script: '[]' });

  const prepared = MergeCore.prepareProject(
    structuredClone(project),
    new MergeCore.IdAllocator(),
  );

  const targetId = prepared.objects[1].id;
  const blocks = JSON.parse(prepared.objects[0].script);
  for (const block of blocks) {
    assert.equal(block.params[0], targetId, block.type);
  }
  assert.deepEqual(MergeCore.validateMerged(prepared), []);
});

test('new broken ref is not hidden when an old one is revived', () => {
  const baselineProject = projectWithObjectRefs([
    ['locate', 'old-missing'],
  ]);
  const baseline = MergeCore.collectBrokenRefs(baselineProject);

  const merged = projectWithObjectRefs([
    ['locate', 'new-missing'],
  ]);
  merged.objects.push({
    id: 'old-missing',
    name: 'revived-old-reference',
    script: '[]',
  });

  const problems = MergeCore.validateMerged(merged, undefined, baseline);

  assert.ok(problems.some(problem => problem.includes('new-missing')), problems.join('\n'));
});

test('existing four-character reference is reserved before ID generation', () => {
  const project = projectWithObjectRefs([
    ['locate', 'aaaa'],
  ]);
  const allocator = new MergeCore.IdAllocator({ maxIds: 10 });

  MergeCore.reserveProjectIds(project, allocator);

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.throws(() => allocator.fresh(), MergeCore.MergeError);
  } finally {
    Math.random = originalRandom;
  }
});

test('unchanged input broken ref remains tolerated', () => {
  const project = projectWithObjectRefs([
    ['locate', 'already-missing'],
  ]);
  const baseline = MergeCore.collectBrokenRefs(project);

  assert.deepEqual(MergeCore.validateMerged(project, undefined, baseline), []);
});

test('duplicate function IDs are split', () => {
  const project = projectWithObjectRefs([]);
  project.functions = [
    { id: 'same-function', content: '[]', localVariables: [] },
    { id: 'same-function', content: '[]', localVariables: [] },
  ];

  const prepared = MergeCore.prepareProject(
    structuredClone(project),
    new MergeCore.IdAllocator(),
  );
  const functionIds = prepared.functions.map(func => func.id);

  assert.equal(functionIds.length, 2);
  assert.equal(new Set(functionIds).size, 2);
  assert.deepEqual(MergeCore.validateMerged(prepared), []);
});

test('resource collision rewrites fileurl and thumbUrl', () => {
  const projects = [0, 1].map(() => ({
    objects: [{
      sprite: {
        pictures: [{
          fileurl: 'temp/resource.png',
          thumbUrl: 'temp/resource.png',
        }],
      },
    }],
  }));
  const { resolved, renames } = MergeCore.resolveResources([
    [{ name: 'temp/resource.png', data: new Uint8Array([1]) }],
    [{ name: 'temp/resource.png', data: new Uint8Array([2]) }],
  ]);

  MergeCore.applyResourceRenames(projects, renames);

  const renamedPath = renames[0].newPath;
  const picture = projects[1].objects[0].sprite.pictures[0];
  assert.ok(resolved.has(renamedPath));
  assert.equal(picture.fileurl, renamedPath);
  assert.equal(picture.thumbUrl, renamedPath);
});

test('validator rejects a missing temp thumbUrl', () => {
  const project = projectWithObjectRefs([]);
  project.objects[0].sprite = {
    pictures: [{
      fileurl: 'temp/resource.png',
      thumbUrl: 'temp/missing-thumb.png',
    }],
  };

  const problems = MergeCore.validateMerged(project, new Set(['temp/resource.png']));

  assert.ok(
    problems.some(problem => problem.includes('temp/missing-thumb.png')),
    problems.join('\n'),
  );
});
