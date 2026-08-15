/**
 * merge-engine.js - .ent 입출력 + 병합 오케스트레이션.
 *
 * 병합 알고리즘 자체는 merge-core.js(MergeCore)에 있다.
 * 이 파일은 gzip/TAR 해체·조립과 진행률 보고만 담당한다.
 */
const MergeEngine = (() => {
  'use strict';

  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  const MIB = 1024 * 1024;
  const CANONICAL_PROJECT_PATH = 'temp/project.json';
  const MAX_FILE_COUNT = 10;
  const MAX_COMPRESSED_FILE_SIZE = 50 * MIB;
  const MAX_COMPRESSED_TOTAL_SIZE = 150 * MIB;
  const MAX_MEMBERS = 5000;
  const MAX_EXPANDED_FILE_SIZE = 250 * MIB;
  const MAX_EXPANDED_TOTAL_SIZE = 500 * MIB;
  const MAX_MEMBER_SIZE = 100 * MIB;
  const MAX_PROJECT_SIZE = 50 * MIB;

  // 브라우저 렌더 루프에 제어권을 넘긴다(무거운 동기 작업 사이의 프리즈 방지).
  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // --- .ent 해체 ----------------------------------------------------------

  function normalizeMemberPath(name) {
    if (typeof name !== 'string' || !name || name.includes('\0')) return null;
    const normalized = String(name).replace(/\\/g, '/');
    if (normalized.startsWith('/')) return null;
    const parts = normalized.split('/').filter(p => p && p !== '.');
    if (!parts.length) return null;
    if (parts.some(p => p === '..')) return null;
    // 드라이브 문자(C:) 같은 절대 경로 표기도 거부한다.
    if (parts[0].includes(':')) return null;
    return parts.join('/');
  }

  function parseEntFile(fileName, arrayBuffer) {
    const compressed = new Uint8Array(arrayBuffer);
    if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
      throw new Error(`'${fileName}'은(는) 지원되는 GZIP TAR .ent 파일이 아닙니다.`);
    }

    let tarData;
    try {
      tarData = pako.inflate(compressed);
    } catch (_) {
      throw new Error(`'${fileName}'은(는) 유효한 .ent 파일이 아닙니다. (GZIP 해제 실패)`);
    }

    let entries;
    try {
      entries = Tar.parse(tarData);
    } catch (_) {
      throw new Error(`'${fileName}'은(는) 유효한 GZIP TAR 파일이 아닙니다.`);
    }
    if (entries.length > MAX_MEMBERS) {
      throw new Error(`'${fileName}'의 아카이브 항목 수가 허용 한도를 초과합니다.`);
    }

    let projectData = null;
    const resources = [];
    const seenPaths = new Set();
    const filePaths = new Set();
    const requiredDirectories = new Set();
    let expandedSize = 0;

    for (const entry of entries) {
      const path = normalizeMemberPath(entry.rawName === undefined ? entry.name : entry.rawName);
      if (!path) {
        throw new Error(`'${fileName}'의 아카이브에 안전하지 않은 경로가 있습니다.`);
      }
      if (seenPaths.has(path)) {
        throw new Error(`'${fileName}'의 아카이브에 중복 경로가 있습니다.`);
      }

      const parts = path.split('/');
      const parents = [];
      for (let i = 1; i < parts.length; i++) parents.push(parts.slice(0, i).join('/'));
      if (parents.some(parent => filePaths.has(parent))) {
        throw new Error(`'${fileName}'의 파일·디렉터리 경로가 충돌합니다.`);
      }

      const isDirectory = entry.type === '5';
      const isRegularFile = entry.type === '0' || entry.type === '\0' || entry.type === '';
      if (isDirectory) {
        if (entry.data.length !== 0) {
          throw new Error(`'${fileName}'의 디렉터리 항목 크기가 올바르지 않습니다.`);
        }
        if (path === CANONICAL_PROJECT_PATH || path.endsWith('/project.json')) {
          throw new Error(`'${fileName}'의 project.json은 일반 파일이어야 합니다.`);
        }
        seenPaths.add(path);
        for (const parent of parents) requiredDirectories.add(parent);
        requiredDirectories.add(path);
        continue;
      }
      if (!isRegularFile) {
        throw new Error(`'${fileName}'의 아카이브에 허용되지 않는 특수 항목이 있습니다.`);
      }
      if (requiredDirectories.has(path)) {
        throw new Error(`'${fileName}'의 파일·디렉터리 경로가 충돌합니다.`);
      }

      seenPaths.add(path);
      filePaths.add(path);
      for (const parent of parents) requiredDirectories.add(parent);

      if (entry.data.length > MAX_MEMBER_SIZE) {
        throw new Error(`'${fileName}'의 개별 파일이 허용 크기를 초과합니다.`);
      }
      expandedSize += entry.data.length;
      if (expandedSize > MAX_EXPANDED_FILE_SIZE) {
        throw new Error(`'${fileName}'의 압축 해제 크기가 허용 한도를 초과합니다.`);
      }

      const basename = path.split('/').pop();
      if (basename === 'project.json' && (
        path !== CANONICAL_PROJECT_PATH || entry.rawName !== CANONICAL_PROJECT_PATH
      )) {
        throw new Error(`'${fileName}'의 project.json은 temp/project.json 경로에 하나만 있어야 합니다.`);
      }
      if (path === CANONICAL_PROJECT_PATH) {
        if (projectData !== null) {
          throw new Error(`'${fileName}'의 project.json이 중복되어 있습니다.`);
        }
        if (entry.data.length > MAX_PROJECT_SIZE) {
          throw new Error(`'${fileName}'의 project.json이 허용 크기를 초과합니다.`);
        }
        try {
          projectData = JSON.parse(textDecoder.decode(entry.data));
        } catch (_) {
          throw new Error(`'${fileName}'의 project.json 파싱에 실패했습니다.`);
        }
        if (!projectData || Array.isArray(projectData) || typeof projectData !== 'object') {
          throw new Error(`'${fileName}'의 project.json 최상위 값은 객체여야 합니다.`);
        }
        continue;
      }
      resources.push({ name: path, data: entry.data });
    }

    if (projectData === null) {
      throw new Error(`'${fileName}'에서 temp/project.json을 찾을 수 없습니다.`);
    }

    return { projectData, resources, expandedSize };
  }

  // --- .ent 조립 ----------------------------------------------------------

  function buildOutputTar(mergedProject, resolvedResources) {
    const projectJsonBytes = textEncoder.encode(
      JSON.stringify(mergedProject, null, 4)
    );

    // 사이트판(파이썬)과 같은 구성: temp/project.json + 리소스.
    // 디렉터리 항목은 넣지 않는다(EntryJS는 파일 항목만 읽는다).
    const tarEntries = [{ name: 'temp/project.json', data: projectJsonBytes }];
    for (const [path, data] of resolvedResources) {
      if (path === 'temp/project.json') continue;
      tarEntries.push({ name: path, data });
    }

    const tarBytes = Tar.create(tarEntries);
    return pako.gzip(tarBytes, { level: 6 });
  }

  // --- 메인 -------------------------------------------------------------

  async function performMerge(files, options, onProgress) {
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    const opts = options || {};

    if (!files || files.length < 2) {
      throw new Error('최소 2개 이상의 .ent 파일이 필요합니다.');
    }
    if (files.length > MAX_FILE_COUNT) {
      throw new Error(`파일은 최대 ${MAX_FILE_COUNT}개까지 합칠 수 있습니다.`);
    }

    const allocator = new MergeCore.IdAllocator();
    const projects = [];
    const remakeMetadata = [];
    const filesResources = [];
    const baselineBroken = new Map();
    let compressedTotal = 0;
    let expandedTotal = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_COMPRESSED_FILE_SIZE) {
        throw new Error(`'${file.name}'의 크기가 50MB 제한을 초과합니다.`);
      }
      compressedTotal += file.size;
      if (compressedTotal > MAX_COMPRESSED_TOTAL_SIZE) {
        throw new Error('선택한 파일의 전체 크기가 150MB 제한을 초과합니다.');
      }
      report(
        Math.round((i / files.length) * 70),
        `처리 중: ${file.name} (${i + 1}/${files.length})`
      );

      const arrayBuffer = await file.arrayBuffer();
      await yieldToUI();

      const { projectData, resources, expandedSize } = parseEntFile(file.name, arrayBuffer);
      expandedTotal += expandedSize;
      if (expandedTotal > MAX_EXPANDED_TOTAL_SIZE) {
        throw new Error('압축 해제한 파일의 전체 크기가 허용 한도를 초과합니다.');
      }

      // 입력이 이미 갖고 있던 끊어진 참조 서명을 기록한다(검증 기준선).
      for (const [key, count] of MergeCore.collectBrokenRefs(projectData)) {
        baselineBroken.set(key, (baselineBroken.get(key) || 0) + count);
      }

      // ID 재발급 전에 선택 가능한 원본 작품의 출처 메타데이터를 보관한다.
      remakeMetadata.push(MergeCore.extractRemakeMetadata(projectData));

      projects.push(projectData);
      filesResources.push(resources);

      await yieldToUI();
    }

    // 앞 파일에서 만든 새 ID가 뒤 파일의 기존·끊어진 ID와 겹치지 않도록
    // 전체 입력을 먼저 예약한 뒤 두 번째 단계에서 프로젝트를 변형한다.
    for (const project of projects) MergeCore.reserveProjectIds(project, allocator);
    for (let i = 0; i < projects.length; i++) {
      projects[i] = MergeCore.prepareProject(projects[i], allocator);
    }

    report(75, '리소스 정리 중...');
    await yieldToUI();

    // 리소스 경로 충돌 해소 후, 바뀐 경로를 참조에 반영한다.
    const { resolved, renames } = MergeCore.resolveResources(filesResources);
    MergeCore.applyResourceRenames(projects, renames);

    report(80, '병합 중...');
    await yieldToUI();

    let merged = MergeCore.mergeProjects(projects);
    merged = MergeCore.unifySpecialVariables(merged);

    report(85, '후처리 중...');
    if (opts.hideTimerAnswer) merged = MergeCore.hideTimerAnswerVariables(merged);
    const remakeMode = typeof opts.remakeMode === 'string'
      ? opts.remakeMode
      : (opts.clearRemake ? 'hidden' : 'default');
    let sourceMetadata = null;
    if (remakeMode === 'source') {
      const sourceIndex = opts.remakeSourceIndex;
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= files.length) {
        throw new Error('원본 정보를 유지할 작품을 선택해주세요.');
      }
      sourceMetadata = remakeMetadata[sourceIndex];
    }
    merged = MergeCore.applyMetadata(merged, remakeMode, sourceMetadata);

    report(90, '검증 중...');
    await yieldToUI();

    // 출력 검증: 중복 ID나 새로 끊어진 참조가 있으면 깨진 파일을 내보내지 않는다.
    const problems = MergeCore.validateMerged(merged, resolved.keys(), baselineBroken);
    if (problems.length) {
      console.error('Merge validation failed:', problems.slice(0, 20));
      throw new Error(
        '병합 결과 검증에 실패했습니다. 문제: ' + problems.slice(0, 5).join(' / ')
      );
    }

    report(95, '파일 생성 중...');
    await yieldToUI();

    const gzBytes = buildOutputTar(merged, resolved);

    report(100, '완료!');
    return new Blob([gzBytes], { type: 'application/gzip' });
  }

  return {
    performMerge,
    _internal: { parseEntFile, buildOutputTar, normalizeMemberPath },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MergeEngine;
}
