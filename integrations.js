/* ============================================================
   우리집 냉장고 — integrations.js
   공용 유틸 · 식재료 사전 · 영수증 파싱 · Gemini · Tesseract ·
   Supabase REST 클라이언트 · Supabase 스키마 SQL
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- utils ---------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDaysStr(days, base) {
    var d = base ? parseDate(base) : new Date();
    if (!d) { d = new Date(); }
    d.setDate(d.getDate() + Number(days || 0));
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseDate(s) {
    if (!s) { return null; }
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) { return null; }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function daysLeft(expiry) {
    var e = parseDate(expiry);
    if (!e) { return null; }
    var t = parseDate(todayStr());
    return Math.round((e.getTime() - t.getTime()) / 86400000);
  }

  function shortDate(s) {
    var d = parseDate(s);
    if (!d) { return ''; }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    var rnd;
    try {
      if (global.crypto && global.crypto.randomUUID) {
        rnd = global.crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      }
    } catch (e) { rnd = null; }
    if (!rnd) { rnd = Math.random().toString(36).slice(2, 10); }
    return (prefix || 'it') + '_' + Date.now().toString(36) + rnd.slice(0, 6);
  }

  function nowIso() { return new Date().toISOString(); }

  function fmtQty(n) {
    var v = Number(n);
    if (!isFinite(v)) { return '0'; }
    v = Math.round(v * 100) / 100;
    return String(v);
  }

  function trimStr(s) { return String(s === null || s === undefined ? '' : s).trim(); }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function copyText(text) {
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; });
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        resolve(ok);
      } catch (e) { reject(e); }
    });
  }

  /* ---------------- 식재료 사전 ----------------
     unit: 기본 단위 / space: 기본 보관함 / days: 기본 유통기한(일) */
  var FOOD_DB = [
    { name: '달걀', unit: '개', space: '냉장실', days: 21, keys: ['달걀', '계란', '에그', '난각'] },
    { name: '우유', unit: '개', space: '냉장실', days: 7, keys: ['우유', '밀크'] },
    { name: '두부', unit: '모', space: '냉장실', days: 7, keys: ['두부'] },
    { name: '대파', unit: '단', space: '냉장실', days: 10, keys: ['대파'] },
    { name: '쪽파', unit: '단', space: '냉장실', days: 7, keys: ['쪽파', '실파'] },
    { name: '양파', unit: '개', space: '실온', days: 20, keys: ['양파'] },
    { name: '감자', unit: '개', space: '실온', days: 20, keys: ['감자'] },
    { name: '고구마', unit: '개', space: '실온', days: 20, keys: ['고구마'] },
    { name: '당근', unit: '개', space: '냉장실', days: 21, keys: ['당근'] },
    { name: '오이', unit: '개', space: '냉장실', days: 7, keys: ['오이'] },
    { name: '애호박', unit: '개', space: '냉장실', days: 10, keys: ['애호박', '호박'] },
    { name: '토마토', unit: '개', space: '냉장실', days: 7, keys: ['토마토'] },
    { name: '양배추', unit: '통', space: '냉장실', days: 14, keys: ['양배추'] },
    { name: '상추', unit: '봉', space: '냉장실', days: 5, keys: ['상추'] },
    { name: '시금치', unit: '봉', space: '냉장실', days: 5, keys: ['시금치'] },
    { name: '버섯', unit: '팩', space: '냉장실', days: 7, keys: ['버섯', '표고', '느타리', '새송이'] },
    { name: '콩나물', unit: '봉', space: '냉장실', days: 5, keys: ['콩나물'] },
    { name: '숙주', unit: '봉', space: '냉장실', days: 4, keys: ['숙주'] },
    { name: '마늘', unit: '개', space: '냉장실', days: 30, keys: ['마늘'] },
    { name: '생강', unit: '개', space: '냉장실', days: 30, keys: ['생강'] },
    { name: '청양고추', unit: '개', space: '냉장실', days: 14, keys: ['청양', '고추'] },
    { name: '돼지고기', unit: 'g', space: '냉동실', days: 30, keys: ['돼지', '삼겹', '목살', '앞다리', '보쌈'] },
    { name: '소고기', unit: 'g', space: '냉동실', days: 30, keys: ['소고기', '한우', '불고기', '차돌'] },
    { name: '닭고기', unit: 'g', space: '냉동실', days: 30, keys: ['닭가슴살', '닭다리', '닭고기', '닭'] },
    { name: '베이컨', unit: '팩', space: '냉장실', days: 7, keys: ['베이컨'] },
    { name: '소시지', unit: '팩', space: '냉장실', days: 10, keys: ['소시지', '비엔나', '핫도그'] },
    { name: '햄', unit: '팩', space: '냉장실', days: 10, keys: ['햄'] },
    { name: '고등어', unit: '팩', space: '냉동실', days: 30, keys: ['고등어', '갈치', '조기', '생선'] },
    { name: '연어', unit: '팩', space: '냉동실', days: 30, keys: ['연어'] },
    { name: '새우', unit: '팩', space: '냉동실', days: 30, keys: ['새우'] },
    { name: '김치', unit: '통', space: '김치냉장고', days: 30, keys: ['김치'] },
    { name: '깍두기', unit: '통', space: '김치냉장고', days: 30, keys: ['깍두기'] },
    { name: '장아찌', unit: '통', space: '김치냉장고', days: 60, keys: ['장아찌'] },
    { name: '밥', unit: '개', space: '냉동실', days: 14, keys: ['햇반', '즉석밥', '밥'] },
    { name: '만두', unit: '봉', space: '냉동실', days: 60, keys: ['만두'] },
    { name: '피자', unit: '판', space: '냉동실', days: 90, keys: ['피자'] },
    { name: '아이스크림', unit: '개', space: '냉동실', days: 90, keys: ['아이스크림'] },
    { name: '식빵', unit: '개', space: '실온', days: 5, keys: ['식빵', '빵'] },
    { name: '라면', unit: '봉', space: '실온', days: 60, keys: ['라면'] },
    { name: '우동', unit: '개', space: '냉동실', days: 30, keys: ['우동'] },
    { name: '파스타', unit: '개', space: '실온', days: 180, keys: ['파스타', '스파게티'] },
    { name: '쌀', unit: 'kg', space: '실온', days: 180, keys: ['쌀'] },
    { name: '밀가루', unit: 'kg', space: '실온', days: 180, keys: ['밀가루'] },
    { name: '설탕', unit: 'kg', space: '실온', days: 365, keys: ['설탕'] },
    { name: '소금', unit: 'kg', space: '실온', days: 365, keys: ['소금'] },
    { name: '간장', unit: '병', space: '실온', days: 180, keys: ['간장'] },
    { name: '된장', unit: '통', space: '냉장실', days: 90, keys: ['된장'] },
    { name: '고추장', unit: '통', space: '냉장실', days: 90, keys: ['고추장'] },
    { name: '참기름', unit: '병', space: '실온', days: 180, keys: ['참기름', '들기름'] },
    { name: '식용유', unit: '병', space: '실온', days: 180, keys: ['식용유', '카놀라', '올리브유'] },
    { name: '참치캔', unit: '개', space: '실온', days: 365, keys: ['참치'] },
    { name: '치즈', unit: '팩', space: '냉장실', days: 14, keys: ['치즈'] },
    { name: '버터', unit: '개', space: '냉장실', days: 30, keys: ['버터'] },
    { name: '요거트', unit: '개', space: '냉장실', days: 10, keys: ['요거트', '요구르트'] },
    { name: '생크림', unit: 'ml', space: '냉장실', days: 7, keys: ['생크림'] },
    { name: '사과', unit: '개', space: '냉장실', days: 21, keys: ['사과'] },
    { name: '바나나', unit: '개', space: '실온', days: 5, keys: ['바나나'] },
    { name: '귤', unit: '개', space: '냉장실', days: 14, keys: ['귤', '오렌지'] },
    { name: '딸기', unit: '팩', space: '냉장실', days: 3, keys: ['딸기'] },
    { name: '포도', unit: '송이', space: '냉장실', days: 7, keys: ['포도'] },
    { name: '수박', unit: '통', space: '냉장실', days: 5, keys: ['수박'] },
    { name: '음료', unit: '병', space: '냉장실', days: 14, keys: ['주스', '콜라', '사이다', '음료', '생수'] },
    { name: '맥주', unit: '병', space: '냉장실', days: 30, keys: ['맥주'] },
    { name: '소주', unit: '병', space: '실온', days: 365, keys: ['소주'] }
  ];

  var QUICK_NAMES = ['달걀', '우유', '두부', '대파', '양파', '돼지고기', '닭고기', '김치', '사과', '바나나', '만두', '치즈'];

  function findFood(name) {
    if (!name) { return null; }
    var best = null;
    for (var i = 0; i < FOOD_DB.length; i++) {
      var f = FOOD_DB[i];
      for (var j = 0; j < f.keys.length; j++) {
        var k = f.keys[j];
        if (name.indexOf(k) >= 0) {
          if (!best || k.length > best.len) { best = { food: f, len: k.length }; }
        }
      }
    }
    return best ? best.food : null;
  }

  function foodByName(name) {
    for (var i = 0; i < FOOD_DB.length; i++) {
      if (FOOD_DB[i].name === name) { return FOOD_DB[i]; }
    }
    return findFood(name);
  }

  /* ---------------- 영수증 텍스트 파싱 ---------------- */
  var SKIP_RE = /^(합계|총액|총\s*매|소계|부가세|과세|면세|받을|받은|결제|카드|현금|잔액|포인트|적립|할인|승인|거래|사업자|대표|주소|전화|영수증|매출|일시|시간|pos|쿠폰|배달|봉투|비닐|세일|행사|단가|수량|품목|금액|no\.?|tel|fax|www|http|주문|번호|일자|매장|지점|고객|회원)/i;
  var SKIP_ANY = /(영수증|마트|마켓|슈퍼|편의점|코스트코|이마트|홈플러스|매장|지점|사업자|대표자|전화|주소|합계|총액|부가세|과세|면세|결제|카드|현금|잔액|적립|할인|승인|쿠폰|배달|봉투|비닐)/;
  var UNIT_RE = /(개|입|팩|봉|병|모|단|장|판|통|캔|컵|송이|kg|g|ml|l|매|박스|세트)$/i;

  function cleanName(s) {
    return String(s || '')
      .replace(/[\[\]{}<>]/g, ' ')
      .replace(/[^가-힣a-zA-Z0-9()%+\-\.\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseReceiptText(text) {
    if (!text) { return []; }
    var lines = String(text).replace(/\r/g, '\n').split(/\n+/);
    var rows = [];
    var seen = {};

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (!raw) { continue; }
      var line = raw.replace(/[\u200b\ufeff]/g, '')
        .replace(/[|│┃¦]/g, ' ')
        .replace(/[·•※]/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!line) { continue; }
      if (line.length < 2) { continue; }
      if (SKIP_RE.test(line)) { continue; }
      if (SKIP_ANY.test(line)) { continue; }

      // 꼬리표·구분선
      line = line.replace(/^[\-=*_.~\s]+|[\-=*_.~\s]+$/g, '').trim();
      // 품목 번호
      line = line.replace(/^\d{1,3}\s*[\.\)]\s*/, '').trim();
      // 가격류 제거 (1,200 / 12000원 / 3,500)
      line = line.replace(/(\d{1,3}(,\d{3})+|\d{4,7})\s*원?/g, ' ').trim();
      // 수량 표기 x2, *2, 2개
      var qty = 1, unit = '';
      var qm = line.match(/(?:x|\*|X)\s*(\d{1,3})\s*$/);
      if (qm) {
        qty = Number(qm[1]);
        line = line.slice(0, qm.index).trim();
      }
      // 끝에 붙은 수량+단위: "우유 2개", "대파 1단"
      var um = line.match(/(\d+(?:\.\d+)?)\s*(개|입|팩|봉|병|모|단|장|판|통|캔|컵|송이|kg|g|ml|L|매|박스|세트)$/i);
      if (um) {
        qty = Number(um[1]);
        unit = um[2];
        line = line.slice(0, um.index).trim();
      } else {
        // 끝의 단위만: "우유 1L" 같은 표기는 이름에 남기고 수량 1
        var um2 = line.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|L)$/i);
        if (um2) {
          qty = Number(um2[1]);
          unit = um2[2];
          line = line.slice(0, um2.index).trim();
        }
      }
      // 남은 꼬리 숫자 (수량 열)
      var tail = line.match(/\s(\d{1,3})$/);
      if (tail && !unit) {
        qty = Number(tail[1]);
        line = line.slice(0, tail.index).trim();
      }
      line = line.replace(/^[\-*·\s]+|[\-*·\s]+$/g, '').trim();
      var name = cleanName(line);
      if (!name) { continue; }
      if (!/[가-힣a-zA-Z]/.test(name)) { continue; }
      if (name.length > 24) { name = name.slice(0, 24).trim(); }
      if (name.replace(/\s/g, '').length < 2) { continue; }

      var key = name.replace(/\s/g, '').toLowerCase();
      if (seen[key]) {
        seen[key].qty = seen[key].qty + qty;
        continue;
      }

      var food = findFood(name);
      var row = {
        name: name,
        qty: qty > 0 ? qty : 1,
        unit: unit || (food ? food.unit : '개'),
        spaceName: food ? food.space : '냉장실',
        days: food ? food.days : 7,
        checked: true
      };
      seen[key] = row;
      rows.push(row);
      if (rows.length >= 60) { break; }
    }
    return rows;
  }

  /* ---------------- Gemini 영수증 인식 ---------------- */
  function extractJson(text) {
    if (!text) { return null; }
    var t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s >= 0 && e > s) { t = t.slice(s, e + 1); }
    try { return JSON.parse(t); } catch (err) { return null; }
  }

  var GEMINI_PROMPT = [
    '이 이미지는 한국 마트·편의점 영수증 사진이다.',
    '영수증에서 실제로 구입한 "식재료·식품" 품목만 뽑아라.',
    '봉투, 비닐, 배달비, 할인, 적립, 합계, 부가세, 카드결제, 매장 정보는 제외한다.',
    '각 품목에 대해 다음 필드를 채운다:',
    '- name: 품목명 (한국어, 브랜드명은 빼고 식재료 위주로, 예: "서울우유 1L" → "우유")',
    '- quantity: 수량 (숫자, 모르면 1)',
    '- unit: 단위 (개, g, kg, 팩, 봉, 병, 모, 단, 통, 판, ml, L 중 하나)',
    '- storage: 보관 추천 ("냉장실", "냉동실", "김치냉장고", "실온" 중 하나)',
    '- shelf_life_days: 오늘 구입 기준 예상 유통기한 일수 (정수, 예: 우유 7, 달걀 21, 돼지고기 30, 김치 30, 라면 60)',
    '출력은 {"items":[{"name":"우유","quantity":1,"unit":"개","storage":"냉장실","shelf_life_days":7}]} 형태의 JSON만. 설명 문장은 쓰지 마라.'
  ].join('\n');

  function geminiModels() { return ['gemini-2.5-flash', 'gemini-2.0-flash']; }

  function friendlyHttpError(status, body) {
    var b = String(body || '');
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(b)) {
      return 'Gemini API 키가 올바르지 않아요. 설정에서 키를 다시 확인해 주세요.';
    }
    if (status === 403) { return 'Gemini API 사용 권한이 없어요. Google AI Studio에서 키 상태를 확인해 주세요.'; }
    if (status === 429) { return 'Gemini 무료 사용량을 잠시 넘었어요. 잠시 뒤 다시 시도해 주세요.'; }
    if (status === 404) { return '이 모델을 사용할 수 없어요(404). 다른 모델로 다시 시도해 주세요.'; }
    if (status >= 500) { return 'Gemini 서버가 잠시 불안정해요. 잠시 뒤 다시 시도해 주세요.'; }
    return 'Gemini 요청 실패 (HTTP ' + status + ') ' + b.slice(0, 140);
  }

  async function geminiExtract(imageDataUrl, apiKey) {
    if (!imageDataUrl) { throw new Error('영수증 사진을 먼저 올려 주세요.'); }
    if (!apiKey) { throw new Error('Gemini API 키가 없어요. 설정에서 키를 저장하거나 OCR로 시도해 주세요.'); }

    var comma = imageDataUrl.indexOf(',');
    if (comma < 0) { throw new Error('이미지를 읽지 못했어요. 다른 사진으로 시도해 주세요.'); }
    var head = imageDataUrl.slice(0, comma);
    var b64 = imageDataUrl.slice(comma + 1);
    var mimeMatch = head.match(/data:([^;]+)/);
    var mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    var body = {
      contents: [{
        parts: [
          { text: GEMINI_PROMPT },
          { inline_data: { mime_type: mime, data: b64 } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 3000, responseMimeType: 'application/json' }
    };

    var models = geminiModels();
    var lastErr = null;

    for (var i = 0; i < models.length; i++) {
      var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] +
        ':generateContent?key=' + encodeURIComponent(apiKey);
      var res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (netErr) {
        throw new Error('Gemini에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
      }
      if (!res.ok) {
        var txt = '';
        try { txt = await res.text(); } catch (e2) { txt = ''; }
        if (res.status === 400 || res.status === 404) {
          lastErr = new Error(friendlyHttpError(res.status, txt));
          continue;
        }
        throw new Error(friendlyHttpError(res.status, txt));
      }
      var data = await res.json();
      var cand = data && data.candidates && data.candidates[0];
      var parts = cand && cand.content && cand.content.parts ? cand.content.parts : [];
      var out = '';
      for (var p = 0; p < parts.length; p++) {
        if (parts[p] && parts[p].text) { out += parts[p].text; }
      }
      var parsed = extractJson(out);
      if (!parsed || !parsed.items || !parsed.items.length) {
        throw new Error('영수증에서 품목을 찾지 못했어요. 사진을 밝게 다시 찍거나 텍스트로 붙여넣어 주세요.');
      }
      return normalizeAiRows(parsed.items);
    }
    throw lastErr || new Error('영수증 인식에 실패했어요.');
  }

  function normalizeAiRows(items) {
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var name = cleanName(it.name || it.item || '');
      if (!name) { continue; }
      var food = findFood(name);
      var unit = trimStr(it.unit) || (food ? food.unit : '개');
      var qty = Number(it.quantity);
      if (!isFinite(qty) || qty <= 0) { qty = 1; }
      var space = trimStr(it.storage || it.space);
      if (['냉장실', '냉동실', '김치냉장고', '실온', '팬트리'].indexOf(space) < 0) {
        space = food ? food.space : '냉장실';
      }
      if (space === '팬트리') { space = '실온'; }
      var days = Number(it.shelf_life_days);
      if (!isFinite(days) || days < 0 || days > 3650) { days = food ? food.days : 7; }
      rows.push({
        name: name,
        qty: qty,
        unit: unit,
        spaceName: space,
        days: Math.round(days),
        checked: true
      });
      if (rows.length >= 60) { break; }
    }
    return rows;
  }

  /* ---------------- 이미지 / OCR ---------------- */
  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('사진을 읽지 못했어요.')); };
      fr.readAsDataURL(file);
    });
  }

  function shrinkImage(dataUrl, maxSide, quality) {
    var max = maxSide || 1400;
    var q = quality || 0.85;
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width;
            var h = img.naturalHeight || img.height;
            var scale = Math.min(1, max / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * scale));
            var ch = Math.max(1, Math.round(h * scale));
            var canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, cw, ch);
            resolve(canvas.toDataURL('image/jpeg', q));
          } catch (e) {
            resolve(dataUrl);
          }
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      } catch (e) {
        resolve(dataUrl);
      }
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-src', src);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('OCR 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')); };
      document.head.appendChild(s);
    });
  }

  var OCR_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  async function ocrImage(dataUrl, onProgress) {
    await loadScript(OCR_CDN);
    if (!global.Tesseract || !global.Tesseract.createWorker) {
      throw new Error('OCR 엔진을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    }
    var worker = await global.Tesseract.createWorker('kor+eng', 1, {
      logger: function (m) {
        if (onProgress && m && m.status) {
          onProgress(m.status, m.progress);
        }
      }
    });
    try {
      var res = await worker.recognize(dataUrl);
      var text = res && res.data ? (res.data.text || '') : '';
      if (!text.trim()) { throw new Error('글자를 읽지 못했어요. 사진을 밝게 다시 찍어 주세요.'); }
      return text;
    } finally {
      try { await worker.terminate(); } catch (e) { /* noop */ }
    }
  }

  /* ---------------- Supabase REST 클라이언트 ---------------- */
  function makeClient(rawUrl, key) {
    var base = String(rawUrl || '').replace(/\/+$/, '') + '/rest/v1/';
    function headers(extra) {
      var h = {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      };
      if (extra) {
        for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { h[k] = extra[k]; } }
      }
      return h;
    }
    function req(path, opts) {
      var o = opts || {};
      o.headers = headers(o.headers || {});
      return fetch(base + path, o).then(function (res) {
        if (res.ok) {
          if (res.status === 204) { return null; }
          var ct = res.headers.get('content-type') || '';
          if (ct.indexOf('json') >= 0) { return res.json(); }
          return res.text();
        }
        return res.text().then(function (txt) {
          var err = new Error('HTTP ' + res.status + (txt ? ' · ' + txt.slice(0, 160) : ''));
          err.status = res.status;
          err.body = txt;
          throw err;
        });
      });
    }
    return {
      select: function (table, familyCode) {
        return req(table + '?family_code=eq.' + encodeURIComponent(familyCode) + '&select=*', { method: 'GET' });
      },
      upsert: function (table, rows) {
        return req(table + '?on_conflict=id', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows)
        });
      },
      remove: function (table, id) {
        return req(table + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
      },
      ping: function () {
        return req('storage_spaces?select=id&limit=1', { method: 'GET' });
      }
    };
  }

  /* ---------------- Supabase 스키마 SQL ---------------- */
  var SCHEMA_SQL = [
    '-- 우리집 냉장고 · Supabase 테이블 정의',
    '-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 RUN 하세요.',
    '-- (프로젝트 생성 후 1회만 실행하면 됩니다)',
    '',
    'create table if not exists public.storage_spaces (',
    '  id          text primary key,',
    '  family_code text not null,',
    '  name        text not null,',
    "  icon        text default '📦',",
    '  sort_order  integer default 0,',
    '  created_at  timestamptz default now(),',
    '  updated_at  timestamptz default now()',
    ');',
    '',
    'create table if not exists public.fridge_items (',
    '  id          text primary key,',
    '  family_code text not null,',
    '  name        text not null,',
    '  space_id    text,',
    '  quantity    numeric default 1,',
    "  unit        text default '개',",
    '  expiry      date,',
    "  memo        text default '',",
    '  created_at  timestamptz default now(),',
    '  updated_at  timestamptz default now()',
    ');',
    '',
    'create table if not exists public.shopping_items (',
    '  id          text primary key,',
    '  family_code text not null,',
    '  name        text not null,',
    '  quantity    numeric default 1,',
    "  unit        text default '개',",
    '  checked     boolean default false,',
    '  created_at  timestamptz default now(),',
    '  updated_at  timestamptz default now()',
    ');',
    '',
    'create index if not exists storage_spaces_family_idx on public.storage_spaces (family_code);',
    'create index if not exists fridge_items_family_idx on public.fridge_items (family_code);',
    'create index if not exists shopping_items_family_idx on public.shopping_items (family_code);',
    '',
    'alter table public.storage_spaces enable row level security;',
    'alter table public.fridge_items enable row level security;',
    'alter table public.shopping_items enable row level security;',
    '',
    'drop policy if exists "family storage" on public.storage_spaces;',
    'create policy "family storage" on public.storage_spaces',
    '  for all to anon, authenticated using (true) with check (true);',
    '',
    'drop policy if exists "family fridge" on public.fridge_items;',
    'create policy "family fridge" on public.fridge_items',
    '  for all to anon, authenticated using (true) with check (true);',
    '',
    'drop policy if exists "family shopping" on public.shopping_items;',
    'create policy "family shopping" on public.shopping_items',
    '  for all to anon, authenticated using (true) with check (true);',
    '',
    'grant select, insert, update, delete on public.storage_spaces to anon, authenticated;',
    'grant select, insert, update, delete on public.fridge_items to anon, authenticated;',
    'grant select, insert, update, delete on public.shopping_items to anon, authenticated;',
    '',
    '-- updated_at 자동 갱신',
    'create or replace function public.touch_updated_at()',
    'returns trigger as $$',
    'begin',
    '  new.updated_at = now();',
    '  return new;',
    'end;',
    '$$ language plpgsql;',
    '',
    'drop trigger if exists trg_touch_storage on public.storage_spaces;',
    'create trigger trg_touch_storage before update on public.storage_spaces',
    '  for each row execute function public.touch_updated_at();',
    '',
    'drop trigger if exists trg_touch_fridge on public.fridge_items;',
    'create trigger trg_touch_fridge before update on public.fridge_items',
    '  for each row execute function public.touch_updated_at();',
    '',
    'drop trigger if exists trg_touch_shopping on public.shopping_items;',
    'create trigger trg_touch_shopping before update on public.shopping_items',
    '  for each row execute function public.touch_updated_at();',
    '',
    '-- 참고: 가족 공유는 "공유 코드"로만 구분하는 간단한 구조입니다.',
    '-- 같은 URL·Anon Key를 아는 사람은 다른 가족 코드도 조회할 수 있으니,',
    '-- 집 안에서 쓰는 가벼운 용도로만 사용하세요.'
  ].join('\n');

  global.FU = {
    pad2: pad2,
    todayStr: todayStr,
    addDaysStr: addDaysStr,
    parseDate: parseDate,
    daysLeft: daysLeft,
    shortDate: shortDate,
    esc: esc,
    uid: uid,
    nowIso: nowIso,
    fmtQty: fmtQty,
    trim: trimStr,
    debounce: debounce,
    copyText: copyText
  };

  global.Integrations = {
    FOOD_DB: FOOD_DB,
    QUICK_NAMES: QUICK_NAMES,
    findFood: findFood,
    foodByName: foodByName,
    parseReceiptText: parseReceiptText,
    extractJson: extractJson,
    geminiExtract: geminiExtract,
    ocrImage: ocrImage,
    fileToDataUrl: fileToDataUrl,
    shrinkImage: shrinkImage,
    makeClient: makeClient,
    SCHEMA_SQL: SCHEMA_SQL,
    OCR_CDN: OCR_CDN
  };

}(typeof window !== 'undefined' ? window : this));
