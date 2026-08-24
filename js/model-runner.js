/**
 * model-runner.js
 * Teachable Machine 모델(이미지 / 포즈)을 같은 방식으로 다루기 위한 래퍼.
 *
 * 어떤 모드든 load()가 끝나면 아래 형태의 러너를 돌려준다:
 *   {
 *     mode:       'image' | 'pose',
 *     classes:    ['Rock', 'Paper', ...],
 *     predict(canvas) -> Promise<[{className, probability}, ...]>   // 확률 내림차순
 *     drawOverlay(ctx)                                              // 포즈 골격 등 (없으면 no-op)
 *     dispose()
 *   }
 */
(function (global) {
  'use strict';

  var TFJS_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js';
  var LIB_URL = {
    image: 'https://cdn.jsdelivr.net/npm/@teachablemachine/image@0.8/dist/teachablemachine-image.min.js',
    pose: 'https://cdn.jsdelivr.net/npm/@teachablemachine/pose@0.8/dist/teachablemachine-pose.min.js'
  };

  var loadedScripts = {};

  /** 같은 스크립트를 두 번 받지 않도록 캐시하면서 <script>를 붙인다 */
  function loadScript(url) {
    if (loadedScripts[url]) return loadedScripts[url];
    loadedScripts[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () {
        delete loadedScripts[url]; // 실패한 건 캐시하지 않아 재시도가 가능하게
        reject(new Error('라이브러리를 불러오지 못했습니다: ' + url));
      };
      document.head.appendChild(s);
    });
    return loadedScripts[url];
  }

  /**
   * 사용자가 넣은 값을 Teachable Machine 모델 폴더 URL로 정규화한다.
   * 허용 형태:
   *   https://teachablemachine.withgoogle.com/models/AbCdEf123/
   *   https://teachablemachine.withgoogle.com/models/AbCdEf123/model.json
   *   AbCdEf123                        (짧은 ID만 입력)
   *   https://내서버.com/내모델/         (자체 호스팅)
   */
  function normalizeModelUrl(input) {
    var value = String(input || '').trim();
    if (!value) throw new Error('모델 주소 또는 ID를 입력해주세요.');

    if (!/^https?:\/\//i.test(value)) {
      // 짧은 ID로 간주
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error('모델 ID 형식이 올바르지 않습니다. 전체 주소를 붙여넣어 보세요.');
      }
      value = 'https://teachablemachine.withgoogle.com/models/' + value;
    }

    value = value.replace(/model\.json.*$/i, ''); // model.json 이하 제거
    value = value.split('?')[0].split('#')[0];
    if (value.slice(-1) !== '/') value += '/';
    return value;
  }

  /** 확률 내림차순으로 정렬한 새 배열 */
  function sortByProbability(predictions) {
    return predictions.slice().sort(function (a, b) { return b.probability - a.probability; });
  }

  /** 이미지 분류 러너 */
  function createImageRunner(model) {
    return {
      mode: 'image',
      classes: model.getClassLabels ? model.getClassLabels() : [],
      predict: function (canvas) {
        return model.predict(canvas).then(sortByProbability);
      },
      drawOverlay: function () { /* 이미지 모드는 오버레이 없음 */ },
      dispose: function () { if (model.dispose) model.dispose(); }
    };
  }

  /** 포즈 분류 러너 — 골격을 캔버스에 그려준다 */
  function createPoseRunner(model) {
    var lastPose = null;
    var MIN_PART_CONFIDENCE = 0.5;

    return {
      mode: 'pose',
      classes: model.getClassLabels ? model.getClassLabels() : [],
      predict: function (canvas) {
        // 1단계: PoseNet으로 관절 좌표 추출 -> 2단계: 그 좌표를 분류
        return model.estimatePose(canvas).then(function (result) {
          lastPose = result.pose;
          return model.predict(result.posenetOutput).then(sortByProbability);
        });
      },
      drawOverlay: function (ctx) {
        if (!lastPose || !global.tmPose) return;
        global.tmPose.drawKeypoints(lastPose.keypoints, MIN_PART_CONFIDENCE, ctx);
        global.tmPose.drawSkeleton(lastPose.keypoints, MIN_PART_CONFIDENCE, ctx);
      },
      dispose: function () { lastPose = null; if (model.dispose) model.dispose(); }
    };
  }

  /** 필요한 라이브러리를 순서대로 받아온다 (tfjs 먼저, 그다음 TM 라이브러리) */
  function ensureLibs(mode) {
    if (!LIB_URL[mode]) return Promise.reject(new Error('알 수 없는 모드: ' + mode));
    return loadScript(TFJS_URL).then(function () { return loadScript(LIB_URL[mode]); });
  }

  var ModelRunner = {
    normalizeModelUrl: normalizeModelUrl,

    /**
     * URL(또는 짧은 ID)로 모델을 불러온다.
     * @param {'image'|'pose'} mode
     * @param {string} input
     * @param {function(string)} [onProgress]
     */
    loadFromUrl: function (mode, input, onProgress) {
      var baseUrl = normalizeModelUrl(input);
      var report = onProgress || function () {};

      report('라이브러리를 불러오는 중...');
      return ensureLibs(mode).then(function () {
        report('모델을 불러오는 중...');
        var lib = mode === 'pose' ? global.tmPose : global.tmImage;
        if (!lib) throw new Error('Teachable Machine 라이브러리를 찾을 수 없습니다.');
        return lib.load(baseUrl + 'model.json', baseUrl + 'metadata.json');
      }).then(function (model) {
        return mode === 'pose' ? createPoseRunner(model) : createImageRunner(model);
      });
    },

    /**
     * Teachable Machine에서 내려받은 파일 3개로 모델을 불러온다.
     * (인터넷이 느리거나 막힌 교실에서 유용)
     * @param {'image'|'pose'} mode
     * @param {{model: File, weights: File, metadata: File}} files
     */
    loadFromFiles: function (mode, files, onProgress) {
      var report = onProgress || function () {};
      if (!files.model || !files.weights || !files.metadata) {
        return Promise.reject(new Error('model.json, weights.bin, metadata.json 세 파일을 모두 선택해주세요.'));
      }

      report('라이브러리를 불러오는 중...');
      return ensureLibs(mode).then(function () {
        report('모델을 불러오는 중...');
        var lib = mode === 'pose' ? global.tmPose : global.tmImage;
        if (!lib || !lib.loadFromFiles) {
          throw new Error('이 라이브러리는 파일 업로드 방식을 지원하지 않습니다.');
        }
        return lib.loadFromFiles(files.model, files.weights, files.metadata);
      }).then(function (model) {
        return mode === 'pose' ? createPoseRunner(model) : createImageRunner(model);
      });
    }
  };

  global.ModelRunner = ModelRunner;
})(window);
