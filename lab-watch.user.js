// ==UserScript==
// @name         Lab Watch
// @namespace    supasit.a
// @version      1.1.0
// @description  แจ้งเตือน (toast + เสียง) เมื่อค่า Lab ใหม่ออกในหน้า Routine ของ Lab Report
// @match        https://pttgclaro.pttgcgroup.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Lab Watch - อ่านข้อมูลที่หน้าเว็บโหลดเองอยู่แล้ว (hook XHR/fetch) ไม่แตะ token
// ข้อมูลเก็บใน localStorage ของ Edge เท่านั้น ไม่ส่งออกนอกเครื่อง ไม่เก็บ analystId

(function () {
  'use strict';

  var STATE_KEY = 'labwatch.v1.state';
  var SETTINGS_KEY = 'labwatch.v1.settings';
  var MAX_FEEDS = 30;

  // ---------- CORE (ฟังก์ชันบริสุทธิ์ - เทสต์ด้วย node ได้) ----------

  function isResultsUrl(url) {
    return typeof url === 'string' && url.indexOf('/getReportResults') !== -1;
  }

  // pageId|tableId|YYYY-MM-DD  (แยกตามวัน -> ข้ามวันเริ่ม baseline ใหม่เอง)
  function parseFeedKey(url) {
    var page = /[?&]pageId=([^&]+)/.exec(url || '');
    var table = /[?&]tableId=([^&]+)/.exec(url || '');
    var day = /[?&]dateStart=(\d{4}-\d{2}-\d{2})/.exec(url || '');
    if (!page || !table || !day) return null;
    return page[1] + '|' + table[1] + '|' + day[1];
  }

  // เก็บเฉพาะแถวที่มีค่า และเฉพาะฟิลด์ที่ต้องใช้ (ไม่รวม analystId)
  function extractItems(rows) {
    var out = [];
    if (!Array.isArray(rows)) return out;
    rows.forEach(function (r) {
      if (!r || r.sampleId == null || r.paramId == null) return;
      var value = r.displayValue == null ? '' : String(r.displayValue).trim();
      if (value === '') return;
      out.push({
        key: r.sampleId + '|' + r.paramId,
        paramId: String(r.paramId),
        paramDesc: r.paramDesc ? String(r.paramDesc) : String(r.paramId),
        point: String(r.displaySamplePointId || r.sampleName || r.samplePointId || ''),
        time: r.collectionDate ? String(r.collectionDate).slice(11, 16) : '',
        value: value,
        units: r.displayUnits ? String(r.displayUnits) : '',
        status: String(r.sampleStatus || r.dataSetStatus || ''),
      });
    });
    return out;
  }

  // state = { feeds: { feedKey: { itemKey: value } }, params: { paramId: desc } }
  // feed ที่ยังไม่เคยเห็น = baseline (บันทึกเงียบๆ ไม่แจ้งเตือน)
  function applyFeed(state, feedKey, rows, muted) {
    var mutedList = muted || [];
    var prevSeen = state.feeds[feedKey];
    var isBaseline = prevSeen === undefined;
    var seen = {};
    var params = {};
    var alerts = [];

    if (!isBaseline) Object.keys(prevSeen).forEach(function (k) { seen[k] = prevSeen[k]; });
    Object.keys(state.params).forEach(function (k) { params[k] = state.params[k]; });

    extractItems(rows).forEach(function (it) {
      params[it.paramId] = it.paramDesc;
      var before = seen[it.key];
      seen[it.key] = it.value;
      if (isBaseline) return;
      var isNew = before === undefined;
      var changed = !isNew && before !== it.value;
      if ((isNew || changed) && mutedList.indexOf(it.paramId) === -1) {
        alerts.push({
          kind: isNew ? 'new' : 'changed',
          before: before,
          point: it.point,
          time: it.time,
          paramId: it.paramId,
          paramDesc: it.paramDesc,
          value: it.value,
          units: it.units,
          status: it.status,
        });
      }
    });

    // ย้าย feed ที่เพิ่งอัปเดตไปท้ายสุด แล้วตัดของเก่าเกิน MAX_FEEDS
    var feeds = {};
    Object.keys(state.feeds).forEach(function (k) {
      if (k !== feedKey) feeds[k] = state.feeds[k];
    });
    feeds[feedKey] = seen;
    var keys = Object.keys(feeds);
    while (keys.length > MAX_FEEDS) delete feeds[keys.shift()];

    return { state: { feeds: feeds, params: params }, alerts: alerts };
  }

  function formatAlert(a) {
    var head = [a.point, a.time].filter(Boolean).join(' ');
    var val = a.kind === 'changed' ? a.before + ' → ' + a.value : a.value;
    var unit = a.units ? ' ' + a.units : '';
    var status = a.status ? ' (' + a.status + ')' : '';
    return head + ' · ' + a.paramDesc + ' = ' + val + unit + status;
  }

  // since = เวลาอ้างอิงที่ "ควรจะได้ข้อมูลแล้ว" (ได้ response ล่าสุด / เพิ่งเข้าหน้า routine)
  // stale = เงียบเกิน thresholdMin · shouldWarn = stale และยังไม่เคยเตือน หรือเตือนครั้งก่อนนานเกิน repeatMin
  function staleStatus(nowMs, sinceMs, thresholdMin, lastWarnMs, repeatMin) {
    var minutes = Math.floor((nowMs - sinceMs) / 60000);
    var stale = minutes >= thresholdMin;
    var shouldWarn = stale && (lastWarnMs == null || nowMs - lastWarnMs >= repeatMin * 60000);
    return { stale: stale, minutes: minutes, shouldWarn: shouldWarn };
  }

  // ---------- โหมดเทสต์ (node): export แล้วจบ ไม่แตะ DOM ----------
  if (typeof window === 'undefined') {
    module.exports = {
      staleStatus: staleStatus,
      isResultsUrl: isResultsUrl,
      parseFeedKey: parseFeedKey,
      extractItems: extractItems,
      applyFeed: applyFeed,
      formatAlert: formatAlert,
    };
    return;
  }

  // ---------- BROWSER ----------

  var STALE_MIN = 20;   // ไม่ได้ข้อมูลที่ใช้ได้เกินกี่นาที -> เตือน
  var REPEAT_MIN = 30;  // เตือนซ้ำทุกกี่นาทีจนกว่าจะกลับมาปกติ

  var startedAt = Date.now();
  var routineSince = null; // เวลาที่เข้าหน้า routine ล่าสุด (กันเตือนผิดตอนเพิ่งกลับมาจากหน้าอื่น)
  var warnedAt = null;
  var isStale = false;
  var staleMinutes = 0;
  var lastResponseAt = null;
  var lastRefreshAt = null;
  var audioCtx = null;
  var refreshTimer = null;
  var panelApi = null;

  function loadJson(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* เต็ม/ถูกบล็อก - ข้ามไป */
    }
  }
  function loadState() {
    var s = loadJson(STATE_KEY, null);
    if (!s || typeof s.feeds !== 'object' || typeof s.params !== 'object') return { feeds: {}, params: {} };
    return s;
  }
  function loadSettings() {
    var s = loadJson(SETTINGS_KEY, {});
    return {
      muted: Array.isArray(s.muted) ? s.muted : [],
      intervalMin: [1, 2, 5, 10].indexOf(s.intervalMin) !== -1 ? s.intervalMin : 5,
      sound: s.sound !== false,
    };
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmmss(d) { return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) : '-'; }

  // เสียง: AudioContext ต้องถูกปลดล็อกด้วยการคลิกของผู้ใช้อย่างน้อย 1 ครั้ง
  function unlockAudio() {
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx && C) audioCtx = new C();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* ไม่มีเสียงก็ยังมี toast */ }
  }
  function beep() {
    try {
      unlockAudio();
      if (!audioCtx) return;
      [880, 1175, 880].forEach(function (freq, i) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.15;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        var t = audioCtx.currentTime + i * 0.25;
        osc.start(t);
        osc.stop(t + 0.18);
      });
    } catch (e) { /* ignore */ }
  }

  function toast(title, body) {
    try {
      if (window.Notification && Notification.permission === 'granted') {
        var n = new Notification(title, { body: body, tag: 'labwatch', renotify: true });
        n.onclick = function () { window.focus(); n.close(); };
      }
    } catch (e) { /* ignore */ }
  }

  function notify(alerts) {
    var lines = alerts.slice(0, 6).map(formatAlert);
    if (alerts.length > 6) lines.push('… และอีก ' + (alerts.length - 6) + ' รายการ');
    toast('Lab: มีค่าใหม่ ' + alerts.length + ' รายการ', lines.join('\n'));
    if (loadSettings().sound) beep();
    if (document.title.indexOf('🔔') !== 0) document.title = '🔔 ' + document.title;
  }

  function onResults(url, body) {
    var feedKey = parseFeedKey(url);
    if (!feedKey) return;
    var rows = body;
    if (typeof body === 'string') rows = JSON.parse(body);
    // error/401 ไม่ใช่ array -> ไม่นับว่าได้ข้อมูล (ไม่งั้นจะไม่เตือนตอน session หลุด)
    if (!Array.isArray(rows)) return;
    var result = applyFeed(loadState(), feedKey, rows, loadSettings().muted);
    saveJson(STATE_KEY, result.state);
    lastResponseAt = new Date();
    if (warnedAt !== null) {
      toast('Lab Watch: กลับมาได้รับข้อมูลแล้ว', 'ระบบเฝ้ากลับมาทำงานปกติ');
      warnedAt = null;
    }
    isStale = false;
    staleMinutes = 0;
    if (result.alerts.length) notify(result.alerts);
    if (panelApi) panelApi.render();
  }

  // เช็คสุขภาพทุก 1 นาที: เงียบเกิน STALE_MIN -> เตือน (เฉพาะตอนอยู่หน้า routine)
  function checkHealth() {
    var now = Date.now();
    if (location.hash.indexOf('#/routine') !== 0) {
      routineSince = null;
      if (isStale) { isStale = false; if (panelApi) panelApi.render(); }
      return;
    }
    if (routineSince === null) routineSince = now;
    var since = Math.max(startedAt, routineSince, lastResponseAt ? lastResponseAt.getTime() : 0);
    var st = staleStatus(now, since, STALE_MIN, warnedAt, REPEAT_MIN);
    var changed = st.stale !== isStale || (st.stale && st.minutes !== staleMinutes);
    isStale = st.stale;
    staleMinutes = st.minutes;
    if (st.shouldWarn) {
      warnedAt = now;
      toast('⚠ Lab Watch: ไม่ได้ข้อมูลมา ' + st.minutes + ' นาที',
        'session อาจหลุด หรือแท็บถูกแช่แข็ง - เปิดหน้าเว็บแล้วกด OK / ล็อกอินใหม่');
      if (loadSettings().sound) beep();
    }
    if (changed && panelApi) panelApi.render();
  }

  // hook XHR (หน้าเว็บเรียกผ่าน xhr) + fetch เผื่อกรณีอื่น
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__lwUrl = String(url); } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (isResultsUrl(xhr.__lwUrl)) {
      xhr.addEventListener('load', function () {
        try {
          var type = xhr.responseType;
          var body = type === '' || type === 'text' ? xhr.responseText : type === 'json' ? xhr.response : null;
          if (body != null) onResults(xhr.__lwUrl, body);
        } catch (e) { /* ข้อมูลไม่ตรงรูปแบบ - ข้าม */ }
      });
    }
    return origSend.apply(this, arguments);
  };
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : input && input.url;
        if (isResultsUrl(url)) {
          p.then(function (res) { return res.clone().text(); })
            .then(function (text) { onResults(url, text); })
            .catch(function () { /* ignore */ });
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // ---------- auto-refresh ----------
  function refreshNow() {
    if (location.hash.indexOf('#/routine') !== 0) return;
    lastRefreshAt = new Date();
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].textContent.trim() === 'OK') {
        buttons[i].click();
        if (panelApi) panelApi.render();
        return;
      }
    }
    location.reload();
  }
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshNow();
      scheduleRefresh();
    }, loadSettings().intervalMin * 60000);
  }

  // ---------- panel (textContent ล้วน ไม่ใช้ innerHTML) ----------
  function make(tag, text, css) {
    var e = document.createElement(tag);
    if (text) e.textContent = text;
    if (css) e.style.cssText = css;
    return e;
  }

  function buildPanel() {
    var box = make('div', '', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:250px;' +
      'background:#fff;color:#1a2233;border:1px solid #c9d3e3;border-radius:13px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.18);font:12px/1.5 "Noto Sans Thai",Arial,sans-serif;');
    var head = make('div', '', 'display:flex;align-items:center;justify-content:space-between;' +
      'padding:6px 10px;background:#1D4ED8;color:#fff;border-radius:12px 12px 0 0;cursor:pointer;');
    head.appendChild(make('b', 'Lab Watch'));
    var toggle = make('span', '–');
    head.appendChild(toggle);
    var bodyEl = make('div', '', 'padding:8px 10px;');
    box.appendChild(head);
    box.appendChild(bodyEl);

    var collapsed = false;
    head.addEventListener('click', function () {
      collapsed = !collapsed;
      bodyEl.style.display = collapsed ? 'none' : 'block';
      toggle.textContent = collapsed ? '+' : '–';
    });

    function btn(label, onClick) {
      var b = make('button', label, 'margin:2px 4px 2px 0;padding:6px 10px;min-height:32px;border:1px solid #1D4ED8;' +
        'background:#fff;color:#1D4ED8;border-radius:999px;cursor:pointer;font:inherit;');
      b.addEventListener('click', function () { unlockAudio(); onClick(); });
      return b;
    }

    function render() {
      var settings = loadSettings();
      var state = loadState();
      bodyEl.textContent = '';

      var perm = window.Notification ? Notification.permission : 'unsupported';
      var permText = perm === 'granted' ? 'อนุญาตแล้ว' : perm === 'denied' ? 'ถูกบล็อก (แก้ที่ไอคอนแม่กุญแจ)' : 'ยังไม่อนุญาต';
      if (isStale) {
        bodyEl.appendChild(make('div', '⚠ ไม่ได้ข้อมูลมา ' + staleMinutes + ' นาที (session อาจหลุด)',
          'background:#fde8e8;color:#b00020;font-weight:600;padding:4px 6px;border-radius:6px;margin-bottom:4px;'));
      }
      bodyEl.appendChild(make('div', 'ข้อมูลล่าสุด: ' + hhmmss(lastResponseAt)));
      bodyEl.appendChild(make('div', 'รีเฟรชล่าสุด: ' + hhmmss(lastRefreshAt)));
      bodyEl.appendChild(make('div', 'แจ้งเตือน: ' + permText));

      var row = make('div', '', 'margin:6px 0;');
      if (perm !== 'granted' && window.Notification) {
        row.appendChild(btn('เปิดแจ้งเตือน', function () {
          Notification.requestPermission().then(render);
        }));
      }
      row.appendChild(btn('ทดสอบ', function () {
        toast('Lab Watch ทดสอบ', 'ถ้าเห็นข้อความนี้ = toast ใช้งานได้');
        if (settings.sound) beep();
      }));
      bodyEl.appendChild(row);

      var soundLabel = make('label', '', 'display:block;margin:4px 0;');
      var soundBox = document.createElement('input');
      soundBox.type = 'checkbox';
      soundBox.checked = settings.sound;
      soundBox.addEventListener('change', function () {
        settings.sound = soundBox.checked;
        saveJson(SETTINGS_KEY, settings);
      });
      soundLabel.appendChild(soundBox);
      soundLabel.appendChild(document.createTextNode(' เสียงเตือน'));
      bodyEl.appendChild(soundLabel);

      var intervalRow = make('div', 'รีเฟรชทุก ', 'margin:4px 0;');
      var sel = document.createElement('select');
      [1, 2, 5, 10].forEach(function (m) {
        var o = document.createElement('option');
        o.value = String(m);
        o.textContent = m + ' นาที';
        if (m === settings.intervalMin) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        settings.intervalMin = Number(sel.value);
        saveJson(SETTINGS_KEY, settings);
        scheduleRefresh();
      });
      intervalRow.appendChild(sel);
      bodyEl.appendChild(intervalRow);

      var ids = Object.keys(state.params).sort();
      bodyEl.appendChild(make('div', 'Parameter ที่เฝ้า (ติ๊กออก = ไม่แจ้ง):', 'margin-top:6px;font-weight:600;'));
      if (!ids.length) {
        bodyEl.appendChild(make('div', 'ยังไม่เห็นข้อมูล - กด OK ในหน้าเว็บ 1 ครั้ง', 'color:#8A6410;'));
      }
      var list = make('div', '', 'max-height:140px;overflow:auto;');
      ids.forEach(function (id) {
        var lab = make('label', '', 'display:block;');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = settings.muted.indexOf(id) === -1;
        cb.addEventListener('change', function () {
          var s = loadSettings();
          s.muted = s.muted.filter(function (m) { return m !== id; });
          if (!cb.checked) s.muted.push(id);
          saveJson(SETTINGS_KEY, s);
        });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' ' + state.params[id]));
        list.appendChild(lab);
      });
      bodyEl.appendChild(list);

      bodyEl.appendChild(btn('ล้างความจำ', function () {
        try { window.localStorage.removeItem(STATE_KEY); } catch (e) { /* ignore */ }
        render();
      }));
    }

    document.body.appendChild(box);
    return { render: render };
  }

  function start() {
    try {
      panelApi = buildPanel();
      panelApi.render();
    } catch (e) { /* panel พังก็ยัง hook ต่อได้ */ }
    scheduleRefresh();
    setInterval(checkHealth, 60000);
    window.addEventListener('focus', function () {
      document.title = document.title.replace(/^🔔 /, '');
    });
    document.addEventListener('click', unlockAudio, { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
