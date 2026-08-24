/**
 * app.js
 * Teachable Machine 모델(이미지 / 포즈)로 micro:bit를 제어하는 페이지 로직.
 * 어느 모드로 동작할지는 <body data-mode="image|pose">로 결정된다.
 * 공용 부품은 js/core.js, 모델 로딩은 js/model-runner.js에 있다.
 */
(function () {
  'use strict';

  var $ = Core.$;
  var MODE = document.body.dataset.mode === 'pose' ? 'pose' : 'image';
  var SIZE = 400;

  var ble = new MicrobitBLE();
  var tx = new Core.Transmitter(ble);
  var gate = new Core.StabilityGate();
  var camera = new Core.SquareCamera(SIZE);

  var stage = $('stage');
  var stageCtx = stage.getContext('2d');
  stage.width = stage.height = SIZE;

  var runner = null;
  var running = false;
  var sendMode = 'change';
  var repeatInterval = 500;
  var busy = false;          // 추론이 겹치지 않게 하는 잠금
  var lastPredictions = null;

  var PAGE = MODE === 'pose' ? 'pose' : 'image';

  var mapper = new Core.MappingTable($('mappingBody'), {
    onTest: function (cmd) { tx.send(cmd, '테스트'); },
    onChange: function () {
      Store.save(PAGE, 'mapping', mapper.snapshot());
      Core.markSaved();
    }
  });

  // ---------------------------------------------------------------- 저장 / 불러오기
  function saveSettings() {
    Store.save(PAGE, 'settings', {
      modelUrl: $('modelUrl').value.trim(),
      threshold: gate.threshold,
      stability: gate.stability,
      sendMode: sendMode,
      repeatInterval: repeatInterval,
      mirrored: camera.mirrored
    });
  }

  function restoreAll() {
    if (!Store.isAvailable()) { Core.markStorageUnavailable(); return; }

    var savedMapping = Store.load(PAGE, 'mapping', null);
    if (savedMapping) mapper.restore(savedMapping.mapping, savedMapping.enabled);

    var st = Store.load(PAGE, 'settings', null);
    if (!st) return;

    if (st.modelUrl) $('modelUrl').value = st.modelUrl;
    if (st.threshold) { gate.threshold = st.threshold; $('threshold').value = Math.round(st.threshold * 100); }
    if (st.stability) { gate.stability = st.stability; $('stability').value = st.stability; }
    if (st.repeatInterval) { repeatInterval = st.repeatInterval; $('repeatInterval').value = st.repeatInterval; }
    if (st.sendMode) { sendMode = st.sendMode; $('sendMode').value = sendMode; $('repeatRow').hidden = sendMode !== 'repeat'; }
    if (typeof st.mirrored === 'boolean') {
      camera.mirrored = st.mirrored;
      $('btnMirror').setAttribute('aria-pressed', String(camera.mirrored));
    }

    $('thresholdValue').textContent = $('threshold').value + '%';
    $('stabilityValue').textContent = $('stability').value + '회';
    $('repeatValue').textContent = $('repeatInterval').value + 'ms';

    if (st.modelUrl) {
      Core.log('지난번 모델 주소를 불러왔습니다. "모델 불러오기"를 눌러주세요.', 'info');
    }
  }

  function clearSaved() {
    Store.clearPage(PAGE);
    $('modelUrl').value = '';
    Core.setStatus($('saveStatus'), '자동 저장 켜짐', 'idle');
    Core.log('저장된 설정을 지웠습니다.', 'info');
  }

  // ---------------------------------------------------------------- 그리기 루프
  function loop() {
    requestAnimationFrame(loop);

    if (!camera.grab()) {
      Core.drawWaiting(stageCtx, SIZE);
      return;
    }

    stageCtx.drawImage(camera.canvas, 0, 0);
    if (runner) runner.drawOverlay(stageCtx);

    Core.drawLabelBar(stageCtx, SIZE,
      gate.confirmed || (running ? '인식 중...' : '대기 중'));
  }

  // ---------------------------------------------------------------- 추론 루프
  function inferenceLoop() {
    if (!running || !runner || busy) return;
    busy = true;

    runner.predict(camera.canvas).then(function (predictions) {
      lastPredictions = predictions;
      if (!running) return;
      renderPredictions(predictions);
      applySendPolicy(predictions);
    }).catch(function (error) {
      console.error(error);
      Core.log('추론 오류: ' + (error.message || error), 'error');
    }).then(function () {
      busy = false;
      if (running) requestAnimationFrame(inferenceLoop);
    });
  }

  function renderPredictions(predictions) {
    var box = $('predictions');
    var order = runner ? runner.classes : [];
    var top = predictions.length ? predictions[0] : null;

    // predictions는 확률 내림차순이라 매 프레임 순서가 바뀐다.
    // 막대가 위아래로 튀지 않도록 화면에는 항상 모델의 클래스 순서대로 그린다.
    var byName = {};
    predictions.forEach(function (p) { byName[p.className] = p.probability; });

    if (box.children.length !== order.length) {
      box.innerHTML = '';
      order.forEach(function () {
        var row = document.createElement('div');
        row.className = 'pred';
        row.innerHTML = '<span class="pred__name"></span>' +
          '<span class="pred__bar"><i></i></span>' +
          '<span class="pred__pct"></span>';
        box.appendChild(row);
      });
    }

    order.forEach(function (className, i) {
      var row = box.children[i];
      if (!row) return;
      var pct = Math.round((byName[className] || 0) * 100);
      row.querySelector('.pred__name').textContent = className;
      row.querySelector('.pred__bar i').style.width = pct + '%';
      row.querySelector('.pred__pct').textContent = pct + '%';
      row.classList.toggle('is-top',
        !!top && className === top.className && top.probability >= gate.threshold);
    });
  }

  function applySendPolicy(predictions) {
    var top = predictions.length ? predictions[0] : null;
    var out = gate.feed(top ? top.className : null, top ? top.probability : 0);
    if (!out.confirmed) return;
    if (!mapper.isEnabled(out.confirmed)) return;

    var command = mapper.commandFor(out.confirmed);
    if (!command) return;

    if (out.changed) {
      if (tx.canSendNow()) tx.send(command, out.confirmed);
    } else if (sendMode === 'repeat' && Date.now() - tx.lastSentAt >= repeatInterval) {
      tx.send(command, out.confirmed);
    }
  }

  // ---------------------------------------------------------------- 모델 로드
  function loadModel() {
    var report = function (message) { Core.setStatus($('modelStatus'), message, 'busy'); };
    var useFiles = document.querySelector('input[name="modelSource"]:checked').value === 'file';

    stop();
    if (runner) { runner.dispose(); runner = null; }
    $('btnStart').disabled = true;

    var promise;
    try {
      if (useFiles) {
        promise = ModelRunner.loadFromFiles(MODE, {
          model: $('fileModel').files[0],
          weights: $('fileWeights').files[0],
          metadata: $('fileMetadata').files[0]
        }, report);
      } else {
        promise = ModelRunner.loadFromUrl(MODE, $('modelUrl').value, report);
      }
    } catch (error) {
      Core.setStatus($('modelStatus'), error.message, 'error');
      return;
    }

    promise.then(function (instance) {
      runner = instance;
      Core.setStatus($('modelStatus'), '모델 로드 완료 — 클래스 ' + runner.classes.length + '개', 'ok');
      Core.log('모델 로드 완료: ' + runner.classes.join(', '), 'info');
      mapper.build(runner.classes);
      $('mappingSection').hidden = false;
      $('btnStart').disabled = false;
    }).catch(function (error) {
      console.error(error);
      Core.setStatus($('modelStatus'), '모델 로드 실패: ' + (error.message || error), 'error');
      Core.log('모델 로드 실패: ' + (error.message || error), 'error');
    });
  }

  // ---------------------------------------------------------------- 시작/중지
  function start() {
    if (!runner || running) return;
    running = true;
    gate.reset();
    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    Core.log('인식을 시작합니다.', 'info');
    inferenceLoop();
  }

  function stop(silent) {
    if (!running) { $('btnStop').disabled = true; return; }
    running = false;
    gate.reset();
    lastPredictions = null;
    $('btnStart').disabled = !runner;
    $('btnStop').disabled = true;

    if (!silent) {
      Core.log('인식을 중지합니다.', 'info');
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

    document.querySelectorAll('input[name="modelSource"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        var useFiles = this.value === 'file';
        $('sourceUrl').hidden = useFiles;
        $('sourceFile').hidden = !useFiles;
      });
    });

    $('modelUrl').addEventListener('input', saveSettings);
    $('btnLoadModel').addEventListener('click', loadModel);
    $('modelUrl').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') loadModel();
    });

    $('btnStart').addEventListener('click', start);
    $('btnStop').addEventListener('click', function () { stop(); });

    Core.bindSlider('threshold', 'thresholdValue',
      function (v) { return v + '%'; },
      function (v) { gate.threshold = v / 100; saveSettings(); });

    Core.bindSlider('stability', 'stabilityValue',
      function (v) { return v + '회'; },
      function (v) { gate.stability = v; saveSettings(); });

    Core.bindSlider('repeatInterval', 'repeatValue',
      function (v) { return v + 'ms'; },
      function (v) { repeatInterval = v; saveSettings(); });

    $('sendMode').addEventListener('change', function () {
      sendMode = this.value;
      $('repeatRow').hidden = this.value !== 'repeat';
      saveSettings();
    });

    $('btnClearSaved').addEventListener('click', function () {
      if (confirm('저장된 모델 주소와 명령 연결을 지웁니다. 계속할까요?')) clearSaved();
    });

    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });

    window.addEventListener('beforeunload', function () { camera.stop(); });
  }

  // ---------------------------------------------------------------- 초기화
  function init() {
    document.title = (MODE === 'pose' ? '포즈 분류' : '이미지 분류') + ' — micro:bit AI 제어';
    Core.mountFooter();
    camera.attach(document.body);

    new Core.BleController(ble, tx, {
      onDrop: function () { if (running) stop(true); }
    });

    restoreAll();
    bindEvents();
    loop();

    camera.start().then(function () {
      Core.setStatus($('cameraStatus'), '카메라 준비됨', 'ok');
    }).catch(function (error) {
      var message = error.name === 'NotAllowedError'
        ? '카메라 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 허용해주세요.'
        : '카메라를 열 수 없습니다: ' + (error.message || error);
      Core.setStatus($('cameraStatus'), message, 'error');
      Core.log(message, 'error');
    });

    Core.log('준비 완료. 1) 카메라 확인 → 2) micro:bit 연결 → 3) 모델 불러오기 순서로 진행하세요.', 'info');
  }

  init();
})();
