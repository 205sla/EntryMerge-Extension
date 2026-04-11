/**
 * merge-engine.js - Core merge logic for EntryMerge.
 * Ports the server-side Python merge algorithm to client-side JavaScript.
 */
const MergeEngine = (() => {
  'use strict';

  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const SPECIAL_VAR_TYPES = new Set(['timer', 'answer']);
  const textDecoder = new TextDecoder();

  // --- Deep comparison (Python's `in` operator does deep equality on lists) ---

  function deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== typeof b) return false;

    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }

    if (typeof a === 'object') {
      const keysA = Object.keys(a);
      if (keysA.length !== Object.keys(b).length) return false;
      for (const k of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
      }
      return true;
    }

    return false;
  }

  function deepIncludes(arr, item) {
    return arr.some(el => deepEqual(el, item));
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Yield control to the browser render loop (prevents UI freeze on heavy operations)
  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // --- Recursive dict merge ---

  function mergeDicts(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (!(key in target)) {
        target[key] = value;
        continue;
      }

      const existing = target[key];

      if (isPlainObject(existing) && isPlainObject(value)) {
        mergeDicts(existing, value);
      } else if (Array.isArray(existing) && Array.isArray(value)) {
        for (const item of value) {
          if (!deepIncludes(existing, item)) existing.push(item);
        }
      } else if (!deepEqual(existing, value)) {
        const list = Array.isArray(existing) ? existing : (target[key] = [existing]);
        if (!deepIncludes(list, value)) list.push(value);
      }
    }
  }

  // --- Scene ID randomization ---

  function generateId(len, usedIds) {
    let id;
    do {
      id = '';
      for (let i = 0; i < len; i++) {
        id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
      }
    } while (usedIds.has(id));
    return id;
  }

  function processSingleProject(project, globalUsedIds) {
    if (!Array.isArray(project.scenes)) return project;

    const mapping = {};

    for (const scene of project.scenes) {
      const oldId = scene.id;
      if (!oldId) continue;
      const newId = generateId(4, globalUsedIds);
      globalUsedIds.add(newId);
      mapping[oldId] = newId;
      scene.id = newId;
    }

    if (project.objects) {
      const update = (obj) => {
        if (obj.scene && mapping[obj.scene]) {
          obj.scene = mapping[obj.scene];
        }
        if (typeof obj.script === 'string') {
          for (const [oldId, newId] of Object.entries(mapping)) {
            obj.script = obj.script.replaceAll(oldId, newId);
          }
        }
      };

      const objs = project.objects;
      const items = Array.isArray(objs) ? objs : Object.values(objs);
      for (const obj of items) {
        if (obj && typeof obj === 'object') update(obj);
      }
    }

    return project;
  }

  // --- Post-merge processing ---

  function dedupSpecialVariables(merged) {
    if (!Array.isArray(merged.variables)) return;
    const seen = new Set();
    merged.variables = merged.variables.filter(v => {
      if (v && typeof v === 'object' && SPECIAL_VAR_TYPES.has(v.variableType)) {
        if (seen.has(v.variableType)) return false;
        seen.add(v.variableType);
      }
      return true;
    });
  }

  function hideTimerAnswerVariables(merged) {
    if (!Array.isArray(merged.variables)) return;
    for (const v of merged.variables) {
      if (v && typeof v === 'object' && SPECIAL_VAR_TYPES.has(v.variableType)) {
        v.x = 2050;
        v.y = 2050;
      }
    }
  }

  function applyMetadata(merged, clearRemake) {
    merged.name = '머지';
    if (clearRemake) {
      merged.parent = '';
      merged.origin = '';
      merged.user = '';
    } else {
      merged.parent = '678b8711133715065e4548c7';
      merged.origin = '678b8711133715065e4548c7';
      merged.user = '56136825dadc91e1235b460d';
    }
  }

  // --- .ent file extraction ---

  function parseEntFile(fileName, arrayBuffer) {
    // Decompress GZIP -> TAR
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
      if (entry.name.includes('..')) continue;

      const basename = entry.name.split('/').pop();
      if (basename === 'project.json') {
        try {
          projectData = JSON.parse(textDecoder.decode(entry.data));
        } catch (_) {
          throw new Error(`'${fileName}'의 project.json 파싱에 실패했습니다.`);
        }
      } else if (entry.data.length > 0) {
        resources.push({ name: entry.name, data: entry.data });
      }
    }

    if (!projectData) {
      throw new Error(`'${fileName}'에서 project.json을 찾을 수 없습니다.`);
    }

    return { projectData, resources };
  }

  // --- TAR output builder ---

  function buildOutputTar(mergedProject, allResources) {
    const projectJsonBytes = new TextEncoder().encode(
      JSON.stringify(mergedProject, null, 4)
    );

    // Build entries with directory structure (matches Python's tar.add(arcname="temp"))
    const tarEntries = [{ name: 'temp/', data: new Uint8Array(0) }];
    const dirs = new Set(['temp/']);

    // Add merged project.json
    allResources.set('temp/project.json', projectJsonBytes);

    for (const [path, data] of allResources) {
      if (!path.startsWith('temp/')) continue;

      // Auto-create intermediate directory entries
      const segments = path.split('/');
      for (let d = 2; d < segments.length; d++) {
        const dir = segments.slice(0, d).join('/') + '/';
        if (!dirs.has(dir)) {
          tarEntries.push({ name: dir, data: new Uint8Array(0) });
          dirs.add(dir);
        }
      }

      tarEntries.push({ name: path, data });
    }

    const tarBytes = Tar.create(tarEntries);
    return pako.gzip(tarBytes, { level: 6 });
  }

  // --- Main orchestration ---

  async function performMerge(files, options, onProgress) {
    const globalUsedIds = new Set();
    const allResources = new Map();
    let mergedProject = null;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress(Math.round((i / files.length) * 80), `처리 중: ${file.name} (${i + 1}/${files.length})`);

      const arrayBuffer = await file.arrayBuffer();

      // Yield to UI before heavy synchronous work
      await yieldToUI();

      const { projectData, resources } = parseEntFile(file.name, arrayBuffer);

      for (const r of resources) {
        allResources.set(r.name, r.data);
      }

      processSingleProject(projectData, globalUsedIds);

      if (mergedProject === null) {
        mergedProject = projectData;
      } else {
        mergeDicts(mergedProject, projectData);
      }

      // Yield after each file to keep UI responsive
      await yieldToUI();
    }

    if (!mergedProject) {
      throw new Error('유효한 project.json 데이터를 찾을 수 없습니다.');
    }

    onProgress(85, '후처리 중...');
    dedupSpecialVariables(mergedProject);
    if (options.hideTimerAnswer) hideTimerAnswerVariables(mergedProject);
    applyMetadata(mergedProject, options.clearRemake);

    onProgress(90, '파일 생성 중...');
    await yieldToUI();

    const gzBytes = buildOutputTar(mergedProject, allResources);

    onProgress(100, '완료!');
    return new Blob([gzBytes], { type: 'application/gzip' });
  }

  return { performMerge };
})();
