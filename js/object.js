/**
 * object.js
 * MediaPipe ObjectDetector(EfficientDet-Lite0)로 사물의 종류·위치·크기를 인식해 micro:bit로 보낸다.
 *
 * 전송 형식
 *   좌표 모드 : x###y###w###h###n##   (19바이트, 예: x200y150w080h060n02)
 *              x,y = 상자 중심 / w,h = 상자 크기 / n = 인식된 개수
 *   이름 모드 : person, cup, ...      (모델이 주는 영문 이름 그대로)
 *   사물이 없으면 어느 모드든 stop
 */
(function () {
  'use strict';

  var $ = Core.$;
  var SIZE = 400;

  var MP_MODULE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8';
  var MP_WASM = MP_MODULE + '/wasm';
  var MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

  var ble = new MicrobitBLE();
  var tx = new Core.Transmitter(ble);
  var camera = new Core.SquareCamera(SIZE);

  var stage = $('stage');
  var stageCtx = stage.getContext('2d');
  stage.width = stage.height = SIZE;

  var detector = null;
  var lastVideoTime = -1;
  var detections = [];      // 화면에 그릴 현재 인식 결과
  var running = false;

  var settings = {
    minScore: 0.5,
    sendMode: 'coord',      // 'coord' | 'name'
    sendInterval: 200,
    target: ''              // 비어 있으면 모든 사물
  };

  var PAGE = 'object';

  // ---------------------------------------------------------------- 저장 / 불러오기
  function saveSettings() {
    Store.save(PAGE, 'settings', {
      minScore: settings.minScore,
      sendMode: settings.sendMode,
      sendInterval: settings.sendInterval,
      target: settings.target,
      mirrored: camera.mirrored
    });
    Core.markSaved();
  }

  function restoreAll() {
    if (!Store.isAvailable()) { Core.markStorageUnavailable(); return; }

    var st = Store.load(PAGE, 'settings', null);
    if (!st) return;

    if (typeof st.minScore === 'number') { settings.minScore = st.minScore; $('minScore').value = Math.round(st.minScore * 100); }
    if (typeof st.sendInterval === 'number') { settings.sendInterval = st.sendInterval; $('sendInterval').value = st.sendInterval; }
    if (st.sendMode) { settings.sendMode = st.sendMode; $('sendMode').value = st.sendMode; $('intervalRow').hidden = st.sendMode !== 'coord'; }
    if (typeof st.target === 'string') { settings.target = st.target; $('targetName').value = st.target; }
    if (typeof st.mirrored === 'boolean') {
      camera.mirrored = st.mirrored;
      $('btnMirror').setAttribute('aria-pressed', String(camera.mirrored));
    }

    $('minScoreValue').textContent = $('minScore').value + '%';
    $('sendIntervalValue').textContent = $('sendInterval').value + 'ms';
    Core.log('지난번 설정을 불러왔습니다.', 'info');
  }

  function clearSaved() {
    Store.clearPage(PAGE);
    Core.setStatus($('saveStatus'), '자동 저장 켜짐', 'idle');
    Core.log('저장된 설정을 지웠습니다.', 'info');
  }

  var lastSentName = null;  // 이름 모드에서 같은 이름을 반복 전송하지 않도록
  var lastSentAt = 0;
  var sentStop = false;

  // ---------------------------------------------------------------- 모델
  function initDetector() {
    Core.setStatus($('modelStatus'), '사물인식 모델을 불러오는 중...', 'busy');

    return import(MP_MODULE).then(function (mp) {
      return mp.FilesetResolver.forVisionTasks(MP_WASM).then(function (vision) {
        var options = function (delegate) {
          return {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: delegate },
            runningMode: 'VIDEO',
            // 화면 표시는 넉넉하게 받고, 실제 사용 여부는 슬라이더로 걸러낸다
            scoreThreshold: 0.3,
            maxResults: 8
          };
        };
        return mp.ObjectDetector.createFromOptions(vision, options('GPU'))
          .catch(function () { return mp.ObjectDetector.createFromOptions(vision, options('CPU')); });
      });
    }).then(function (instance) {
      detector = instance;
      Core.setStatus($('modelStatus'), '사물인식 준비됨 — 80종 인식 가능', 'ok');
      Core.log('사물인식 모델을 불러왔습니다. (EfficientDet-Lite0, COCO 80종)', 'info');
      $('btnStart').disabled = false;
    }).catch(function (error) {
      Core.setStatus($('modelStatus'), '모델 로드 실패: ' + (error.message || error), 'error');
      Core.log('사물인식 모델 로드 실패: ' + (error.message || error), 'error');
    });
  }

  // ---------------------------------------------------------------- 루프
  function loop() {
    requestAnimationFrame(loop);

    if (!camera.grab()) {
      Core.drawWaiting(stageCtx, SIZE);
      return;
    }

    if (detector && camera.video.currentTime !== lastVideoTime) {
      lastVideoTime = camera.video.currentTime;
      try {
        var result = detector.detectForVideo(camera.canvas, performance.now());
        detections = filterDetections(result.detections || []);
        if (running) transmit();
      } catch (e) {
        // 프레임 하나 실패로 루프가 멈추지 않게 넘어간다
      }
    }

    stageCtx.drawImage(camera.canvas, 0, 0);
    drawBoxes();

    var text = !detections.length
      ? (running ? '사물이 보이지 않습니다' : '대기 중')
      : detections[0].name + '  ' + Math.round(detections[0].score * 100) + '%' +
        (detections.length > 1 ? '  (외 ' + (detections.length - 1) + ')' : '');
    Core.drawLabelBar(stageCtx, SIZE, text);
  }

  /** 신뢰도 기준과 추적 대상으로 걸러내고, 신뢰도 높은 순으로 정렬한다 */
  function filterDetections(raw) {
    var target = settings.target.trim().toLowerCase();

    return raw.map(function (d) {
      var top = (d.categories && d.categories[0]) || {};
      var box = d.boundingBox || {};
      return {
        name: top.categoryName || '?',
        score: top.score || 0,
        x: box.originX || 0,
        y: box.originY || 0,
        w: box.width || 0,
        h: box.height || 0
      };
    }).filter(function (d) {
      if (d.score < settings.minScore) return false;
      if (target && d.name.toLowerCase().indexOf(target) === -1) return false;
      return true;
    }).sort(function (a, b) { return b.score - a.score; });
  }

  // ---------------------------------------------------------------- 전송
  function transmit() {
    var now = Date.now();

    if (!detections.length) {
      // 사물이 사라지면 stop을 한 번만 보낸다
      if (!sentStop) {
        sentStop = true;
        lastSentName = null;
        tx.send('stop', '사물 없음');
      }
      return;
    }

    sentStop = false;
    var top = detections[0];

    if (settings.sendMode === 'name') {
      // 이름은 바뀔 때만 보낸다 (같은 사물을 계속 보내면 통신이 막힌다)
      if (top.name === lastSentName) return;
      lastSentName = top.name;
      tx.send(top.name, '사물');
      return;
    }

    // 좌표는 계속 변하므로 정해진 간격으로 보낸다
    if (now - lastSentAt < settings.sendInterval) return;
    lastSentAt = now;

    var cx = top.x + top.w / 2;
    var cy = top.y + top.h / 2;
    var packet = 'x' + Core.pad3(cx) + 'y' + Core.pad3(cy) +
      'w' + Core.pad3(top.w) + 'h' + Core.pad3(top.h) +
      'n' + Core.pad2(detections.length);

    tx.send(packet, top.name);
  }

  // ---------------------------------------------------------------- 그리기
  function drawBoxes() {
    detections.forEach(function (d, i) {
      var isTop = i === 0;
      stageCtx.lineWidth = isTop ? 4 : 2.5;
      stageCtx.strokeStyle = '#151515';
      stageCtx.strokeRect(d.x, d.y, d.w, d.h);

      // 상자 안쪽에 색 테두리를 한 겹 더 그려 대비를 준다
      stageCtx.lineWidth = 2;
      stageCtx.strokeStyle = isTop ? '#F5C842' : '#FFFFFF';
      stageCtx.strokeRect(d.x + 3, d.y + 3, Math.max(0, d.w - 6), Math.max(0, d.h - 6));

      var label = d.name + ' ' + Math.round(d.score * 100) + '%';
      stageCtx.font = '700 14px system-ui, sans-serif';
      var tw = stageCtx.measureText(label).width;
      var ty = d.y > 22 ? d.y - 22 : d.y + 2;

      stageCtx.fillStyle = isTop ? '#F5C842' : '#FFFFFF';
      stageCtx.fillRect(d.x, ty, tw + 12, 20);
      stageCtx.strokeStyle = '#151515';
      stageCtx.lineWidth = 2;
      stageCtx.strokeRect(d.x, ty, tw + 12, 20);

      stageCtx.fillStyle = '#151515';
      stageCtx.textAlign = 'left';
      stageCtx.textBaseline = 'middle';
      stageCtx.fillText(label, d.x + 6, ty + 10);
    });

    // 인식 목록을 오른쪽 패널에도 보여준다
    renderList();
  }

  var lastListKey = '';
  function renderList() {
    var key = detections.map(function (d) { return d.name + Math.round(d.score * 20); }).join('|');
    if (key === lastListKey) return; // 매 프레임 DOM을 갈아엎지 않도록
    lastListKey = key;

    var box = $('predictions');
    box.innerHTML = '';
    detections.slice(0, 6).forEach(function (d, i) {
      var row = document.createElement('div');
      row.className = 'pred' + (i === 0 ? ' is-top' : '');
      row.innerHTML = '<span class="pred__name"></span><span class="pred__bar"><i></i></span><span class="pred__pct"></span>';
      row.querySelector('.pred__name').textContent = d.name;
      row.querySelector('.pred__bar i').style.width = Math.round(d.score * 100) + '%';
      row.querySelector('.pred__pct').textContent = Math.round(d.score * 100) + '%';
      box.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- 시작/중지
  function start() {
    if (running || !detector) return;
    running = true;
    lastSentName = null;
    sentStop = false;
    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    Core.log('사물인식 전송을 시작합니다. (' +
      (settings.sendMode === 'coord' ? '좌표 모드' : '이름 모드') + ')', 'info');
  }

  function stop(silent) {
    if (!running) { $('btnStop').disabled = true; return; }
    running = false;
    lastSentName = null;
    $('btnStart').disabled = !detector;
    $('btnStop').disabled = true;

    if (!silent) {
      Core.log('사물인식 전송을 중지합니다.', 'info');
      tx.sendReliable('stop', '중지');
    }
  }

  // ---------------------------------------------------------------- 배선
  function bindEvents() {
    $('btnMirror').addEventListener('click', function () {
      this.setAttribute('aria-pressed', String(camera.toggleMirror()));
      saveSettings();
    });

    $('btnSwitchCam').addEventListener('click', function () {
      camera.switchFacing().catch(function (e) {
        Core.setStatus($('cameraStatus'), '카메라 전환 실패: ' + e.message, 'error');
      });
    });

    $('btnStart').addEventListener('click', start);
    $('btnStop').addEventListener('click', function () { stop(); });

    $('sendMode').addEventListener('change', function () {
      settings.sendMode = this.value;
      $('intervalRow').hidden = this.value !== 'coord';
      lastSentName = null;
      updatePacketPreview();
      saveSettings();
    });

    $('targetName').addEventListener('input', function () {
      settings.target = this.value;
      saveSettings();
    });

    Core.bindSlider('minScore', 'minScoreValue',
      function (v) { return v + '%'; },
      function (v) { settings.minScore = v / 100; saveSettings(); });

    Core.bindSlider('sendInterval', 'sendIntervalValue',
      function (v) { return v + 'ms'; },
      function (v) { settings.sendInterval = v; saveSettings(); });

    $('btnClearSaved').addEventListener('click', function () {
      if (confirm('저장된 설정을 지웁니다. 계속할까요?')) clearSaved();
    });

    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });

    window.addEventListener('beforeunload', function () { camera.stop(); });
  }

  function updatePacketPreview() {
    $('packetPreview').textContent = settings.sendMode === 'coord'
      ? 'x200y150w080h060n02'
      : 'person';
  }

  // ---------------------------------------------------------------- 초기화
  function init() {
    Core.mountFooter();
    camera.attach(document.body);

    new Core.BleController(ble, tx, {
      onDrop: function () { if (running) stop(true); }
    });

    restoreAll();
    bindEvents();
    updatePacketPreview();
    loop();

    camera.start().then(function () {
      Core.setStatus($('cameraStatus'), '카메라 준비됨', 'ok');
      return initDetector();
    }).catch(function (error) {
      var message = error.name === 'NotAllowedError'
        ? '카메라 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 허용해주세요.'
        : '카메라를 열 수 없습니다: ' + (error.message || error);
      Core.setStatus($('cameraStatus'), message, 'error');
      Core.log(message, 'error');
    });

    Core.log('준비 중입니다. 모델이 준비되면 전송을 시작할 수 있습니다.', 'info');
  }

  init();
})();
