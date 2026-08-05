(function () {
  'use strict';

  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const MAX_TOTAL_SIZE = 150 * 1024 * 1024;
  const MAX_FILE_COUNT = 10;

  // --- DOM references ---
  const $ = id => document.getElementById(id);
  const dom = {
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    fileList: $('fileList'),
    mergeBtn: $('mergeBtn'),
    status: $('status'),
    totalSize: $('totalSize'),
    extraToggle: $('extraToggle'),
    extraSettings: $('extraSettings'),
    remakeModeInputs: [...document.querySelectorAll('input[name="remakeMode"]')],
    remakeSource: $('remakeSource'),
    hideTimerAnswer: $('hideTimerAnswer'),
    overlay: $('progressOverlay'),
    progressMsg: $('progressMsg'),
    progressBarTrack: $('progressBarTrack'),
    progressBar: $('progressBar'),
    progressPct: $('progressPct'),
    progressClose: $('progressClose'),
  };

  let files = [];
  let remakeSourceFile = null;
  let dragCounter = 0; // Tracks nested dragenter/dragleave events
  let focusBeforeProgress = null;

  // --- Settings toggle ---
  dom.extraToggle.addEventListener('click', () => {
    const isOpen = dom.extraSettings.classList.toggle('show');
    dom.extraToggle.setAttribute('aria-expanded', String(isOpen));
  });

  function selectedRemakeMode() {
    return dom.remakeModeInputs.find(input => input.checked)?.value || 'default';
  }

  function syncRemakeSource() {
    if (!files.includes(remakeSourceFile)) remakeSourceFile = files[0] || null;
    dom.remakeSource.innerHTML = '';
    if (files.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '먼저 작품 파일을 추가해주세요';
      dom.remakeSource.appendChild(option);
    } else {
      files.forEach((file, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `${index + 1}. ${file.name}`;
        option.selected = file === remakeSourceFile;
        dom.remakeSource.appendChild(option);
      });
    }
    dom.remakeSource.disabled = selectedRemakeMode() !== 'source' || files.length === 0;
  }

  dom.remakeModeInputs.forEach(input => input.addEventListener('change', syncRemakeSource));
  dom.remakeSource.addEventListener('change', () => {
    remakeSourceFile = files[Number(dom.remakeSource.value)] || null;
  });

  // --- Drag & drop (with nested element handling) ---
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); }
  });

  dom.dropZone.addEventListener('dragenter', e => {
    e.preventDefault();
    if (++dragCounter === 1) dom.dropZone.classList.add('drag-over');
  });
  dom.dropZone.addEventListener('dragleave', e => {
    e.preventDefault();
    if (--dragCounter === 0) dom.dropZone.classList.remove('drag-over');
  });
  dom.dropZone.addEventListener('dragover', e => e.preventDefault());
  dom.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    dom.dropZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  dom.fileInput.addEventListener('change', () => {
    addFiles(dom.fileInput.files);
    dom.fileInput.value = '';
  });

  // --- File management ---
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function addFiles(newFiles) {
    for (const f of newFiles) {
      if (!f.name.toLowerCase().endsWith('.ent')) continue;
      if (files.some(x => x.name === f.name && x.size === f.size)) continue;
      if (files.length >= MAX_FILE_COUNT) break;
      files.push(f);
    }
    renderList();
  }

  function removeFile(idx) {
    files.splice(idx, 1);
    renderList();
  }

  function renderList() {
    dom.fileList.innerHTML = '';
    let total = 0;
    let hasOverSize = false;

    files.forEach((f, i) => {
      total += f.size;
      const overSize = f.size > MAX_FILE_SIZE;
      if (overSize) hasOverSize = true;

      const li = document.createElement('li');
      if (overSize) li.classList.add('over-size');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.textContent = f.name;

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'size';
      sizeSpan.textContent = formatSize(f.size) + (overSize ? ' (초과!)' : '');

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.setAttribute('aria-label', `${f.name} 제거`);
      removeBtn.addEventListener('click', () => removeFile(i));

      li.append(nameSpan, sizeSpan, removeBtn);
      dom.fileList.appendChild(li);
    });

    const totalOver = total > MAX_TOTAL_SIZE;

    if (files.length > 0) {
      dom.totalSize.textContent = `합계: ${formatSize(total)} / ${formatSize(MAX_TOTAL_SIZE)}`;
      dom.totalSize.className = 'total-size' + (totalOver ? ' over' : '');
    } else {
      dom.totalSize.textContent = '';
    }

    dom.mergeBtn.disabled = files.length < 2 || hasOverSize || totalOver;

    setStatus('', '');

    if (hasOverSize) {
      setStatus('50MB를 초과하는 파일이 있습니다.', 'error');
    } else if (totalOver) {
      setStatus('전체 용량이 150MB를 초과합니다.', 'error');
    }
    syncRemakeSource();
  }

  // --- Status message ---
  function setStatus(text, type) {
    dom.status.textContent = text;
    dom.status.className = 'status' + (type ? ' ' + type : '');
  }

  // --- Progress overlay ---
  function showProgress() {
    focusBeforeProgress = document.activeElement;
    dom.progressMsg.textContent = '작품을 합치는 중...';
    dom.progressBar.style.width = '0%';
    dom.progressBarTrack.setAttribute('aria-valuenow', '0');
    dom.progressPct.textContent = '0%';
    dom.progressClose.style.display = 'none';
    dom.overlay.setAttribute('aria-hidden', 'false');
    dom.overlay.classList.add('show');
  }

  function updateProgress(pct, msg) {
    const normalized = Math.max(0, Math.min(100, Number(pct) || 0));
    dom.progressBar.style.width = normalized + '%';
    dom.progressBarTrack.setAttribute('aria-valuenow', String(normalized));
    dom.progressPct.textContent = normalized + '%';
    if (msg) dom.progressMsg.textContent = msg;
  }

  function finishProgress(success) {
    dom.progressClose.style.display = 'block';
    if (success) {
      dom.progressMsg.textContent = '합치기 완료!';
      dom.progressBar.style.width = '100%';
      dom.progressBarTrack.setAttribute('aria-valuenow', '100');
      dom.progressPct.textContent = '100%';
    }
    dom.progressClose.focus();
  }

  dom.progressClose.addEventListener('click', () => {
    dom.overlay.classList.remove('show');
    dom.overlay.setAttribute('aria-hidden', 'true');
    const focusTarget = focusBeforeProgress && focusBeforeProgress !== document.body
      ? focusBeforeProgress
      : dom.mergeBtn;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
    focusBeforeProgress = null;
  });

  // --- Merge ---
  dom.mergeBtn.addEventListener('click', async () => {
    if (files.length < 2) return;

    const remakeMode = selectedRemakeMode();
    const remakeSourceIndex = files.indexOf(remakeSourceFile);
    if (remakeMode === 'source' && remakeSourceIndex < 0) {
      setStatus('원본 정보를 유지할 작품을 선택해주세요.', 'error');
      return;
    }

    dom.mergeBtn.disabled = true;
    dom.mergeBtn.textContent = '합치는 중...';
    setStatus('로컬에서 처리 중입니다...', 'loading');
    showProgress();

    try {
      const blob = await MergeEngine.performMerge(
        [...files],
        {
          remakeMode,
          remakeSourceIndex,
          hideTimerAnswer: dom.hideTimerAnswer.checked
        },
        updateProgress
      );

      // Trigger download (defer revokeObjectURL to ensure download starts)
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '머지.ent';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      dom.mergeBtn.textContent = '작품 합치기';
      renderList();
      setStatus('합치기 완료! 파일이 다운로드됩니다.', 'success');
      finishProgress(true);
    } catch (e) {
      const msg = e.message || '오류가 발생했습니다.';
      dom.mergeBtn.textContent = '작품 합치기';
      renderList();
      setStatus(msg, 'error');
      updateProgress(0, '오류 발생: ' + msg);
      finishProgress(false);
    }
  });
})();
