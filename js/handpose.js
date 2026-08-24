/**
 * handpose.js
 * MediaPipe HandLandmarker로 손 관절을 뽑고, 브라우저 안에서 KNN으로 손모양을 학습·분류한다.
 * Teachable Machine이 필요 없다 — 학습이 이 페이지 안에서 끝난다.
 * 특징 추출과 분류 계산은 js/knn.js에 있다.
 */
(function () {
  'use strict';

  var $ = Core.$;
  var SIZE = 400;

  var MP_MODULE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8';
  var MP_WASM = MP_MODULE + '/wasm';
  var MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  // 21개 관절을 잇는 선 (MediaPipe 손 모델 표준 연결)
  var HAND_LINKS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [9, 10], [10, 11], [11, 12],
    [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20],
    [5, 9], [9, 13], [13, 17]
  ];

  var ble = new MicrobitBLE();
  var tx = new Core.Transmitter(ble);
  var gate = new Core.StabilityGate();
  var camera = new Core.SquareCamera(SIZE);
  var knn = new HandKNN.KNN(5);

  var stage = $('stage');
  var stageCtx = stage.getContext('2d');
  stage.width = stage.height = SIZE;

  var landmarker = null;
  var lastLandmarks = null;
  var lastVideoTime = -1;

  var classNames = [];       // 표에 보이는 순서를 유지하기 위한 이름 목록
  var collectingFor = null;  // 지금 샘플을 담고 있는 이름
  var running = false;
  var sendMode = 'change';
  var repeatInterval = 500;
  var lastResult = null;

  var PAGE = 'handpose';

  var mapper = new Core.MappingTable($('mappingBody'), {
    onTest: function (cmd) { tx.send(cmd, '테스트'); },
    onChange: function () { saveMapping(); }
  });

  // ---------------------------------------------------------------- 저장 / 불러오기
  function saveTraining() {
    // 샘플은 담는 동안 초당 수십 번 늘어나므로 잠잠해진 뒤 한 번만 저장한다
    Store.saveLater(PAGE, 'classNames', classNames, 400);
    Store.saveLater(PAGE, 'knn', knn.toJSON(), 400);
    Core.markSaved();
  }

  function saveMapping() {
    Store.save(PAGE, 'mapping', mapper.snapshot());
  }

  function saveSettings() {
    Store.save(PAGE, 'settings', {
      threshold: gate.threshold,
      stability: gate.stability,
      sendMode: sendMode,
      repeatInterval: repeatInterval,
      mirrored: camera.mirrored
    });
  }

  /** 페이지를 열 때 지난번 내용을 되돌린다 */
  function restoreAll() {
    if (!Store.isAvailable()) { Core.markStorageUnavailable(); return; }

    var st = Store.load(PAGE, 'settings', null);
    if (st) {
      if (st.threshold) { gate.threshold = st.threshold; $('threshold').value = Math.round(st.threshold * 100); }
      if (st.stability) { gate.stability = st.stability; $('stability').value = st.stability; }
      if (st.repeatInterval) { repeatInterval = st.repeatInterval; $('repeatInterval').value = st.repeatInterval; }
      if (st.sendMode) { sendMode = st.sendMode; $('sendMode').value = sendMode; $('repeatRow').hidden = sendMode !== 'repeat'; }
      if (typeof st.mirrored === 'boolean') {
        camera.mirrored = st.mirrored;
        $('btnMirror').setAttribute('aria-pressed', String(camera.mirrored));
      }
      // 슬라이더 옆 숫자도 되돌린 값에 맞춘다
      $('thresholdValue').textContent = $('threshold').value + '%';
      $('stabilityValue').textContent = $('stability').value + '회';
      $('repeatValue').textContent = $('repeatInterval').value + 'ms';
    }

    var savedMapping = Store.load(PAGE, 'mapping', null);
    if (savedMapping) mapper.restore(savedMapping.mapping, savedMapping.enabled);

    var names = Store.load(PAGE, 'classNames', null);
    var data = Store.load(PAGE, 'knn', null);
    if (!names || !names.length) return;

    classNames = names;
    if (data) {
      try { knn.loadJSON(data); } catch (e) {
        Core.log('저장된 학습을 불러오지 못했습니다: ' + e.message, 'warn');
      }
    }

    renderClasses();
    rebuildMapping();
    updateTrainStatus();
    Core.log('지난번 학습을 불러왔습니다 — 손모양 ' + classNames.length + '개 / 샘플 ' + knn.count() + '개', 'info');
  }

  /** 학습 결과를 파일로 내보낸다 (한 번 만들어 학생 전체에게 나눠줄 때) */
  function exportTraining() {
    if (!knn.count()) { Core.log('내보낼 학습 내용이 없습니다.', 'warn'); return; }
    Store.exportFile('handpose-training.json', {
      type: 'handpose-knn',
      version: 1,
      classNames: classNames,
      knn: knn.toJSON(),
      mapping: mapper.snapshot()
    });
    Core.log('학습 내용을 파일로 내보냈습니다. (샘플 ' + knn.count() + '개)', 'info');
  }

  /** 내보낸 파일을 불러온다 */
  function importTraining(file) {
    Store.importFile(file).then(function (data) {
      if (!data || !data.knn) throw new Error('손모양 학습 파일이 아닙니다.');

      var count = knn.loadJSON(data.knn);
      classNames = (Array.isArray(data.classNames) && data.classNames.length)
        ? data.classNames
        : knn.labels();

      if (data.mapping) mapper.restore(data.mapping.mapping, data.mapping.enabled);

      stop(true);
      renderClasses();
      rebuildMapping();
      updateTrainStatus();
      saveTraining();
      saveMapping();
      Core.log('파일에서 학습을 불러왔습니다 — 손모양 ' + classNames.length + '개 / 샘플 ' + count + '개', 'info');
    }).catch(function (error) {
      Core.log('불러오기 실패: ' + (error.message || error), 'error');
    });
  }

  function clearSaved() {
    Store.clearPage(PAGE);
    knn.clear();
    classNames = [];
    stop(true);
    renderClasses();
    rebuildMapping();
    updateTrainStatus();
    $('predictions').innerHTML = '';
    Core.setStatus($('saveStatus'), '자동 저장 켜짐', 'idle');
    Core.log('저장된 학습 내용을 모두 지웠습니다.', 'info');
  }

  // ---------------------------------------------------------------- 클래스 표
  function renderClasses() {
    var body = $('classBody');
    body.innerHTML = '';

    classNames.forEach(function (name, index) {
      var tr = document.createElement('tr');

      var tdName = document.createElement('td');
      tdName.className = 'mapping__class';
      tdName.textContent = name;

      var count = knn.count(name);
      var tdCount = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'sample-count' + (count ? ' is-ready' : '');
      badge.textContent = count;
      tdCount.appendChild(badge);

      var tdCollect = document.createElement('td');
      var collectBtn = document.createElement('button');
      collectBtn.type = 'button';
      collectBtn.className = 'btn btn--accent btn--sm';
      collectBtn.textContent = '누르고 있기';
      // 누르고 있는 동안 매 프레임 샘플이 쌓인다 (30번 클릭하는 것보다 편하다)
      var startCollect = function (e) {
        e.preventDefault();
        collectingFor = name;
        collectBtn.classList.add('is-collecting');
      };
      var endCollect = function () {
        if (collectingFor === name) collectingFor = null;
        collectBtn.classList.remove('is-collecting');
      };
      collectBtn.addEventListener('mousedown', startCollect);
      collectBtn.addEventListener('touchstart', startCollect, { passive: false });
      collectBtn.addEventListener('mouseup', endCollect);
      collectBtn.addEventListener('mouseleave', endCollect);
      collectBtn.addEventListener('touchend', endCollect);
      tdCollect.appendChild(collectBtn);

      var tdClear = document.createElement('td');
      var clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn btn--ghost btn--sm';
      clearBtn.textContent = '비우기';
      clearBtn.addEventListener('click', function () {
        knn.clear(name);
        renderClasses();
        updateTrainStatus();
        saveTraining();
        Core.log('"' + name + '" 샘플을 비웠습니다.', 'info');
      });
      tdClear.appendChild(clearBtn);

      var tdDel = document.createElement('td');
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn--ghost btn--sm';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', function () {
        knn.clear(name);
        classNames.splice(index, 1);
        renderClasses();
        rebuildMapping();
        updateTrainStatus();
        saveTraining();
      });
      tdDel.appendChild(delBtn);

      tr.appendChild(tdName);
      tr.appendChild(tdCount);
      tr.appendChild(tdCollect);
      tr.appendChild(tdClear);
      tr.appendChild(tdDel);
      body.appendChild(tr);
    });
  }

  /** 담는 중에는 표 전체를 다시 그리면 누르고 있던 버튼이 사라지므로 숫자만 갱신한다 */
  function updateSampleCount(name) {
    var index = classNames.indexOf(name);
    var row = $('classBody').children[index];
    if (!row) return;
    var badge = row.querySelector('.sample-count');
    if (badge) {
      badge.textContent = knn.count(name);
      badge.classList.add('is-ready');
    }
  }

  function rebuildMapping() {
    mapper.build(classNames);
    $('mappingSection').hidden = classNames.length === 0;
  }

  function updateTrainStatus() {
    var trained = knn.trainedLabelCount();
    var ready = trained >= 2;
    Core.setStatus($('trainStatus'),
      ready
        ? '학습됨 — 손모양 ' + trained + '개 / 샘플 ' + knn.count() + '개'
        : '손모양 2개 이상에 샘플을 담아주세요 (현재 ' + trained + '개)',
      ready ? 'ok' : 'busy');
    $('btnStart').disabled = !ready || running;
  }

  function addClass(name) {
    name = String(name || '').trim();
    if (!name) { Core.log('손모양 이름을 입력해주세요.', 'error'); return false; }
    if (classNames.indexOf(name) !== -1) {
      Core.log('이미 있는 이름입니다: ' + name, 'warn');
      return false;
    }
    classNames.push(name);
    renderClasses();
    rebuildMapping();
    updateTrainStatus();
    saveTraining();
    return true;
  }

  // ---------------------------------------------------------------- MediaPipe
  function initLandmarker() {
    Core.setStatus($('modelStatus'), '손 인식 모델을 불러오는 중...', 'busy');

    return import(MP_MODULE).then(function (mp) {
      return mp.FilesetResolver.forVisionTasks(MP_WASM).then(function (vision) {
        var options = function (delegate) {
          return {
            baseOptions: { modelAssetPath: MP_MODEL, delegate: delegate },
            runningMode: 'VIDEO',
            numHands: 1
          };
        };
        // GPU를 못 쓰는 환경(가상머신 등)에서는 CPU로 되돌린다
        return mp.HandLandmarker.createFromOptions(vision, options('GPU'))
          .catch(function () { return mp.HandLandmarker.createFromOptions(vision, options('CPU')); });
      });
    }).then(function (instance) {
      landmarker = instance;
      Core.setStatus($('modelStatus'), '손 인식 준비됨', 'ok');
      Core.log('손 인식 모델을 불러왔습니다.', 'info');
    }).catch(function (error) {
      Core.setStatus($('modelStatus'), '손 인식 모델 로드 실패: ' + (error.message || error), 'error');
      Core.log('손 인식 모델 로드 실패: ' + (error.message || error), 'error');
    });
  }

  // ---------------------------------------------------------------- 루프
  function loop() {
    requestAnimationFrame(loop);

    if (!camera.grab()) {
      Core.drawWaiting(stageCtx, SIZE);
      return;
    }

    // 같은 프레임을 두 번 넣으면 MediaPipe가 오류를 내므로 시간이 바뀔 때만 추론한다
    if (landmarker && camera.video.currentTime !== lastVideoTime) {
      lastVideoTime = camera.video.currentTime;
      try {
        var result = landmarker.detectForVideo(camera.canvas, performance.now());
        lastLandmarks = (result.landmarks && result.landmarks.length) ? result.landmarks[0] : null;
        onLandmarks(lastLandmarks);
      } catch (e) {
        // 프레임 하나 실패로 루프가 멈추지 않게 넘어간다
      }
    }

    stageCtx.drawImage(camera.canvas, 0, 0);
    drawHand(lastLandmarks);

    var text = !lastLandmarks ? '손이 보이지 않습니다'
      : collectingFor ? '담는 중: ' + collectingFor
        : running && lastResult ? lastResult.label + '  ' + Math.round(lastResult.confidence * 100) + '%'
          : running ? '인식 중...' : '대기 중';
    Core.drawLabelBar(stageCtx, SIZE, text);
  }

  function onLandmarks(landmarks) {
    if (!landmarks) {
      if (running) { lastResult = null; renderPrediction(null); feedGate(null, 0); }
      return;
    }

    var features = HandKNN.extractFeatures(landmarks);
    if (!features) return;

    if (collectingFor) {
      knn.add(collectingFor, features);
      updateSampleCount(collectingFor);
      updateTrainStatus();
      saveTraining();
      return;
    }

    if (!running) return;

    var result = knn.classify(features);
    lastResult = result;
    renderPrediction(result);
    if (result) feedGate(result.label, result.confidence);
  }

  function feedGate(label, confidence) {
    var out = gate.feed(label, confidence);
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

  function renderPrediction(result) {
    var box = $('predictions');

    if (box.children.length !== classNames.length) {
      box.innerHTML = '';
      classNames.forEach(function () {
        var row = document.createElement('div');
        row.className = 'pred';
        row.innerHTML = '<span class="pred__name"></span><span class="pred__bar"><i></i></span><span class="pred__pct"></span>';
        box.appendChild(row);
      });
    }

    classNames.forEach(function (name, i) {
      var row = box.children[i];
      if (!row) return;
      var isTop = result && result.label === name;
      var pct = isTop ? Math.round(result.confidence * 100) : 0;
      row.querySelector('.pred__name').textContent = name;
      row.querySelector('.pred__bar i').style.width = pct + '%';
      row.querySelector('.pred__pct').textContent = pct + '%';
      row.classList.toggle('is-top', !!isTop && result.confidence >= gate.threshold);
    });
  }

  // ---------------------------------------------------------------- 골격 그리기
  function drawHand(landmarks) {
    if (!landmarks) return;

    stageCtx.strokeStyle = '#151515';
    stageCtx.lineWidth = 4;
    HAND_LINKS.forEach(function (link) {
      var a = landmarks[link[0]];
      var b = landmarks[link[1]];
      stageCtx.beginPath();
      stageCtx.moveTo(a.x * SIZE, a.y * SIZE);
      stageCtx.lineTo(b.x * SIZE, b.y * SIZE);
      stageCtx.stroke();
    });

    landmarks.forEach(function (p, i) {
      stageCtx.beginPath();
      stageCtx.arc(p.x * SIZE, p.y * SIZE, i === 0 ? 7 : 5, 0, Math.PI * 2);
      stageCtx.fillStyle = i === 0 ? '#EE8B37' : '#2FB07A';
      stageCtx.fill();
      stageCtx.lineWidth = 2;
      stageCtx.strokeStyle = '#151515';
      stageCtx.stroke();
    });
  }

  // ---------------------------------------------------------------- 시작/중지
  function start() {
    if (running || knn.trainedLabelCount() < 2) return;
    running = true;
    gate.reset();
    lastResult = null;
    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    Core.log('분류를 시작합니다. (샘플 ' + knn.count() + '개)', 'info');
  }

  function stop(silent) {
    if (!running) { $('btnStop').disabled = true; return; }
    running = false;
    lastResult = null;
    gate.reset();
    $('btnStop').disabled = true;
    updateTrainStatus();

    if (!silent) {
      Core.log('분류를 중지합니다.', 'info');
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

    $('btnAddClass').addEventListener('click', function () {
      if (addClass($('newClass').value)) {
        $('newClass').value = '';
        $('newClass').focus();
      }
    });

    $('newClass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btnAddClass').click();
    });

    $('btnPreset').addEventListener('click', function () {
      ['주먹', '보', '가위'].forEach(addClass);
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

    $('btnExportTraining').addEventListener('click', exportTraining);
    $('btnImportTraining').addEventListener('click', function () { $('trainingFile').click(); });
    $('trainingFile').addEventListener('change', function () {
      if (this.files[0]) importTraining(this.files[0]);
      this.value = '';
    });
    $('btnClearSaved').addEventListener('click', function () {
      if (confirm('저장된 손모양 학습을 모두 지웁니다. 계속할까요?')) clearSaved();
    });

    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });

    // 버튼 밖에서 손을 떼도 담기가 멈추도록
    window.addEventListener('mouseup', function () {
      if (!collectingFor) return;
      collectingFor = null;
      var el = document.querySelector('.is-collecting');
      if (el) el.classList.remove('is-collecting');
    });

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
    updateTrainStatus();
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

    Core.log('손모양 이름을 추가하고, 손을 화면에 두고 "누르고 있기"로 샘플을 담으세요.', 'info');
  }

  init();
})();
