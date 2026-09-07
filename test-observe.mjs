/**
 * 실측 수집기 판독 테스트. 2026-09-07 에 실제로 확인한 문구를 그대로 박아뒀다.
 */
import { parseSHM, parseRaw } from "./scripts/observe.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)); };

const sector = (name, state, upd, win, cls) => `
  <div class="sector"><h3>${name}</h3><span class="${cls}"></span>
    <p>Meteorological conditions have been considered ${state} for flight for the set margin of time.</p>
    <p>Date and hour of update : ${upd}</p>
    <p>Relevant date and margin of hours : ${win}</p></div>`;
const area = (n, state, upd, win, cls) => `
  <div class="area"><h3>${n}.AREA</h3><span class="${cls}"></span>
    <p>Meteorological conditions have been considered ${n}.AREA is ${state} For secondary flights.</p>
    <p>Date and hour of update : ${upd}</p><p>Relevant date and margin of hours : ${win}</p></div>`;

console.log("\n[1] SHM — 전 구역 불가 (2026-09-07 실제 페이지 형태)");
{
  const U = "07.09.2026 - 09:04", W = "08.09.2026 - 02:45 - 16:05";
  const html = "<html><body><h2>Meteorological Data and Assessment</h2>" +
    sector("SECTOR A", "unsuitable", U, W, "red-flag") + sector("SECTOR B", "unsuitable", U, W, "red-flag") +
    sector("SECTOR C", "unsuitable", U, W, "red-flag") +
    [2, 3, 4, 5].map(n => area(n, "unsuitable", U, W, "red-flag")).join("") + "</body></html>";
  const s = parseSHM(html);
  ok(s && s.verdict === "cancelled", "A/B/C 전부 불가 → cancelled");
  ok(s.date === "2026-09-08", `해당 날짜는 '해당 시간'의 날짜 (${s.date}) — 전날 미리 올라온 판정`);
  ok(s.updated === "2026-09-07T09:04:00+03:00", `갱신 시각 ISO (${s.updated})`);
  ok(s.sectors["SECTOR A"].from === "02:45" && s.sectors["SECTOR A"].to === "16:05", "해당 시간 구간");
  ok(s.mainNo === 3 && s.mainYes === 0, "구역 집계");
  ok(s.flags.filter(f => f === "red").length === 7, "깃발 색 7개 모두 red");
  ok(s.sectors["2.AREA"].state === "no", "보조 구역도 판독");
}

console.log("\n[2] SHM — 일부 구역만 가능");
{
  const U = "08.09.2026 - 04:10", W = "08.09.2026 - 02:45 - 16:05";
  const html = sector("SECTOR A", "suitable", U, W, "green-flag") + sector("SECTOR B", "unsuitable", U, W, "red-flag") +
    sector("SECTOR C", "suitable", U, W, "green-flag");
  const s = parseSHM(html);
  ok(s.verdict === "flew", "한 구역이라도 가능하면 flew (일부 운항)");
  ok(s.mainYes === 2 && s.mainNo === 1, `집계 가능 ${s.mainYes} · 불가 ${s.mainNo}`);
  ok(s.updated.slice(0, 10) === s.date, "당일 갱신 = 확정 판정으로 취급될 조건");
}

console.log("\n[3] SHM — 안전장치");
{
  ok(parseSHM("<html><body>Login page</body></html>") === null, "구역 정보 없으면 null");
  const s = parseSHM(sector("SECTOR A", "considered", "07.09.2026 - 09:04", "08.09.2026 - 02:45 - 16:05", ""));
  ok(s && s.verdict === null, "suitable/unsuitable 둘 다 없으면 판정 보류");
  // "unsuitable" 안에 "suitable" 이 들어 있다 — 순서가 중요
  const s2 = parseSHM(sector("SECTOR A", "unsuitable", "07.09.2026 - 09:04", "08.09.2026 - 02:45 - 16:05", "red-flag"));
  ok(s2.sectors["SECTOR A"].state === "no", '"unsuitable" 을 "suitable" 로 오독하지 않음');
}

console.log("\n[4] METAR 원문 판독");
{
  const a = parseRaw("METAR LTAZ 070650Z 03014G25KT 350V060 9999 SCT035 21/09 Q1024");
  ok(a.sknt === 14 && a.gust === 25 && a.drct === 30, `풍속 14 돌풍 25 풍향 030 (${JSON.stringify(a)})`);
  ok(a.vsby === 9999 && a.sky === "SCT" && a.base === 3500, "시정 9999m · 구름 SCT 3500ft");
  ok(a.tmpc === 21 && a.dwpc === 9, "기온 21 이슬점 9");
  const b = parseRaw("METAR LTAZ 070250Z VRB02KT CAVOK 19/06 Q1022");
  ok(b.sknt === 2 && b.drct === null && b.gust === null, "VRB02KT → 풍향 없음, 돌풍 없음");
  ok(b.vsby === 10000 && b.sky === undefined, "CAVOK → 시정 10km 이상, 구름 없음");
  const c = parseRaw("METAR LTAZ 150350Z 24006KT 0800 FG VV001 M02/M03 Q1030");
  ok(c.vsby === 800 && c.tmpc === -2 && c.dwpc === -3, "안개 800m · 영하 기온 (M02/M03)");
  const d = parseRaw("METAR LTAZ 070950Z 01010KT 9999 BKN035 24/07 Q1023");
  ok(d.sknt === 10 && d.sky === "BKN", "BKN 판독");
}

console.log(`\n${fail ? `실패 ${fail}건` : "전부 통과"} (${pass}건)`);
process.exit(fail ? 1 : 0);
