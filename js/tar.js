/**
 * tar.js - Lightweight TAR archive parser and creator for browser environments.
 *
 * 읽기: USTAR + PAX(typeflag 'x'/'g') + GNU longname/longlink('L'/'K') 확장 헤더.
 *       파이썬 tarfile의 기본 출력이 PAX이므로, PAX를 모르면 100자 초과 경로가
 *       잘려 리소스 참조가 끊어진다.
 * 쓰기: USTAR 고정. 100자 초과 경로는 prefix/name 으로 바이트 단위 분할한다.
 */
const Tar = (() => {
  'use strict';

  const BLOCK = 512;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /**
   * Parse a TAR archive from a Uint8Array.
   * @param {Uint8Array} buffer - Raw TAR data (already decompressed).
   * @returns {Array<{name: string, data: Uint8Array, type: string}>}
   */
  function parse(buffer) {
    if (!buffer || buffer.length < BLOCK) return [];

    const entries = [];
    let offset = 0;

    // 확장 헤더가 다음 항목에 넘겨주는 값.
    let pendingName = null;
    let pendingLinkName = null;
    // PAX global header('g')가 지정한 기본값.
    let globalName = null;

    while (offset + BLOCK <= buffer.length) {
      const header = buffer.subarray(offset, offset + BLOCK);
      if (isZeroBlock(header)) break;

      const typeFlag = String.fromCharCode(header[156]);
      const size = readOctal(header, 124, 12);
      const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;

      offset += BLOCK;
      const dataEnd = Math.min(offset + size, buffer.length);
      const rawData = size > 0 ? buffer.subarray(offset, dataEnd) : new Uint8Array(0);

      // --- 확장 헤더: 데이터가 메타데이터다. 항목으로 내보내지 않는다. ---
      if (typeFlag === 'x' || typeFlag === 'X') {
        const records = parsePaxRecords(rawData);
        if (records.path !== undefined) pendingName = records.path;
        if (records.linkpath !== undefined) pendingLinkName = records.linkpath;
        offset += dataBlocks;
        continue;
      }
      if (typeFlag === 'g') {
        const records = parsePaxRecords(rawData);
        if (records.path !== undefined) globalName = records.path;
        offset += dataBlocks;
        continue;
      }
      if (typeFlag === 'L') {
        // GNU longname: 데이터 전체가 다음 항목의 경로(NUL 종단).
        pendingName = decodeCString(rawData);
        offset += dataBlocks;
        continue;
      }
      if (typeFlag === 'K') {
        pendingLinkName = decodeCString(rawData);
        offset += dataBlocks;
        continue;
      }

      // --- 실제 항목 ---
      let fullName;
      if (pendingName !== null) {
        fullName = pendingName;
      } else {
        const name = readStr(header, 0, 100);
        const magic = readStr(header, 257, 6);
        fullName = name;
        if (magic.startsWith('ustar')) {
          const prefix = readStr(header, 345, 155);
          if (prefix) fullName = prefix + '/' + name;
        }
        if (!fullName && globalName) fullName = globalName;
      }
      fullName = normalizePath(fullName);
      pendingName = null;
      pendingLinkName = null;

      // 심볼릭/하드 링크는 버린다(아카이브 밖을 가리킬 수 있다).
      if (typeFlag === '1' || typeFlag === '2') {
        offset += dataBlocks;
        continue;
      }

      if (size > 0) {
        if (offset + size <= buffer.length) {
          entries.push({
            name: fullName,
            data: buffer.slice(offset, offset + size),
            type: typeFlag,
          });
        }
        // 데이터가 잘린 항목은 조용히 빈 파일로 만들지 않고 건너뛴다.
      } else {
        entries.push({ name: fullName, data: new Uint8Array(0), type: typeFlag });
      }

      offset += dataBlocks;
    }

    return entries;
  }

  /**
   * PAX 확장 헤더 데이터를 파싱한다.
   * 형식: "<len> <key>=<value>\n" 의 반복. len은 레코드 전체 바이트 수.
   */
  function parsePaxRecords(data) {
    const records = {};
    let i = 0;
    while (i < data.length) {
      // 길이 필드(공백까지)
      let sp = i;
      while (sp < data.length && data[sp] !== 0x20) sp++;
      if (sp >= data.length) break;
      const len = parseInt(decoder.decode(data.subarray(i, sp)), 10);
      if (!Number.isFinite(len) || len <= 0 || i + len > data.length) break;

      // "<key>=<value>\n"
      const body = data.subarray(sp + 1, i + len);
      let eq = 0;
      while (eq < body.length && body[eq] !== 0x3d) eq++;
      if (eq < body.length) {
        const key = decoder.decode(body.subarray(0, eq));
        // 끝의 개행 하나를 제거한다.
        let end = body.length;
        if (end > 0 && body[end - 1] === 0x0a) end--;
        records[key] = decoder.decode(body.subarray(eq + 1, end));
      }
      i += len;
    }
    return records;
  }

  function decodeCString(data) {
    let end = 0;
    while (end < data.length && data[end] !== 0) end++;
    return decoder.decode(data.subarray(0, end));
  }

  /**
   * Create a TAR archive from entries (USTAR).
   * Entries with names ending in '/' are treated as directories (type '5').
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @returns {Uint8Array}
   */
  function create(entries) {
    if (!entries || entries.length === 0) return new Uint8Array(BLOCK * 2);

    // Pre-calculate total size for single allocation
    let totalSize = BLOCK * 2; // end-of-archive marker
    for (const entry of entries) {
      const size = entry.name.endsWith('/') ? 0 : (entry.data ? entry.data.length : 0);
      totalSize += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }

    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const entry of entries) {
      const isDir = entry.name.endsWith('/');
      const data = isDir ? null : (entry.data || new Uint8Array(0));
      const size = data ? data.length : 0;

      // Build 512-byte POSIX header
      const header = result.subarray(offset, offset + BLOCK);
      writeName(header, entry.name);
      writeStr(header, 100, 8, isDir ? '0000755\0' : '0000644\0'); // mode
      writeStr(header, 108, 8, '0000000\0'); // uid = 0
      writeStr(header, 116, 8, '0000000\0'); // gid = 0
      writeStr(header, 124, 12, padOctal(size, 11) + '\0'); // size
      writeStr(header, 136, 12, padOctal(0, 11) + '\0');    // mtime = 0
      header[156] = isDir ? 53 : 48; // type: '5' dir or '0' file
      writeStr(header, 257, 6, 'ustar\0'); // magic
      writeStr(header, 263, 2, '00');       // version

      // Checksum: fill field with spaces, sum all bytes, write result
      for (let i = 148; i < 156; i++) header[i] = 32;
      let chksum = 0;
      for (let i = 0; i < BLOCK; i++) chksum += header[i];
      writeStr(header, 148, 8, padOctal(chksum, 6) + '\0 ');

      offset += BLOCK;

      // Write file data + padding
      if (size > 0) {
        result.set(data, offset);
        offset += Math.ceil(size / BLOCK) * BLOCK;
      }
    }

    // End-of-archive (remaining bytes are already zero)
    return result;
  }

  // --- Helpers ---

  function isZeroBlock(block) {
    for (let i = 0; i < BLOCK; i++) {
      if (block[i] !== 0) return false;
    }
    return true;
  }

  function readStr(buf, off, len) {
    let end = off;
    const limit = off + len;
    while (end < limit && buf[end] !== 0) end++;
    return decoder.decode(buf.subarray(off, end));
  }

  function readOctal(buf, off, len) {
    // GNU base-256 확장(최상위 비트 set)도 처리한다.
    if (buf[off] & 0x80) {
      let value = 0;
      for (let i = off; i < off + len; i++) {
        value = value * 256 + (i === off ? (buf[i] & 0x7f) : buf[i]);
      }
      return value;
    }
    const s = readStr(buf, off, len).trim();
    return s ? (parseInt(s, 8) || 0) : 0;
  }

  function writeStr(buf, off, len, str) {
    const bytes = encoder.encode(str);
    const n = Math.min(bytes.length, len);
    for (let i = 0; i < n; i++) buf[off + i] = bytes[i];
  }

  function writeName(header, name) {
    const bytes = encoder.encode(name);
    if (bytes.length <= 100) {
      header.set(bytes, 0);
      return;
    }
    // USTAR: prefix(345, 155바이트) + '/' + name(0, 100바이트).
    // 바이트 길이로 나눠야 한다(한글 경로에서 문자 수로 나누면 넘친다).
    // name 부분이 100바이트 이하가 되는 가장 앞쪽 '/'를 찾는다.
    const split = findUstarSplit(name, bytes);
    if (!split) {
      throw new Error(`TAR 경로가 너무 깁니다(USTAR 한계 초과): ${name}`);
    }
    writeStr(header, 345, 155, split.prefix);
    writeStr(header, 0, 100, split.name);
  }

  function findUstarSplit(name, bytes) {
    // 각 '/'를 경계로 시도한다. 뒤쪽('/'가 늦게 오는) 후보부터 보면
    // prefix가 길어지므로, 앞에서부터 훑어 첫 성립 지점을 쓴다.
    for (let i = 0; i < name.length; i++) {
      if (name[i] !== '/') continue;
      const prefix = name.slice(0, i);
      const tail = name.slice(i + 1);
      if (!tail) continue;
      const prefixLen = encoder.encode(prefix).length;
      const tailLen = encoder.encode(tail).length;
      if (prefixLen <= 155 && tailLen <= 100) return { prefix, name: tail };
    }
    void bytes;
    return null;
  }

  function padOctal(num, digits) {
    return num.toString(8).padStart(digits, '0');
  }

  function normalizePath(p) {
    return p.replace(/^\.\//, '').replace(/^\//, '');
  }

  return { parse, create };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Tar;
}
