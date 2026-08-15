const test = require('node:test');
const assert = require('node:assert/strict');

global.pako = require('../js/pako.min.js');
global.Tar = require('../js/tar.js');
const MergeEngine = require('../js/merge-engine.js');

const encoder = new TextEncoder();
const { parseEntFile } = MergeEngine._internal;

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function makeEnt(entries) {
  return toArrayBuffer(global.pako.gzip(global.Tar.create(entries)));
}

function projectEntry(name = 'temp/project.json', value = { objects: [] }) {
  return { name, data: encoder.encode(JSON.stringify(value)) };
}

function rewriteChecksum(tar, headerOffset) {
  for (let i = 148; i < 156; i++) tar[headerOffset + i] = 32;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += tar[headerOffset + i];
  const value = sum.toString(8).padStart(6, '0') + '\0 ';
  for (let i = 0; i < value.length; i++) {
    tar[headerOffset + 148 + i] = value.charCodeAt(i);
  }
}

test('canonical project and zero-byte resources are preserved', () => {
  const parsed = parseEntFile('ok.ent', makeEnt([
    projectEntry(),
    { name: 'temp/empty.png', data: new Uint8Array(0) },
  ]));

  assert.deepEqual(parsed.projectData, { objects: [] });
  assert.equal(parsed.resources.length, 1);
  assert.equal(parsed.resources[0].name, 'temp/empty.png');
  assert.equal(parsed.resources[0].data.length, 0);
});

test('zlib streams are rejected even if pako could inflate them', () => {
  const tar = global.Tar.create([projectEntry()]);
  const zlib = global.pako.deflate(tar);

  assert.throws(
    () => parseEntFile('zlib.ent', toArrayBuffer(zlib)),
    /GZIP TAR/
  );
});

test('project.json must use the exact canonical path', () => {
  for (const name of ['project.json', 'other/project.json', './temp/project.json']) {
    assert.throws(
      () => parseEntFile('path.ent', makeEnt([projectEntry(name)])),
      /temp\/project\.json/
    );
  }
});

test('duplicate paths and file-directory prefix collisions are rejected', () => {
  assert.throws(
    () => parseEntFile('duplicate.ent', makeEnt([projectEntry(), projectEntry()])),
    /중복 경로/
  );

  assert.throws(
    () => parseEntFile('prefix.ent', makeEnt([
      { name: 'temp', data: encoder.encode('file') },
      projectEntry(),
    ])),
    /경로가 충돌/
  );
});

test('special TAR entries and non-object projects are rejected', () => {
  const tar = global.Tar.create([
    projectEntry(),
    { name: 'temp/link', data: new Uint8Array(0) },
  ]);
  // 두 번째 항목의 typeflag를 심볼릭 링크('2')로 바꾼다. 파서는 체크섬을
  // 검증하므로 변경한 헤더의 체크섬도 다시 계산한다.
  tar[1024 + 156] = '2'.charCodeAt(0);
  rewriteChecksum(tar, 1024);
  assert.throws(
    () => parseEntFile('link.ent', toArrayBuffer(global.pako.gzip(tar))),
    /특수 항목/
  );

  assert.throws(
    () => parseEntFile('array.ent', makeEnt([projectEntry('temp/project.json', [])])),
    /최상위 값은 객체/
  );
});

test('truncated TAR member data is rejected', () => {
  const tar = global.Tar.create([
    { name: 'temp/resource.bin', data: new Uint8Array(700) },
  ]);
  const truncated = tar.slice(0, 512 + 600);

  assert.throws(() => global.Tar.parse(truncated), /잘렸습니다/);
});

test('corrupted TAR headers are rejected by checksum', () => {
  const tar = global.Tar.create([projectEntry()]);
  tar[10] ^= 1;

  assert.throws(() => global.Tar.parse(tar), /체크섬/);
});
