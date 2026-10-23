"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../app-core.js");

const base = [
  "企業コード,お仕事NO,応募日,応募者名,応募媒体,仕事名,職種,就業形態,勤務地名1",
  "YAMATO,JOB001,2026/10/01,山田太郎,Indeed,配送スタッフ,配送,アルバイト,千葉営業所"
].join("\r\n");
const report = [
  "配信日,応募数",
  "合計,5",
  "2026/10/01,3",
  "2026/10/02,0",
  "2026/10/03,2"
].join("\r\n");

function merge(normalText = base, airText = report, overrides = {}) {
  return Core.mergeApplications({
    normal: Core.parseCsv(normalText),
    airwork: Core.parseCsv(airText),
    companyCode: "YAMATO",
    ...overrides
  });
}
function value(row, headers, name) { return row[headers.indexOf(name)]; }

test("AirWork total row is not counted and each application expands to one row", () => {
  const result = merge();
  assert.equal(result.stats.normalCount, 1);
  assert.equal(result.stats.addedCount, 5);
  assert.equal(result.stats.outputCount, 6);
  assert.deepEqual(result.byDay.map(item => item.count), [3,0,2]);
  assert.equal(result.rows.filter(row => value(row, result.headers, "応募日") === "2026/10/02").length, 0);
});
test("the original row is preserved and appended fields are blank", () => {
  const result = merge();
  assert.deepEqual(result.headers.slice(0,9), Core.parseCsv(base).headers);
  assert.deepEqual(result.rows[0].slice(0,9), Core.parseCsv(base).rows[0]);
  assert.equal(value(result.rows[0], result.headers, "対応状況"), "");
});
test("generated records contain a separate job without guessed personal details", () => {
  const result = merge();
  const row = result.rows[1];
  assert.equal(value(row, result.headers, "お仕事NO"), "AIRWORK_ONLY");
  assert.equal(value(row, result.headers, "企業コード"), "YAMATO");
  assert.equal(value(row, result.headers, "応募日"), "2026/10/01");
  assert.equal(value(row, result.headers, "応募媒体"), "AirWork");
  assert.equal(value(row, result.headers, "応募者名"), "");
  assert.equal(value(row, result.headers, "職種"), "AirWork（詳細不明）");
  assert.equal(value(row, result.headers, "就業形態"), "AirWork（詳細不明）");
  assert.equal(value(row, result.headers, "勤務地名1"), "AirWork（詳細不明）");
});
test("a CSV with only 応募日時 maps dates correctly", () => {
  const source = base.replace("応募日,", "応募日時,");
  const result = merge(source);
  assert.equal(value(result.rows[1], result.headers, "応募日時"), "2026/10/01");
});
test("a CSV with both date columns gets the same generated date", () => {
  const source = base.replace("応募日,", "応募日時,応募日,").replace("2026/10/01,山田", "2026/10/01,2026/10/01,山田");
  const result = merge(source);
  assert.equal(value(result.rows[1],result.headers,"応募日時"),"2026/10/01");
  assert.equal(value(result.rows[1],result.headers,"応募日"),"2026/10/01");
});
test("CSV parser handles escaped quotes, comma, line break, and BOM", () => {
  const data = Core.parseCsv('\uFEFF名前,説明\n"姓,名","2行\n目の""説明"""');
  assert.deepEqual(data.rows[0], ["姓,名", '2行\n目の"説明"']);
  assert.deepEqual(Core.parseCsv(Core.serializeCsv(data)), data);
});
test("UTF-8 with BOM is decoded", () => {
  const bytes = new TextEncoder().encode("\uFEFF配信日,応募数\n2026/10/01,1");
  const decoded = Core.decodeCsv(bytes);
  assert.equal(decoded.encoding, "UTF-8");
  assert.equal(Core.parseCsv(decoded.text).rows[0][1], "1");
});
test("Shift_JIS is decoded", () => {
  // 配信日,応募数\n2026/10/01,1 encoded in CP932.
  const bytes = Buffer.from([0x94,0x7a,0x90,0x4d,0x93,0xfa,0x2c,0x89,0x9e,0x95,0xe5,0x90,0x94,0x0a,0x32,0x30,0x32,0x36,0x2f,0x31,0x30,0x2f,0x30,0x31,0x2c,0x31]);
  const decoded = Core.decodeCsv(bytes);
  assert.equal(decoded.encoding,"Shift_JIS");
  assert.equal(Core.parseCsv(decoded.text).rows[0][1],"1");
});
test("multiple daily records for one date combine without losing counts", () => {
  const output = merge(base, "配信日,応募数\n合計,3\n2026/10/01,1\n2026/10/01,2");
  assert.equal(output.stats.addedCount,3);
  assert.equal(output.stats.duplicateDays,1);
  assert.equal(output.byDay.length,1);
});
test("multiple company input requires explicit company selection", () => {
  const source = base + "\nOTHER,JOB2,2026/10/02,佐藤,他媒体,軽作業,軽作業,パート,他営業所";
  const info = Core.analyzeNormal(Core.parseCsv(source));
  assert.equal(info.companies.length,2);
  assert.throws(() => merge(source,report,{companyCode:""}), /企業コード/);
});
test("validates negative, fractional, missing, and mismatching counts", () => {
  for (const text of [
    "配信日,応募数\n2026/10/01,-1",
    "配信日,応募数\n2026/10/01,1.5",
    "配信日,応募数\n2026/10/01,",
    "配信日,応募数\n合計,2\n2026/10/01,3"
  ]) assert.throws(() => merge(base,text), /応募数|一致/);
});
test("validates impossible or malformed dates", () => {
  for (const d of ["2026/02/29","2026/13/01","2026/10/01 00:00:00","10/01/2026"]) {
    assert.throws(() => merge(base,"配信日,応募数\n"+d+",1"), /配信日/);
  }
});
test("rejects missing required input headers", () => {
  assert.throws(() => merge(base.replace("お仕事NO","仕事番号")),/お仕事NO/);
  assert.throws(() => merge(base,"日付,応募数\n2026/10/01,2"),/配信日/);
});
test("rejects duplicate attachment when the same virtual job exists", () => {
  const first = merge();
  assert.throws(() => Core.mergeApplications({
    normal:Core.parseCsv(Core.serializeCsv(first)),
    airwork:Core.parseCsv(report), companyCode:"YAMATO"
  }),/二重追加/);
});
test("collides with the existing job only for the selected company", () => {
  assert.throws(() => merge(base, report,{virtualJobNo:"JOB001"}),/二重追加/);
  assert.doesNotThrow(() => merge(base, report,{virtualJobNo:"AW_NOT_EXISTING"}));
});
test("keeps unknown source columns and quoted original cells", () => {
  const source = base.replace("勤務地名1", "勤務地名1,補足").replace("千葉営業所", '"千葉,営業所","改行\nあり"');
  const result = merge(source);
  assert.equal(value(result.rows[0],result.headers,"補足"),"改行\nあり");
  assert.equal(value(result.rows[1],result.headers,"補足"),"");
  assert.deepEqual(Core.parseCsv(Core.serializeCsv(result)).rows, result.rows);
});
