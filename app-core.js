"use strict";
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AirworkAttachCore = api;
})(typeof window !== "undefined" ? window : null, function makeCore() {
"use strict";
function fail(message) { throw new Error(message); }
function clean(value) { return String(value == null ? "" : value).trim(); }
function parseCsv(text) {
  const source = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  if (!source.trim()) fail("CSVが空です。");
  const records = [];
  let row = [], field = "", quoted = false, justClosed = false;
  function pushField() { row.push(field); field = ""; justClosed = false; }
  function pushRow() {
    pushField();
    if (row.some(cell => clean(cell) !== "")) records.push(row);
    row = [];
  }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; justClosed = true; }
      } else { field += ch; }
    } else if (justClosed) {
      if (ch === ",") pushField();
      else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && source[i + 1] === "\n") i++;
        pushRow();
      } else if (ch !== " " && ch !== "\t") {
        fail("CSVの引用符直後に想定外の文字があります（" + (records.length + 1) + "行付近）。");
      }
    } else if (ch === '"' && field === "") { quoted = true; }
    else if (ch === '"') { fail("CSVの引用符の位置が不正です（" + (records.length + 1) + "行付近）。"); }
    else if (ch === ",") pushField();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      pushRow();
    } else { field += ch; }
  }
  if (quoted) fail("CSVの引用符が閉じられていません。");
  if (row.length || field !== "" || justClosed) pushRow();
  if (!records.length) fail("CSVの見出し行がありません。");
  const headers = records.shift().map(clean);
  if (headers.some(h => !h)) fail("CSVの見出しに空欄があります。");
  if (new Set(headers).size !== headers.length) fail("CSVの見出しに同名の列があります。");
  const rows = records.map((fields, i) => {
    if (fields.length > headers.length) fail("CSVの" + (i + 2) + "行目に見出しより多くの列があります。");
    return headers.map((_, j) => fields[j] == null ? "" : fields[j]);
  });
  return {headers, rows};
}
function serializeCsv(data) {
  const values = [data.headers, ...data.rows];
  return values.map(row => row.map(value => {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }).join(",")).join("\r\n") + "\r\n";
}
function decodeCsv(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  try { return {text: new TextDecoder("utf-8", {fatal: true}).decode(bytes), encoding: "UTF-8"}; }
  catch (_) {
    try { return {text: new TextDecoder("shift_jis", {fatal: true}).decode(bytes), encoding: "Shift_JIS"}; }
    catch (_) { fail("文字コードを判定できません。UTF-8またはShift_JISのCSVを選んでください。"); }
  }
}
function index(headers, aliases) {
  for (const label of aliases) {
    const found = headers.indexOf(label);
    if (found !== -1) return found;
  }
  return -1;
}
function valueAt(row, headers, aliases) {
  for (const alias of aliases) {
    const n = headers.indexOf(alias);
    if (n >= 0 && clean(row[n])) return clean(row[n]);
  }
  return "";
}
function fieldsPresent(headers, aliases) { return aliases.some(name => headers.includes(name)); }
function normalizeJobNo(v) { return clean(v).toUpperCase().replace(/_[0-9]{3,8}$|§.*/g, ""); }
function analyzeNormal(normal) {
  const headers = normal.headers || [];
  if (!headers.includes("お仕事NO")) fail("通常応募CSVには「お仕事NO」列が必要です。応募CSV_A形式を選んでください。");
  const required = [
    [["企業コード", "企業ID"], "企業コード または 企業ID"],
    [["応募日時", "応募日"], "応募日時 または 応募日"],
    [["氏名", "応募者名"], "氏名 または 応募者名"]
  ];
  for (const [aliases, label] of required) {
    if (!fieldsPresent(headers, aliases)) fail("通常応募CSVに必要な列がありません：" + label);
  }
  const totals = new Map();
  for (const row of normal.rows) {
    const company = valueAt(row, headers, ["企業コード", "企業ID"]);
    if (company) totals.set(company, (totals.get(company) || 0) + 1);
  }
  if (!totals.size) fail("通常応募CSVから企業コードを取得できません。");
  return {count: normal.rows.length, companies: Array.from(totals, ([code, count]) => ({code, count}))};
}
function dateString(value) {
  const match = clean(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) fail("配信日の形式が不正です：" + value + "（例：2026/10/01）");
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() + 1 !== m || utc.getUTCDate() !== d)
    fail("存在しない配信日です：" + value);
  return String(y).padStart(4, "0") + "/" + String(m).padStart(2, "0") + "/" + String(d).padStart(2, "0");
}
function quantity(value, rowLabel) {
  const raw = clean(value).replace(/,/g, "");
  if (!/^\d+$/.test(raw)) fail(rowLabel + "の応募数は0以上の整数で指定してください：" + value);
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) fail(rowLabel + "の応募数が大きすぎます。");
  return count;
}
function analyzeAirwork(airwork) {
  const dateIx = index(airwork.headers, ["配信日"]);
  const countIx = index(airwork.headers, ["応募数"]);
  if (dateIx < 0 || countIx < 0) fail("AirWork実績CSVには「配信日」「応募数」列が必要です。");
  const counts = new Map();
  let reported = null;
  let entries = 0;
  for (let i = 0; i < airwork.rows.length; i++) {
    const row = airwork.rows[i];
    const rawDate = clean(row[dateIx]);
    const rawCount = clean(row[countIx]);
    if (/^(合計|総計|total)$/i.test(rawDate)) {
      if (reported !== null) fail("合計行が複数あります。");
      reported = quantity(rawCount, "合計行");
      continue;
    }
    if (!rawDate && !rawCount) continue;
    if (!rawDate) fail("AirWork実績CSVの" + (i + 2) + "行目に配信日がありません。");
    const day = dateString(rawDate);
    const count = quantity(rawCount, day);
    counts.set(day, (counts.get(day) || 0) + count);
    entries++;
  }
  if (!entries) fail("AirWork実績CSVに日別データがありません。");
  const byDay = Array.from(counts, ([date, count]) => ({date, count})).sort((a, b) => a.date.localeCompare(b.date));
  const total = byDay.reduce((sum, entry) => sum + entry.count, 0);
  if (!Number.isSafeInteger(total)) fail("応募数の合計が大きすぎます。");
  if (reported !== null && reported !== total)
    fail("合計行の応募数（" + reported + "）と日別応募数の合計（" + total + "）が一致しません。");
  return {byDay, count: total, sourceRows: entries, hasTotalRow: reported !== null, duplicateDays: entries - byDay.length};
}
function mergeApplications(options) {
  const normal = options.normal;
  const airwork = options.airwork;
  const normalInfo = analyzeNormal(normal);
  const airworkInfo = analyzeAirwork(airwork);
  const company = clean(options.companyCode);
  const companyInfo = normalInfo.companies.find(item => item.code === company);
  if (!companyInfo) fail("企業コードを通常応募CSVの候補から選択してください。");
  const jobNo = clean(options.virtualJobNo || "AIRWORK_ONLY");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(jobNo))
    fail("仮想仕事番号は英字で始まる60文字以内の半角英数字・_・-で指定してください。");
  const jobKey = normalizeJobNo(jobNo);
  for (const row of normal.rows) {
    const existingCompany = valueAt(row, normal.headers, ["企業コード", "企業ID"]);
    const existingJob = valueAt(row, normal.headers, ["仕事番号", "お仕事NO"]);
    if (existingCompany.toUpperCase() === company.toUpperCase() && normalizeJobNo(existingJob) === jobKey)
      fail("通常応募CSVに同じ企業・仮想仕事番号（" + jobNo + "）があります。二重追加を防ぐため処理を中止しました。元のCSVを使うか、番号を変更してください。");
  }
  const headers = normal.headers.slice();
  const ensureColumn = (aliases, canonical) => { if (!fieldsPresent(headers, aliases)) headers.push(canonical); };
  ensureColumn(["応募媒体", "応募媒体名"], "応募媒体");
  ensureColumn(["対応状況", "応募者対応ステータス（企業）"], "対応状況");
  ensureColumn(["仕事名"], "仕事名");
  ensureColumn(["職種"], "職種");
  ensureColumn(["雇用形態", "就業形態"], "雇用形態");
  ensureColumn(["求人勤務地名称", "勤務地名1"], "求人勤務地名称");
  ensureColumn(["募集背景"], "募集背景");
  const rows = normal.rows.map(row => [...row, ...Array(headers.length - normal.headers.length).fill("")]);
  function put(row, aliases, content) {
    for (const alias of aliases) {
      const pos = headers.indexOf(alias);
      if (pos >= 0) row[pos] = content;
    }
  }
  if (rows.length + airworkInfo.count > 250000) fail("統合後の応募行数が25万件を超えます。ファイルを分割してください。");
  for (const day of airworkInfo.byDay) {
    for (let i = 0; i < day.count; i++) {
      const row = Array(headers.length).fill("");
      put(row, ["企業コード", "企業ID"], company);
      put(row, ["仕事番号", "お仕事NO"], jobNo);
      put(row, ["応募日時", "応募日"], day.date);
      put(row, ["応募媒体", "応募媒体名"], "AirWork");
      put(row, ["対応状況", "応募者対応ステータス（企業）"], "AirWork（状況未取得）");
      put(row, ["仕事名"], "AirWork（応募実績）");
      put(row, ["職種"], "AirWork（詳細不明）");
      put(row, ["雇用形態", "就業形態"], "AirWork（詳細不明）");
      put(row, ["求人勤務地名称", "勤務地名1"], "AirWork（詳細不明）");
      put(row, ["募集背景"], "AirWork（詳細不明）");
      put(row, ["性別"], "不明");
      rows.push(row);
    }
  }
  return {
    headers, rows, byDay: airworkInfo.byDay,
    stats: {
      normalCount: normalInfo.count, addedCount: airworkInfo.count,
      outputCount: rows.length, companyCode: company, virtualJobNo: jobNo,
      dayCount: airworkInfo.byDay.length, duplicateDays: airworkInfo.duplicateDays,
      hasTotalRow: airworkInfo.hasTotalRow, appendedStartIndex: normalInfo.count
    }
  };
}
return {parseCsv, serializeCsv, decodeCsv, analyzeNormal, analyzeAirwork, mergeApplications};
});
