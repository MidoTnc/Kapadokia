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

  // 1) 오늘 상태 스크래핑
  const votes = [];
  for (const site of SITES) {
    try {
      const v = verdict(await fetchText(site.url));
      console.log(`${site.name}: ${v ?? "판독불가"}`);
      if (v) votes.push({ site: site.name, v });
    } catch (e) {
      console.log(`${site.name}: 실패 (${e.message})`);
    }
  }
  if (votes.length) {
    const flew = votes.filter(v => v.v === "flew").length;
    const canc = votes.length - flew;
    const agree = flew === 0 || canc === 0;
    const prev = log[today];
    if (flew === canc) {
      // 찬반 동수 — 어느 쪽으로도 찍지 않는다. 틀린 정답을 넣으면 모델 채점이 오염된다.
      console.log(`${today}: 사이트 의견이 ${votes.map(v => `${v.site}=${v.v}`).join(" / ")} 로 갈려 기록하지 않음`);
    } else if (!prev || prev.src === "auto") {
      log[today] = {
        s: flew > canc ? "flew" : "cancelled",
        src: "scrape",
        agree,
        note: votes.map(v => `${v.site}:${v.v}`).join(", ")
      };
      console.log(`기록: ${today} → ${log[today].s}${agree ? "" : " (일부 불일치)"}`);
    }
  } else {
    console.log("스크래핑으로 오늘 상태를 정하지 못함");
  }

  // 2) 비어 있는 날짜 + 옛 기준으로 찍어둔 auto 기록을 채우거나 갱신
  let filled = 0, redone = 0;
  try {
    const auto = await autoLabels(60, await loadS0());
    for (const [date, rec] of Object.entries(auto)) {
      if (date > today) continue;
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

main().catch(e => { console.error(e); process.exit(1); });
