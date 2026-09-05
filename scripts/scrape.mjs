/**
 * 매일 1회 실행되어 카파도키아 벌룬 운항 여부를 기록한다.
 * 서버(GitHub Actions)에서 돌기 때문에 CORS 제약이 없다 — 사이트를 직접 읽는다.
 *
 *   1) 상태 사이트 여러 곳을 읽어 다수결 → src:"scrape"
 *   2) 판독 실패한 과거 날짜는 Open-Meteo 실황으로 자동 추정 → src:"auto"
 *   3) 사람이 손으로 넣은 기록(src:"manual"/"official")은 절대 덮지 않는다
 *
 * 결과는 data/log.json 에 누적된다.
 */
import { readFile, writeFile } from "node:fs/promises";

const LAT = 38.6431, LON = 34.8289, TZ = "Europe/Istanbul";

/* 자동 추정 기준이 바뀌면 이 숫자를 올린다.
   그러면 예전 기준으로 찍어둔 auto 기록을 다음 실행 때 알아서 다시 계산한다.
   (사람이 넣은 기록과 사이트에서 읽어온 기록은 절대 건드리지 않는다) */
const EST_VERSION = 4;   // 앱과 계산 일치화 (900/800hPa·저층운량 추가)
const OUT = new URL("../data/log.json", import.meta.url);

/* 최근 이 기간은 날씨 짐작으로 채우지 않는다 (앱의 NO_GUESS_DAYS 와 같은 값).
   기상 신호가 전혀 없는데 취소되는 날이 실제로 있다(2026-08-28: 지상 2kt·시정 39.9km).
   짐작으로 메우면 최신 구간이 틀린 채 굳고, 앱에서는 실측처럼 보인다. */
const NO_GUESS_DAYS = 14;

/* 하루치만 긁으면 그날 실패한 순간 그 날짜는 영영 비어버린다.
   매 실행마다 최근 이 기간에서 아직 실측이 없는 날을 다시 시도한다. */
const BACKREAD_DAYS = 14;

const SITES = [
  { name: "balloonstatus", url: "https://balloonstatus.com/" },          // 홈이 "flew 05:30–09:30" 을 보여줘 오독이 적다
  { name: "balloonstatus2", url: "https://balloonstatus.com/cappadocia/today/" },
  // ToursCE 는 Cloudflare 가 서버 요청을 403 으로 막는다. 다른 곳과 값도 가장 많이 어긋나 제외.
  { name: "epicturkey",    url: "https://epicturkeytravel.com/cappadocia-balloon-flight-status/" }
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HDRS = {
  "user-agent": UA,
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache"
};
const pad = n => String(n).padStart(2, "0");
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* 앱과 동일한 일출 계산 (NOAA) */
function sunriseLocal(dateStr){
  const [Y,M,Dd] = dateStr.split("-").map(Number);
  const rad = Math.PI/180;
  const JD = Date.UTC(Y,M-1,Dd)/864e5 + 2440587.5;        // 그날 00:00 UTC 의 율리우스일
  const n = Math.ceil(JD - 2451545.0 + 0.0008);
  const Jstar = n - LON/360;                            // 동경일수록 남중이 이르다
  const Msun = (357.5291 + 0.98560028*Jstar) % 360;
  const C = 1.9148*Math.sin(Msun*rad) + 0.02*Math.sin(2*Msun*rad) + 0.0003*Math.sin(3*Msun*rad);
  const lam = (Msun + C + 180 + 102.9372) % 360;
  const Jtransit = 2451545.0 + Jstar + 0.0053*Math.sin(Msun*rad) - 0.0069*Math.sin(2*lam*rad);
  const decl = Math.asin(Math.sin(lam*rad) * Math.sin(23.4397*rad));
  const cosW = (Math.sin(-0.833*rad) - Math.sin(LAT*rad)*Math.sin(decl)) /
               (Math.cos(LAT*rad)*Math.cos(decl));
  if(cosW > 1 || cosW < -1) return null;
  const w = Math.acos(cosW)/rad;
  const ms = ((Jtransit - w/360) - 2440587.5)*864e5 + 3*3600e3;   // 터키는 연중 UTC+3
  const d = new Date(ms);
  return dateStr + "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}


const todayLocal = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
};

/* 본문에서 운항/취소 판정. 예보 문단의 단어까지 세지 않도록 상단만 본다.
 *
 * 주의: "closed after 09:30" 은 그날 운항 시간대가 끝났다는 뜻이지 취소가 아니다.
 * 늦은 시각에 긁으면 정상 운항한 날이 통째로 '취소'로 뒤집힌다.
 * 실제로 2026-08-27 이 그렇게 잘못 기록됐다(현지 확인 결과 운항).
 */
function verdict(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const head = text.slice(0, 2500);

  // 실제 비행 시간대가 적혀 있으면 그날은 뜬 것이다. 다른 단어보다 우선한다.
  if (/flew\s+\d{1,2}:\d{2}/.test(head) || /flew this morning/.test(head)) return "flew";

  // 운항창 종료 표현은 취소와 무관하므로 세지 않는다
  const cleaned = head
    .replace(/closed\s+after[^a-z]{0,12}\d{1,2}:\d{2}/g, " ")
    .replace(/window\s+closed/g, " ");

  const neg = (cleaned.match(/cancell?ed|no flights?|not flying|grounded|iptal|zones? (are )?closed|all (three )?(flight )?zones/g) || []).length;
  const pos = (cleaned.match(/flew|flying|are operating|flyable|will fly|flights operate/g) || []).length;
  if (!neg && !pos) return null;
  if (neg === pos) return null;
  return neg > pos ? "cancelled" : "flew";
}

/* 날짜가 붙은 '지난 판정' 표를 읽는다.
 *
 * 하루치 헤드라인만 보는 방식은 그날 한 번 실패하면 복구가 안 된다.
 * 여기서는 "28 Aug ... cancelled" 처럼 날짜와 결과가 가까이 붙은 것만 집어낸다.
 *
 * 예보 문구(likely / unlikely / marginal / risk / 62%)는 판정이 아니므로 반드시 걸러낸다.
 * 이것을 실측으로 착각하면 모델 채점이 통째로 오염된다.
 */
const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const MONWORD = "january|february|march|april|may|june|july|august|september|october|november|december" +
                "|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const FORECASTY = /likely|unlikely|marginal|probabilit|risk|chance|forecast|expect|\d\s*%/;
const PAST_NEG = /cancell?ed|did not fly|no flights?|not flying|grounded|iptal|zones? closed/;
const PAST_POS = /\bflew\b|flights? operated|operated normally|flights? took off/;

function isoFrom(monName, day, today) {
  const m = MON[String(monName).slice(0, 3).toLowerCase()];
  if (!m || !day || day < 1 || day > 31) return null;
  let y = +today.slice(0, 4);
  // 연도 표기가 없다. 오늘보다 두 달 이상 미래로 나오면 작년 것이다.
  if ((new Date(`${y}-${pad(m)}-${pad(day)}`) - new Date(today)) / 864e5 > 60) y -= 1;
  return `${y}-${pad(m)}-${pad(day)}`;
}

function datedVerdicts(html, today) {
  const t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ")
    .toLowerCase();

  // 1) 날짜가 나오는 자리를 전부 찾는다. 뒤 문장은 아직 먹지 않는다
  //    (먹어버리면 그 안에 들어 있는 다음 날짜를 통째로 놓친다 — 표 형식이 딱 그렇다)
  const dre = new RegExp(`(?:(\\d{1,2})\\s+(${MONWORD})|(${MONWORD})\\s+(\\d{1,2}))\\b`, "g");
  const hits = [];
  let m;
  while ((m = dre.exec(t))) {
    const iso = m[1] ? isoFrom(m[2], +m[1], today) : isoFrom(m[3], +m[4], today);
    if (iso) hits.push({ iso, start: m.index, end: dre.lastIndex });
  }

  // 2) 각 날짜 뒤 ~120자, 단 다음 날짜가 먼저 나오면 거기서 끊는다
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.iso > today) continue;
    const stop = Math.min(h.end + 120, i + 1 < hits.length ? hits[i + 1].start : t.length);
    const tail = t.slice(h.end, stop);
    if (FORECASTY.test(tail)) continue;                 // 예보 문구는 판정이 아니다
    const neg = PAST_NEG.test(tail), pos = PAST_POS.test(tail);
    if (neg === pos) continue;                          // 둘 다거나 둘 다 아니면 버린다
    const v = neg ? "cancelled" : "flew";
    if (h.iso in out && out[h.iso] !== v) { out[h.iso] = null; continue; }  // 모순 → 폐기
    if (out[h.iso] !== null) out[h.iso] = v;
  }
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/* 한 날짜에 모인 표들을 놓고 무엇을 할지 정한다.
   기존 기록을 언제 덮어도 되는지가 핵심이라 따로 떼어 테스트한다. */
function decide(votes, prev) {
  const flew = votes.filter(v => v.v === "flew").length;
  const canc = votes.length - flew;
  const list = votes.map(v => `${v.site}=${v.v}`).join(" / ");
  // 찬반 동수 — 어느 쪽으로도 찍지 않는다. 틀린 정답을 넣으면 모델 채점이 오염된다.
  if (flew === canc) return { action: "skip", why: `의견이 ${list} 로 갈려 기록하지 않음` };

  const agree = flew === 0 || canc === 0;
  const rec = { s: flew > canc ? "flew" : "cancelled", src: "scrape", agree,
                note: votes.map(v => `${v.site}:${v.v}`).join(", ") };

  // 사람이 넣은 기록은 무슨 일이 있어도 덮지 않는다
  if (prev && (prev.src === "official" || prev.src === "manual"))
    return { action: "skip", why: `직접 확인한 기록(${prev.s})이 있어 건드리지 않음` };

  if (!prev || prev.src === "auto")
    return { action: "write", rec, why: `${rec.s}${agree ? "" : " (일부 불일치)"}` };

  // 지난번엔 의견이 갈렸는데 이번엔 만장일치로 다르게 나왔다면 고친다
  if (prev.src === "scrape" && prev.agree === false && agree && prev.s !== rec.s)
    return { action: "fix", rec, why: `정정 ${prev.s} → ${rec.s} (이번엔 만장일치)` };

  return { action: "skip", why: `이미 ${prev.s} 로 기록됨` };
}

async function fetchText(url) {
  const r = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

/* 판정 경계값. 앱은 기후값 계산에서 나온 s0 를 쓴다(연 223일 운항에 맞춰 보정된 값).
   스크래퍼가 제멋대로 1.9 를 쓰면 앱과 결과가 어긋나고, 실제로 취소일을 하나도 못 잡았다. */
async function loadS0() {
  try {
    const j = JSON.parse(await readFile(new URL("../data/climatology.json", import.meta.url), "utf8"));
    if (j && typeof j.s0 === "number") { console.log(`판정 경계값 s0=${j.s0.toFixed(3)} (기후값 파일)`); return j.s0; }
  } catch { }
  console.log("기후값 파일이 없어 기본 경계값 1.23 사용");
  return 1.23;
}

/* Open-Meteo 실황으로 과거 날짜 자동 추정.
 *
 * 중요: 여기 계산은 앱(index.html) 및 climatology.mjs 와 "완전히 같아야" 한다.
 * 예전엔 850hPa 하나만 받고 저층운량도 빼먹은 간이 버전이라, 같은 날을 앱은 취소로
 * 보는데 스크래퍼는 운항으로 찍는 일이 생겼다. 변수 목록과 판정식을 그대로 맞췄다.
 */
const VARSETS = [
  ["wind_speed_10m","wind_gusts_10m","precipitation","cloud_cover_low","visibility",
   "temperature_2m","dew_point_2m","wind_speed_900hPa","wind_speed_850hPa","wind_speed_800hPa"],
  ["wind_speed_10m","wind_gusts_10m","precipitation","temperature_2m","dew_point_2m","wind_speed_850hPa"],
  ["wind_speed_10m","wind_gusts_10m","precipitation","temperature_2m","dew_point_2m"]
];

function featuresOf(hourly, list, sr) {
  const srMin = +sr.slice(11, 13) * 60 + +sr.slice(14, 16);
  const lo = srMin - 105, hi = srMin + 120;      // 일출 -45분 ~ +2시간 (1시간 해상도 여유)
  const g = n => hourly[n] || null;
  const A = {
    w10: g("wind_speed_10m"), gu: g("wind_gusts_10m"), pr: g("precipitation"),
    ccl: g("cloud_cover_low"), vi: g("visibility"), t2: g("temperature_2m"), td: g("dew_point_2m"),
    w900: g("wind_speed_900hPa"), w850: g("wind_speed_850hPa"), w800: g("wind_speed_800hPa")
  };
  let w10 = -1, gu = -1, wal = -1, pr = 0, vi = null, cclS = 0, n = 0, dewDep = null, w10s = 0;
  for (const { i, min } of list) {
    if (min < lo || min > hi) continue;
    n++;
    const mx = (arr, cur) => (arr && arr[i] != null) ? Math.max(cur, arr[i]) : cur;
    w10 = mx(A.w10, w10); gu = mx(A.gu, gu);
    wal = mx(A.w900, wal); wal = mx(A.w850, wal); wal = mx(A.w800, wal);
    if (A.pr && A.pr[i] != null) pr += A.pr[i];
    if (A.vi && A.vi[i] != null) vi = vi == null ? A.vi[i] : Math.min(vi, A.vi[i]);
    if (A.ccl && A.ccl[i] != null) cclS += A.ccl[i];
    if (A.t2 && A.td && A.t2[i] != null && A.td[i] != null) {
      const dd = A.t2[i] - A.td[i]; dewDep = dewDep == null ? dd : Math.min(dewDep, dd);
    }
    if (A.w10 && A.w10[i] != null) w10s = A.w10[i];
  }
  if (!n || w10 < 0) return null;
  if (gu < 0) gu = w10 * 1.5;
  return { w10, gu, wal: wal < 0 ? null : wal, llj: wal >= 0 ? Math.max(0, wal - w10) : null,
           dewDep, pr, vi, ccl: n ? cclS / n : null, w10s };
}

function severityOf(f) {
  if (!f) return null;
  const over = (x, t, sc) => x == null ? 0 : Math.max(0, (x - t) / sc);
  let s = 0;
  s += over(f.w10, 10, 2.5) * 2.0;      // 규정 지상 10kt
  s += over(f.gu, 15, 4);
  s += over(f.wal, 16, 5) * 1.5;        // 비행 고도대 (900~800hPa 중 최대)
  s += over(f.llj, 8, 4) * 1.2;         // 저층 제트
  if (f.pr > 0.2) s += 3.5;
  if (f.vi != null) { if (f.vi < 2000) s += 3.5; else if (f.vi < 5000) s += 1.0; }
  if (f.dewDep != null && f.dewDep < 2.2 && f.w10s < 7) s += 1.5;
  if (f.ccl != null && f.ccl > 70) s += 0.6;
  return s;
}

async function autoLabels(days = 60, s0 = 1.23) {
  let d = null;
  for (const vs of VARSETS) {
    const q = new URLSearchParams({
      latitude: LAT, longitude: LON, timezone: TZ, wind_speed_unit: "kn",
      hourly: vs.join(","), past_days: String(days), forecast_days: "1"
    });
    try {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?" + q, { signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      d = await r.json();
      console.log(`기상 변수 ${vs.length}종 사용`);
      break;
    } catch (e) { console.log(`변수 ${vs.length}종 실패: ${e.message}`); }
  }
  if (!d || !d.hourly) throw new Error("기상 데이터를 받지 못함");

  const rows = {};
  d.hourly.time.forEach((t, i) => {
    const date = t.slice(0, 10);
    (rows[date] ||= []).push({ i, min: +t.slice(11, 13) * 60 + +t.slice(14, 16) });
  });

  const out = {};
  let canc = 0;
  for (const [date, list] of Object.entries(rows)) {
    const sr = sunriseLocal(date); if (!sr) continue;
    const s = severityOf(featuresOf(d.hourly, list, sr));
    if (s == null) continue;
    // 앱과 동일: p = 1/(1+exp(1.6*(s-s0))) < 0.5 이면 취소. 즉 s > s0.
    const v = s <= s0 ? "flew" : "cancelled";
    if (v === "cancelled") canc++;
    out[date] = { s: v, src: "auto", est: EST_VERSION, note: `s=${s.toFixed(2)}` };
  }
  console.log(`추정 결과: ${Object.keys(out).length}일 중 취소 ${canc}일`);
  return out;
}

const main = async () => {
  let store = { log: {} };
  try { store = JSON.parse(await readFile(OUT, "utf8")); } catch { }
  store.log ||= {};
  const log = store.log;
  const today = todayLocal();

  // 1) 사이트를 읽어 (a) 오늘 헤드라인 (b) 날짜가 붙은 지난 판정 을 모두 모은다
  const byDate = {};                                   // { "2026-08-28": [{site, v}] }
  const push = (date, site, v) => { (byDate[date] ||= []).push({ site, v }); };
  let read = 0;
  for (const site of SITES) {
    try {
      const html = await fetchText(site.url);
      read++;
      const head = verdict(html);
      if (head) { push(today, site.name, head); }
      const dated = datedVerdicts(html, today);
      for (const [d2, v] of Object.entries(dated)) {
        if (d2 === today && head) continue;            // 오늘은 헤드라인 판정을 우선
        push(d2, site.name, v);
      }
      console.log(`${site.name}: 오늘=${head ?? "판독불가"} · 날짜별 ${Object.keys(dated).length}일`);
    } catch (e) {
      console.log(`${site.name}: 실패 (${e.message})`);
    }
  }
  store.lastScrape = { at: new Date().toISOString(), sitesRead: read, sitesTried: SITES.length };

  const oldest = addDays(today, -BACKREAD_DAYS);
  let wrote = 0, fixed = 0;
  for (const [date, votes] of Object.entries(byDate)) {
    if (date > today || date < oldest) continue;
    const d2 = decide(votes, log[date]);
    console.log(`${date}: ${d2.why}`);
    if (d2.action === "write") { log[date] = d2.rec; wrote++; }
    else if (d2.action === "fix") { log[date] = d2.rec; fixed++; }
  }
  if (!wrote && !fixed) console.log("새로 기록할 날이 없음");
  else console.log(`스크래핑 ${wrote}일 기록${fixed ? ` · ${fixed}일 정정` : ""}`);

  // 아직 비어 있는 최근 날짜를 남겨 앱이 사용자에게 물어볼 수 있게 한다
  const pending = [];
  for (let i = 0; i <= BACKREAD_DAYS; i++) {
    const d2 = addDays(today, -i);
    const r2 = log[d2];
    if (!r2 || r2.src === "auto") pending.push(d2);
  }
  store.pending = pending;
  if (pending.length) console.log(`아직 실측이 없는 최근 날짜 ${pending.length}일: ${pending.join(", ")}`);

  // 2) 비어 있는 날짜 + 옛 기준으로 찍어둔 auto 기록을 채우거나 갱신
  let filled = 0, redone = 0;
  try {
    const auto = await autoLabels(60, await loadS0());
    const guard = addDays(today, -NO_GUESS_DAYS);
    for (const [date, rec] of Object.entries(auto)) {
      if (date > today) continue;
      if (date > guard) continue;                  // 최근 구간은 짐작으로 채우지 않는다
      const cur = log[date];
      if (!cur) { log[date] = rec; filled++; continue; }
      if (cur.src !== "auto") continue;            // 실측·수동 기록은 손대지 않는다
      if (cur.est === EST_VERSION) continue;       // 이미 최신 기준
      log[date] = rec; redone++;                   // 옛 기준 → 다시 계산
    }
  } catch (e) {
    console.log("자동 추정 실패: " + e.message);
  }

  store.updated = new Date().toISOString();
  store.counts = {
    total: Object.keys(log).length,
    measured: Object.values(log).filter(v => v.src !== "auto").length,
    flew: Object.values(log).filter(v => v.s === "flew").length
  };
  await writeFile(OUT, JSON.stringify(store, null, 1) + "\n");
  console.log(`자동 추정 ${filled}일 추가${redone ? ` · ${redone}일 새 기준으로 재계산` : ""}` +
    ` · 누적 ${store.counts.total}일 (실측 ${store.counts.measured} · 뜬 날 ${store.counts.flew})`);
};

export { verdict, datedVerdicts, decide, severityOf, featuresOf, sunriseLocal, addDays, NO_GUESS_DAYS, BACKREAD_DAYS };

if (process.argv[1] && process.argv[1].endsWith("scrape.mjs")) {
  main().catch(e => { console.error(e); process.exit(1); });
}
