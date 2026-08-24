/**
 * voice.js
 * Web Speech API로 말을 인식해, 등록한 단어에 맞는 명령을 micro:bit로 보낸다.
 */
(function () {
  'use strict';

  var $ = Core.$;

  var ble = new MicrobitBLE();
  var tx = new Core.Transmitter(ble);

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var listening = false;

  var words = [];          // [{word, command, enabled}]
  var lastFiredAt = {};    // command -> timestamp (같은 명령 재전송 억제)

  var settings = {
    lang: 'ko-KR',
    matchMode: 'include',
    cooldown: 1000,
    autoRestart: true
  };

  var PAGE = 'voice';

  // ---------------------------------------------------------------- 저장 / 불러오기
  function saveWords() {
    Store.save(PAGE, 'words', words);
    Core.markSaved();
  }

  function saveSettings() {
    Store.save(PAGE, 'settings', settings);
  }

  function restoreAll() {
    if (!Store.isAvailable()) { Core.markStorageUnavailable(); return; }

    var st = Store.load(PAGE, 'settings', null);
    if (st) {
      settings.lang = st.lang || settings.lang;
      settings.matchMode = st.matchMode || settings.matchMode;
      settings.cooldown = typeof st.cooldown === 'number' ? st.cooldown : settings.cooldown;
      settings.autoRestart = st.autoRestart !== false;

      $('langSelect').value = settings.lang;
      $('matchMode').value = settings.matchMode;
      $('cooldown').value = settings.cooldown;
      $('cooldownValue').textContent = settings.cooldown + 'ms';
      $('chkAutoRestart').checked = settings.autoRestart;
    }

    var saved = Store.load(PAGE, 'words', null);
    if (Array.isArray(saved) && saved.length) {
      words = saved.filter(function (w) { return w && w.word && w.command; });
      renderWords();
      Core.log('지난번 명령어 ' + words.length + '개를 불러왔습니다.', 'info');
    }
  }

  function clearSaved() {
    Store.clearPage(PAGE);
    words = [];
    renderWords();
    Core.setStatus($('saveStatus'), '자동 저장 켜짐', 'idle');
    Core.log('저장된 명령어를 모두 지웠습니다.', 'info');
  }

  var PRESET = [
    { word: '앞으로', command: 'forward' },
    { word: '멈춰', command: 'stop' },
    { word: '왼쪽', command: 'left' },
    { word: '오른쪽', command: 'right' }
  ];

  // ---------------------------------------------------------------- 단어 표
  function renderWords() {
    var body = $('wordBody');
    body.innerHTML = '';

    words.forEach(function (item, index) {
      var tr = document.createElement('tr');

      var tdOn = document.createElement('td');
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = item.enabled;
      chk.setAttribute('aria-label', item.word + ' 사용');
      chk.addEventListener('change', function () {
        item.enabled = chk.checked;
        saveWords();
      });
      tdOn.appendChild(chk);

      var tdWord = document.createElement('td');
      tdWord.className = 'mapping__class';
      var wordInput = document.createElement('input');
      wordInput.type = 'text';
      wordInput.value = item.word;
      wordInput.setAttribute('aria-label', '들을 말');
      wordInput.addEventListener('input', function () {
        item.word = wordInput.value.trim();
        saveWords();
      });
      tdWord.appendChild(wordInput);

      var tdCmd = document.createElement('td');
      var cmdInput = document.createElement('input');
      cmdInput.type = 'text';
      cmdInput.value = item.command;
      cmdInput.maxLength = 18;
      cmdInput.setAttribute('aria-label', '보낼 명령');
      cmdInput.addEventListener('input', function () {
        item.command = cmdInput.value.trim();
        saveWords();
      });
      tdCmd.appendChild(cmdInput);

      var tdTest = document.createElement('td');
      var testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn btn--ghost btn--sm';
      testBtn.textContent = '테스트';
      testBtn.addEventListener('click', function () {
        if (!item.command) { Core.log('명령이 비어 있습니다.', 'error'); return; }
        tx.send(item.command, '테스트');
      });
      tdTest.appendChild(testBtn);

      var tdDel = document.createElement('td');
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn--ghost btn--sm';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', function () {
        words.splice(index, 1);
        renderWords();
        saveWords();
      });
      tdDel.appendChild(delBtn);

      tr.appendChild(tdOn);
      tr.appendChild(tdWord);
      tr.appendChild(tdCmd);
      tr.appendChild(tdTest);
      tr.appendChild(tdDel);
      body.appendChild(tr);
    });
  }

  function addWord(word, command) {
    word = String(word || '').trim();
    command = String(command || '').trim();
    if (!word || !command) {
      Core.log('말과 명령을 모두 입력해주세요.', 'error');
      return false;
    }
    if (!/^[\x20-\x7E]+$/.test(command)) {
      Core.log('명령은 영문·숫자로 지어주세요. 한글은 micro:bit에서 깨집니다.', 'warn');
      return false;
    }
    words.push({ word: word, command: command, enabled: true });
    renderWords();
    saveWords();
    return true;
  }

  // ---------------------------------------------------------------- 매칭
  /** 비교를 위해 공백을 없애고 소문자로 만든다 */
  function normalize(text) {
    return String(text).toLowerCase().replace(/\s+/g, '');
  }

  /**
   * 인식된 문장에 맞는 항목을 찾는다.
   * 여러 개가 걸리면 가장 긴(구체적인) 말을 고른다.
   */
  function findMatch(transcript) {
    var heard = normalize(transcript);
    var best = null;

    words.forEach(function (item) {
      if (!item.enabled || !item.word || !item.command) return;
      var target = normalize(item.word);
      if (!target) return;

      var hit = settings.matchMode === 'exact'
        ? heard === target
        : heard.indexOf(target) !== -1;

      if (hit && (!best || target.length > normalize(best.word).length)) best = item;
    });

    return best;
  }

  function handleTranscript(transcript) {
    $('heard').textContent = transcript;

    var match = findMatch(transcript);
    if (!match) {
      addHit(transcript, null);
      return;
    }

    var now = Date.now();
    if (now - (lastFiredAt[match.command] || 0) < settings.cooldown) {
      addHit(transcript, match.command + ' (대기 중)');
      return;
    }

    lastFiredAt[match.command] = now;
    addHit(transcript, match.command);
    tx.send(match.command, match.word);
  }

  /** 최근 인식 결과를 왼쪽 패널에 쌓는다 */
  function addHit(transcript, command) {
    var box = $('voiceHits');
    var row = document.createElement('div');
    row.className = 'voice-hit' + (command ? ' is-matched' : '');

    var text = document.createElement('span');
    text.className = 'voice-hit__text';
    text.textContent = transcript;

    var tag = document.createElement('span');
    tag.className = 'voice-hit__tag';
    tag.textContent = command || '해당 없음';

    row.appendChild(text);
    row.appendChild(tag);
    box.insertBefore(row, box.firstChild);
    while (box.children.length > 8) box.removeChild(box.lastChild);
  }

  // ---------------------------------------------------------------- 음성 인식
  function createRecognition() {
    var r = new SR();
    r.lang = settings.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = function (event) {
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var result = event.results[i];
        if (result.isFinal) {
          handleTranscript(result[0].transcript.trim());
        } else {
          interim += result[0].transcript;
        }
      }
      $('interim').textContent = interim;
    };

    r.onerror = function (event) {
      // no-speech는 조용할 때 흔히 발생하므로 오류로 취급하지 않는다
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      var fatal = event.error === 'not-allowed' || event.error === 'service-not-allowed';
      var message = fatal
        ? '마이크 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 허용해주세요.'
        : event.error === 'network'
          ? '음성인식 서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.'
          : '음성인식 오류: ' + event.error;

      Core.setStatus($('micStatus'), message, 'error');
      Core.log(message, 'error');

      if (fatal) stopListening(true);
    };

    r.onend = function () {
      // 브라우저가 조용할 때 스스로 멈추므로 다시 켜준다
      if (listening && settings.autoRestart) {
        try { r.start(); } catch (e) { /* 이미 시작된 상태면 무시 */ }
      } else if (listening) {
        stopListening();
      }
    };

    return r;
  }

  function startListening() {
    if (!SR) return;
    if (listening) return;

    listening = true;
    recognition = createRecognition();

    try {
      recognition.start();
    } catch (error) {
      listening = false;
      Core.setStatus($('micStatus'), '마이크를 켤 수 없습니다: ' + error.message, 'error');
      return;
    }

    $('btnListen').disabled = true;
    $('btnStopListen').disabled = false;
    $('micIndicator').classList.add('is-live');
    Core.setStatus($('micStatus'), '듣고 있습니다', 'ok');
    Core.log('음성인식을 시작합니다. (' + settings.lang + ')', 'info');
  }

  function stopListening(silent) {
    if (!listening) return;
    listening = false;

    if (recognition) {
      try { recognition.stop(); } catch (e) { /* 이미 멈춘 상태면 무시 */ }
      recognition = null;
    }

    $('btnListen').disabled = false;
    $('btnStopListen').disabled = true;
    $('micIndicator').classList.remove('is-live');
    $('interim').textContent = '';

    if (!silent) {
      Core.setStatus($('micStatus'), '대기 중', 'idle');
      Core.log('음성인식을 중지합니다.', 'info');
    }
  }

  // ---------------------------------------------------------------- CSV
  function exportCsv() {
    if (!words.length) { Core.log('내보낼 명령어가 없습니다.', 'warn'); return; }

    var lines = ['말,명령'];
    words.forEach(function (w) {
      lines.push('"' + w.word.replace(/"/g, '""') + '","' + w.command.replace(/"/g, '""') + '"');
    });

    // 엑셀에서 한글이 깨지지 않도록 BOM을 붙인다
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'voice-commands.csv';
    a.click();
    URL.revokeObjectURL(url);
    Core.log('CSV로 내보냈습니다. (' + words.length + '개)', 'info');
  }

  function importCsv(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result).replace(/^﻿/, '');
      var rows = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      var added = 0;

      rows.forEach(function (line, i) {
        var cells = parseCsvLine(line);
        if (cells.length < 2) return;
        // 첫 줄이 머리글이면 건너뛴다
        if (i === 0 && /^(말|word|단어)$/i.test(cells[0].trim())) return;
        if (addWord(cells[0], cells[1])) added++;
      });

      Core.log(added ? ('CSV에서 ' + added + '개를 불러왔습니다.') : 'CSV에서 불러올 항목이 없습니다.',
        added ? 'info' : 'warn');
    };
    reader.onerror = function () { Core.log('CSV를 읽을 수 없습니다.', 'error'); };
    reader.readAsText(file, 'utf-8');
  }

  /** 따옴표로 감싼 값을 포함한 CSV 한 줄을 자른다 */
  function parseCsvLine(line) {
    var cells = [];
    var cur = '';
    var inQuotes = false;

    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cells.push(cur); cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  }

  // ---------------------------------------------------------------- 초기화
  function bindEvents() {
    $('btnListen').addEventListener('click', startListening);
    $('btnStopListen').addEventListener('click', function () { stopListening(); });

    $('langSelect').addEventListener('change', function () {
      settings.lang = this.value;
      saveSettings();
      if (listening) { stopListening(true); startListening(); }
    });

    $('matchMode').addEventListener('change', function () { settings.matchMode = this.value; saveSettings(); });
    $('chkAutoRestart').addEventListener('change', function () { settings.autoRestart = this.checked; saveSettings(); });

    Core.bindSlider('cooldown', 'cooldownValue',
      function (v) { return v + 'ms'; },
      function (v) { settings.cooldown = v; saveSettings(); });

    $('btnAddWord').addEventListener('click', function () {
      if (addWord($('newWord').value, $('newCommand').value)) {
        $('newWord').value = '';
        $('newCommand').value = '';
        $('newWord').focus();
      }
    });

    [$('newWord'), $('newCommand')].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') $('btnAddWord').click();
      });
    });

    $('btnPreset').addEventListener('click', function () {
      PRESET.forEach(function (p) { addWord(p.word, p.command); });
    });

    $('btnExportCsv').addEventListener('click', exportCsv);
    $('btnImportCsv').addEventListener('click', function () { $('csvFile').click(); });
    $('csvFile').addEventListener('change', function () {
      if (this.files[0]) importCsv(this.files[0]);
      this.value = '';
    });

    $('btnClearSaved').addEventListener('click', function () {
      if (confirm('저장된 명령어를 모두 지웁니다. 계속할까요?')) clearSaved();
    });

    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });
  }

  function init() {
    Core.mountFooter();

    new Core.BleController(ble, tx, {
      onDrop: function () { /* 음성인식은 연결이 끊겨도 계속 들을 수 있게 둔다 */ }
    });

    restoreAll();
    bindEvents();

    if (!SR) {
      Core.setStatus($('micStatus'), '이 브라우저는 음성인식을 지원하지 않습니다', 'error');
      $('btnListen').disabled = true;
      $('heard').textContent = 'Chrome 또는 Edge에서 열어주세요';
      Core.log('Web Speech API를 지원하지 않는 브라우저입니다. Chrome 또는 Edge를 사용해주세요.', 'error');
    } else {
      Core.log('준비 완료. 명령어를 등록하고 마이크를 켜세요.', 'info');
    }
  }

  init();
})();
