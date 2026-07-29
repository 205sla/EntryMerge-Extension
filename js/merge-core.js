/**
 * merge-core.js - 엔트리 작품(.ent) 병합 코어.
 *
 * 무차별 문자열 치환 대신, project.json 스키마와 블록 AST를 이해하고
 * ID namespace별로 식별자를 재발급한다.
 *
 * 사이트판 services/EntryMergeServer/entry_merge.py 와 동일한 명세를 구현한다.
 * 두 구현은 동일 입력에 대해 논리적으로 동일한 출력을 낸다(ID 자체는 난수).
 */
const MergeCore = (() => {
  'use strict';

  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const ID_LEN = 4;

  // --- ID namespace -------------------------------------------------------
  // 같은 문자열이 서로 다른 namespace의 ID로 쓰일 수 있다(실측: 'result'가
  // scene ID이면서 variable ID인 파일이 존재). 따라서 namespace를 섞지 않는다.
  const NS = {
    SCENE: 'scene',
    OBJECT: 'object',
    VARIABLE: 'variable',
    LIST: 'list',
    MESSAGE: 'message',
    FUNCTION: 'function',
    FUNCVAR: 'funcvar',
    TABLE: 'table',
  };
  const ALL_NAMESPACES = Object.keys(NS).map(k => NS[k]);

  // picture/sound는 재발급하지 않는다. getPicture/getSound는 오브젝트 내부
  // 스코프이고 ID -> 이름 -> 인덱스 순 fallback이므로 전역 유일성이 필요 없다.

  // --- 블록 파라미터 allowlist --------------------------------------------
  // 190개 실파일 코퍼스 + entryjs paramsKeyMap 대조로 도출.
  // 여기 없는 파라미터는 절대 건드리지 않는다
  // (text p0, function_field_label p0 등은 사용자 텍스트다).
  const BLOCK_PARAM_REFS = new Map();

  // 블록 type과 파라미터 인덱스를 하나의 Map 키로 합친다.
  // 인덱스가 숫자라 구분자가 블록 이름과 섞일 위험은 없다.
  function paramKey(blockType, index) {
    return blockType + '#' + index;
  }

  function reg(namespace, index, blockTypes) {
    for (const bt of blockTypes) {
      BLOCK_PARAM_REFS.set(paramKey(bt, index), namespace);
    }
  }

  reg(NS.VARIABLE, 0, [
    'set_variable', 'get_variable', 'change_variable',
    'show_variable', 'hide_variable',
  ]);

  reg(NS.LIST, 0, ['change_value_list_index', 'show_list', 'hide_list']);
  reg(NS.LIST, 1, [
    'add_value_to_list', 'insert_value_to_list', 'remove_value_from_list',
    'value_of_index_from_list', 'is_included_in_list', 'length_of_list',
  ]);

  reg(NS.FUNCVAR, 0, ['set_func_variable', 'get_func_variable']);

  reg(NS.MESSAGE, 0, ['message_cast', 'message_cast_wait']);
  reg(NS.MESSAGE, 1, ['when_message_cast']);

  // start_neighbor_scene 의 p0는 'next'/'prev' 연산자이므로 대상이 아니다.
  reg(NS.SCENE, 0, ['start_scene']);

  // 오브젝트 참조. 인덱스는 entryjs paramsKeyMap 실측값.
  reg(NS.OBJECT, 0, [
    'create_clone', 'see_angle_object', 'locate', 'text_read', 'get_block_count',
  ]);
  reg(NS.OBJECT, 1, [
    'reach_something', 'coordinate_object', 'distance_something',
    'locate_object_time',
  ]);

  function refNamespace(blockType, index) {
    if (typeof blockType !== 'string') return undefined;
    return BLOCK_PARAM_REFS.get(paramKey(blockType, index));
  }

  // allowlist 슬롯이어도 아래 예약값은 그대로 둔다. EntryJS가 특수 처리한다.
  // 근거: block_judgement.js 의 case 'wall' / targetSpriteId === 'mouse',
  //       block_flow.js 의 targetSpriteId === 'self'.
  const SENTINEL_VALUES = new Set([
    '', 'self', 'mouse', 'all', 'none', 'null', 'next', 'prev',
    'wall', 'wall_up', 'wall_down', 'wall_left', 'wall_right',
    'FRONT', 'BACK',
  ]);

  // 작품 전체에 하나만 존재해야 하는 특수 변수.
  const SPECIAL_VARIABLE_TYPES = new Set(['timer', 'answer', 'stt']);

  // 값이 충돌해도 배열로 만들면 안 되는 스칼라 필드. 첫 파일 값을 채택한다.
  // speed가 배열이 되면 Entry.FPS가 배열이 되어 1000/[60,60] = NaN 으로 틱이 붕괴한다.
  const SCALAR_FIELDS = [
    'speed', 'isPracticalCourse', 'name', 'parent', 'origin', 'user',
    'projectId', 'learning',
  ];
  const SCALAR_INTERFACE_FIELDS = ['canvasWidth', 'menuWidth', 'object'];

  // 파일별로 concat 하는 배열 필드. 값이 같아도 dedup 하지 않는다
  // (같은 보관함에서 꺼낸 동일 오브젝트 2개는 각각 독립 오브젝트여야 한다).
  const CONCAT_FIELDS = [
    'objects', 'scenes', 'variables', 'messages', 'functions', 'tables',
  ];

  // 집합 합집합으로 합치는 필드(순서 보존, 중복 제거).
  const UNION_FIELDS = [
    'expansionBlocks', 'aiUtilizeBlocks', 'hardwareLiteBlocks',
    'externalModules', 'externalModulesLite',
  ];

  class MergeError extends Error {}

  // --- ID 발급 ------------------------------------------------------------

  /**
   * namespace별 ID 재발급기.
   *
   * 매핑표는 입력 파일별로 독립이다. 서로 다른 파일이 같은 옛 ID를 쓰더라도
   * 각각 다른 새 ID를 받아야 한다(그렇지 않으면 병합 후 중복 ID가 남는다).
   * 새 ID pool은 요청 전체에서 공유해 유일성을 보장한다.
   */
  class IdAllocator {
    constructor() {
      this._used = new Set();
      this._files = [];
      this.maps = this._emptyMaps();
    }

    _emptyMaps() {
      const maps = {};
      for (const ns of ALL_NAMESPACES) maps[ns] = new Map();
      return maps;
    }

    beginFile() {
      this.maps = this._emptyMaps();
      this._files.push(this.maps);
      return this.maps;
    }

    fresh() {
      let id;
      do {
        id = '';
        for (let i = 0; i < ID_LEN; i++) {
          id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
        }
      } while (this._used.has(id));
      this._used.add(id);
      return id;
    }

    reserve(value) {
      if (value) this._used.add(String(value));
    }

    remap(namespace, oldId) {
      if (oldId === null || oldId === undefined) return null;
      const key = String(oldId);
      const table = this.maps[namespace];
      if (!table.has(key)) table.set(key, this.fresh());
      return table.get(key);
    }

    alias(namespace, oldId, newId) {
      this.maps[namespace].set(String(oldId), newId);
    }

    lookup(namespace, oldId) {
      if (oldId === null || oldId === undefined) return null;
      return this.maps[namespace].get(String(oldId)) || null;
    }
  }

  // --- 블록 AST 순회 ------------------------------------------------------

  function rewriteBlockParams(node, allocator) {
    if (Array.isArray(node)) {
      for (const item of node) rewriteBlockParams(item, allocator);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const blockType = node.type;

    // func_<functionId> 형태의 함수 호출 블록 타입.
    if (typeof blockType === 'string' && blockType.startsWith('func_')) {
      const oldFid = blockType.slice('func_'.length);
      const newFid = allocator.lookup(NS.FUNCTION, oldFid);
      if (newFid) node.type = 'func_' + newFid;
    }

    const params = node.params;
    if (Array.isArray(params)) {
      for (let i = 0; i < params.length; i++) {
        const param = params[i];
        if (typeof param === 'string') {
          const namespace = refNamespace(blockType, i);
          if (!namespace) continue;
          if (SENTINEL_VALUES.has(param)) continue;
          const mapped = allocator.lookup(namespace, param);
          // 매핑에 없으면 원본을 보존한다(이미 끊어진 참조를 새로 깨뜨리지 않는다).
          if (mapped) params[i] = mapped;
        } else {
          rewriteBlockParams(param, allocator);
        }
      }
    }

    if (Array.isArray(node.statements)) {
      for (const statement of node.statements) {
        rewriteBlockParams(statement, allocator);
      }
    }
  }

  function rewriteScript(script, allocator) {
    if (typeof script !== 'string' || !script.trim()) return script;
    let tree;
    try {
      tree = JSON.parse(script);
    } catch (_) {
      // 파싱 불가한 script는 건드리지 않는다. 무차별 치환보다 보존이 안전하다.
      return script;
    }
    rewriteBlockParams(tree, allocator);
    return JSON.stringify(tree);
  }

  // --- 단일 프로젝트 ID 재발급 -------------------------------------------

  function collectAndRemapDeclarations(project, allocator) {
    // 입력 파일 자체에 중복 ID가 있을 수 있다(과거 버그로 만들어진 작품).
    // 첫 항목만 매핑에 등록하고, 뒤따르는 동일 ID 항목은 새 ID를 따로 발급한다.
    const remapUnique = (items, namespace) => {
      const seen = new Set();
      for (const item of items || []) {
        if (!item || typeof item !== 'object' || !item.id) continue;
        const oldId = String(item.id);
        if (seen.has(oldId)) {
          item.id = allocator.fresh();
        } else {
          seen.add(oldId);
          item.id = allocator.remap(namespace, oldId);
        }
      }
    };

    remapUnique(project.scenes, NS.SCENE);
    remapUnique(project.objects, NS.OBJECT);
    remapUnique(project.messages, NS.MESSAGE);
    remapUnique(project.tables, NS.TABLE);

    const seenVars = new Set();
    for (const variable of project.variables || []) {
      if (!variable || typeof variable !== 'object' || !variable.id) continue;
      // 특수 변수(초시계/대답/음성인식)도 파일별로 재발급한다. 병합 후
      // unifySpecialVariables()가 대표 1개만 남기고 참조를 대표 ID로 돌린다.
      const namespace = variable.variableType === 'list' ? NS.LIST : NS.VARIABLE;
      const oldId = String(variable.id);
      const key = namespace + '|' + oldId;
      if (seenVars.has(key)) {
        variable.id = allocator.fresh();
      } else {
        seenVars.add(key);
        variable.id = allocator.remap(namespace, oldId);
      }
    }

    const seenFuncs = new Set();
    for (const func of project.functions || []) {
      if (!func || typeof func !== 'object' || !func.id) continue;
      const oldFid = String(func.id);
      let newFid;
      if (seenFuncs.has(oldFid)) {
        newFid = allocator.fresh();
      } else {
        seenFuncs.add(oldFid);
        newFid = allocator.remap(NS.FUNCTION, oldFid);
      }
      func.id = newFid;

      // 함수 지역변수는 `${func.id}_${hash}` 복합 ID다. 접두사를 함께 바꾼다.
      for (const local of func.localVariables || []) {
        if (!local || typeof local !== 'object' || !local.id) continue;
        const oldLid = String(local.id);
        const prefix = oldFid + '_';
        if (oldLid.startsWith(prefix)) {
          const newLid = newFid + '_' + oldLid.slice(prefix.length);
          allocator.alias(NS.FUNCVAR, oldLid, newLid);
          allocator.reserve(newLid);
          local.id = newLid;
        } else {
          local.id = allocator.remap(NS.FUNCVAR, oldLid);
        }
      }
    }
  }

  function rewriteReferences(project, allocator) {
    for (const obj of project.objects || []) {
      if (!obj || typeof obj !== 'object') continue;
      const newScene = allocator.lookup(NS.SCENE, obj.scene);
      if (newScene) obj.scene = newScene;
      obj.script = rewriteScript(obj.script, allocator);
    }

    // 지역변수 소유권(object)은 오브젝트 ID 변경과 함께 갱신해야 한다.
    for (const variable of project.variables || []) {
      if (!variable || typeof variable !== 'object') continue;
      if (variable.object) {
        const newOwner = allocator.lookup(NS.OBJECT, variable.object);
        if (newOwner) variable.object = newOwner;
      }
    }

    for (const func of project.functions || []) {
      if (!func || typeof func !== 'object') continue;
      if (typeof func.content === 'string') {
        func.content = rewriteScript(func.content, allocator);
      } else if (func.content && typeof func.content === 'object') {
        rewriteBlockParams(func.content, allocator);
      }
    }

    const iface = project.interface;
    if (iface && typeof iface === 'object' && iface.object) {
      const newObj = allocator.lookup(NS.OBJECT, iface.object);
      if (newObj) iface.object = newObj;
    }
  }

  function prepareProject(project, allocator) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new MergeError('project.json 형식이 올바르지 않습니다.');
    }
    // 파일마다 독립 namespace. 같은 옛 ID라도 파일별로 다른 새 ID를 받는다.
    allocator.beginFile();
    collectAndRemapDeclarations(project, allocator);
    rewriteReferences(project, allocator);
    return project;
  }

  // --- 스키마 기반 병합 ---------------------------------------------------

  function mergeProjects(projects) {
    if (!projects || !projects.length) {
      throw new MergeError('병합할 프로젝트가 없습니다.');
    }

    const merged = {};
    const base = projects[0];

    // 스칼라 필드는 첫 파일 값을 채택한다(배열화 금지).
    for (const field of SCALAR_FIELDS) {
      if (field in base) merged[field] = base[field];
    }

    if (base.interface && typeof base.interface === 'object') {
      merged.interface = {};
      for (const key of SCALAR_INTERFACE_FIELDS) {
        if (key in base.interface) merged.interface[key] = base.interface[key];
      }
    }

    for (const field of CONCAT_FIELDS) {
      const combined = [];
      for (const project of projects) {
        if (Array.isArray(project[field])) combined.push(...project[field]);
      }
      if (combined.length || field in base) merged[field] = combined;
    }

    for (const field of UNION_FIELDS) {
      const seen = [];
      const seenKeys = new Set();
      for (const project of projects) {
        if (!Array.isArray(project[field])) continue;
        for (const item of project[field]) {
          const key = (item && typeof item === 'object')
            ? JSON.stringify(item)
            : String(item);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            seen.push(item);
          }
        }
      }
      if (seen.length || field in base) merged[field] = seen;
    }

    // 알려지지 않은 최상위 필드는 첫 파일 값을 보존한다(스키마 변화 대비).
    const known = new Set([...SCALAR_FIELDS, ...CONCAT_FIELDS, ...UNION_FIELDS, 'interface']);
    for (const project of projects) {
      for (const key of Object.keys(project)) {
        if (!known.has(key) && !(key in merged)) merged[key] = project[key];
      }
    }

    return merged;
  }

  /**
   * 초시계/대답/음성인식 변수는 작품 전체에 하나만 존재해야 한다.
   * 첫 항목을 대표로 남기고, 버려지는 항목의 ID는 대표 ID로 치환해 참조를 살린다.
   *
   * 병합 이후에 호출되므로 이 시점의 ID는 이미 재발급된 최종 ID다.
   */
  function unifySpecialVariables(merged) {
    if (!Array.isArray(merged.variables)) return merged;

    const representative = new Map();
    const redirect = new Map();
    const kept = [];

    for (const variable of merged.variables) {
      if (!variable || typeof variable !== 'object') {
        kept.push(variable);
        continue;
      }
      const vtype = variable.variableType;
      if (!SPECIAL_VARIABLE_TYPES.has(vtype)) {
        kept.push(variable);
        continue;
      }
      if (representative.has(vtype)) {
        // 버려지는 항목 -> 대표 ID로 참조를 돌린다.
        if (variable.id) redirect.set(String(variable.id), representative.get(vtype));
        continue;
      }
      representative.set(vtype, variable.id);
      kept.push(variable);
    }

    merged.variables = kept;
    if (redirect.size) redirectVariableRefs(merged, redirect);
    return merged;
  }

  function redirectVariableRefs(merged, redirect) {
    const fix = (node) => {
      if (Array.isArray(node)) {
        for (const item of node) fix(item);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const params = node.params;
      if (Array.isArray(params)) {
        for (let i = 0; i < params.length; i++) {
          const param = params[i];
          if (typeof param === 'string') {
            if (refNamespace(node.type, i) === NS.VARIABLE && redirect.has(param)) {
              params[i] = redirect.get(param);
            }
          } else {
            fix(param);
          }
        }
      }
      if (Array.isArray(node.statements)) for (const s of node.statements) fix(s);
    };

    const fixScript = (script) => {
      if (typeof script !== 'string' || !script.trim()) return script;
      let tree;
      try {
        tree = JSON.parse(script);
      } catch (_) {
        return script;
      }
      fix(tree);
      return JSON.stringify(tree);
    };

    for (const obj of merged.objects || []) {
      if (obj && typeof obj === 'object') obj.script = fixScript(obj.script);
    }
    for (const func of merged.functions || []) {
      if (func && typeof func === 'object' && typeof func.content === 'string') {
        func.content = fixScript(func.content);
      }
    }
  }

  // --- 후처리 -------------------------------------------------------------

  function hideTimerAnswerVariables(merged) {
    if (!Array.isArray(merged.variables)) return merged;
    for (const variable of merged.variables) {
      if (variable && typeof variable === 'object' &&
          SPECIAL_VARIABLE_TYPES.has(variable.variableType)) {
        variable.x = 2050;
        variable.y = 2050;
      }
    }
    return merged;
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
    return merged;
  }

  // --- 리소스 충돌 --------------------------------------------------------

  /** FNV-1a 32bit. 내용 동일성 판별용(암호학 용도 아님). */
  function hashBytes(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // 길이를 섞어 짧은 충돌을 줄인다.
    h ^= bytes.length;
    return (Math.imul(h, 0x01000193) >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 파일별 리소스 목록을 합친다.
   * 경로가 같고 내용이 같으면 1회만 저장. 내용이 다르면 경로를 바꾼다.
   * @returns {{resolved: Map<string, Uint8Array>, renames: Array}}
   */
  function resolveResources(filesResources) {
    const resolved = new Map();
    const digests = new Map();
    const renames = [];

    filesResources.forEach((resources, fileIndex) => {
      for (const { name, data } of resources) {
        const digest = hashBytes(data);
        if (!resolved.has(name)) {
          resolved.set(name, data);
          digests.set(name, digest);
          continue;
        }
        if (digests.get(name) === digest) continue; // 동일 내용 -> 생략
        const newPath = dedupePath(name, digest, resolved);
        resolved.set(newPath, data);
        digests.set(newPath, digest);
        renames.push({ fileIndex, oldPath: name, newPath });
      }
    });

    return { resolved, renames };
  }

  function dedupePath(path, digest, resolved) {
    const lastSegment = path.slice(path.lastIndexOf('/') + 1);
    let stem = path;
    let suffix = '';
    if (lastSegment.includes('.')) {
      const dot = path.lastIndexOf('.');
      stem = path.slice(0, dot);
      suffix = path.slice(dot);
    }
    for (let n = 1; n < 1000; n++) {
      const tag = n === 1 ? digest.slice(0, 6) : digest.slice(0, 6) + n;
      const candidate = `${stem}_${tag}${suffix}`;
      if (!resolved.has(candidate)) return candidate;
    }
    throw new MergeError('리소스 경로 충돌을 해결할 수 없습니다: ' + path);
  }

  function applyResourceRenames(projects, renames) {
    if (!renames || !renames.length) return;
    const byFile = new Map();
    for (const { fileIndex, oldPath, newPath } of renames) {
      if (!byFile.has(fileIndex)) byFile.set(fileIndex, new Map());
      byFile.get(fileIndex).set(oldPath, newPath);
    }
    for (const [fileIndex, mapping] of byFile) {
      const project = projects[fileIndex];
      if (!project) continue;
      for (const obj of project.objects || []) {
        const sprite = obj && obj.sprite;
        if (!sprite || typeof sprite !== 'object') continue;
        for (const group of ['pictures', 'sounds']) {
          for (const item of sprite[group] || []) {
            if (item && typeof item === 'object' && mapping.has(item.fileurl)) {
              item.fileurl = mapping.get(item.fileurl);
            }
          }
        }
      }
    }
  }

  // --- 출력 검증 ----------------------------------------------------------

  function collectDeclared(project) {
    const declared = {};
    for (const ns of ALL_NAMESPACES) declared[ns] = new Set();

    for (const scene of project.scenes || []) {
      if (scene && scene.id) declared[NS.SCENE].add(String(scene.id));
    }
    for (const obj of project.objects || []) {
      if (obj && obj.id) declared[NS.OBJECT].add(String(obj.id));
    }
    for (const variable of project.variables || []) {
      if (!variable || !variable.id) continue;
      const ns = variable.variableType === 'list' ? NS.LIST : NS.VARIABLE;
      declared[ns].add(String(variable.id));
    }
    for (const message of project.messages || []) {
      if (message && message.id) declared[NS.MESSAGE].add(String(message.id));
    }
    for (const table of project.tables || []) {
      if (table && table.id) declared[NS.TABLE].add(String(table.id));
    }
    for (const func of project.functions || []) {
      if (!func) continue;
      if (func.id) declared[NS.FUNCTION].add(String(func.id));
      for (const local of func.localVariables || []) {
        if (local && local.id) declared[NS.FUNCVAR].add(String(local.id));
      }
    }
    return declared;
  }

  function validateScriptRefs(script, declared, label) {
    const problems = [];
    if (typeof script !== 'string' || !script.trim()) return problems;
    let tree;
    try {
      tree = JSON.parse(script);
    } catch (_) {
      return problems;
    }

    const visit = (node) => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const blockType = node.type;
      if (typeof blockType === 'string' && blockType.startsWith('func_')) {
        const fid = blockType.slice('func_'.length);
        if (fid && !declared[NS.FUNCTION].has(fid)) {
          problems.push(`${label}: 없는 함수를 호출합니다(func_${fid}).`);
        }
      }
      const params = node.params;
      if (Array.isArray(params)) {
        for (let i = 0; i < params.length; i++) {
          const param = params[i];
          if (typeof param === 'string') {
            const ns = refNamespace(blockType, i);
            if (ns && param && !SENTINEL_VALUES.has(param) && !declared[ns].has(param)) {
              problems.push(
                `${label}: ${ns} 참조가 끊어졌습니다(${blockType} p${i} = ${param}).`);
            }
          } else {
            visit(param);
          }
        }
      }
      if (Array.isArray(node.statements)) for (const s of node.statements) visit(s);
    };

    visit(tree);
    return problems;
  }

  /**
   * 한 프로젝트의 끊어진 참조 개수. 입력이 이미 망가진 경우를 병합 실패로
   * 리하지 않기 위한 기준선으로 쓴다.
   */
  function countBrokenRefs(project) {
    const declared = collectDeclared(project);
    let total = 0;
    for (const obj of project.objects || []) {
      if (obj) total += validateScriptRefs(obj.script, declared, '').length;
    }
    for (const func of project.functions || []) {
      if (func && typeof func.content === 'string') {
        total += validateScriptRefs(func.content, declared, '').length;
      }
    }
    return total;
  }

  /**
   * 중복 ID / 끊어진 참조 / 타입 오류를 검사한다.
   * @param {number} baselineBrokenRefs 입력이 이미 갖고 있던 끊어진 참조 수.
   */
  function validateMerged(merged, resourcePaths, baselineBrokenRefs = 0) {
    const problems = [];
    const brokenRefs = [];
    const declared = {};
    for (const ns of ALL_NAMESPACES) declared[ns] = new Set();

    const declare = (namespace, value, label) => {
      if (!value) return;
      const key = String(value);
      if (declared[namespace].has(key)) {
        problems.push(`중복 ${namespace} ID: ${key} (${label})`);
      }
      declared[namespace].add(key);
    };

    for (const scene of merged.scenes || []) {
      if (scene) declare(NS.SCENE, scene.id, scene.name || '');
    }
    for (const obj of merged.objects || []) {
      if (obj) declare(NS.OBJECT, obj.id, obj.name || '');
    }
    for (const variable of merged.variables || []) {
      if (!variable) continue;
      const ns = variable.variableType === 'list' ? NS.LIST : NS.VARIABLE;
      declare(ns, variable.id, variable.name || '');
    }
    for (const message of merged.messages || []) {
      if (message) declare(NS.MESSAGE, message.id, message.name || '');
    }
    for (const table of merged.tables || []) {
      if (table) declare(NS.TABLE, table.id, table.name || '');
    }
    for (const func of merged.functions || []) {
      if (!func) continue;
      declare(NS.FUNCTION, func.id, 'function');
      for (const local of func.localVariables || []) {
        if (local) declare(NS.FUNCVAR, local.id, local.name || '');
      }
    }

    // 특수 변수는 타입별로 하나만 남아야 한다.
    const typeCounts = new Map();
    for (const variable of merged.variables || []) {
      if (variable && SPECIAL_VARIABLE_TYPES.has(variable.variableType)) {
        const t = variable.variableType;
        typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
      }
    }
    for (const [vtype, count] of typeCounts) {
      if (count > 1) problems.push(`특수 변수 ${vtype}가 ${count}개 남았습니다.`);
    }

    // 스칼라 필드 타입.
    if (Array.isArray(merged.speed)) {
      problems.push('speed가 배열입니다(Entry.FPS 붕괴).');
    }
    if (merged.interface && typeof merged.interface === 'object') {
      if (Array.isArray(merged.interface.object)) {
        problems.push('interface.object가 배열입니다.');
      }
      const ifaceObj = merged.interface.object;
      if (ifaceObj && !declared[NS.OBJECT].has(String(ifaceObj))) {
        problems.push(`interface.object가 없는 오브젝트를 가리킵니다: ${ifaceObj}`);
      }
    }

    // 참조 검사.
    for (const obj of merged.objects || []) {
      if (!obj || typeof obj !== 'object') continue;
      if (obj.scene && !declared[NS.SCENE].has(String(obj.scene))) {
        problems.push(
          `오브젝트 '${obj.name || '?'}'의 scene 참조가 끊어졌습니다: ${obj.scene}`);
      }
      brokenRefs.push(
        ...validateScriptRefs(obj.script, declared, `오브젝트 '${obj.name || '?'}'`));
    }

    for (const variable of merged.variables || []) {
      if (!variable || typeof variable !== 'object') continue;
      if (variable.object && !declared[NS.OBJECT].has(String(variable.object))) {
        problems.push(
          `지역변수 '${variable.name || '?'}'의 소유 오브젝트가 없습니다: ${variable.object}`);
      }
    }

    for (const func of merged.functions || []) {
      if (func && typeof func.content === 'string') {
        brokenRefs.push(...validateScriptRefs(func.content, declared, '함수'));
      }
    }

    // 입력이 이미 갖고 있던 끊어진 참조는 병합 실패로 보지 않는다.
    if (brokenRefs.length > baselineBrokenRefs) {
      problems.push(...brokenRefs.slice(0, brokenRefs.length - baselineBrokenRefs));
    }

    if (resourcePaths) {
      const available = new Set(resourcePaths);
      for (const obj of merged.objects || []) {
        const sprite = obj && obj.sprite;
        if (!sprite || typeof sprite !== 'object') continue;
        for (const group of ['pictures', 'sounds']) {
          for (const item of sprite[group] || []) {
            if (!item || typeof item !== 'object') continue;
            const url = item.fileurl;
            if (typeof url !== 'string' || !url) continue;
            // 아카이브에 동봉되는 리소스만 검사한다.
            // '/images/...'(사이트 정적 자산), './bower_components/...'
            // (EntryJS 기본 미디어), 절대 URL은 아카이브 항목이 아니다.
            if (!url.startsWith('temp/')) continue;
            if (!available.has(url)) problems.push(`리소스 누락: ${url}`);
          }
        }
      }
    }

    return problems;
  }

  return {
    NS,
    MergeError,
    IdAllocator,
    prepareProject,
    mergeProjects,
    unifySpecialVariables,
    hideTimerAnswerVariables,
    applyMetadata,
    resolveResources,
    applyResourceRenames,
    validateMerged,
    countBrokenRefs,
    // 테스트용 내부 노출
    _internal: { rewriteScript, refNamespace, SENTINEL_VALUES, hashBytes },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MergeCore;
}
