/**
 * knn.js
 * 손 관절 좌표 → 특징 벡터 변환과 KNN 분류. 순수 계산만 담아 따로 테스트할 수 있게 분리했다.
 *
 * 브라우저: window.HandKNN
 * Node:     require('./knn.js')
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HandKNN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 관절 21개를 손목(0번) 기준 상대좌표로 바꾸고 손 크기로 나눈다.
   * 손이 화면 어디에 있든, 카메라에서 얼마나 멀든 같은 모양이면 같은 값이 나온다.
   * z는 흔들림이 커서 쓰지 않으므로 결과는 40개 숫자(20관절 × x,y).
   *
   * @param {Array<{x:number,y:number}>} landmarks
   * @returns {Float32Array|null} 손이 한 점으로 뭉개졌으면 null
   */
  function extractFeatures(landmarks) {
    if (!landmarks || landmarks.length < 2) return null;

    var wrist = landmarks[0];
    var maxDist = 0;

    for (var i = 1; i < landmarks.length; i++) {
      var dx = landmarks[i].x - wrist.x;
      var dy = landmarks[i].y - wrist.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxDist) maxDist = d;
    }
    if (maxDist < 1e-6) return null;

    var features = new Float32Array((landmarks.length - 1) * 2);
    var k = 0;
    for (var j = 1; j < landmarks.length; j++) {
      features[k++] = (landmarks[j].x - wrist.x) / maxDist;
      features[k++] = (landmarks[j].y - wrist.y) / maxDist;
    }
    return features;
  }

  function squaredDistance(a, b) {
    var sum = 0;
    for (var i = 0; i < a.length; i++) {
      var d = a[i] - b[i];
      sum += d * d;
    }
    return sum;
  }

  /** 라벨별 샘플 창고 + K최근접 분류기 */
  function KNN(k) {
    this.k = k || 5;
    this.samples = {}; // label -> [Float32Array]
  }

  KNN.prototype.add = function (label, features) {
    if (!features) return false;
    if (!this.samples[label]) this.samples[label] = [];
    this.samples[label].push(features);
    return true;
  };

  KNN.prototype.count = function (label) {
    return label === undefined
      ? Object.keys(this.samples).reduce((n, l) => n + this.samples[l].length, 0)
      : (this.samples[label] || []).length;
  };

  KNN.prototype.labels = function () {
    return Object.keys(this.samples);
  };

  /** 샘플이 하나 이상 담긴 라벨 수 */
  KNN.prototype.trainedLabelCount = function () {
    var self = this;
    return Object.keys(this.samples).filter(function (l) { return self.samples[l].length > 0; }).length;
  };

  KNN.prototype.clear = function (label) {
    if (label === undefined) this.samples = {};
    else delete this.samples[label];
  };

  KNN.prototype.rename = function (from, to) {
    if (this.samples[from]) {
      this.samples[to] = this.samples[from];
      delete this.samples[from];
    }
  };

  /**
   * 가장 가까운 샘플 K개의 다수결로 분류한다.
   * @returns {{label: string, confidence: number}|null} confidence는 K개 중 승자 득표율
   */
  KNN.prototype.classify = function (features) {
    if (!features) return null;

    var pool = [];
    var self = this;
    Object.keys(this.samples).forEach(function (label) {
      self.samples[label].forEach(function (sample) {
        pool.push({ label: label, dist: squaredDistance(features, sample) });
      });
    });
    if (!pool.length) return null;

    pool.sort(function (a, b) { return a.dist - b.dist; });
    var k = Math.min(this.k, pool.length);

    var votes = {};
    for (var i = 0; i < k; i++) {
      votes[pool[i].label] = (votes[pool[i].label] || 0) + 1;
    }

    var best = null;
    Object.keys(votes).forEach(function (label) {
      if (best === null || votes[label] > votes[best]) best = label;
    });

    return { label: best, confidence: votes[best] / k };
  };

  /**
   * 학습 결과를 저장·전달할 수 있는 순수 객체로 바꾼다.
   * 소수점을 4자리로 줄여도 분류 결과는 달라지지 않으면서 용량은 절반 이하가 된다.
   */
  KNN.prototype.toJSON = function () {
    var out = {};
    var self = this;
    Object.keys(this.samples).forEach(function (label) {
      out[label] = self.samples[label].map(function (f) {
        var arr = [];
        for (var i = 0; i < f.length; i++) arr.push(Math.round(f[i] * 10000) / 10000);
        return arr;
      });
    });
    return { type: 'handpose-knn', version: 1, k: this.k, samples: out };
  };

  /**
   * toJSON으로 만든 데이터를 현재 분류기에 채워 넣는다 (기존 내용은 지워진다).
   * @returns {number} 불러온 샘플 수
   */
  KNN.prototype.loadJSON = function (data) {
    if (!data || !data.samples || typeof data.samples !== 'object') {
      throw new Error('손모양 학습 파일이 아닙니다.');
    }

    this.samples = {};
    if (data.k) this.k = data.k;

    var self = this;
    var count = 0;
    Object.keys(data.samples).forEach(function (label) {
      var list = data.samples[label];
      if (!Array.isArray(list)) return;
      list.forEach(function (arr) {
        if (!Array.isArray(arr) || !arr.length) return;
        self.add(label, Float32Array.from(arr));
        count++;
      });
    });

    if (!count) throw new Error('파일에 학습된 샘플이 없습니다.');
    return count;
  };

  return {
    extractFeatures: extractFeatures,
    squaredDistance: squaredDistance,
    KNN: KNN
  };
});
