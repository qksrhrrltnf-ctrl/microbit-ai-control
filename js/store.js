/**
 * store.js
 * 브라우저 안에 설정과 학습 결과를 저장한다. 서버도 데이터베이스도 쓰지 않는다.
 *
 * - 저장 위치는 그 기기의 브라우저 하나뿐이며, 밖으로 나가지 않는다.
 * - 시크릿 모드나 저장이 막힌 환경에서도 앱이 멈추지 않도록 모든 접근을 감싼다.
 * - 용량이 가득 차면(약 5MB) 저장만 실패하고 화면 동작은 그대로 이어진다.
 *
 * 사용법:
 *   Store.save('handpose', 'classes', data);
 *   var data = Store.load('handpose', 'classes', []);
 *   Store.saveLater('handpose', 'classes', data);   // 자주 바뀌는 값은 이쪽
 */
(function (global) {
  'use strict';

  var PREFIX = 'mbai';   // micro:bit AI 제어
  var VERSION = 1;

  var available = null;  // 첫 접근 때 한 번만 확인
  var timers = {};       // 미뤄둔 저장 예약

  function keyOf(page, name) {
    return PREFIX + ':' + page + ':' + name;
  }

  /** 이 브라우저에서 저장을 쓸 수 있는지 (시크릿 모드·정책 차단 대비) */
  function isAvailable() {
    if (available !== null) return available;
    try {
      var probe = PREFIX + ':probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      available = true;
    } catch (e) {
      available = false;
    }
    return available;
  }

  var Store = {
    isAvailable: isAvailable,

    /**
     * 값을 저장한다.
     * @returns {boolean} 성공하면 true (용량 초과·차단 시 false)
     */
    save: function (page, name, value) {
      if (!isAvailable()) return false;
      try {
        localStorage.setItem(keyOf(page, name), JSON.stringify({ v: VERSION, d: value }));
        return true;
      } catch (e) {
        // 용량 초과가 가장 흔하다. 화면 동작은 막지 않고 알리기만 한다.
        if (global.Core && Core.log) {
          Core.log('브라우저 저장 공간이 부족해 저장하지 못했습니다. "저장 내용 지우기"로 정리해주세요.', 'warn');
        }
        return false;
      }
    },

    /**
     * 자주 바뀌는 값을 위한 미뤄서 저장.
     * 손모양 샘플처럼 1초에 수십 번 바뀌는 값을 매번 저장하면 화면이 끊긴다.
     */
    saveLater: function (page, name, value, delayMs) {
      var id = keyOf(page, name);
      clearTimeout(timers[id]);
      timers[id] = setTimeout(function () {
        Store.save(page, name, value);
      }, delayMs || 500);
    },

    /** 저장된 값을 읽는다. 없거나 형식이 다르면 fallback을 준다. */
    load: function (page, name, fallback) {
      if (!isAvailable()) return fallback;
      try {
        var raw = localStorage.getItem(keyOf(page, name));
        if (!raw) return fallback;
        var parsed = JSON.parse(raw);
        // 저장 형식이 바뀐 예전 데이터는 조용히 버린다
        if (!parsed || parsed.v !== VERSION) return fallback;
        return parsed.d;
      } catch (e) {
        return fallback;
      }
    },

    remove: function (page, name) {
      if (!isAvailable()) return;
      try { localStorage.removeItem(keyOf(page, name)); } catch (e) { /* 무시 */ }
    },

    /** 한 페이지가 저장한 것만 모두 지운다 */
    clearPage: function (page) {
      if (!isAvailable()) return 0;
      var head = PREFIX + ':' + page + ':';
      var doomed = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(head) === 0) doomed.push(k);
        }
        doomed.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) { /* 무시 */ }
      return doomed.length;
    },

    /** 이 앱이 저장한 것을 전부 지운다 (다른 사이트 데이터는 건드리지 않는다) */
    clearAll: function () {
      if (!isAvailable()) return 0;
      var head = PREFIX + ':';
      var doomed = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(head) === 0) doomed.push(k);
        }
        doomed.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) { /* 무시 */ }
      return doomed.length;
    },

    /** 이 앱이 쓰고 있는 대략적인 용량 (KB) */
    usageKB: function () {
      if (!isAvailable()) return 0;
      var total = 0;
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(PREFIX + ':') === 0) {
            total += k.length + (localStorage.getItem(k) || '').length;
          }
        }
      } catch (e) { /* 무시 */ }
      return Math.round(total / 1024 * 10) / 10;
    },

    // ------------------------------------------------------------ 파일로 주고받기
    /**
     * 데이터를 .json 파일로 내려받는다.
     * 선생님이 한 번 만든 설정을 학생 전체에게 나눠줄 때 쓴다.
     */
    exportFile: function (filename, payload) {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },

    /**
     * .json 파일을 읽어 객체로 돌려준다.
     * @returns {Promise<object>}
     */
    importFile: function (file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            resolve(JSON.parse(String(reader.result)));
          } catch (e) {
            reject(new Error('파일 형식이 올바르지 않습니다. 이 앱에서 내보낸 .json 파일인지 확인해주세요.'));
          }
        };
        reader.onerror = function () { reject(new Error('파일을 읽을 수 없습니다.')); };
        reader.readAsText(file, 'utf-8');
      });
    }
  };

  global.Store = Store;
})(window);
