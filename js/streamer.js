/**
 * streamer.js
 * micro:bit가 보내는 센서값을 받아 실시간 그래프로 보여주고 CSV로 내보낸다.
 * 이 페이지는 유일하게 micro:bit -> 웹 방향(수신)만 쓴다.
 *
 * 받는 형식 (줄 단위)
 *   light=123            이름과 값
 *   light=123,temp=25    한 줄에 여러 개
 *   123                  이름 없으면 value로 저장
 */
(function () {
  'use strict';

  var $ = Core.$;

  // 계열 색 — dataviz 검증기(색약 분리 ΔE 8.3, 대비 3:1 이상) 통과한 고정 순서.
  // 순서를 섞거나 5번째 색을 만들어 쓰지 않는다.
  var PALETTE = ['#17724E', '#C13B77', '#C96A0F', '#2B5FA8'];
  var MAX_SERIES = PALETTE.length;

  var ble = new MicrobitBLE();

  var series = {};      // 이름 -> {name, color, points: [{t, v}]}
  var order = [];       // 도착 순서 (색을 고정하기 위해 유지)
  var droppedKeys = {}; // 자리가 없어 버린 이름 (조용히 버리지 않고 알린다)
  var startedAt = null;
  var paused = false;
  var windowSize = 200;
  var hoverIndex = null;
  var demoTimer = null;

  // ---------------------------------------------------------------- 파싱
  /**
   * 한 줄을 {name, value} 목록으로 바꾼다.
   * @returns {Array<{name: string, value: number}>}
   */
  function parseLine(text) {
    var out = [];
    String(text).split(/[,;]/).forEach(function (part) {
      var pair = part.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (pair) {
        out.push({ name: pair[1], value: parseFloat(pair[2]) });
        return;
      }
      var bare = part.trim();
      if (/^-?\d+(?:\.\d+)?$/.test(bare)) {
        out.push({ name: 'value', value: parseFloat(bare) });
      }
    });
    return out;
  }

  function record(name, value) {
    if (!series[name]) {
      if (order.length >= MAX_SERIES) {
        // 색을 새로 만들어내지 않는다. 버린 사실은 기록에 남긴다.
        if (!droppedKeys[name]) {
          droppedKeys[name] = true;
          Core.log('그래프는 ' + MAX_SERIES + '개까지만 표시합니다. "' + name + '"은(는) 제외했습니다.', 'warn');
        }
        return;
      }
      series[name] = { name: name, color: PALETTE[order.length], points: [] };
      order.push(name);
      buildCharts();
    }

    if (startedAt === null) startedAt = Date.now();

    var s = series[name];
    s.points.push({ t: Date.now() - startedAt, v: value });
    if (s.points.length > 2000) s.points.shift(); // 메모리 상한
  }

  // ---------------------------------------------------------------- 차트
  /**
   * 센서마다 값의 범위가 달라(조도 0~255, 온도 0~50) 한 축에 겹쳐 그리면
   * 작은 값이 납작해진다. 그래서 계열마다 작은 그래프를 따로 만든다.
   */
  function buildCharts() {
    var wrap = $('charts');
    wrap.innerHTML = '';

    if (!order.length) {
      wrap.innerHTML = '<p class="charts__empty">아직 받은 데이터가 없습니다.</p>';
      return;
    }

    order.forEach(function (name) {
      var s = series[name];

      var block = document.createElement('div');
      block.className = 'chart';

      var head = document.createElement('div');
      head.className = 'chart__head';
      head.innerHTML =
        '<span class="chart__swatch"></span>' +
        '<span class="chart__name"></span>' +
        '<span class="chart__value" data-value></span>';
      head.querySelector('.chart__swatch').style.background = s.color;
      head.querySelector('.chart__name').textContent = name;

      var canvas = document.createElement('canvas');
      canvas.className = 'chart__canvas';
      canvas.height = 132;

      block.appendChild(head);
      block.appendChild(canvas);
      wrap.appendChild(block);

      s.canvas = canvas;
      s.valueEl = head.querySelector('[data-value]');

      canvas.addEventListener('mousemove', function (e) {
        var rect = canvas.getBoundingClientRect();
        hoverIndex = pickIndex(s, (e.clientX - rect.left) / rect.width);
      });
      canvas.addEventListener('mouseleave', function () { hoverIndex = null; });
    });
  }

  /** 마우스의 가로 위치(0~1)를 표시 구간 안의 표본 번호로 바꾼다 */
  function pickIndex(s, ratio) {
    var visible = Math.min(windowSize, s.points.length);
    if (!visible) return null;
    return Math.max(0, Math.min(visible - 1, Math.round(ratio * (visible - 1))));
  }

  function drawAll() {
    requestAnimationFrame(drawAll);
    order.forEach(function (name) { drawChart(series[name]); });
  }

  function drawChart(s) {
    var canvas = s.canvas;
    if (!canvas) return;

    // 캔버스를 표시 크기에 맞춰 선명하게 그린다
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 300;
    if (canvas.width !== Math.round(cssW * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(132 * dpr);
    }

    var ctx = canvas.getContext('2d');
    var W = cssW;
    var H = 132;
    var padL = 42, padR = 12, padT = 10, padB = 20;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var pts = s.points.slice(-windowSize);
    if (s.valueEl) {
      s.valueEl.textContent = pts.length ? formatValue(pts[pts.length - 1].v) : '—';
    }
    if (pts.length < 1) return;

    var min = Infinity, max = -Infinity;
    pts.forEach(function (p) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    });
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.12;
    min -= pad; max += pad;

    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var xAt = function (i) { return padL + (pts.length === 1 ? plotW / 2 : i / (pts.length - 1) * plotW); };
    var yAt = function (v) { return padT + plotH - (v - min) / (max - min) * plotH; };

    // 격자와 축은 배경으로 물러나게 (연한 회색 1px)
    ctx.strokeStyle = 'rgba(21, 21, 21, 0.14)';
    ctx.lineWidth = 1;
    ctx.font = '500 10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(21, 21, 21, 0.55)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    [0, 0.5, 1].forEach(function (f) {
      var v = min + (max - min) * (1 - f);
      var y = padT + plotH * f;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.fillText(formatValue(v), padL - 6, y);
    });

    // 데이터 선 — 2px, 계열 색
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var x = xAt(i), y = yAt(p.v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 마지막 값에 표식 (지름 9px, 표면색 링으로 분리)
    var lastX = xAt(pts.length - 1);
    var lastY = yAt(pts[pts.length - 1].v);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    // 마우스를 올린 지점 — 세로선 + 값
    if (hoverIndex !== null && hoverIndex < pts.length) {
      var hx = xAt(hoverIndex);
      var hp = pts[hoverIndex];
      ctx.strokeStyle = 'rgba(21, 21, 21, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(hx, yAt(hp.v), 4, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = s.color;
      ctx.stroke();

      var label = formatValue(hp.v) + '  ' + (hp.t / 1000).toFixed(1) + 's';
      ctx.font = '700 11px ui-monospace, monospace';
      var tw = ctx.measureText(label).width + 10;
      var tx = Math.min(W - padR - tw, Math.max(padL, hx - tw / 2));
      ctx.fillStyle = '#151515';
      ctx.fillRect(tx, padT, tw, 17);
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      ctx.fillText(label, tx + 5, padT + 9);
    }

    // 가로축 시간 범위
    ctx.font = '500 10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(21, 21, 21, 0.55)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText((pts[0].t / 1000).toFixed(1) + 's', padL, H - padB + 4);
    ctx.textAlign = 'right';
    ctx.fillText((pts[pts.length - 1].t / 1000).toFixed(1) + 's', W - padR, H - padB + 4);
  }

  function formatValue(v) {
    return Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  }

  // ---------------------------------------------------------------- 표로 보기
  function renderTable() {
    var wrap = $('tableWrap');
    if (wrap.hidden) return;

    // 계열이 하나도 없으면 머리글만 남은 빈 표가 보이므로 아예 비운다
    if (!order.length) {
      $('dataTable').innerHTML = '';
      return;
    }

    var rows = [];
    var maxLen = order.reduce(function (n, name) {
      return Math.max(n, series[name].points.length);
    }, 0);
    var from = Math.max(0, maxLen - 30);

    for (var i = maxLen - 1; i >= from; i--) {
      var cells = order.map(function (name) {
        var p = series[name].points[i];
        return p ? formatValue(p.v) : '';
      });
      var anyT = order.map(function (name) {
        var p = series[name].points[i];
        return p ? (p.t / 1000).toFixed(1) : null;
      }).filter(Boolean)[0];
      rows.push('<tr><td>' + (anyT || '') + '</td><td>' + cells.join('</td><td>') + '</td></tr>');
    }

    $('dataTable').innerHTML =
      '<thead><tr><th>시간(s)</th><th>' + order.join('</th><th>') + '</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody>';
  }

  // ---------------------------------------------------------------- CSV
  function exportCsv() {
    if (!order.length) { Core.log('내보낼 데이터가 없습니다.', 'warn'); return; }

    var maxLen = order.reduce(function (n, name) {
      return Math.max(n, series[name].points.length);
    }, 0);

    var lines = ['시간(초),' + order.join(',')];
    for (var i = 0; i < maxLen; i++) {
      var t = null;
      var cells = order.map(function (name) {
        var p = series[name].points[i];
        if (p && t === null) t = (p.t / 1000).toFixed(3);
        return p ? p.v : '';
      });
      lines.push((t === null ? '' : t) + ',' + cells.join(','));
    }

    // 엑셀에서 한글 머리글이 깨지지 않도록 BOM을 붙인다
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'microbit-data.csv';
    a.click();
    URL.revokeObjectURL(url);
    Core.log('CSV로 내보냈습니다. (' + maxLen + '줄, 계열 ' + order.length + '개)', 'info');
  }

  function clearData() {
    series = {};
    order = [];
    droppedKeys = {};
    startedAt = null;
    hoverIndex = null;
    buildCharts();
    renderTable();
    updateCounts();
    Core.log('받은 데이터를 모두 지웠습니다.', 'info');
  }

  function updateCounts() {
    var total = order.reduce(function (n, name) { return n + series[name].points.length; }, 0);
    Core.setStatus($('dataStatus'),
      order.length ? ('계열 ' + order.length + '개 / 표본 ' + total + '개') : '데이터 대기 중',
      order.length ? 'ok' : 'idle');
  }

  // ---------------------------------------------------------------- 연습 데이터
  /** micro:bit 없이 동작을 확인할 수 있게 가짜 센서값을 만들어 넣는다 */
  function toggleDemo() {
    if (demoTimer) {
      clearInterval(demoTimer);
      demoTimer = null;
      $('btnDemo').textContent = '연습 데이터 시작';
      $('btnDemo').setAttribute('aria-pressed', 'false');
      Core.log('연습 데이터를 멈췄습니다.', 'info');
      return;
    }

    var tick = 0;
    demoTimer = setInterval(function () {
      tick++;
      var light = Math.round(128 + 100 * Math.sin(tick / 12));
      var temp = (24 + 3 * Math.sin(tick / 40)).toFixed(1);
      handleLine('light=' + light + ',temp=' + temp);
    }, 200);

    $('btnDemo').textContent = '연습 데이터 정지';
    $('btnDemo').setAttribute('aria-pressed', 'true');
    Core.log('연습 데이터를 시작했습니다. (light, temp)', 'info');
  }

  // ---------------------------------------------------------------- 수신
  function handleLine(text) {
    if (paused) return;

    var values = parseLine(text);
    if (!values.length) {
      Core.log('micro:bit  ->  ' + text + '  (숫자를 찾지 못해 그래프에 넣지 않았습니다)', 'warn');
      return;
    }

    values.forEach(function (item) { record(item.name, item.value); });
    updateCounts();
    renderTable();
  }

  // ---------------------------------------------------------------- 배선
  function bindEvents() {
    $('btnConnect').addEventListener('click', function () {
      ble.connect().catch(function () { /* 상태 배지로 안내됨 */ });
    });
    $('btnDisconnect').addEventListener('click', function () { ble.disconnect(); });

    $('btnPause').addEventListener('click', function () {
      paused = !paused;
      this.textContent = paused ? '받기 다시 시작' : '잠시 멈추기';
      this.setAttribute('aria-pressed', String(paused));
      Core.log(paused ? '수신을 잠시 멈췄습니다.' : '수신을 다시 시작합니다.', 'info');
    });

    $('btnDemo').addEventListener('click', toggleDemo);
    $('btnExportCsv').addEventListener('click', exportCsv);
    $('btnClearData').addEventListener('click', clearData);

    $('btnToggleTable').addEventListener('click', function () {
      var wrap = $('tableWrap');
      wrap.hidden = !wrap.hidden;
      this.textContent = wrap.hidden ? '표로 보기' : '표 숨기기';
      renderTable();
    });

    Core.bindSlider('windowSize', 'windowSizeValue',
      function (v) { return v + '개'; },
      function (v) { windowSize = v; Store.save('streamer', 'windowSize', v); });

    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });
  }

  // ---------------------------------------------------------------- 초기화
  function init() {
    Core.mountFooter();
    Core.mountBleHint();
    Core.checkEnvironment();

    var connectedAt = 0;

    ble.on('status', function (s) {
      Core.setStatus($('bleStatus'), s.message,
        s.state === 'connected' ? 'ok' :
          s.state === 'error' ? 'error' :
            s.state === 'connecting' ? 'busy' : 'idle');
      $('btnConnect').disabled = s.connected || s.state === 'connecting';
      $('btnDisconnect').disabled = !s.connected;
      Core.log(s.message, s.state === 'error' ? 'error' : 'info');

      if (s.state === 'connected') {
        connectedAt = Date.now();
        var hint = $('bleHint');
        if (hint) hint.classList.remove('is-urgent');
      }

      if (s.state === 'error') {
        // 붙자마자 떨어지는 것은 페어링 설정이 꺼져 있을 때의 전형적인 증상
        if (connectedAt && Date.now() - connectedAt < 5000) {
          Core.flagBleHint('연결되자마자 끊어졌습니다. MakeCode <b>프로젝트 설정 → ' +
            'No Pairing Required</b>가 꺼져 있을 때 이렇게 됩니다.');
          Core.log('연결 직후 끊김 — No Pairing Required 설정을 확인해주세요.', 'warn');
        } else if (!connectedAt) {
          Core.flagBleHint('연결에 실패했습니다. micro:bit 전원과 블루투스 프로그램, ' +
            'MakeCode <b>No Pairing Required</b> 설정을 확인해주세요.');
        }
        connectedAt = 0;
      }
    });

    // 이 페이지의 본업: micro:bit가 보낸 줄을 그래프로
    ble.on('line', handleLine);

    bindEvents();

    // 표시 개수만 기억한다. 받은 데이터 자체는 실시간 스트림이라 저장하지 않는다.
    var savedWindow = Store.load('streamer', 'windowSize', null);
    if (savedWindow) {
      windowSize = savedWindow;
      $('windowSize').value = savedWindow;
      $('windowSizeValue').textContent = savedWindow + '개';
    }

    buildCharts();
    updateCounts();
    drawAll();

    Core.log('micro:bit를 연결하면 보내는 값이 그래프로 그려집니다. 기기가 없으면 "연습 데이터"로 확인해보세요.', 'info');
  }

  init();
})();
