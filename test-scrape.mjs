/**
 * 스크래퍼 판독 로직 테스트.
 *
 * 이 컨테이너에서는 바깥 사이트를 못 읽으므로(403), 실제로 겪었던 형식들을
 * 고정 문자열로 박아두고 파서만 검증한다. 여기서 통과해야 Actions 에서 믿을 수 있다.
 */
import { verdict, datedVerdicts, decide, addDays, NO_GUESS_DAYS, BACKREAD_DAYS } from "./scripts/scrape.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)); };
const TODAY = "2026-08-30";

console.log("\n[1] 하루치 헤드라인 판독");
ok(verdict("<p>Balloons flew 05:30-09:30 this morning.</p>") === "flew", "운항 시간대가 적히면 운항");
ok(verdict("<p>SHGM has cancelled flights today. All zones closed.</p>") === "cancelled", "취소 문구 → 취소");
ok(verdict("<p>Flights flew 05:40. Window closed after 09:30.</p>") === "flew",
  '"closed after 09:30" 은 취소가 아니다 (8/27 을 뒤집었던 버그)');
ok(verdict("<p>Nothing to see here.</p>") === null, "근거가 없으면 판단하지 않음");
ok(verdict("<p>flights are operating and flyable today</p>") === "flew", "운항 문구 → 운항");

console.log("\n[2] 날짜별 지난 판정 판독");
{
  const html = `<table>
    <tr><td>28 Aug</td><td>Flights cancelled — high winds aloft</td></tr>
    <tr><td>29 Aug</td><td>No flights, all zones closed</td></tr>
    <tr><td>27 Aug</td><td>Balloons flew this morning</td></tr>
  </table>`;
  const g = datedVerdicts(html, TODAY);
  ok(g["2026-08-28"] === "cancelled", "28 Aug → 취소");
  ok(g["2026-08-29"] === "cancelled", "29 Aug → 취소");
  ok(g["2026-08-27"] === "flew", "27 Aug → 운항");
  ok(Object.keys(g).length === 3, `군더더기 없이 3일만 (${Object.keys(g).length}일)`);
}
{
  const g = datedVerdicts("<p>Aug 24 — flights were cancelled</p>", TODAY);
  ok(g["2026-08-24"] === "cancelled", '"Aug 24" 처럼 월이 앞에 와도 읽는다');
}

console.log("\n[3] 예보를 실측으로 착각하지 않는다");
{
  // epicturkeytravel 의 실제 형식. 이건 예보지 판정이 아니다.
  const fc = `Fri · 28 Aug — Aloft (~2,000 m): 4.3 kt ❌ Flight Unlikely`;
  ok(Object.keys(datedVerdicts(fc, TODAY)).length === 0, '"Flight Unlikely" 는 예보라 무시');
  ok(Object.keys(datedVerdicts("Sat 29 Aug 52% Moderate Risk", TODAY)).length === 0,
    "확률·위험도 표기는 예보라 무시");
  ok(Object.keys(datedVerdicts("Sun 30 Aug — cancellation risk low", TODAY)).length === 0,
    '"risk" 가 붙으면 예보로 본다');
  ok(Object.keys(datedVerdicts("Mon 31 Aug — likely to fly", TODAY)).length === 0,
    '"likely" 는 예보라 무시');
}

console.log("\n[4] 안전장치");
{
  ok(Object.keys(datedVerdicts("5 Sep — flights cancelled", TODAY)).length === 0,
    "오늘보다 미래 날짜는 버린다");
  const g = datedVerdicts("<p>28 Aug flights cancelled</p><p>28 Aug balloons flew</p>", TODAY);
  ok(g["2026-08-28"] === undefined, "같은 날에 모순된 문구가 있으면 아예 버린다");
  const g2 = datedVerdicts("<p>28 Aug — sunny and calm</p>", TODAY);
  ok(g2["2026-08-28"] === undefined, "판정 문구가 없으면 기록하지 않음");
  const g3 = datedVerdicts("28 Dec — flights cancelled", "2026-01-15");
  ok(g3["2025-12-28"] === "cancelled", "연말/연초를 넘어가면 작년으로 넘긴다");
}

console.log("\n[5] 기존 기록을 언제 덮을 것인가");
{
  const V = v => [{ site: "a", v }, { site: "b", v }];
  const MIX = [{ site: "a", v: "flew" }, { site: "b", v: "cancelled" }, { site: "c", v: "cancelled" }];

  ok(decide(V("cancelled"), null).action === "write", "빈 날짜에는 기록한다");
  ok(decide(V("cancelled"), { s: "flew", src: "auto" }).action === "write", "짐작(auto)은 실측으로 덮는다");
  ok(decide(V("flew"), { s: "cancelled", src: "official" }).action === "skip",
    "공식 기록은 절대 덮지 않는다");
  ok(decide(V("flew"), { s: "cancelled", src: "manual" }).action === "skip",
    "사용자가 직접 넣은 기록은 절대 덮지 않는다 (제일 중요)");
  ok(decide([{ site: "a", v: "flew" }, { site: "b", v: "cancelled" }], null).action === "skip",
    "찬반 동수면 아무것도 안 쓴다");
  ok(decide(MIX, null).rec.agree === false, "의견이 갈리면 agree=false 로 남겨둔다");
  ok(decide(V("flew"), { s: "cancelled", src: "scrape", agree: false }).action === "fix",
    "지난번 불일치 기록은 이번 만장일치로 정정한다");
  ok(decide(V("flew"), { s: "cancelled", src: "scrape", agree: true }).action === "skip",
    "지난번이 만장일치였다면 뒤집지 않는다 (핑퐁 방지)");
  ok(decide(MIX, { s: "flew", src: "scrape", agree: false }).action === "skip",
    "이번에도 갈리면 그대로 둔다");
}

console.log("\n[6] 짐작 금지 구간");
ok(NO_GUESS_DAYS === 14 && BACKREAD_DAYS === 14, "최근 14일은 짐작 금지 · 매 실행마다 재시도");

console.log("\n[7] 날짜 유틸");
ok(addDays("2026-08-30", -14) === "2026-08-16", "14일 전");
ok(addDays("2026-03-01", -1) === "2026-02-28", "월 경계");
ok(addDays("2026-01-01", -1) === "2025-12-31", "연 경계");

console.log(`\n${fail ? `실패 ${fail}건` : "전부 통과"} (${pass}건)`);
process.exit(fail ? 1 : 0);
