/**
 * microbit-ble.js
 * micro:bit Web Bluetooth (UART Service) 코어 모듈
 *
 * micro:bit 블루투스 프로파일 기준 UUID:
 *   서비스    6E400001-...  UART Service
 *   TX 특성   6E400002-...  micro:bit -> 웹  (notify)  ※ micro:bit가 "송신"하는 통로
 *   RX 특성   6E400003-...  웹 -> micro:bit  (write)   ※ micro:bit가 "수신"하는 통로
 *
 * 사용법:
 *   const ble = new MicrobitBLE();
 *   ble.on('status', s => console.log(s.state, s.message));
 *   ble.on('line',   t => console.log('받음:', t));
 *   await ble.connect();
 *   await ble.send('rock');   // 끝에 "\n"이 자동으로 붙어서 전송됨
 */
(function (global) {
  'use strict';

  var UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  var UART_TX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // micro:bit -> 웹
  var UART_RX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 웹 -> micro:bit

  // BLE 기본 MTU(23) - 헤더(3) = 한 번에 보낼 수 있는 최대 바이트
  var CHUNK_SIZE = 20;
  var WRITE_TIMEOUT_MS = 2000;

  /** 프로미스가 제한 시간을 넘기면 강제로 실패시킨다 (BLE 응답이 영영 안 올 때 대비) */
  function withTimeout(promise, ms) {
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error('BLE write timeout')); }, ms);
    });
    return Promise.race([promise, timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  /**
   * UTF-8 바이트 배열을 size 이하의 조각으로 자른다.
   * 멀티바이트 문자(한글 등)가 중간에서 잘리지 않도록 연속 바이트(10xxxxxx)를 피해서 자른다.
   */
  function chunkBytes(bytes, size) {
    var chunks = [];
    var i = 0;
    while (i < bytes.length) {
      var end = Math.min(i + size, bytes.length);
      while (end > i + 1 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      chunks.push(bytes.slice(i, end));
      i = end;
    }
    return chunks;
  }

  function MicrobitBLE() {
    this.device = null;
    this.rxChar = null;   // 웹 -> micro:bit
    this.txChar = null;   // micro:bit -> 웹
    this.connected = false;

    this._handlers = { status: [], line: [] };
    this._writeQueue = Promise.resolve(); // 쓰기 직렬화 (동시 write 시 GATT 오류 방지)
    this._rxBuffer = '';
    this._manualDisconnect = false;
    this._onGattDisconnected = this._onGattDisconnected.bind(this);
  }

  /** 이 브라우저가 Web Bluetooth를 지원하는가 */
  MicrobitBLE.isSupported = function () {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  };

  MicrobitBLE.prototype.on = function (event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn);
    return this;
  };

  MicrobitBLE.prototype._emit = function (event, payload) {
    (this._handlers[event] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  };

  MicrobitBLE.prototype._status = function (state, message) {
    this._emit('status', { state: state, message: message, connected: this.connected });
  };

  /** 기기 선택 팝업을 띄우고 연결한다 */
  MicrobitBLE.prototype.connect = function () {
    var self = this;

    if (!MicrobitBLE.isSupported()) {
      var err = new Error('이 브라우저는 Web Bluetooth를 지원하지 않습니다.');
      self._status('error', err.message);
      return Promise.reject(err);
    }

    self._status('connecting', '기기를 찾는 중...');

    return navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE]
    })
      .then(function (device) {
        self.device = device;
        device.addEventListener('gattserverdisconnected', self._onGattDisconnected);
        self._status('connecting', '연결하는 중...');
        return device.gatt.connect();
      })
      .then(function (server) { return server.getPrimaryService(UART_SERVICE); })
      .then(function (service) {
        return Promise.all([
          service.getCharacteristic(UART_RX_CHAR),
          service.getCharacteristic(UART_TX_CHAR)
        ]);
      })
      .then(function (chars) {
        self.rxChar = chars[0];
        self.txChar = chars[1];
        // micro:bit가 보내는 데이터 구독 (양방향 통신용)
        return self.txChar.startNotifications().then(function () {
          self.txChar.addEventListener('characteristicvaluechanged', function (e) {
            self._onNotify(e.target.value);
          });
        }).catch(function () {
          // 알림 구독에 실패해도 웹 -> micro:bit 전송은 가능하므로 넘어간다
        });
      })
      .then(function () {
        self.connected = true;
        self._manualDisconnect = false;
        self._status('connected', '연결됨: ' + (self.device.name || 'micro:bit'));
        return self.device.name;
      })
      .catch(function (error) {
        self.connected = false;
        // 사용자가 기기 선택 창을 그냥 닫은 경우는 오류가 아니다
        var cancelled = error && (error.name === 'NotFoundError' || error.name === 'AbortError');
        self._status(cancelled ? 'idle' : 'error',
          cancelled ? '연결이 취소되었습니다.' : ('연결 실패: ' + (error.message || error)));
        throw error;
      });
  };

  /** 연결을 끊는다 */
  MicrobitBLE.prototype.disconnect = function () {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this._manualDisconnect = true;
      this.device.gatt.disconnect(); // 뒷정리는 gattserverdisconnected 핸들러가 담당
    } else {
      this._cleanup();
      this._status('idle', '연결 해제됨');
    }
  };

  MicrobitBLE.prototype._cleanup = function () {
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
    }
    this.device = null;
    this.rxChar = null;
    this.txChar = null;
    this.connected = false;
    this._rxBuffer = '';
  };

  MicrobitBLE.prototype._onGattDisconnected = function () {
    var wasManual = this._manualDisconnect;
    this._cleanup();
    this._manualDisconnect = false;
    if (wasManual) {
      this._status('idle', '연결 해제됨');
    } else {
      // 전원 꺼짐 / 통신 범위 이탈 등 예기치 않은 끊김
      this._status('error', '연결이 끊어졌습니다. 다시 연결해주세요.');
    }
  };

  /** micro:bit가 보낸 데이터를 줄 단위로 잘라 line 이벤트로 넘긴다 */
  MicrobitBLE.prototype._onNotify = function (dataView) {
    var text = new TextDecoder().decode(dataView);
    this._rxBuffer += text;
    var parts = this._rxBuffer.split('\n');
    this._rxBuffer = parts.pop(); // 마지막 조각은 아직 끝나지 않은 줄
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i].replace(/\r$/, '');
      if (line.length) this._emit('line', line);
    }
  };

  /**
   * micro:bit로 문자열을 보낸다. 끝에 "\n"이 자동으로 붙는다.
   * 여러 번 호출해도 큐에 쌓여 순서대로 하나씩 전송된다.
   * @returns {Promise<boolean>} 성공하면 true
   */
  MicrobitBLE.prototype.send = function (text) {
    var self = this;

    if (!self.connected || !self.rxChar) return Promise.resolve(false);

    var payload = String(text);
    if (payload.slice(-1) !== '\n') payload += '\n';

    // 앞선 전송이 끝난 뒤에 이어서 실행 (동시 write 방지)
    var task = self._writeQueue.then(function () {
      if (!self.connected || !self.rxChar) return false;

      var bytes = new TextEncoder().encode(payload);
      var chunks = chunkBytes(bytes, CHUNK_SIZE);

      // 20바이트씩 순서대로 전송
      return chunks.reduce(function (chain, chunk) {
        return chain.then(function () {
          var write = self.rxChar.writeValueWithResponse
            ? self.rxChar.writeValueWithResponse(chunk)
            : self.rxChar.writeValue(chunk);
          return withTimeout(write, WRITE_TIMEOUT_MS);
        });
      }, Promise.resolve()).then(function () { return true; });
    }).catch(function (error) {
      console.warn('[MicrobitBLE] 전송 실패:', error.message || error);
      return false;
    });

    // 실패해도 큐가 멈추지 않도록 한다
    self._writeQueue = task.catch(function () {});
    return task;
  };

  /** 반드시 전달돼야 하는 명령(예: stop)을 위한 재시도 전송 */
  MicrobitBLE.prototype.sendReliable = function (text, maxRetries, delayMs) {
    var self = this;
    maxRetries = maxRetries || 5;
    delayMs = delayMs || 80;

    function attempt(n) {
      return self.send(text).then(function (ok) {
        if (ok || n >= maxRetries - 1) return ok;
        return new Promise(function (r) { setTimeout(r, delayMs); }).then(function () {
          return attempt(n + 1);
        });
      });
    }
    return attempt(0);
  };

  global.MicrobitBLE = MicrobitBLE;
})(window);
