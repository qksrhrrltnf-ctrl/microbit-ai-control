/**
 * face.js
 * MediaPipe FaceLandmarker(Face Mesh)로 얼굴 위치와 눈·입 상태를 읽어 micro:bit로 보낸다.
 *
 * 전송 형식 (19바이트, UART 20바이트 한계 내)
 *   x##y##m##a##b##r#s#
 *     x, y : 얼굴 중심 (0~99)
 *     m    : 입 벌림  (0~99)
 *     a    : 왼눈 열림 (0~99)
 *     b    : 오른눈 열림 (0~99)
 *     r    : 고개 기울기 (0~9, 5가 수평)
 *     s    : 미소 (0~9)
 *   얼굴이 안 보이면 stop
 */
(function () {
  'use strict';

  var $ = Core.$;
  var SIZE = 400;

  var MP_MODULE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8';
  var MP_WASM = MP_MODULE + '/wasm';
  var MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  // Face Mesh에서 쓰는 주요 점 번호
  var EYE_LEFT = 33;      // 왼쪽 눈 바깥쪽
  var EYE_RIGHT = 263;    // 오른쪽 눈 바깥쪽

  var ble = new MicrobitBLE();
  var tx = new Core.Transmitter(ble);
  var camera = new Core.SquareCamera(SIZE);

  var stage = $('stage');
  var stageCtx = stage.getContext('2d');
  stage.width = stage.height = SIZE;

  var landmarker = null;
  var lastVideoTime = -1;
  var landmarks = null;
  var params = null;
  var running = false;

  var settings = { sendInterval: 200, showMesh: true };
  var PAGE = 'face';

  // ---------------------------------------------------------------- 저장 / 불러오기
  function saveSettings() {
    Store.save(PAGE, 'settings', {
      sendInterval: settings.sendInterval,
      showMesh: settings.showMesh,
      mirrored: camera.mirrored
    });
    Core.markSaved();
  }

  function restoreAll() {
    if (!Store.isAvailable()) { Core.markStorageUnavailable(); return; }

    var st = Store.load(PAGE, 'settings', null);
    if (!st) return;

    if (typeof st.sendInterval === 'number') { settings.sendInterval = st.sendInterval; $('sendInterval').value = st.sendInterval; }
    if (typeof st.showMesh === 'boolean') { settings.showMesh = st.showMesh; $('chkMesh').checked = st.showMesh; }
    if (typeof st.mirrored === 'boolean') {
      camera.mirrored = st.mirrored;
      $('btnMirror').setAttribute('aria-pressed', String(camera.mirrored));
    }

    $('sendIntervalValue').textContent = $('sendInterval').value + 'ms';
    Core.log('지난번 설정을 불러왔습니다.', 'info');
  }

  function clearSaved() {
    Store.clearPage(PAGE);
    Core.setStatus($('saveStatus'), '자동 저장 켜짐', 'idle');
    Core.log('저장된 설정을 지웠습니다.', 'info');
  }
  var lastSentAt = 0;
  var sentStop = false;

  /**
   * 얼굴 상태를 19바이트 문자열로 만든다.
   * @param {{x,y,mouth,eyeL,eyeR,roll,smile}} p
   */
  function buildPacket(p) {
    return 'x' + Core.pad2(p.x) +
      'y' + Core.pad2(p.y) +
      'm' + Core.pad2(p.mouth) +
      'a' + Core.pad2(p.eyeL) +
      'b' + Core.pad2(p.eyeR) +
      'r' + Math.round(Core.clamp(p.roll, 0, 9)) +
      's' + Math.round(Core.clamp(p.smile, 0, 9));
  }

  // ---------------------------------------------------------------- 모델
  function initLandmarker() {
    Core.setStatus($('modelStatus'), '얼굴인식 모델을 불러오는 중...', 'busy');

    return import(MP_MODULE).then(function (mp) {
      return mp.FilesetResolver.forVisionTasks(MP_WASM).then(function (vision) {
        var options = function (delegate) {
          return {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: delegate },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: true
          };
        };
        return mp.FaceLandmarker.createFromOptions(vision, options('GPU'))
          .catch(function () { return mp.FaceLandmarker.createFromOptions(vision, options('CPU')); });
      });
    }).then(function (instance) {
      landmarker = instance;
      Core.setStatus($('modelStatus'), '얼굴인식 준비됨', 'ok');
      Core.log('얼굴인식 모델을 불러왔습니다. (Face Mesh 478점 + 표정)', 'info');
      $('btnStart').disabled = false;
    }).catch(function (error) {
      Core.setStatus($('modelStatus'), '모델 로드 실패: ' + (error.message || error), 'error');
      Core.log('얼굴인식 모델 로드 실패: ' + (error.message || error), 'error');
    });
  }

  // ---------------------------------------------------------------- 값 계산
  function computeParams(points, blendshapes) {
    // 얼굴이 차지하는 상자의 중심을 얼굴 위치로 본다
    var minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (var i = 0; i < points.length; i++) {
      if (points[i].x < minX) minX = points[i].x;
      if (points[i].x > maxX) maxX = points[i].x;
      if (points[i].y < minY) minY = points[i].y;
      if (points[i].y > maxY) maxY = points[i].y;
    }

    var shapes = {};
    if (blendshapes && blendshapes.categories) {
      blendshapes.categories.forEach(function (c) { shapes[c.categoryName] = c.score; });
    }

    // 두 눈을 잇는 선의 기울기로 고개 기울기를 구한다 (-0.5~0.5 라디안 → 0~9)
    var dy = points[EYE_RIGHT].y - points[EYE_LEFT].y;
    var dx = points[EYE_RIGHT].x - points[EYE_LEFT].x;
    var angle = Math.atan2(dy, dx);

    var smile = ((shapes.mouthSmileLeft || 0) + (shapes.mouthSmileRight || 0)) / 2;

    return {
      x: Core.clamp((minX + maxX) / 2 * 100, 0, 99),
      y: Core.clamp((minY + maxY) / 2 * 100, 0, 99),
      mouth: Core.clamp((shapes.jawOpen || 0) * 100, 0, 99),
      // 감은 정도를 뒤집어 "열린 정도"로 만든다
      eyeL: Core.clamp((1 - (shapes.eyeBlinkLeft || 0)) * 100, 0, 99),
      eyeR: Core.clamp((1 - (shapes.eyeBlinkRight || 0)) * 100, 0, 99),
      roll: Core.clamp(Core.mapRange(angle, -0.5, 0.5, 0, 9), 0, 9),
      smile: Core.clamp(smile * 10, 0, 9),
      width: (maxX - minX) * 100
    };
  }

  // ---------------------------------------------------------------- 루프
  function loop() {
    requestAnimationFrame(loop);

    if (!camera.grab()) {
      Core.drawWaiting(stageCtx, SIZE);
      return;
    }

    if (landmarker && camera.video.currentTime !== lastVideoTime) {
      lastVideoTime = camera.video.currentTime;
      try {
        var result = landmarker.detectForVideo(camera.canvas, performance.now());
        var has = result.faceLandmarks && result.faceLandmarks.length;
        landmarks = has ? result.faceLandmarks[0] : null;
        params = has ? computeParams(landmarks,
          result.faceBlendshapes && result.faceBlendshapes[0]) : null;
        renderValues();
        if (running) transmit();
      } catch (e) {
        // 프레임 하나 실패로 루프가 멈추지 않게 넘어간다
      }
    }

    stageCtx.drawImage(camera.canvas, 0, 0);
    drawFace();

    Core.drawLabelBar(stageCtx, SIZE,
      params ? buildPacket(params) : (running ? '얼굴이 보이지 않습니다' : '대기 중'));
  }

  function transmit() {
    if (!params) {
      if (!sentStop) {
        sentStop = true;
        tx.send('stop', '얼굴 없음');
      }
      return;
    }
    sentStop = false;

    var now = Date.now();
    if (now - lastSentAt < settings.sendInterval) return;
    lastSentAt = now;
    tx.send(buildPacket(params), '얼굴');
  }

  // ---------------------------------------------------------------- 화면 표시
  var VALUE_ROWS = [
    { key: 'x', label: '얼굴 X', max: 99 },
    { key: 'y', label: '얼굴 Y', max: 99 },
    { key: 'mouth', label: '입 벌림', max: 99 },
    { key: 'eyeL', label: '왼눈 열림', max: 99 },
    { key: 'eyeR', label: '오른눈 열림', max: 99 },
    { key: 'roll', label: '고개 기울기', max: 9 },
    { key: 'smile', label: '미소', max: 9 }
  ];

  function renderValues() {
    var box = $('predictions');

    if (box.children.length !== VALUE_ROWS.length) {
      box.innerHTML = '';
      VALUE_ROWS.forEach(function () {
        var row = document.createElement('div');
        row.className = 'pred';
        row.innerHTML = '<span class="pred__name"></span><span class="pred__bar"><i></i></span><span class="pred__pct"></span>';
        box.appendChild(row);
      });
    }

    VALUE_ROWS.forEach(function (def, i) {
      var row = box.children[i];
      var value = params ? Math.round(params[def.key]) : 0;
      row.querySelector('.pred__name').textContent = def.label;
      row.querySelector('.pred__bar i').style.width = (value / def.max * 100) + '%';
      row.querySelector('.pred__pct').textContent = value;
      row.classList.toggle('is-top', !!params);
    });

    $('packetNow').textContent = params ? buildPacket(params) : 'stop';
  }

  function drawFace() {
    if (!landmarks) return;

    if (settings.showMesh) {
      // 478개 점을 작은 점으로 찍어 얼굴 윤곽을 보여준다
      stageCtx.fillStyle = 'rgba(47, 176, 122, 0.85)';
      for (var i = 0; i < landmarks.length; i++) {
        stageCtx.fillRect(landmarks[i].x * SIZE - 1, landmarks[i].y * SIZE - 1, 2, 2);
      }
    }

    // 두 눈을 잇는 선으로 고개 기울기를 눈에 보이게 한다
    var a = landmarks[EYE_LEFT];
    var b = landmarks[EYE_RIGHT];
    stageCtx.strokeStyle = '#EE8B37';
    stageCtx.lineWidth = 3;
    stageCtx.beginPath();
    stageCtx.moveTo(a.x * SIZE, a.y * SIZE);
    stageCtx.lineTo(b.x * SIZE, b.y * SIZE);
    stageCtx.stroke();

    [a, b].forEach(function (p) {
      stageCtx.beginPath();
      stageCtx.arc(p.x * SIZE, p.y * SIZE, 5, 0, Math.PI * 2);
      stageCtx.fillStyle = '#F5C842';
      stageCtx.fill();
      stageCtx.lineWidth = 2;
      stageCtx.strokeStyle = '#151515';
      stageCtx.stroke();
    });
  }

  // ---------------------------------------------------------------- 시작/중지
  function start() {
    if (running || !landmarker) return;
    running = true;
    sentStop = false;
    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    Core.log('얼굴 데이터 전송을 시작합니다.', 'info');
  }

  function stop(silent) {
    if (!running) { $('btnStop').disabled = true; return; }
    running = false;
    $('btnStart').disabled = !landmarker;
    $('btnStop').disabled = true;

    if (!silent) {
      Core.log('얼굴 데이터 전송을 중지합니다.', 'info');
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

    $('chkMesh').addEventListener('change', function () { settings.showMesh = this.checked; saveSettings(); });

    Core.bindSlider('sendInterval', 'sendIntervalValue',
      function (v) { return v + 'ms'; },
      function (v) { settings.sendInterval = v; saveSettings(); });

    $('btnStart').addEventListener('click', start);
    $('btnStop').addEventListener('click', function () { stop(); });
    $('btnClearSaved').addEventListener('click', function () {
      if (confirm('저장된 설정을 지웁니다. 계속할까요?')) clearSaved();
    });

    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });

    window.addEventListener('beforeunload', function () { camera.stop(); });
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
    renderValues();
    loop();

    camera.start().then(function () {
      Core.setStatus($('cameraStatus'), '카메라 준비됨', 'ok');
      return initLandmarker();
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
