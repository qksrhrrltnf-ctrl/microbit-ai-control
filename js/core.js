/**
 * core.js
 * 모든 기능 페이지가 공유하는 재사용 부품 모음.
 *
 *   Core.log / Core.setStatus      기록창 · 상태 배지
 *   Core.SquareCamera              카메라 → 정사각형 크롭 캔버스
 *   Core.MappingTable              클래스 → 명령어 매핑 표
 *   Core.StabilityGate             신뢰도 기준 + 연속 확인으로 결과 확정
 *   Core.Transmitter               연습 모드 · 최소 간격 · 기록을 포함한 전송기
 *   Core.BleController             연결/해제/연습모드 버튼 배선
 *   Core.bindSlider                슬라이더 + 값 표시 배선
 *   Core.mountFooter               제작자 표기 푸터
 *
 * 각 페이지 전용 로직은 이 파일을 쓰는 별도 js 파일에 둔다.
 */
(function (global) {
  'use strict';

  /* ============================================================
     제작자 표기 — 이 두 줄만 채우면 모든 페이지 푸터/헤더에 반영됩니다.
     ============================================================ */
  var CREDIT = {
    author: 'Robot_TECH',
    githubUrl: 'https://github.com/qksrhrrltnf-ctrl/microbit-ai-control'
  };

  var Core = {};

  Core.CREDIT = CREDIT;

  // ---------------------------------------------------------------- 기본 유틸
  Core.$ = function (id) { return document.getElementById(id); };

  Core.setStatus = function (el, message, kind) {
    if (!el) return;
    el.textContent = message;
    el.className = 'status status--' + (kind || 'idle');
  };

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  Core.timestamp = function () {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };

  /** 기록창(#log)에 한 줄 추가. 최신이 위로 쌓이고 200줄에서 잘린다. */
  Core.log = function (message, kind) {
    var list = Core.$('log');
    if (!list) { console.log('[log]', message); return; }
    var li = document.createElement('li');
    li.className = 'log__row log__row--' + (kind || 'info');
    var time = document.createElement('span');
    time.className = 'log__time';
    time.textContent = Core.timestamp();
    var msg = document.createElement('span');
    msg.className = 'log__msg';
    msg.textContent = message;
    li.appendChild(time);
    li.appendChild(msg);
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 200) list.removeChild(list.lastChild);
  };

  /** 0~999 범위를 3자리 문자열로 (좌표 패킷용) */
  Core.pad3 = function (n) {
    n = Math.max(0, Math.min(999, Math.round(n)));
    return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n);
  };

  /** 0~99 범위를 2자리 문자열로 */
  Core.pad2 = function (n) {
    n = Math.max(0, Math.min(99, Math.round(n)));
    return n < 10 ? '0' + n : String(n);
  };

  Core.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  /** 값을 한 범위에서 다른 범위로 옮긴다 */
  Core.mapRange = function (v, inLo, inHi, outLo, outHi) {
    if (inHi === inLo) return outLo;
    return outLo + (v - inLo) * (outHi - outLo) / (inHi - inLo);
  };

  // ---------------------------------------------------------------- 스크립트 로더
  var scriptCache = {};

  /** 같은 URL을 두 번 받지 않으면서 <script>를 붙인다 */
  Core.loadScript = function (url) {
    if (scriptCache[url]) return scriptCache[url];
    scriptCache[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () {
        delete scriptCache[url]; // 실패한 건 캐시하지 않아 재시도 가능하게
        reject(new Error('라이브러리를 불러오지 못했습니다: ' + url));
      };
      document.head.appendChild(s);
    });
    return scriptCache[url];
  };

  // ---------------------------------------------------------------- 카메라
  /**
   * 카메라 영상을 정사각형으로 잘라 자체 캔버스에 계속 그린다.
   * 학습 모델은 대부분 정사각 입력으로 훈련되므로, 원본 비율을 그대로 넣으면
   * 찌그러진 이미지가 들어가 정확도가 떨어진다.
   *
   * @param {number} size 캔버스 한 변 (기본 400)
   */
  Core.SquareCamera = function (size) {
    this.size = size || 400;
    this.facingMode = 'user';
    this.mirrored = true;
    this.stream = null;
    this.ready = false;

    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.video.id = 'video';

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d');
  };

  Core.SquareCamera.prototype.attach = function (parent) {
    (parent || document.body).appendChild(this.video);
    return this;
  };

  Core.SquareCamera.prototype.start = function () {
    var self = this;
    self.stop();
    self.ready = false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('이 브라우저는 카메라를 지원하지 않습니다.'));
    }

    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: self.facingMode,
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    }).then(function (stream) {
      self.stream = stream;
      self.video.srcObject = stream;
      return self.video.play();
    }).then(function () {
      self.ready = true;
      return self;
    });
  };

  Core.SquareCamera.prototype.stop = function () {
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { t.stop(); });
      this.stream = null;
    }
    this.ready = false;
  };

  Core.SquareCamera.prototype.toggleMirror = function () {
    this.mirrored = !this.mirrored;
    return this.mirrored;
  };

  Core.SquareCamera.prototype.switchFacing = function () {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    return this.start();
  };

  /** 현재 프레임을 자체 캔버스에 센터 크롭으로 그린다. 그려졌으면 true */
  Core.SquareCamera.prototype.grab = function () {
    var v = this.video;
    if (!v.videoWidth) return false;

    var side = Math.min(v.videoWidth, v.videoHeight);
    var sx = (v.videoWidth - side) / 2;
    var sy = (v.videoHeight - side) / 2;

    this.ctx.save();
    if (this.mirrored) {
      this.ctx.translate(this.size, 0);
      this.ctx.scale(-1, 1);
    }
    this.ctx.drawImage(v, sx, sy, side, side, 0, 0, this.size, this.size);
    this.ctx.restore();
    return true;
  };

  /** 카메라가 아직 준비되지 않았을 때 안내 문구를 그린다 */
  Core.drawWaiting = function (ctx, size, text) {
    ctx.fillStyle = '#151515';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#8A8A8A';
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text || '카메라 대기 중...', size / 2, size / 2);
  };

  /** 화면 아래쪽에 현재 결과를 띠로 표시한다 */
  Core.drawLabelBar = function (ctx, size, text) {
    var h = 48;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
    ctx.fillRect(0, size - h, size, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size - h / 2);
  };

  // ---------------------------------------------------------------- 매핑 표
  /**
   * 클래스 이름과 실제로 보낼 명령어를 분리해 관리한다.
   * 클래스명을 한글로 지어도 되고, 명령은 짧은 영문으로 보낼 수 있다.
   *
   * @param {HTMLElement} tbody 표의 tbody
   * @param {{onTest: function(string)}} opts
   */
  Core.MappingTable = function (tbody, opts) {
    this.tbody = tbody;
    this.opts = opts || {};
    this.mapping = {};
    this.enabled = {};
    this.classes = [];
  };

  /**
   * 클래스명으로부터 기본 명령어를 만든다.
   * UART로 한글을 보내면 micro:bit에서 깨지므로 ASCII가 아니면 c1, c2... 로 대체한다.
   */
  Core.MappingTable.defaultCommand = function (className, index) {
    var trimmed = String(className).trim();
    if (/^[\x20-\x7E]+$/.test(trimmed) && trimmed.length <= 18) {
      return trimmed.replace(/\s+/g, '_');
    }
    return 'c' + (index + 1);
  };

  Core.MappingTable.prototype.build = function (classes) {
    var self = this;
    // 표를 다시 그려도 사용자가 고쳐둔 명령어는 유지한다
    var prevMapping = self.mapping;
    var prevEnabled = self.enabled;

    self.classes = classes.slice();
    self.mapping = {};
    self.enabled = {};
    self.tbody.innerHTML = '';

    classes.forEach(function (className, index) {
      var command = prevMapping[className] !== undefined
        ? prevMapping[className]
        : Core.MappingTable.defaultCommand(className, index);
      self.mapping[className] = command;
      self.enabled[className] = prevEnabled[className] !== undefined ? prevEnabled[className] : true;

      var tr = document.createElement('tr');

      var tdOn = document.createElement('td');
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = self.enabled[className];
      chk.setAttribute('aria-label', className + ' 전송 사용');
      chk.addEventListener('change', function () {
        self.enabled[className] = chk.checked;
        if (self.opts.onChange) self.opts.onChange();
      });
      tdOn.appendChild(chk);

      var tdName = document.createElement('td');
      tdName.className = 'mapping__class';
      tdName.textContent = className;

      var tdCmd = document.createElement('td');
      var field = document.createElement('input');
      field.type = 'text';
      field.value = command;
      field.maxLength = 18;
      field.setAttribute('aria-label', className + ' 명령어');
      field.addEventListener('input', function () {
        self.mapping[className] = field.value.trim();
        if (self.opts.onChange) self.opts.onChange();
      });
      tdCmd.appendChild(field);

      var tdTest = document.createElement('td');
      var testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn btn--ghost btn--sm';
      testBtn.textContent = '테스트';
      testBtn.addEventListener('click', function () {
        var cmd = self.mapping[className];
        if (!cmd) { Core.log('명령이 비어 있습니다: ' + className, 'error'); return; }
        if (self.opts.onTest) self.opts.onTest(cmd);
      });
      tdTest.appendChild(testBtn);

      tr.appendChild(tdOn);
      tr.appendChild(tdName);
      tr.appendChild(tdCmd);
      tr.appendChild(tdTest);
      self.tbody.appendChild(tr);
    });

    // 그대로 보낼 수 없어 자동 배정된 클래스가 있으면 알려준다 (새로 추가된 것만)
    var renamed = classes.filter(function (c) {
      if (prevMapping[c] !== undefined) return false;
      return self.mapping[c] !== String(c).trim().replace(/\s+/g, '_');
    });
    if (renamed.length) {
      Core.log('micro:bit로 그대로 보낼 수 없는 클래스명(' + renamed.join(', ') +
        ')은 c1, c2... 로 자동 배정했습니다. 필요하면 직접 바꾸세요.', 'warn');
    }

    if (self.opts.onChange) self.opts.onChange();
  };

  /**
   * 저장해 둔 매핑을 되돌린다. build() 전에 부르면 그 값이 표에 채워진다.
   * @param {object} mapping  클래스명 -> 명령어
   * @param {object} [enabled] 클래스명 -> 사용 여부
   */
  Core.MappingTable.prototype.restore = function (mapping, enabled) {
    if (mapping) this.mapping = Object.assign({}, mapping);
    if (enabled) this.enabled = Object.assign({}, enabled);
  };

  /** 지금 표의 내용을 저장 가능한 형태로 꺼낸다 */
  Core.MappingTable.prototype.snapshot = function () {
    return { mapping: this.mapping, enabled: this.enabled };
  };

  Core.MappingTable.prototype.commandFor = function (className) {
    return this.mapping[className];
  };

  Core.MappingTable.prototype.isEnabled = function (className) {
    return this.enabled[className] !== false;
  };

  // ---------------------------------------------------------------- 결과 확정 게이트
  /**
   * 인식 결과가 깜빡이는 것을 막는다.
   *  1) 최고 확률이 임계값을 넘어야 후보로 인정
   *  2) 같은 후보가 연속 N번 나와야 확정
   */
  Core.StabilityGate = function () {
    this.threshold = 0.7;
    this.stability = 3;
    this.pending = null;
    this.count = 0;
    this.confirmed = null;
  };

  Core.StabilityGate.prototype.reset = function () {
    this.pending = null;
    this.count = 0;
    this.confirmed = null;
  };

  /**
   * @returns {{confirmed: string|null, changed: boolean}}
   */
  Core.StabilityGate.prototype.feed = function (label, probability) {
    var candidate = (label != null && probability >= this.threshold) ? label : null;

    if (candidate === this.pending) {
      this.count++;
    } else {
      this.pending = candidate;
      this.count = 1;
    }

    if (!candidate || this.count < this.stability) {
      return { confirmed: this.confirmed, changed: false };
    }

    var changed = this.confirmed !== candidate;
    this.confirmed = candidate;
    return { confirmed: candidate, changed: changed };
  };

  // ---------------------------------------------------------------- 전송기
  /**
   * 연습 모드 · 최소 전송 간격 · 기록을 한곳에서 처리한다.
   * @param {MicrobitBLE} ble
   */
  Core.Transmitter = function (ble) {
    this.ble = ble;
    this.simulator = false;
    this.minGapMs = 100;
    this.lastSentAt = 0;
  };

  Core.Transmitter.prototype.canSendNow = function () {
    return Date.now() - this.lastSentAt >= this.minGapMs;
  };

  /**
   * 명령을 보낸다. 연습 모드이거나 연결이 없으면 기록만 남긴다.
   * @param {string} command
   * @param {string} [note] 기록에 함께 남길 설명 (예: 클래스명)
   */
  Core.Transmitter.prototype.send = function (command, note) {
    var self = this;
    if (!command) return Promise.resolve(false);

    self.lastSentAt = Date.now();
    var label = note ? (note + '  ->  ' + command) : command;

    if (self.simulator || !self.ble.connected) {
      Core.log('(연습) ' + label, 'sim');
      return Promise.resolve(false);
    }

    return self.ble.send(command).then(function (ok) {
      Core.log((ok ? '전송 ' : '전송 실패 ') + label, ok ? 'send' : 'error');
      return ok;
    });
  };

  /** 반드시 전달돼야 하는 명령(예: stop) */
  Core.Transmitter.prototype.sendReliable = function (command, note) {
    var self = this;
    self.lastSentAt = Date.now();
    var label = note ? (note + '  ->  ' + command) : command;

    if (self.simulator || !self.ble.connected) {
      Core.log('(연습) ' + label, 'sim');
      return Promise.resolve(false);
    }

    return self.ble.sendReliable(command).then(function (ok) {
      Core.log((ok ? '전송 ' : '전송 실패 ') + label, ok ? 'send' : 'error');
      return ok;
    });
  };

  // ---------------------------------------------------------------- BLE 패널 배선
  /**
   * 연결/해제 버튼, 상태 배지, 연습 모드 체크박스를 한 번에 연결한다.
   *
   * @param {MicrobitBLE} ble
   * @param {Core.Transmitter} transmitter
   * @param {{onDrop: function}} opts  연결이 끊겼을 때 호출 (인식 중지 등)
   */
  Core.BleController = function (ble, transmitter, opts) {
    opts = opts || {};

    var btnConnect = Core.$('btnConnect');
    var btnDisconnect = Core.$('btnDisconnect');
    var badge = Core.$('bleStatus');
    var chkSimulator = Core.$('chkSimulator');

    if (btnConnect) {
      btnConnect.addEventListener('click', function () {
        ble.connect().catch(function () { /* 상태 배지로 이미 안내됨 */ });
      });
    }
    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', function () { ble.disconnect(); });
    }
    if (chkSimulator) {
      chkSimulator.addEventListener('change', function () {
        transmitter.simulator = this.checked;
        Core.log(transmitter.simulator
          ? '연습 모드: micro:bit로 보내지 않고 기록만 남깁니다.'
          : '연습 모드를 껐습니다.', 'info');
      });
    }

    ble.on('status', function (s) {
      Core.setStatus(badge, s.message,
        s.state === 'connected' ? 'ok' :
          s.state === 'error' ? 'error' :
            s.state === 'connecting' ? 'busy' : 'idle');

      if (btnConnect) btnConnect.disabled = s.connected || s.state === 'connecting';
      if (btnDisconnect) btnDisconnect.disabled = !s.connected;

      Core.log(s.message, s.state === 'error' ? 'error' : 'info');

      // 예기치 않게 끊기면 진행 중인 인식도 멈춘다
      if (s.state === 'error' && opts.onDrop) opts.onDrop();
    });

    ble.on('line', function (text) { Core.log('micro:bit  ->  ' + text, 'recv'); });

    // 지원하지 않는 브라우저 안내
    Core.checkEnvironment();
  };

  /** Web Bluetooth 지원 여부를 확인해 #envWarning에 안내를 넣는다 */
  Core.checkEnvironment = function () {
    var warn = Core.$('envWarning');
    if (!warn) return;

    if (MicrobitBLE.isSupported()) { warn.hidden = true; return; }

    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    warn.hidden = false;
    warn.innerHTML = isIOS
      ? '이 브라우저는 <b>Web Bluetooth</b>를 지원하지 않습니다. iPhone/iPad에서는 ' +
        '<a href="https://apps.apple.com/app/id1492822055" target="_blank" rel="noopener">Bluefy</a> ' +
        '브라우저로 이 페이지를 열어주세요. (연습 모드는 지금도 사용할 수 있습니다)'
      : '이 브라우저는 <b>Web Bluetooth</b>를 지원하지 않습니다. ' +
        '<b>Chrome</b> 또는 <b>Edge</b>로 열어주세요. (연습 모드는 지금도 사용할 수 있습니다)';

    var btnConnect = Core.$('btnConnect');
    if (btnConnect) btnConnect.disabled = true;
  };

  // ---------------------------------------------------------------- 저장 상태 표시
  var savedTimer = null;

  /** #saveStatus 배지에 "저장됨"을 잠깐 띄운다 */
  Core.markSaved = function () {
    var el = Core.$('saveStatus');
    if (!el) return;
    var kb = global.Store ? global.Store.usageKB() : 0;
    Core.setStatus(el, '저장됨 · ' + kb + 'KB', 'ok');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () {
      Core.setStatus(el, '자동 저장 켜짐', 'idle');
    }, 2000);
  };

  /** 저장을 쓸 수 없는 환경임을 알린다 (시크릿 모드 등) */
  Core.markStorageUnavailable = function () {
    var el = Core.$('saveStatus');
    if (el) Core.setStatus(el, '이 브라우저에서는 저장할 수 없습니다', 'error');
    Core.log('시크릿 모드이거나 저장이 차단되어 있어 설정이 유지되지 않습니다.', 'warn');
  };

  // ---------------------------------------------------------------- 슬라이더
  /**
   * 슬라이더와 값 표시를 연결한다.
   * @param {string} id        input[type=range]의 id
   * @param {string} valueId   값을 표시할 요소의 id
   * @param {function(number): string} format
   * @param {function(number)} onChange
   */
  Core.bindSlider = function (id, valueId, format, onChange) {
    var input = Core.$(id);
    var out = Core.$(valueId);
    if (!input) return;

    var apply = function () {
      var v = Number(input.value);
      if (out) out.textContent = format(v);
      if (onChange) onChange(v);
    };
    input.addEventListener('input', apply);
    apply();
  };

  // ---------------------------------------------------------------- 푸터
  /**
   * data-credit 속성이 붙은 푸터에 제작자 표기를 채운다.
   * CREDIT.author가 비어 있으면 기본 문구만 보여준다.
   */
  Core.mountFooter = function () {
    var foot = document.querySelector('[data-credit]');
    if (!foot) return;

    var line = document.createElement('div');
    line.className = 'foot__credit';

    if (CREDIT.author) {
      var made = document.createElement('span');
      made.className = 'foot__author';
      made.textContent = 'Made by ' + CREDIT.author;
      line.appendChild(made);

      if (CREDIT.githubUrl) {
        var link = document.createElement('a');
        link.className = 'foot__link';
        link.href = CREDIT.githubUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'GitHub ↗';
        line.appendChild(link);
      }
    }

    var sub = document.createElement('div');
    sub.className = 'foot__sub';
    sub.textContent = '수업·연구용 오픈소스 프로젝트 · Web Bluetooth + on-device AI';

    foot.innerHTML = '';
    if (line.childNodes.length) foot.appendChild(line);
    foot.appendChild(sub);
  };

  global.Core = Core;
})(window);
