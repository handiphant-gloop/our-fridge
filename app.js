/* ============================================================
   우리집 냉장고 — app.js
   화면 렌더링 · 식재료/보관함/장보기 관리 · 설정 · 가족 공유 동기화
   ============================================================ */
(function (global) {
  'use strict';

  var FU = global.FU;
  var INT = global.Integrations;

  var LS_DATA = 'fridge.v1.data';
  var LS_SET = 'fridge.v1.settings';
  var LS_OUT = 'fridge.v1.outbox';
  var LS_SYNC = 'fridge.v1.lastSync';
  var LS_MIG = 'fridge.v1.migrated';

  var UNITS = ['개', 'g', 'kg', '팩', '봉', '병', '모', '단', '장', '판', '통', '캔', '컵', 'ml', 'L', '송이'];
  var SPACE_ICONS = ['🧊', '❄️', '🥬', '🌡️', '📦', '🧺', '🍎', '🥫', '🍶', '🧴'];

  var state = {
    storages: [],
    items: [],
    shopping: [],
    view: 'fridge',
    spaceFilter: 'all',
    quickFilter: 'all',
    sort: 'expiry',
    search: '',
    settings: { geminiKey: '', sbUrl: '', sbKey: '', sbCode: '' },
    cloud: { enabled: false, status: 'local', message: '', lastSync: 0, busy: false },
    receipt: { image: null, rows: [], text: '', status: null, log: '' },
    sheetMode: 'direct',
    deferredPrompt: null
  };

  var cloudTimer = null;
  var pollTimer = null;
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  /* ============================================================
     저장 (localStorage)
     ============================================================ */
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SET) || '{}') || {}; } catch (e) { s = {}; }
    state.settings = {
      geminiKey: s.geminiKey || '',
      sbUrl: s.sbUrl || '',
      sbKey: s.sbKey || '',
      sbCode: s.sbCode || ''
    };
    state.cloud.lastSync = Number(localStorage.getItem(LS_SYNC) || 0) || 0;
    if (state.settings.sbUrl && state.settings.sbKey && state.settings.sbCode) {
      state.cloud.enabled = true;
      state.cloud.status = 'online';
    }
  }

  function saveSettings() {
    try { localStorage.setItem(LS_SET, JSON.stringify(state.settings)); } catch (e) { /* noop */ }
  }

  function defaultStorages() {
    var t = FU.nowIso();
    return [
      { id: 'sp_fridge', name: '냉장실', icon: '🧊', sortOrder: 1, createdAt: t, updatedAt: t },
      { id: 'sp_freezer', name: '냉동실', icon: '❄️', sortOrder: 2, createdAt: t, updatedAt: t },
      { id: 'sp_kimchi', name: '김치냉장고', icon: '🥬', sortOrder: 3, createdAt: t, updatedAt: t },
      { id: 'sp_pantry', name: '실온', icon: '🌡️', sortOrder: 4, createdAt: t, updatedAt: t }
    ];
  }

  function loadLocal() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(LS_DATA) || 'null'); } catch (e) { d = null; }
    if (d && Array.isArray(d.storages)) {
      state.storages = d.storages;
      state.items = Array.isArray(d.items) ? d.items : [];
      state.shopping = Array.isArray(d.shopping) ? d.shopping : [];
    } else {
      state.storages = defaultStorages();
      state.items = [];
      state.shopping = [];
    }
    if (!state.storages.length) { state.storages = defaultStorages(); }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS_DATA, JSON.stringify({
        storages: state.storages,
        items: state.items,
        shopping: state.shopping
      }));
    } catch (e) { /* noop */ }
  }

  /* ============================================================
     helpers
     ============================================================ */
  function spaceById(id) {
    for (var i = 0; i < state.storages.length; i++) {
      if (state.storages[i].id === id) { return state.storages[i]; }
    }
    return null;
  }

  function sortedStorages() {
    return state.storages.slice().sort(function (a, b) {
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  }

  function resolveSpaceId(name) {
    if (!name) { return state.storages[0] ? state.storages[0].id : ''; }
    var exact = null, partial = null;
    for (var i = 0; i < state.storages.length; i++) {
      var s = state.storages[i];
      if (s.name === name) { exact = s; }
      else if (!partial && (s.name.indexOf(name) >= 0 || name.indexOf(s.name) >= 0)) { partial = s; }
    }
    if (exact) { return exact.id; }
    if (partial) { return partial.id; }
    var fridge = state.storages.filter(function (s) { return s.name.indexOf('냉장') >= 0; })[0];
    return fridge ? fridge.id : (state.storages[0] ? state.storages[0].id : '');
  }

  function itemById(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { return state.items[i]; }
    }
    return null;
  }

  function shoppingById(id) {
    for (var i = 0; i < state.shopping.length; i++) {
      if (state.shopping[i].id === id) { return state.shopping[i]; }
    }
    return null;
  }

  function ddayInfo(expiry) {
    var d = FU.daysLeft(expiry);
    if (d === null) { return { cls: 'none', label: '기한 없음', days: null }; }
    if (d < 0) { return { cls: 'danger', label: 'D+' + (-d), days: d }; }
    if (d === 0) { return { cls: 'warn', label: '오늘까지', days: 0 }; }
    if (d <= 3) { return { cls: 'warn', label: 'D-' + d, days: d }; }
    return { cls: 'ok', label: 'D-' + d, days: d };
  }

  function foodDefaults(name) {
    var f = INT.findFood(name);
    if (!f) { return { unit: '개', spaceName: '냉장실', days: 7 }; }
    return { unit: f.unit, spaceName: f.space, days: f.days };
  }

  function timeAgo(ts) {
    if (!ts) { return '아직 없음'; }
    var diff = Math.max(0, Date.now() - ts);
    var m = Math.floor(diff / 60000);
    if (m < 1) { return '방금 전'; }
    if (m < 60) { return m + '분 전'; }
    var h = Math.floor(m / 60);
    if (h < 24) { return h + '시간 전'; }
    return Math.floor(h / 24) + '일 전';
  }

  function toast(msg, ms) {
    var el = $('toast');
    if (!el) { return; }
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2400);
  }

  /* ============================================================
     렌더
     ============================================================ */
  function renderAll() {
    renderSummaries();
    renderChips();
    renderFilterBanner();
    renderItems();
    renderShopping();
    renderSpaceList();
    renderDataStat();
    updateSyncUI();
  }

  function renderSummaries() {
    var soon = 0, expired = 0;
    for (var i = 0; i < state.items.length; i++) {
      var d = FU.daysLeft(state.items[i].expiry);
      if (d === null) { continue; }
      if (d < 0) { expired++; }
      else if (d <= 3) { soon++; }
    }
    $('sumTotal').textContent = state.items.length;
    $('sumSoon').textContent = soon;
    $('sumExpired').textContent = expired;

    var cards = document.querySelectorAll('.sum-card');
    for (var c = 0; c < cards.length; c++) {
      var key = cards[c].getAttribute('data-summary');
      var active = (key === 'all' && state.quickFilter === 'all') ||
        (key === 'soon' && state.quickFilter === 'soon') ||
        (key === 'expired' && state.quickFilter === 'expired');
      if (active) { cards[c].classList.add('active'); }
      else { cards[c].classList.remove('active'); }
    }
  }

  function renderChips() {
    var html = '<button type="button" class="chip' + (state.spaceFilter === 'all' ? ' active' : '') +
      '" data-space="all">전체 <span class="cnt">' + state.items.length + '</span></button>';
    sortedStorages().forEach(function (sp) {
      var n = state.items.filter(function (it) { return it.spaceId === sp.id; }).length;
      html += '<button type="button" class="chip' + (state.spaceFilter === sp.id ? ' active' : '') +
        '" data-space="' + FU.esc(sp.id) + '">' + FU.esc(sp.icon || '📦') + ' ' + FU.esc(sp.name) +
        ' <span class="cnt">' + n + '</span></button>';
    });
    $('storageChips').innerHTML = html;
  }

  function renderFilterBanner() {
    var b = $('filterBanner');
    if (state.quickFilter === 'all') {
      b.classList.add('hidden');
      return;
    }
    b.classList.remove('hidden');
    $('filterBannerText').textContent = state.quickFilter === 'soon'
      ? '🍳 오늘 뭐 먹지? · 3일 안에 먹을 재료만'
      : '⚠️ 유통기한이 지난 재료만';
  }

  function visibleItems() {
    var q = (state.search || '').trim().toLowerCase();
    var arr = state.items.filter(function (it) {
      if (state.spaceFilter !== 'all' && it.spaceId !== state.spaceFilter) { return false; }
      if (q) {
        var hay = (it.name + ' ' + (it.memo || '') + ' ' + (it.unit || '')).toLowerCase();
        if (hay.indexOf(q) < 0) { return false; }
      }
      if (state.quickFilter !== 'all') {
        var d = FU.daysLeft(it.expiry);
        if (d === null) { return false; }
        if (state.quickFilter === 'soon' && (d < 0 || d > 3)) { return false; }
        if (state.quickFilter === 'expired' && d >= 0) { return false; }
      }
      return true;
    });

    var s = state.sort;
    arr.sort(function (a, b) {
      if (s === 'name') { return String(a.name).localeCompare(String(b.name), 'ko'); }
      if (s === 'created') {
        var ca = a.createdAt || '', cb = b.createdAt || '';
        if (ca === cb) { return String(a.name).localeCompare(String(b.name), 'ko'); }
        return ca < cb ? 1 : -1;
      }
      var da = FU.daysLeft(a.expiry), db = FU.daysLeft(b.expiry);
      if (da === null && db === null) { return String(a.name).localeCompare(String(b.name), 'ko'); }
      if (da === null) { return 1; }
      if (db === null) { return -1; }
      if (da !== db) { return da - db; }
      return String(a.name).localeCompare(String(b.name), 'ko');
    });
    return arr;
  }

  function cardHTML(it) {
    var d = ddayInfo(it.expiry);
    var sp = spaceById(it.spaceId);
    var spaceLabel = sp ? ((sp.icon ? sp.icon + ' ' : '') + sp.name) : '보관함 없음';
    var dateTxt = it.expiry ? FU.shortDate(it.expiry) : '';
    var html = '<article class="card d-' + d.cls + '">' +
      '<div class="card-main">' +
        '<div class="card-top">' +
          '<button type="button" class="card-name" data-act="edit" data-id="' + FU.esc(it.id) + '">' + FU.esc(it.name) + '</button>' +
          '<span class="space-badge">' + FU.esc(spaceLabel) + '</span>' +
        '</div>' +
        '<div class="card-meta">' +
          '<span class="dday ' + d.cls + '">' + FU.esc(d.label) + '</span>' +
          (dateTxt ? '<span class="card-qty-text">' + FU.esc(dateTxt) + '까지</span>' : '') +
        '</div>' +
        (it.memo ? '<p class="card-memo">' + FU.esc(it.memo) + '</p>' : '') +
      '</div>' +
      '<div class="stepper">' +
        '<div class="step-btns">' +
          '<button type="button" data-act="dec" data-id="' + FU.esc(it.id) + '" aria-label="수량 줄이기">−</button>' +
          '<span class="qty-val">' + FU.esc(FU.fmtQty(it.qty)) + '</span>' +
          '<button type="button" class="plus" data-act="inc" data-id="' + FU.esc(it.id) + '" aria-label="수량 늘리기">＋</button>' +
        '</div>' +
        '<span class="qty-unit">' + FU.esc(it.unit || '개') + '</span>' +
      '</div>' +
      '<div class="card-tools">' +
        '<button type="button" class="tool-btn" data-act="edit" data-id="' + FU.esc(it.id) + '" aria-label="수정">✎</button>' +
      '</div>' +
    '</article>';
    return html;
  }

  function emptyHTML() {
    if (!state.items.length) {
      return '<div class="empty">' +
        '<span class="empty-emoji">🧊</span>' +
        '<p>냉장고가 비어 있어요.<br>아래 <b>＋</b> 버튼으로 식재료를 추가하거나<br>영수증 사진으로 한 번에 등록해 보세요.</p>' +
        '<button type="button" class="btn primary" data-act="add">첫 식재료 추가</button>' +
        '<button type="button" class="btn ghost" data-act="demo" style="margin-left:6px">예시 데이터 넣기</button>' +
        '</div>';
    }
    return '<div class="empty">' +
      '<span class="empty-emoji">🔍</span>' +
      '<p>조건에 맞는 식재료가 없어요.</p>' +
      '<button type="button" class="btn ghost" data-act="reset-filter">필터 해제</button>' +
      '</div>';
  }

  function renderItems() {
    var el = $('itemList');
    var arr = visibleItems();
    if (!arr.length) {
      el.innerHTML = emptyHTML();
      return;
    }
    var html = '';
    if (state.spaceFilter === 'all' && state.storages.length > 1) {
      var groups = sortedStorages();
      var used = {};
      groups.forEach(function (sp) {
        var bucket = arr.filter(function (it) { return it.spaceId === sp.id; });
        if (!bucket.length) { return; }
        used[sp.id] = 1;
        html += '<div class="group-head">' + FU.esc((sp.icon ? sp.icon + ' ' : '') + sp.name) +
          ' <span class="g-count">' + bucket.length + '개</span></div>';
        html += bucket.map(cardHTML).join('');
      });
      var orphans = arr.filter(function (it) { return !used[it.spaceId]; });
      if (orphans.length) {
        html += '<div class="group-head">기타 <span class="g-count">' + orphans.length + '개</span></div>';
        html += orphans.map(cardHTML).join('');
      }
    } else {
      html = arr.map(cardHTML).join('');
    }
    el.innerHTML = html;
  }

  function renderShopping() {
    var el = $('shopList');
    if (!el) { return; }
    var list = state.shopping.slice().sort(function (a, b) {
      if (!!a.checked !== !!b.checked) { return a.checked ? 1 : -1; }
      var ca = a.createdAt || '', cb = b.createdAt || '';
      if (ca === cb) { return 0; }
      return ca < cb ? 1 : -1;
    });
    var checked = list.filter(function (s) { return s.checked; });
    $('shopCount').textContent = state.shopping.length + '개';

    var bar = $('shopCheckoutBar');
    if (checked.length) {
      bar.classList.remove('hidden');
      $('shopCheckedInfo').textContent = '체크 ' + checked.length + '개';
    } else {
      bar.classList.add('hidden');
    }

    if (!list.length) {
      el.innerHTML = '<div class="empty"><span class="empty-emoji">🛒</span>' +
        '<p>장보기 목록이 비어 있어요.<br>다 쓴 재료는 수량을 0으로 줄이면<br>자동으로 여기에 담을 수 있어요.</p></div>';
      renderBadge();
      return;
    }

    el.innerHTML = list.map(function (s) {
      var dateTxt = s.createdAt ? FU.shortDate(s.createdAt) : '';
      return '<div class="shop-item' + (s.checked ? ' done' : '') + '">' +
        '<button type="button" class="shop-check' + (s.checked ? ' on' : '') + '" data-act="toggle" data-id="' + FU.esc(s.id) + '" aria-label="체크">' + (s.checked ? '✓' : '') + '</button>' +
        '<div class="shop-main">' +
          '<div class="shop-name">' + FU.esc(s.name) + '</div>' +
          '<div class="shop-meta">' + FU.esc(FU.fmtQty(s.qty) + ' ' + (s.unit || '개')) + (dateTxt ? ' · ' + FU.esc(dateTxt) : '') + '</div>' +
        '</div>' +
        '<div class="shop-actions">' +
          (s.checked ? '<button type="button" class="btn tiny primary" data-act="intake" data-id="' + FU.esc(s.id) + '">입고</button>' : '') +
          '<button type="button" class="tool-btn" data-act="del" data-id="' + FU.esc(s.id) + '" aria-label="삭제">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');
    renderBadge();
  }

  function renderBadge() {
    var b = $('shopBadge');
    if (!b) { return; }
    var n = state.shopping.filter(function (s) { return !s.checked; }).length;
    if (n > 0) {
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }

  function renderSpaceList() {
    var el = $('spaceList');
    if (!el) { return; }
    el.innerHTML = sortedStorages().map(function (sp) {
      var n = state.items.filter(function (it) { return it.spaceId === sp.id; }).length;
      return '<div class="space-row">' +
        '<span class="space-emoji">' + FU.esc(sp.icon || '📦') + '</span>' +
        '<span class="space-name">' + FU.esc(sp.name) + '</span>' +
        '<span class="space-count">' + n + '개</span>' +
        '<span class="space-actions">' +
          '<button type="button" class="btn tiny ghost" data-act="rename" data-id="' + FU.esc(sp.id) + '">이름 변경</button>' +
          '<button type="button" class="btn tiny danger-ghost" data-act="remove" data-id="' + FU.esc(sp.id) + '">삭제</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  function renderDataStat() {
    var el = $('dataStat');
    if (!el) { return; }
    el.textContent = '식재료 ' + state.items.length + '개 · 보관함 ' + state.storages.length +
      '개 · 장보기 ' + state.shopping.length + '개 · ' +
      (state.cloud.enabled ? '가족 공유(서버에도 저장)' : '이 폰에만 저장');
  }

  /* ============================================================
     시트(sheet)
     ============================================================ */
  function sheetHead(title) {
    return '<div class="sheet-head"><h2 id="sheetTitle">' + FU.esc(title) + '</h2>' +
      '<button type="button" class="sheet-close" data-close="1" aria-label="닫기">✕</button></div>';
  }

  function openSheet(html) {
    var ov = $('sheetOverlay');
    var sh = $('sheet');
    sh.innerHTML = html;
    ov.classList.remove('hidden');
    ov.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var closers = sh.querySelectorAll('[data-close]');
    for (var i = 0; i < closers.length; i++) {
      closers[i].addEventListener('click', closeSheet);
    }
    return sh;
  }

  function closeSheet() {
    var ov = $('sheetOverlay');
    ov.classList.add('hidden');
    ov.setAttribute('aria-hidden', 'true');
    $('sheet').innerHTML = '';
    document.body.style.overflow = '';
  }

  function confirmSheet(opts) {
    var html = sheetHead(opts.title || '확인') +
      '<p class="sheet-note" style="font-size:14px;color:var(--text-soft);margin-top:2px">' + FU.esc(opts.message || '') + '</p>' +
      '<div class="sheet-actions">' +
        '<button type="button" class="btn ghost" data-close="1">취소</button>' +
        '<button type="button" id="confirmOk" class="btn ' + (opts.danger ? 'danger' : 'primary') + '">' + FU.esc(opts.confirmText || '확인') + '</button>' +
      '</div>';
    var sh = openSheet(html);
    var ok = sh.querySelector('#confirmOk');
    ok.addEventListener('click', function () {
      closeSheet();
      if (typeof opts.onConfirm === 'function') { opts.onConfirm(); }
    });
  }

  /* ============================================================
     식재료 CRUD
     ============================================================ */
  function makeItem(data) {
    var t = FU.nowIso();
    return {
      id: data.id || FU.uid('it'),
      name: data.name,
      spaceId: data.spaceId,
      qty: Number(data.qty),
      unit: data.unit || '개',
      expiry: data.expiry || null,
      memo: data.memo || '',
      createdAt: data.createdAt || t,
      updatedAt: t
    };
  }

  function saveItem(item) {
    var idx = -1;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === item.id) { idx = i; break; }
    }
    if (idx >= 0) { state.items[idx] = item; }
    else { state.items.push(item); }
    saveLocal();
    cloud.queue('upsert', 'fridge_items', itemRow(item));
  }

  function removeItem(id) {
    state.items = state.items.filter(function (it) { return it.id !== id; });
    saveLocal();
    cloud.queue('delete', 'fridge_items', null, id);
  }

  function itemRow(it) {
    return {
      id: it.id,
      family_code: state.settings.sbCode,
      name: it.name,
      space_id: it.spaceId,
      quantity: Number(it.qty),
      unit: it.unit,
      expiry: it.expiry || null,
      memo: it.memo || '',
      created_at: it.createdAt,
      updated_at: it.updatedAt
    };
  }

  function saveShopping(s) {
    var idx = -1;
    for (var i = 0; i < state.shopping.length; i++) {
      if (state.shopping[i].id === s.id) { idx = i; break; }
    }
    if (idx >= 0) { state.shopping[idx] = s; }
    else { state.shopping.push(s); }
    saveLocal();
    cloud.queue('upsert', 'shopping_items', shoppingRow(s));
  }

  function removeShopping(id) {
    state.shopping = state.shopping.filter(function (s) { return s.id !== id; });
    saveLocal();
    cloud.queue('delete', 'shopping_items', null, id);
  }

  function shoppingRow(s) {
    return {
      id: s.id,
      family_code: state.settings.sbCode,
      name: s.name,
      quantity: Number(s.qty),
      unit: s.unit || '개',
      checked: !!s.checked,
      created_at: s.createdAt,
      updated_at: s.updatedAt
    };
  }

  function saveSpace(sp) {
    var idx = -1;
    for (var i = 0; i < state.storages.length; i++) {
      if (state.storages[i].id === sp.id) { idx = i; break; }
    }
    if (idx >= 0) { state.storages[idx] = sp; }
    else { state.storages.push(sp); }
    saveLocal();
    cloud.queue('upsert', 'storage_spaces', spaceRow(sp));
  }

  function removeSpaceRow(id) {
    state.storages = state.storages.filter(function (s) { return s.id !== id; });
    saveLocal();
    cloud.queue('delete', 'storage_spaces', null, id);
  }

  function spaceRow(sp) {
    return {
      id: sp.id,
      family_code: state.settings.sbCode,
      name: sp.name,
      icon: sp.icon || '📦',
      sort_order: Number(sp.sortOrder) || 0,
      created_at: sp.createdAt,
      updated_at: sp.updatedAt
    };
  }

  function changeQty(id, delta) {
    var it = itemById(id);
    if (!it) { return; }
    var next = Math.round((Number(it.qty) + delta) * 100) / 100;
    if (next <= 0) {
      openZeroSheet(it);
      return;
    }
    it.qty = next;
    it.updatedAt = FU.nowIso();
    saveItem(it);
    renderSummaries();
    renderItems();
    renderChips();
  }

  function openZeroSheet(item) {
    var html = sheetHead('다 썼어요') +
      '<p class="sheet-note" style="font-size:14px;color:var(--text-soft);margin-top:0">' +
        '<b>' + FU.esc(item.name) + '</b> 수량이 0이 됐어요.<br>장보기 목록에 담아 둘까요?</p>' +
      '<div class="sheet-actions" style="flex-direction:column">' +
        '<button type="button" id="zeroShop" class="btn primary">장보기 목록에 추가</button>' +
        '<div style="display:flex;gap:8px">' +
          '<button type="button" id="zeroDelete" class="btn ghost" style="flex:1">식재료 삭제</button>' +
          '<button type="button" class="btn ghost" data-close="1" style="flex:1">취소</button>' +
        '</div>' +
      '</div>';
    var sh = openSheet(html);
    sh.querySelector('#zeroShop').addEventListener('click', function () {
      var now = FU.nowIso();
      var s = { id: FU.uid('sh'), name: item.name, qty: 1, unit: item.unit || '개', checked: false, createdAt: now, updatedAt: now };
      removeItem(item.id);
      saveShopping(s);
      closeSheet();
      renderAll();
      toast('🛒 장보기 목록에 담았어요');
    });
    sh.querySelector('#zeroDelete').addEventListener('click', function () {
      removeItem(item.id);
      closeSheet();
      renderAll();
      toast(item.name + ' 삭제했어요');
    });
  }

  /* ============================================================
     추가/수정 시트
     ============================================================ */
  function openAddSheet(mode) {
    if (mode === 'receipt') {
      state.receipt = { image: null, rows: [], text: '', status: null, log: '' };
      renderReceiptSheet();
    } else {
      openDirectSheet(null);
    }
  }

  function segHTML(active) {
    return '<div class="seg">' +
      '<button type="button" data-mode="direct" class="' + (active === 'direct' ? 'active' : '') + '">✍️ 직접 입력</button>' +
      '<button type="button" data-mode="receipt" class="' + (active === 'receipt' ? 'active' : '') + '">🧾 영수증 인식</button>' +
      '</div>';
  }

  function bindSeg(sh) {
    var btns = sh.querySelectorAll('.seg [data-mode]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        var mode = e.currentTarget.getAttribute('data-mode');
        if (mode === 'receipt') { openAddSheet('receipt'); }
        else { openDirectSheet(null); }
      });
    }
  }

  function openDirectSheet(item) {
    var isEdit = !!item;
    var it = item || {
      name: '',
      spaceId: state.spaceFilter !== 'all' ? state.spaceFilter : (state.storages[0] ? state.storages[0].id : ''),
      qty: 1,
      unit: '개',
      expiry: FU.addDaysStr(7),
      memo: ''
    };

    var opts = sortedStorages().map(function (sp) {
      return '<option value="' + FU.esc(sp.id) + '"' + (sp.id === it.spaceId ? ' selected' : '') + '>' +
        FU.esc((sp.icon ? sp.icon + ' ' : '') + sp.name) + '</option>';
    }).join('');

    var quick = '';
    if (!isEdit) {
      quick = '<div class="quick-chips" id="quickChips">' + INT.QUICK_NAMES.map(function (n) {
        return '<button type="button" class="chip" data-quick="' + FU.esc(n) + '">' + FU.esc(n) + '</button>';
      }).join('') + '</div>';
    }

    var html = sheetHead(isEdit ? '식재료 수정' : '식재료 추가') +
      (isEdit ? '' : segHTML('direct')) +
      quick +
      '<label class="field"><span>품목명</span>' +
        '<input id="fName" type="text" placeholder="예: 우유, 대파, 달걀" autocomplete="off" value="' + FU.esc(it.name) + '"></label>' +
      '<label class="field"><span>보관함</span><select id="fSpace">' + opts + '</select></label>' +
      '<div class="field"><span>수량 · 단위</span>' +
        '<div class="qty-row">' +
          '<div class="qty-box">' +
            '<button type="button" id="qMinus" aria-label="수량 줄이기">−</button>' +
            '<input id="fQty" type="number" inputmode="decimal" step="any" min="0" value="' + FU.esc(FU.fmtQty(it.qty)) + '">' +
            '<button type="button" id="qPlus" aria-label="수량 늘리기">＋</button>' +
          '</div>' +
          '<input id="fUnit" class="unit-input" type="text" list="unitList" placeholder="단위" value="' + FU.esc(it.unit || '개') + '">' +
        '</div>' +
        '<div class="suggest-row" id="unitChips">' + UNITS.map(function (u) {
          return '<button type="button" class="chip" data-unit="' + FU.esc(u) + '">' + FU.esc(u) + '</button>';
        }).join('') + '</div>' +
      '</div>' +
      '<datalist id="unitList">' + UNITS.map(function (u) { return '<option value="' + FU.esc(u) + '">'; }).join('') + '</datalist>' +
      '<label class="field"><span>유통기한</span>' +
        '<input id="fExpiry" type="date" value="' + FU.esc(it.expiry || '') + '"></label>' +
      '<div class="date-quick" id="dateQuick">' +
        '<button type="button" data-days="0">오늘</button>' +
        '<button type="button" data-days="3">+3일</button>' +
        '<button type="button" data-days="7">+7일</button>' +
        '<button type="button" data-days="14">+14일</button>' +
        '<button type="button" data-days="30">+30일</button>' +
        '<button type="button" data-days="none">기한 없음</button>' +
      '</div>' +
      '<label class="field" style="margin-top:12px"><span>메모 (선택)</span>' +
        '<input id="fMemo" type="text" placeholder="예: 선재 간식, 아래칸" autocomplete="off" value="' + FU.esc(it.memo || '') + '"></label>' +
      '<div class="sheet-actions">' +
        '<button type="button" id="btnSaveItem" class="btn primary">' + (isEdit ? '수정 저장' : '추가하기') + '</button>' +
        (isEdit ? '<button type="button" id="btnDeleteItem" class="btn danger-ghost">삭제</button>' : '') +
      '</div>';

    var sh = openSheet(html);
    if (!isEdit) { bindSeg(sh); }

    var fName = sh.querySelector('#fName');
    var fQty = sh.querySelector('#fQty');
    var fUnit = sh.querySelector('#fUnit');
    var fExpiry = sh.querySelector('#fExpiry');
    var fMemo = sh.querySelector('#fMemo');
    var fSpace = sh.querySelector('#fSpace');

    function refreshDateActive() {
      var val = fExpiry.value;
      var btns = sh.querySelectorAll('#dateQuick button');
      for (var i = 0; i < btns.length; i++) {
        var d = btns[i].getAttribute('data-days');
        var active = (d === 'none' && !val) || (d !== 'none' && val === FU.addDaysStr(Number(d)));
        if (active) { btns[i].classList.add('active'); }
        else { btns[i].classList.remove('active'); }
      }
    }
    refreshDateActive();

    var quickWrap = sh.querySelector('#quickChips');
    if (quickWrap) {
      quickWrap.addEventListener('click', function (e) {
        var b = e.target.closest('[data-quick]');
        if (!b) { return; }
        var name = b.getAttribute('data-quick');
        var f = INT.foodByName(name);
        fName.value = name;
        if (f) {
          fUnit.value = f.unit;
          fSpace.value = resolveSpaceId(f.space);
          fExpiry.value = FU.addDaysStr(f.days);
        }
        refreshDateActive();
      });
    }

    sh.querySelector('#unitChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-unit]');
      if (!b) { return; }
      fUnit.value = b.getAttribute('data-unit');
    });

    sh.querySelector('#qMinus').addEventListener('click', function () {
      var v = Number(fQty.value) || 0;
      fQty.value = FU.fmtQty(Math.max(0, v - 1));
    });
    sh.querySelector('#qPlus').addEventListener('click', function () {
      var v = Number(fQty.value) || 0;
      fQty.value = FU.fmtQty(v + 1);
    });

    sh.querySelector('#dateQuick').addEventListener('click', function (e) {
      var b = e.target.closest('[data-days]');
      if (!b) { return; }
      var d = b.getAttribute('data-days');
      fExpiry.value = d === 'none' ? '' : FU.addDaysStr(Number(d));
      refreshDateActive();
    });
    fExpiry.addEventListener('change', refreshDateActive);

    sh.querySelector('#btnSaveItem').addEventListener('click', function () {
      var name = FU.trim(fName.value);
      if (!name) {
        toast('품목명을 입력해 주세요.');
        fName.focus();
        return;
      }
      var qty = Number(fQty.value);
      if (!isFinite(qty) || qty < 0) { qty = 1; }
      var unit = FU.trim(fUnit.value) || '개';
      var expiry = fExpiry.value || null;
      var memo = FU.trim(fMemo.value);
      var spaceId = fSpace.value || resolveSpaceId('냉장실');

      if (isEdit) {
        item.name = name;
        item.qty = Math.round(qty * 100) / 100;
        item.unit = unit;
        item.expiry = expiry;
        item.memo = memo;
        item.spaceId = spaceId;
        item.updatedAt = FU.nowIso();
        saveItem(item);
      } else {
        saveItem(makeItem({ name: name, spaceId: spaceId, qty: qty, unit: unit, expiry: expiry, memo: memo }));
      }
      closeSheet();
      renderAll();
      toast(isEdit ? '수정했어요' : '🧊 ' + name + ' 추가했어요');
    });

    if (isEdit) {
      sh.querySelector('#btnDeleteItem').addEventListener('click', function () {
        confirmSheet({
          title: '식재료 삭제',
          message: '‘' + item.name + '’을(를) 냉장고에서 지울까요?',
          confirmText: '삭제',
          danger: true,
          onConfirm: function () {
            removeItem(item.id);
            renderAll();
            toast('삭제했어요');
          }
        });
      });
    }
  }

  /* ============================================================
     영수증 시트
     ============================================================ */
  function setReceiptStatus(text, type) {
    state.receipt.status = text ? { text: text, type: type || '' } : null;
    var el = $('receiptStatus');
    if (el) {
      if (!text) { el.classList.add('hidden'); }
      else {
        el.classList.remove('hidden');
        el.textContent = text;
        el.className = 'receipt-status ' + (type || '');
      }
    } else {
      renderReceiptSheet();
    }
  }

  function renderReceiptSheet() {
    var r = state.receipt;
    var html = sheetHead('영수증으로 추가') +
      segHTML('receipt') +
      '<input type="file" id="receiptFile" accept="image/*" capture="environment" class="hidden">' +
      '<div id="receiptPhotoArea">' +
        (r.image
          ? '<img id="receiptPreview" src="' + r.image + '" alt="영수증 사진">' +
            '<div class="receipt-actions"><button type="button" id="btnPickPhoto" class="btn small ghost">다른 사진 선택</button></div>'
          : '<button type="button" id="btnPickPhoto" class="dropzone">' +
              '<span class="dz-emoji">📷</span>' +
              '<span>영수증 사진 찍기 / 앨범에서 선택</span>' +
              '<span style="font-size:11.5px">품목과 금액이 잘 보이게 찍어 주세요</span>' +
            '</button>') +
      '</div>' +
      '<div class="receipt-actions">' +
        '<button type="button" id="btnGemini" class="btn primary">✨ AI로 인식</button>' +
        '<button type="button" id="btnOcr" class="btn ghost">글자만 추출(OCR)</button>' +
      '</div>' +
      '<div id="receiptStatus" class="receipt-status ' + (r.status ? (r.status.type || '') : 'hidden') + '">' +
        (r.status ? FU.esc(r.status.text) : '') + '</div>' +
      '<details class="sql-details" style="margin-top:12px">' +
        '<summary>텍스트 붙여넣기로 등록 (API 키 없이도 가능)</summary>' +
        '<textarea id="receiptText" class="field" style="width:100%;margin-top:9px;padding:10px;border:1px solid var(--line);background:var(--card-2);border-radius:10px;min-height:86px" placeholder="영수증 내용을 그대로 붙여넣으세요.\n예)\n서울우유 1L 2,900\n대파 1단 3,200\n두부 2개 4,000">' + FU.esc(r.text) + '</textarea>' +
        '<div class="btn-row"><button type="button" id="btnParseText" class="btn small primary">품목 찾기</button></div>' +
      '</details>' +
      '<div id="receiptRows" class="receipt-list"></div>' +
      '<div id="receiptFooter"></div>';

    var sh = openSheet(html);
    bindSeg(sh);

    var fileInput = sh.querySelector('#receiptFile');
    var pick = sh.querySelector('#btnPickPhoto');
    if (pick) {
      pick.addEventListener('click', function () { fileInput.click(); });
    }

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) { return; }
      setReceiptStatus('사진 준비 중…', '');
      INT.fileToDataUrl(file).then(function (url) {
        return INT.shrinkImage(url, 1500, 0.85);
      }).then(function (url) {
        state.receipt.image = url;
        state.receipt.status = null;
        renderReceiptSheet();
        setReceiptStatus('사진이 준비됐어요. ‘AI로 인식’을 눌러 주세요.', 'ok');
      }).catch(function (err) {
        setReceiptStatus(err && err.message ? err.message : '사진을 읽지 못했어요.', 'err');
      });
    });

    sh.querySelector('#btnGemini').addEventListener('click', function () {
      if (!state.receipt.image) {
        setReceiptStatus('영수증 사진을 먼저 올려 주세요.', 'err');
        return;
      }
      if (!state.settings.geminiKey) {
        setReceiptStatus('Gemini API 키가 없어요. 설정 탭에서 키를 저장하거나, 아래 ‘글자만 추출(OCR)’을 눌러 주세요.', 'err');
        return;
      }
      setReceiptStatus('✨ Gemini가 영수증을 읽고 있어요… (10~20초)', '');
      INT.geminiExtract(state.receipt.image, state.settings.geminiKey).then(function (rows) {
        state.receipt.rows = rows;
        renderReceiptSheet();
        setReceiptStatus(rows.length + '개 품목을 찾았어요. 확인하고 등록하세요.', 'ok');
      }).catch(function (err) {
        renderReceiptSheet();
        setReceiptStatus(err && err.message ? err.message : '영수증 인식에 실패했어요.', 'err');
      });
    });

    sh.querySelector('#btnOcr').addEventListener('click', function () {
      if (!state.receipt.image) {
        setReceiptStatus('영수증 사진을 먼저 올려 주세요.', 'err');
        return;
      }
      setReceiptStatus('🔍 글자를 읽는 중이에요… 처음엔 30초쯤 걸릴 수 있어요.', '');
      INT.ocrImage(state.receipt.image, function (status, progress) {
        var pct = progress ? Math.round(progress * 100) : 0;
        setReceiptStatus('🔍 OCR: ' + status + (pct ? ' ' + pct + '%' : ''), '');
      }).then(function (text) {
        state.receipt.text = text;
        var rows = INT.parseReceiptText(text);
        state.receipt.rows = rows;
        renderReceiptSheet();
        if (rows.length) {
          setReceiptStatus(rows.length + '개 품목을 찾았어요. 틀린 부분은 고쳐서 등록하세요.', 'ok');
        } else {
          setReceiptStatus('품목을 자동으로 나누지 못했어요. 아래 텍스트를 확인해 직접 고쳐 보세요.', 'err');
        }
      }).catch(function (err) {
        renderReceiptSheet();
        setReceiptStatus(err && err.message ? err.message : 'OCR에 실패했어요.', 'err');
      });
    });

    var textArea = sh.querySelector('#receiptText');
    textArea.addEventListener('input', function () {
      state.receipt.text = textArea.value;
    });

    sh.querySelector('#btnParseText').addEventListener('click', function () {
      var txt = textArea.value;
      state.receipt.text = txt;
      if (!txt.trim()) {
        setReceiptStatus('영수증 내용을 먼저 붙여넣어 주세요.', 'err');
        return;
      }
      var rows = INT.parseReceiptText(txt);
      state.receipt.rows = rows;
      renderReceiptSheet();
      if (rows.length) {
        setReceiptStatus(rows.length + '개 품목을 찾았어요. 확인하고 등록하세요.', 'ok');
      } else {
        setReceiptStatus('품목을 찾지 못했어요. 한 줄에 한 품목씩 입력해 보세요.', 'err');
      }
    });

    renderReceiptRows(sh);
  }

  function renderReceiptRows(sh) {
    var wrap = sh.querySelector('#receiptRows');
    var footer = sh.querySelector('#receiptFooter');
    var rows = state.receipt.rows;
    if (!rows || !rows.length) {
      wrap.innerHTML = '<p class="hint" style="text-align:center;padding:14px 6px">인식 결과가 여기에 표시돼요.<br>사진을 올리고 AI 인식 · OCR · 텍스트 붙여넣기를 사용해 보세요.</p>';
      footer.innerHTML = '';
      return;
    }

    var spaceOpts = sortedStorages();
    wrap.innerHTML = rows.map(function (row, idx) {
      var opts = spaceOpts.map(function (sp) {
        var selected = sp.name === row.spaceName || sp.id === row.spaceName;
        return '<option value="' + FU.esc(sp.name) + '"' + (selected ? ' selected' : '') + '>' + FU.esc(sp.name) + '</option>';
      }).join('');
      return '<div class="receipt-row" data-idx="' + idx + '">' +
        '<input type="checkbox" class="rr-check" data-idx="' + idx + '" data-field="checked"' + (row.checked ? ' checked' : '') + '>' +
        '<div class="rr-fields">' +
          '<input class="rr-name" type="text" data-idx="' + idx + '" data-field="name" value="' + FU.esc(row.name) + '">' +
          '<div class="rr-line">' +
            '<input class="rr-qty" type="number" inputmode="decimal" step="any" min="0" data-idx="' + idx + '" data-field="qty" value="' + FU.esc(FU.fmtQty(row.qty)) + '">' +
            '<input class="rr-unit" type="text" data-idx="' + idx + '" data-field="unit" value="' + FU.esc(row.unit) + '">' +
            '<select class="rr-space" data-idx="' + idx + '" data-field="spaceName">' + opts + '</select>' +
            '<span class="unit-lab">유통</span>' +
            '<input class="rr-days" type="number" inputmode="numeric" min="0" data-idx="' + idx + '" data-field="days" value="' + (row.days === null || row.days === undefined ? '' : FU.esc(String(row.days))) + '">' +
            '<span class="unit-lab">일</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    paintReceiptFooter();
    bindReceiptRows(wrap);
  }

  function paintReceiptFooter() {
    var footer = $('receiptFooter');
    if (!footer) { return; }
    var rows = state.receipt.rows || [];
    if (!rows.length) { footer.innerHTML = ''; return; }
    var checked = rows.filter(function (r) { return r.checked; }).length;
    footer.innerHTML = '<div class="receipt-selectall">' +
        '<input type="checkbox" id="rrSelectAll"' + (checked === rows.length ? ' checked' : '') + '> 전체 선택 <span style="margin-left:auto">' + checked + ' / ' + rows.length + '개 선택</span>' +
      '</div>' +
      '<div class="sheet-actions">' +
        '<button type="button" id="btnRegisterRows" class="btn primary">' + checked + '개 등록하기</button>' +
      '</div>';
    var all = $('rrSelectAll');
    if (all) {
      all.addEventListener('change', function () {
        var v = all.checked;
        state.receipt.rows.forEach(function (r) { r.checked = v; });
        renderReceiptSheet();
      });
    }
    var reg = $('btnRegisterRows');
    if (reg) { reg.addEventListener('click', registerReceiptRows); }
  }

  function bindReceiptRows(wrap) {
    function handle(e) {
      var t = e.target;
      var idx = t.getAttribute('data-idx');
      var field = t.getAttribute('data-field');
      if (idx === null || !field) { return; }
      var row = state.receipt.rows[Number(idx)];
      if (!row) { return; }
      if (field === 'checked') {
        row.checked = !!t.checked;
        paintReceiptFooter();
      } else if (field === 'qty') {
        row.qty = t.value === '' ? 0 : Number(t.value);
      } else if (field === 'days') {
        row.days = t.value === '' ? null : Number(t.value);
      } else {
        row[field] = t.value;
      }
    }
    wrap.addEventListener('input', handle);
    wrap.addEventListener('change', handle);
  }

  function registerReceiptRows() {
    var rows = (state.receipt.rows || []).filter(function (r) {
      return r.checked && FU.trim(r.name);
    });
    if (!rows.length) {
      toast('등록할 품목을 선택해 주세요.');
      return;
    }
    rows.forEach(function (r) {
      var days = r.days;
      var expiry = (days === null || days === undefined || days === '' || !isFinite(Number(days)))
        ? null
        : FU.addDaysStr(Number(days));
      saveItem(makeItem({
        name: FU.trim(r.name),
        spaceId: resolveSpaceId(r.spaceName),
        qty: Number(r.qty) > 0 ? Number(r.qty) : 1,
        unit: FU.trim(r.unit) || '개',
        expiry: expiry,
        memo: ''
      }));
    });
    closeSheet();
    state.receipt = { image: null, rows: [], text: '', status: null, log: '' };
    switchView('fridge');
    renderAll();
    toast('🧾 ' + rows.length + '개 식재료를 등록했어요');
  }

  /* ============================================================
     장보기
     ============================================================ */
  function addShoppingItem(name) {
    var now = FU.nowIso();
    var f = INT.findFood(name);
    var s = {
      id: FU.uid('sh'),
      name: name,
      qty: 1,
      unit: f ? f.unit : '개',
      checked: false,
      createdAt: now,
      updatedAt: now
    };
    saveShopping(s);
    renderShopping();
    renderDataStat();
  }

  function openIntakeSheet(id) {
    var s = shoppingById(id);
    if (!s) { return; }
    var f = INT.findFood(s.name);
    var defaultDays = f ? f.days : 7;
    var defaultSpace = resolveSpaceId(f ? f.space : '냉장실');
    var opts = sortedStorages().map(function (sp) {
      return '<option value="' + FU.esc(sp.id) + '"' + (sp.id === defaultSpace ? ' selected' : '') + '>' +
        FU.esc((sp.icon ? sp.icon + ' ' : '') + sp.name) + '</option>';
    }).join('');

    var html = sheetHead('냉장고에 넣기') +
      '<p class="sheet-note" style="margin-top:0;font-size:14px;color:var(--text-soft)"><b>' + FU.esc(s.name) + '</b> 을(를) 넣을 칸과 유통기한을 정해 주세요.</p>' +
      '<label class="field"><span>보관함</span><select id="iSpace">' + opts + '</select></label>' +
      '<div class="field"><span>수량 · 단위</span><div class="qty-row">' +
        '<div class="qty-box"><input id="iQty" type="number" inputmode="decimal" step="any" min="0" value="' + FU.esc(FU.fmtQty(s.qty)) + '"></div>' +
        '<input id="iUnit" class="unit-input" type="text" list="unitList" value="' + FU.esc(s.unit || '개') + '">' +
      '</div></div>' +
      '<label class="field"><span>유통기한</span><input id="iExpiry" type="date" value="' + FU.esc(FU.addDaysStr(defaultDays)) + '"></label>' +
      '<div class="date-quick" id="iDateQuick">' +
        '<button type="button" data-days="0">오늘</button>' +
        '<button type="button" data-days="3">+3일</button>' +
        '<button type="button" data-days="7">+7일</button>' +
        '<button type="button" data-days="14">+14일</button>' +
        '<button type="button" data-days="30">+30일</button>' +
        '<button type="button" data-days="none">기한 없음</button>' +
      '</div>' +
      '<div class="sheet-actions">' +
        '<button type="button" id="btnIntake" class="btn primary">냉장고에 넣기</button>' +
      '</div>';

    var sh = openSheet(html);
    var iExpiry = sh.querySelector('#iExpiry');
    sh.querySelector('#iDateQuick').addEventListener('click', function (e) {
      var b = e.target.closest('[data-days]');
      if (!b) { return; }
      var d = b.getAttribute('data-days');
      iExpiry.value = d === 'none' ? '' : FU.addDaysStr(Number(d));
    });
    sh.querySelector('#btnIntake').addEventListener('click', function () {
      var qty = Number(sh.querySelector('#iQty').value);
      saveItem(makeItem({
        name: s.name,
        spaceId: sh.querySelector('#iSpace').value,
        qty: isFinite(qty) && qty > 0 ? qty : 1,
        unit: FU.trim(sh.querySelector('#iUnit').value) || '개',
        expiry: iExpiry.value || null,
        memo: ''
      }));
      removeShopping(s.id);
      closeSheet();
      renderAll();
      toast('🧊 ' + s.name + ' 냉장고에 넣었어요');
    });
  }

  function checkoutAllShopping() {
    var checked = state.shopping.filter(function (s) { return s.checked; });
    if (!checked.length) { return; }
    checked.forEach(function (s) {
      var f = INT.findFood(s.name);
      saveItem(makeItem({
        name: s.name,
        spaceId: resolveSpaceId(f ? f.space : '냉장실'),
        qty: s.qty > 0 ? s.qty : 1,
        unit: s.unit || '개',
        expiry: FU.addDaysStr(f ? f.days : 7),
        memo: ''
      }));
      removeShopping(s.id);
    });
    renderAll();
    toast('🧊 ' + checked.length + '개를 냉장고에 넣었어요. 칸·기한은 카드를 눌러 고칠 수 있어요.');
  }

  /* ============================================================
     보관함 관리
     ============================================================ */
  function openSpaceSheet(existing) {
    var isEdit = !!existing;
    var icons = SPACE_ICONS.map(function (ic) {
      var active = (existing && existing.icon === ic) || (!existing && ic === '📦');
      return '<button type="button" class="chip' + (active ? ' active' : '') + '" data-icon="' + ic + '" style="font-size:18px;padding:6px 11px">' + ic + '</button>';
    }).join('');

    var html = sheetHead(isEdit ? '보관함 이름 변경' : '보관함 추가') +
      '<label class="field"><span>이름</span><input id="spaceName" type="text" placeholder="예: 김치냉장고, 베란다, 2층 냉장고" autocomplete="off" value="' + FU.esc(existing ? existing.name : '') + '"></label>' +
      '<div class="field"><span>아이콘</span><div class="quick-chips" id="iconChips">' + icons + '</div></div>' +
      '<div class="sheet-actions">' +
        '<button type="button" id="btnSaveSpace" class="btn primary">' + (isEdit ? '저장' : '추가') + '</button>' +
      '</div>';

    var sh = openSheet(html);
    var iconWrap = sh.querySelector('#iconChips');
    var selectedIcon = existing ? (existing.icon || '📦') : '📦';
    iconWrap.addEventListener('click', function (e) {
      var b = e.target.closest('[data-icon]');
      if (!b) { return; }
      selectedIcon = b.getAttribute('data-icon');
      var all = iconWrap.querySelectorAll('[data-icon]');
      for (var i = 0; i < all.length; i++) {
        all[i].classList.toggle('active', all[i] === b);
      }
    });

    sh.querySelector('#btnSaveSpace').addEventListener('click', function () {
      var name = FU.trim(sh.querySelector('#spaceName').value);
      if (!name) { toast('보관함 이름을 입력해 주세요.'); return; }
      var dup = state.storages.filter(function (s) { return s.name === name && (!existing || s.id !== existing.id); });
      if (dup.length) { toast('같은 이름의 보관함이 이미 있어요.'); return; }

      if (isEdit) {
        existing.name = name;
        existing.icon = selectedIcon;
        existing.updatedAt = FU.nowIso();
        saveSpace(existing);
      } else {
        var maxOrder = 0;
        state.storages.forEach(function (s) { maxOrder = Math.max(maxOrder, Number(s.sortOrder) || 0); });
        var t = FU.nowIso();
        saveSpace({ id: FU.uid('sp'), name: name, icon: selectedIcon, sortOrder: maxOrder + 1, createdAt: t, updatedAt: t });
      }
      closeSheet();
      renderAll();
      toast(isEdit ? '보관함 이름을 바꿨어요' : '보관함 추가했어요');
    });
  }

  function deleteSpace(id) {
    var sp = spaceById(id);
    if (!sp) { return; }
    if (state.storages.length <= 1) {
      toast('보관함은 최소 하나 있어야 해요.');
      return;
    }
    var others = sortedStorages().filter(function (s) { return s.id !== id; });
    var target = others[0];
    var count = state.items.filter(function (it) { return it.spaceId === id; }).length;
    var msg = count
      ? '‘' + sp.name + '’에 있는 식재료 ' + count + '개는 ‘' + target.name + '’(으)로 옮겨요.'
      : '‘' + sp.name + '’ 보관함을 지울까요?';
    confirmSheet({
      title: '보관함 삭제',
      message: msg,
      confirmText: '삭제',
      danger: true,
      onConfirm: function () {
        if (count) {
          state.items.forEach(function (it) {
            if (it.spaceId === id) {
              it.spaceId = target.id;
              it.updatedAt = FU.nowIso();
              saveItem(it);
            }
          });
        }
        removeSpaceRow(id);
        if (state.spaceFilter === id) { state.spaceFilter = 'all'; }
        renderAll();
        toast('보관함을 삭제했어요');
      }
    });
  }

  /* ============================================================
     가족 공유 (Supabase)
     ============================================================ */
  var cloud = {
    client: null,
    outbox: [],
    flushing: false,

    load: function () {
      try { cloud.outbox = JSON.parse(localStorage.getItem(LS_OUT) || '[]') || []; } catch (e) { cloud.outbox = []; }
    },
    saveOutbox: function () {
      try { localStorage.setItem(LS_OUT, JSON.stringify(cloud.outbox)); } catch (e) { /* noop */ }
    },
    queue: function (op, table, row, rowId) {
      if (!state.cloud.enabled) { return; }
      var key = table + ':' + (row ? row.id : rowId);
      cloud.outbox = cloud.outbox.filter(function (o) {
        return (o.table + ':' + (o.row ? o.row.id : o.rowId)) !== key;
      });
      cloud.outbox.push({
        op: op,
        table: table,
        key: key,
        row: row || null,
        rowId: rowId || null
      });
      if (cloud.outbox.length > 400) { cloud.outbox = cloud.outbox.slice(-400); }
      cloud.saveOutbox();
      scheduleSync(600);
    },
    flush: async function () {
      if (!cloud.client || cloud.flushing) { return; }
      if (!cloud.outbox.length) { return; }
      cloud.flushing = true;
      try {
        while (cloud.outbox.length) {
          var o = cloud.outbox[0];
          if (o.op === 'upsert') { await cloud.client.upsert(o.table, [o.row]); }
          else { await cloud.client.remove(o.table, o.rowId); }
          cloud.outbox.shift();
          cloud.saveOutbox();
        }
      } finally {
        cloud.flushing = false;
      }
    },
    pull: async function () {
      var code = state.settings.sbCode;
      var res = await Promise.all([
        cloud.client.select('storage_spaces', code),
        cloud.client.select('fridge_items', code),
        cloud.client.select('shopping_items', code)
      ]);
      var st = res[0] || [], it = res[1] || [], sh = res[2] || [];
      if (!st.length && !it.length && !sh.length && state.storages.length) {
        // 서버가 비어 있으면 기본 보관함을 올린다
        await cloud.pushAll();
        return;
      }
      state.storages = st.map(rowToSpace);
      state.items = it.map(rowToItem);
      state.shopping = sh.map(rowToShopping);
      if (!state.storages.length) { state.storages = defaultStorages(); }
      saveLocal();
    },
    pushAll: async function () {
      if (!cloud.client) { return; }
      if (state.storages.length) { await cloud.client.upsert('storage_spaces', state.storages.map(spaceRow)); }
      if (state.items.length) { await cloud.client.upsert('fridge_items', state.items.map(itemRow)); }
      if (state.shopping.length) { await cloud.client.upsert('shopping_items', state.shopping.map(shoppingRow)); }
    },
    merge: async function (remote) {
      var haveSt = {}, haveIt = {}, haveSh = {};
      (remote[0] || []).forEach(function (r) { haveSt[r.id] = 1; });
      (remote[1] || []).forEach(function (r) { haveIt[r.id] = 1; });
      (remote[2] || []).forEach(function (r) { haveSh[r.id] = 1; });
      var st = state.storages.filter(function (s) { return !haveSt[s.id]; }).map(spaceRow);
      var it = state.items.filter(function (i) { return !haveIt[i.id]; }).map(itemRow);
      var sh = state.shopping.filter(function (s) { return !haveSh[s.id]; }).map(shoppingRow);
      if (st.length) { await cloud.client.upsert('storage_spaces', st); }
      if (it.length) { await cloud.client.upsert('fridge_items', it); }
      if (sh.length) { await cloud.client.upsert('shopping_items', sh); }
      return { items: it.length, shopping: sh.length };
    },
    sync: async function (manual) {
      if (!state.cloud.enabled) {
        if (manual) { toast('가족 공유를 먼저 연결해 주세요. (설정 → 가족 공유)'); switchView('settings'); }
        return;
      }
      if (state.cloud.busy) { return; }
      if (!cloud.client) { cloud.client = INT.makeClient(state.settings.sbUrl, state.settings.sbKey); }
      state.cloud.busy = true;
      setCloudStatus('syncing', '동기화 중…');
      try {
        await cloud.flush();
        await cloud.pull();
        state.cloud.lastSync = Date.now();
        try { localStorage.setItem(LS_SYNC, String(state.cloud.lastSync)); } catch (e) { /* noop */ }
        setCloudStatus('online', '');
        renderAll();
        if (manual) { toast('가족 냉장고와 동기화했어요'); }
      } catch (err) {
        setCloudStatus('error', friendlyErr(err));
        if (manual) { toast('동기화 실패: ' + friendlyErr(err)); }
      } finally {
        state.cloud.busy = false;
      }
    },
    connect: async function () {
      var url = FU.trim(state.settings.sbUrl).replace(/\/+$/, '');
      var key = FU.trim(state.settings.sbKey);
      var code = FU.trim(state.settings.sbCode);
      if (!url || !key || !code) { toast('URL · Anon Key · 공유 코드를 모두 입력해 주세요.'); return; }
      if (!/^https:\/\/[^\s]+$/i.test(url) && !/^http:\/\/localhost/i.test(url)) {
        toast('URL은 https://… 형식으로 입력해 주세요.');
        return;
      }
      state.settings.sbUrl = url;
      state.settings.sbKey = key;
      state.settings.sbCode = code;
      saveSettings();
      cloud.client = INT.makeClient(url, key);
      state.cloud.enabled = true;
      state.cloud.busy = true;
      setCloudStatus('syncing', '연결 확인 중…');

      try {
        await cloud.client.ping();
        var remote = await Promise.all([
          cloud.client.select('storage_spaces', code),
          cloud.client.select('fridge_items', code),
          cloud.client.select('shopping_items', code)
        ]);
        var remoteCount = (remote[0] || []).length + (remote[1] || []).length + (remote[2] || []).length;
        var localCount = state.items.length + state.shopping.length;
        var msg = '';

        if (remoteCount === 0) {
          await cloud.pushAll();
          msg = localCount ? '가족 냉장고를 만들고 이 폰의 식재료를 올렸어요' : '가족 냉장고를 만들었어요';
        } else if (localCount === 0) {
          state.storages = (remote[0] || []).map(rowToSpace);
          state.items = (remote[1] || []).map(rowToItem);
          state.shopping = (remote[2] || []).map(rowToShopping);
          if (!state.storages.length) { state.storages = defaultStorages(); }
          saveLocal();
          msg = '가족 냉장고 데이터를 이 폰으로 받았어요';
        } else {
          var added = await cloud.merge(remote);
          state.storages = (remote[0] || []).map(rowToSpace);
          state.items = (remote[1] || []).map(rowToItem);
          state.shopping = (remote[2] || []).map(rowToShopping);
          if (!state.storages.length) { state.storages = defaultStorages(); }
          saveLocal();
          msg = '가족 냉장고와 합쳤어요' + (added.items ? ' (이 폰 항목 ' + added.items + '개 추가)' : '');
        }

        state.cloud.lastSync = Date.now();
        try { localStorage.setItem(LS_SYNC, String(state.cloud.lastSync)); } catch (e) { /* noop */ }
        try { localStorage.setItem(LS_MIG, '1'); } catch (e) { /* noop */ }
        setCloudStatus('online', msg);
        cloud.startPolling();
        renderAll();
        toast('👨‍👩‍👦 ' + msg);
      } catch (err) {
        state.cloud.enabled = false;
        setCloudStatus('error', friendlyErr(err));
        toast('연결 실패: ' + friendlyErr(err));
      } finally {
        state.cloud.busy = false;
        updateSyncUI();
      }
    },
    disconnect: function () {
      state.cloud.enabled = false;
      cloud.client = null;
      state.cloud.status = 'local';
      state.cloud.message = '';
      cloud.stopPolling();
      saveSettings();
      updateSyncUI();
      renderDataStat();
      toast('가족 공유를 끄고 이 폰에만 저장해요. (데이터는 그대로 남아 있어요)');
    },
    startPolling: function () {
      cloud.stopPolling();
      pollTimer = setInterval(function () {
        if (state.cloud.enabled && document.visibilityState === 'visible' && !document.querySelector('.overlay:not(.hidden)')) {
          cloud.sync(false);
        }
      }, 8000);
    },
    stopPolling: function () {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
  };

  function scheduleSync(ms) {
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(function () {
      if (state.cloud.enabled) {
        cloud.flush().then(function () {
          state.cloud.lastSync = Date.now();
          try { localStorage.setItem(LS_SYNC, String(state.cloud.lastSync)); } catch (e) { /* noop */ }
          setCloudStatus('online', '');
        }).catch(function (err) {
          setCloudStatus('error', friendlyErr(err));
        });
      }
    }, ms || 500);
  }

  function setCloudStatus(status, message) {
    state.cloud.status = status;
    state.cloud.message = message || '';
    updateSyncUI();
  }

  function friendlyErr(err) {
    if (!err) { return '알 수 없는 오류가 생겼어요.'; }
    var msg = String(err.message || err);
    if (err.status === 401 || err.status === 403) { return 'Anon Key 또는 권한 문제예요. 키를 다시 확인해 주세요.'; }
    if (err.status === 404) { return '테이블을 찾지 못했어요. URL이 맞는지, 아래 SQL을 SQL Editor에서 실행했는지 확인해 주세요.'; }
    if (err.status === 400) { return '요청 형식이 맞지 않아요. 테이블 구조(SQL)를 확인해 주세요.'; }
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) { return '서버에 연결하지 못했어요. URL과 인터넷 연결을 확인해 주세요.'; }
    return msg.slice(0, 180);
  }

  function updateSyncUI() {
    var dot = $('syncDot');
    var badge = $('cloudModeBadge');
    var line = $('cloudStatus');
    var dis = $('btnDisconnect');
    var on = state.cloud.enabled;
    var st = state.cloud.status;

    var dotCls = !on ? 'local' : (st === 'error' ? 'error' : (st === 'syncing' ? 'syncing' : 'online'));
    if (dot) {
      dot.className = 'dot ' + dotCls;
      dot.title = !on ? '로컬 저장' : (st === 'error' ? '연결 오류' : '가족 공유 중');
    }
    if (badge) {
      badge.textContent = !on ? '로컬 저장' : (st === 'error' ? '연결 오류' : (st === 'syncing' ? '동기화 중' : '가족 공유'));
      badge.className = 'pill ' + (!on ? 'muted' : (st === 'error' ? 'danger' : 'on'));
    }
    if (line) {
      var text;
      if (!on) { text = '로컬 모드로 동작 중이에요. 이 폰에만 저장됩니다.'; }
      else if (st === 'error') { text = '동기화 오류: ' + (state.cloud.message || '연결을 확인해 주세요.'); }
      else if (state.cloud.busy || st === 'syncing') { text = '가족 냉장고와 맞추는 중…'; }
      else {
        text = '가족과 공유 중';
        if (state.cloud.lastSync) { text += ' · 마지막 동기화 ' + timeAgo(state.cloud.lastSync); }
        if (state.cloud.message) { text += ' · ' + state.cloud.message; }
      }
      line.textContent = text;
      line.className = 'status-line ' + (st === 'error' && on ? 'err' : (on ? 'ok' : ''));
    }
    if (dis) { dis.classList.toggle('hidden', !on); }
  }

  function rowToSpace(r) {
    return {
      id: r.id,
      name: r.name,
      icon: r.icon || '📦',
      sortOrder: Number(r.sort_order) || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }
  function rowToItem(r) {
    return {
      id: r.id,
      name: r.name,
      spaceId: r.space_id,
      qty: Number(r.quantity) || 0,
      unit: r.unit || '개',
      expiry: r.expiry ? String(r.expiry).slice(0, 10) : null,
      memo: r.memo || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }
  function rowToShopping(r) {
    return {
      id: r.id,
      name: r.name,
      qty: Number(r.quantity) || 1,
      unit: r.unit || '개',
      checked: !!r.checked,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  /* ============================================================
     화면 전환
     ============================================================ */
  function switchView(view) {
    state.view = view;
    var views = { fridge: $('view-fridge'), shopping: $('view-shopping'), settings: $('view-settings') };
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('hidden', k !== view);
    });
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === view);
    }
    $('fab').classList.toggle('hidden', view !== 'fridge');
    if (view === 'settings') { renderSettings(); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderSettings() {
    if ($('sbUrl')) { $('sbUrl').value = state.settings.sbUrl || ''; }
    if ($('sbKey')) { $('sbKey').value = state.settings.sbKey || ''; }
    if ($('sbCode')) { $('sbCode').value = state.settings.sbCode || ''; }
    if ($('geminiKey')) { $('geminiKey').value = state.settings.geminiKey || ''; }
    if ($('sqlBlock')) { $('sqlBlock').textContent = INT.SCHEMA_SQL; }
    var gb = $('geminiBadge');
    if (gb) {
      gb.textContent = state.settings.geminiKey ? '키 저장됨' : '키 없음';
      gb.className = 'pill ' + (state.settings.geminiKey ? 'on' : 'muted');
    }
    renderSpaceList();
    renderDataStat();
    updateSyncUI();
  }

  /* ============================================================
     데이터 · 앱 설치
     ============================================================ */
  function exportData() {
    var payload = {
      app: 'fridge-app',
      version: 1,
      exportedAt: FU.nowIso(),
      storages: state.storages,
      items: state.items,
      shopping: state.shopping
    };
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '우리집-냉장고-' + FU.todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        if (a.parentNode) { a.parentNode.removeChild(a); }
      }, 1200);
      toast('JSON 파일로 내보냈어요');
    } catch (e) {
      toast('내보내기에 실패했어요.');
    }
  }

  function importData(file) {
    if (state.cloud.enabled) {
      toast('가족 공유 중에는 가져오기를 쓸 수 없어요. 설정에서 연결을 해제한 뒤 시도해 주세요.');
      return;
    }
    var fr = new FileReader();
    fr.onload = function () {
      var d = null;
      try { d = JSON.parse(String(fr.result || '')); } catch (e) { d = null; }
      if (!d || !Array.isArray(d.storages) || !Array.isArray(d.items)) {
        toast('이 앱에서 내보낸 JSON 파일이 아니에요.');
        return;
      }
      confirmSheet({
        title: '데이터 가져오기',
        message: '지금 이 폰의 냉장고를 백업 파일 내용으로 바꿀까요? (식재료 ' + d.items.length + '개)',
        confirmText: '가져오기',
        onConfirm: function () {
          state.storages = d.storages.length ? d.storages : defaultStorages();
          state.items = d.items;
          state.shopping = Array.isArray(d.shopping) ? d.shopping : [];
          state.spaceFilter = 'all';
          saveLocal();
          renderAll();
          toast('백업 데이터를 불러왔어요');
        }
      });
    };
    fr.readAsText(file);
  }

  function demoData() {
    if (state.items.length || state.shopping.length) {
      toast('이미 식재료가 있어요. 비운 뒤에 다시 시도해 주세요.');
      return;
    }
    var demo = [
      { name: '우유', space: '냉장실', qty: 1, unit: '개', days: 1, memo: '선재 아침' },
      { name: '대파', space: '냉장실', qty: 1, unit: '단', days: 3, memo: '' },
      { name: '달걀', space: '냉장실', qty: 10, unit: '개', days: 20, memo: '' },
      { name: '두부', space: '냉장실', qty: 1, unit: '모', days: -1, memo: '오늘 먹기' },
      { name: '돼지고기', space: '냉동실', qty: 500, unit: 'g', days: 25, memo: '구이용' },
      { name: '김치', space: '김치냉장고', qty: 1, unit: '통', days: 18, memo: '' },
      { name: '양파', space: '실온', qty: 3, unit: '개', days: 12, memo: '' }
    ];
    demo.forEach(function (d) {
      saveItem(makeItem({
        name: d.name,
        spaceId: resolveSpaceId(d.space),
        qty: d.qty,
        unit: d.unit,
        expiry: FU.addDaysStr(d.days),
        memo: d.memo
      }));
    });
    renderAll();
    toast('예시 식재료 7개를 넣었어요. 지우고 쓰셔도 돼요.');
  }

  function resetData() {
    if (state.cloud.enabled) {
      toast('가족 공유를 먼저 해제해 주세요. (설정 → 가족 공유 → 연결 해제)');
      return;
    }
    confirmSheet({
      title: '전체 삭제',
      message: '이 폰에 저장된 식재료·장보기·보관함 설정을 모두 지웁니다. 되돌릴 수 없어요.',
      confirmText: '모두 지우기',
      danger: true,
      onConfirm: function () {
        state.storages = defaultStorages();
        state.items = [];
        state.shopping = [];
        state.spaceFilter = 'all';
        state.quickFilter = 'all';
        state.search = '';
        saveLocal();
        var si = $('searchInput');
        if (si) { si.value = ''; }
        renderAll();
        toast('모두 지웠어요');
      }
    });
  }

  function installApp() {
    if (state.deferredPrompt) {
      state.deferredPrompt.prompt();
      state.deferredPrompt.userChoice.then(function () {
        state.deferredPrompt = null;
      });
      return;
    }
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua);
    var msg = isIOS
      ? 'Safari 하단의 공유 버튼(□↑)을 누르고 ‘홈 화면에 추가’를 선택하세요.'
      : 'Chrome 우측 상단 ⋮ 메뉴에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택하세요.';
    var html = sheetHead('홈 화면에 추가') +
      '<p class="sheet-note" style="font-size:14px;color:var(--text-soft)">' + FU.esc(msg) + '</p>' +
      '<p class="hint">홈 화면에 추가하면 주소창 없이 앱처럼 열리고, 인터넷이 잠깐 끊겨도 마지막 화면이 열립니다.</p>' +
      '<div class="sheet-actions"><button type="button" class="btn primary" data-close="1">알겠어요</button></div>';
    openSheet(html);
  }

  /* ============================================================
     이벤트 연결
     ============================================================ */
  function bindEvents() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        switchView(e.currentTarget.getAttribute('data-view'));
      });
    }

    $('fab').addEventListener('click', function () {
      if (state.view === 'shopping') {
        var inp = $('shopInput');
        if (inp) { inp.focus(); }
        return;
      }
      openAddSheet('direct');
    });

    var cards = document.querySelectorAll('.sum-card');
    for (var c = 0; c < cards.length; c++) {
      cards[c].addEventListener('click', function (e) {
        var k = e.currentTarget.getAttribute('data-summary');
        state.quickFilter = (state.quickFilter === k) ? 'all' : k;
        if (k === 'all') { state.quickFilter = 'all'; }
        renderSummaries();
        renderFilterBanner();
        renderItems();
      });
    }

    $('btnClearFilter').addEventListener('click', function () {
      state.quickFilter = 'all';
      renderSummaries();
      renderFilterBanner();
      renderItems();
    });

    $('storageChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-space]');
      if (!b) { return; }
      state.spaceFilter = b.getAttribute('data-space');
      renderChips();
      renderItems();
    });

    var searchTimer = null;
    $('searchInput').addEventListener('input', function (e) {
      var v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.search = v;
        renderItems();
      }, 140);
    });

    $('sortSelect').addEventListener('change', function (e) {
      state.sort = e.target.value;
      renderItems();
    });

    $('itemList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) { return; }
      var act = b.getAttribute('data-act');
      var id = b.getAttribute('data-id');
      if (act === 'inc') { changeQty(id, 1); }
      else if (act === 'dec') { changeQty(id, -1); }
      else if (act === 'edit') {
        var it = itemById(id);
        if (it) { openDirectSheet(it); }
      } else if (act === 'add') { openAddSheet('direct'); }
      else if (act === 'demo') { demoData(); }
      else if (act === 'reset-filter') {
        state.quickFilter = 'all';
        state.spaceFilter = 'all';
        state.search = '';
        $('searchInput').value = '';
        renderSummaries();
        renderFilterBanner();
        renderChips();
        renderItems();
      }
    });

    $('shopForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var inp = $('shopInput');
      var name = FU.trim(inp.value);
      if (!name) { return; }
      addShoppingItem(name);
      inp.value = '';
      inp.focus();
      renderDataStat();
    });

    $('shopList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) { return; }
      var act = b.getAttribute('data-act');
      var id = b.getAttribute('data-id');
      var s = shoppingById(id);
      if (!s) { return; }
      if (act === 'toggle') {
        s.checked = !s.checked;
        s.updatedAt = FU.nowIso();
        saveShopping(s);
        renderShopping();
      } else if (act === 'del') {
        removeShopping(id);
        renderShopping();
        renderDataStat();
      } else if (act === 'intake') {
        openIntakeSheet(id);
      }
    });

    $('shopCheckoutAll').addEventListener('click', checkoutAllShopping);

    /* 설정 */
    $('btnSaveCloud').addEventListener('click', function () {
      state.settings.sbUrl = FU.trim($('sbUrl').value);
      state.settings.sbKey = FU.trim($('sbKey').value);
      state.settings.sbCode = FU.trim($('sbCode').value);
      saveSettings();
      cloud.connect();
    });

    $('btnSyncNow').addEventListener('click', function () { cloud.sync(true); });
    $('btnSyncNowTop').addEventListener('click', function () {
      if (state.cloud.enabled) { cloud.sync(true); }
      else { toast('지금은 이 폰에만 저장 중이에요. 설정에서 가족 공유를 연결할 수 있어요.'); }
    });

    $('btnDisconnect').addEventListener('click', function () {
      confirmSheet({
        title: '가족 공유 해제',
        message: '이 폰은 이제 혼자 저장해요. 서버에 있는 가족 데이터는 그대로 남고, 이 폰의 데이터도 그대로 남습니다.',
        confirmText: '해제',
        danger: true,
        onConfirm: function () { cloud.disconnect(); }
      });
    });

    $('btnGenCode').addEventListener('click', function () {
      var code = 'home-' + Math.random().toString(36).slice(2, 8);
      $('sbCode').value = code;
      toast('공유 코드를 만들었어요. 다른 폰에도 똑같이 입력하세요.');
    });

    $('btnCopySql').addEventListener('click', function () {
      INT.copyText(INT.SCHEMA_SQL).then(function () {
        toast('SQL을 복사했어요. Supabase SQL Editor에 붙여넣고 RUN 하세요.');
      }).catch(function () {
        toast('복사에 실패했어요. SQL 칸을 길게 눌러 직접 복사해 주세요.');
      });
    });

    $('btnCopySchemaFile').addEventListener('click', function () {
      try { window.open('schema.sql', '_blank'); } catch (e) { toast('schema.sql 파일을 열 수 없어요.'); }
    });

    $('btnSaveKey').addEventListener('click', function () {
      var v = FU.trim($('geminiKey').value);
      state.settings.geminiKey = v;
      saveSettings();
      renderSettings();
      toast(v ? 'Gemini 키를 저장했어요. 영수증 인식에 쓸 수 있어요.' : '키를 비웠어요.');
    });
    $('btnClearKey').addEventListener('click', function () {
      state.settings.geminiKey = '';
      saveSettings();
      renderSettings();
      toast('Gemini 키를 지웠어요.');
    });

    $('btnAddSpace').addEventListener('click', function () { openSpaceSheet(null); });

    $('spaceList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) { return; }
      var sp = spaceById(b.getAttribute('data-id'));
      if (!sp) { return; }
      if (b.getAttribute('data-act') === 'rename') { openSpaceSheet(sp); }
      else { deleteSpace(sp.id); }
    });

    $('btnExport').addEventListener('click', exportData);
    $('btnImport').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) { importData(f); }
      e.target.value = '';
    });
    $('btnDemo').addEventListener('click', demoData);
    $('btnReset').addEventListener('click', resetData);
    $('btnInstall').addEventListener('click', installApp);

    $('sheetOverlay').addEventListener('click', function (e) {
      if (e.target === $('sheetOverlay')) { closeSheet(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeSheet(); }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.cloud.enabled) { cloud.sync(false); }
    });

    global.addEventListener('online', function () {
      if (state.cloud.enabled) { cloud.sync(false); }
    });
    global.addEventListener('offline', function () {
      if (state.cloud.enabled) { setCloudStatus('error', '인터넷이 끊겼어요. 연결되면 자동으로 다시 맞춥니다.'); }
    });

    global.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      state.deferredPrompt = e;
    });

    global.addEventListener('scroll', function () {
      document.body.classList.toggle('scrolled', (global.scrollY || 0) > 4);
    }, { passive: true });
  }

  /* ============================================================
     시작
     ============================================================ */
  function registerSW() {
    if (!('serviceWorker' in navigator)) { return; }
    if (!/^https?:$/.test(location.protocol)) { return; }
    global.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* 오프라인 미지원 */ });
    });
  }

  function handleUrl() {
    try {
      var p = new URLSearchParams(location.search);
      var v = p.get('view');
      if (v && (v === 'fridge' || v === 'shopping' || v === 'settings')) { switchView(v); }
      if (p.get('action') === 'add') {
        setTimeout(function () { openAddSheet('direct'); }, 200);
      }
    } catch (e) { /* noop */ }
  }

  function boot() {
    loadSettings();
    loadLocal();
    cloud.load();
    bindEvents();
    $('sortSelect').value = state.sort;
    renderAll();
    renderSettings();
    handleUrl();
    registerSW();

    if (state.cloud.enabled) {
      cloud.client = INT.makeClient(state.settings.sbUrl, state.settings.sbKey);
      setTimeout(function () { cloud.sync(false); }, 300);
      cloud.startPolling();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.App = {
    state: state,
    renderAll: renderAll,
    openAddSheet: openAddSheet,
    saveItem: saveItem,
    makeItem: makeItem,
    parse: INT.parseReceiptText,
    cloud: cloud
  };

}(typeof window !== 'undefined' ? window : this));
