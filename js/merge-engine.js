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

  // 브라우저 렌더 루프에 제어권을 넘긴다(무거운 동기 작업 사이의 프리즈 방지).
  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // --- .ent 해체 ----------------------------------------------------------

  function isSafeMemberPath(name) {
    const normalized = String(name).replace(/\\/g, '/');
    if (normalized.startsWith('/')) return false;
    const parts = normalized.split('/').filter(p => p && p !== '.');
    if (!parts.length) return false;
    if (parts.some(p => p === '..')) return false;
    // 드라이브 문자(C:) 같은 절대 경로 표기도 거부한다.
    return !parts[0].includes(':');
  }

  function parseEntFile(fileName, arrayBuffer) {
    let tarData;
    try {
      tarData = pako.inflate(new Uint8Array(arrayBuffer));
    } catch (_) {
      throw new Error(`'${fileName}'은(는) 유효한 .ent 파일이 아닙니다. (GZIP 해제 실패)`);
    }

    const entries = Tar.parse(tarData);
    let projectData = null;
    const resources = [];

    for (const entry of entries) {
      if (entry.type === '5' || entry.name.endsWith('/')) continue;
      if (!isSafeMemberPath(entry.name)) continue;

      const basename = entry.name.split('/').pop();
      if (basename === 'project.json') {
        try {
          projectData = JSON.parse(textDecoder.decode(entry.data));
        } catch (_) {
          throw new Error(`'${fileName}'의 project.json 파싱에 실패했습니다.`);
        }
        continue;
      }
      if (entry.data.length > 0) {
        resources.push({ name: entry.name, data: entry.data });
      }
    }

    if (!projectData) {
      throw new Error(`'${fileName}'에서 project.json을 찾을 수 없습니다.`);
    }

    return { projectData, resources };
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

    const allocator = new MergeCore.IdAllocator();
    const projects = [];
    const filesResources = [];
    let baselineBroken = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      report(
        Math.round((i / files.length) * 70),
        `처리 중: ${file.name} (${i + 1}/${files.length})`
      );

      const arrayBuffer = await file.arrayBuffer();
      await yieldToUI();

      const { projectData, resources } = parseEntFile(file.name, arrayBuffer);

      // 입력이 이미 갖고 있던 끊어진 참조 수를 기록한다(검증 기준선).
      baselineBroken += MergeCore.countBrokenRefs(projectData);

      // 파일마다 독립적인 ID namespace로 전 식별자를 재발급한다.
      projects.push(MergeCore.prepareProject(projectData, allocator));
      filesResources.push(resources);

      await yieldToUI();
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
    merged = MergeCore.applyMetadata(merged, !!opts.clearRemake);

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

  return { performMerge };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MergeEngine;
}
