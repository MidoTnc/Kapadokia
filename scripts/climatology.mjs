/**
 * 15년치 기후값을 한 번 계산해 data/climatology.json 에 저장한다.
 *
 * 왜 필요한가: 이 계산은 Open-Meteo 아카이브에서 15년 × 14변수 × 시간별 데이터를 받아온다.
 * 방문자마다 이걸 하면 한 사람당 수백 건의 API 호출이 나가서 무료 한도를 금방 넘긴다.
 * 과거 날씨는 바뀌지 않으므로 한 번 만들어 파일로 두고 모두가 그걸 내려받으면 된다.
 *
 * 실행: node scripts/climatology.mjs        (Actions 에서 수동/월 1회)
 * 앱은 data/climatology.json 이 있으면 그걸 쓰고, 없으면 예전처럼 직접 계산한다.
 */
import { writeFile } from "node:fs/promises";

const LAT = 38.6431, LON = 34.8289, TZ = "Europe/Istanbul";
const YEARS = 15;
const ANCHOR_DAYS = 223;          // 2025년 실측 운항일수
const WIN_PRE = 45, WIN_POST = 120;
const OUT = new URL("../data/climatology.json", import.meta.url);

const VARSETS = [
  ["wind_speed_10m","wind_gusts_10m","wind_direction_10m","precipitation","cloud_cover","cloud_cover_low",
   "visibility","temperature_2m","dew_point_2m",
   "wind_speed_900hPa","wind_speed_850hPa","wind_speed_800hPa","wind_direction_850hPa","temperature_850hPa"],
  ["wind_speed_10m","wind_gusts_10m","wind_direction_10m","precipitation","cloud_cover",
   "temperature_2m","dew_point_2m","wind_speed_850hPa","wind_direction_850hPa","temperature_850hPa"],
  ["wind_speed_10m","wind_gusts_10m","precipitation","cloud_cover","temperature_2m","dew_point_2m"],
  ["wind_speed_10m","wind_gusts_10m","precipitation","cloud_cover"]
];

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

/* 앱과 동일한 특징 추출 + 위험도 */
function features(hourly, rows, sr) {
  const srMin = +sr.slice(11, 13) * 60 + +sr.slice(14, 16);
  const lo = srMin - WIN_PRE - 60, hi = srMin + WIN_POST;
  const g = n => hourly[n] || null;
  const A = {
    w10: g("wind_speed_10m"), gu: g("wind_gusts_10m"), pr: g("precipitation"),
    ccl: g("cloud_cover_low"), vi: g("visibility"), t2: g("temperature_2m"), td: g("dew_point_2m"),
    w900: g("wind_speed_900hPa"), w850: g("wind_speed_850hPa"), w800: g("wind_speed_800hPa"),
    t850: g("temperature_850hPa")
  };
  let w10 = -1, gu = -1, wal = -1, pr = 0, vi = null, cclS = 0, n = 0;
  let dewDep = null, inv = null, w10s = 0;
  for (const r of rows) {
    if (r.min < lo || r.min > hi) continue;
    const i = r.i; n++;
    const mx = (arr, cur) => (arr && arr[i] != null) ? Math.max(cur, arr[i]) : cur;
    w10 = mx(A.w10, w10); gu = mx(A.gu, gu);
    wal = mx(A.w900, wal); wal = mx(A.w850, wal); wal = mx(A.w800, wal);
    if (A.pr && A.pr[i] != null) pr += A.pr[i];
    if (A.vi && A.vi[i] != null) vi = vi == null ? A.vi[i] : Math.min(vi, A.vi[i]);
    if (A.ccl && A.ccl[i] != null) cclS += A.ccl[i];
    if (A.t2 && A.td && A.t2[i] != null && A.td[i] != null) {
      const dd = A.t2[i] - A.td[i]; dewDep = dewDep == null ? dd : Math.min(dewDep, dd);
    }
    if (A.t850 && A.t2 && A.t850[i] != null && A.t2[i] != null) {
      const iv = A.t850[i] - A.t2[i]; inv = inv == null ? iv : Math.max(inv, iv);
    }
    if (A.w10 && A.w10[i] != null) w10s = A.w10[i];
  }
  if (!n || w10 < 0) return null;
  if (gu < 0) gu = w10 * 1.5;
  return { w10, gu, wal: wal < 0 ? null : wal, llj: wal >= 0 ? Math.max(0, wal - w10) : null,
           dewDep, inv, pr, vi, ccl: n ? cclS / n : null, w10s };
}
function severity(f) {
  if (!f) return null;
  const over = (x, t, sc) => x == null ? 0 : Math.max(0, (x - t) / sc);
  let s = 0;
  s += over(f.w10, 10, 2.5) * 2.0;
  s += over(f.gu, 15, 4);
  s += over(f.wal, 16, 5) * 1.5;
  s += over(f.llj, 8, 4) * 1.2;
  if (f.pr > 0.2) s += 3.5;
  if (f.vi != null) { if (f.vi < 2000) s += 3.5; else if (f.vi < 5000) s += 1.0; }
  if (f.dewDep != null && f.dewDep < 2.2 && f.w10s < 7) s += 1.5;
  if (f.ccl != null && f.ccl > 70) s += 0.6;
  return s;
}
const K = 1.6;
const prob = (s, s0) => s == null ? null : 1 / (1 + Math.exp(K * (s - s0)));
function calibrate(sevs, target) {
  let lo = 0, hi = 12;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const mean = sevs.reduce((a, s) => a + prob(s, mid), 0) / sevs.length;
    mean < target ? lo = mid : hi = mid;
  }
  return (lo + hi) / 2;
}
const doy = k => { const d = new Date(k + "T12:00:00Z"); return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5); };

const main = async () => {
  const endY = new Date().getUTCFullYear() - 1, startY = endY - YEARS + 1;
  const sevs = [], byDoy = {}, byMonth = {}, dayS = {};
  let tier = 0;

  for (let y = startY; y <= endY; y += 3) {
    const a = y, b = Math.min(y + 2, endY);
    let data = null;
    for (let k = tier; k < VARSETS.length; k++) {
      const q = new URLSearchParams({
        latitude: LAT, longitude: LON, timezone: TZ, wind_speed_unit: "kn",
        start_date: `${a}-01-01`, end_date: `${b}-12-31`, hourly: VARSETS[k].join(",")
      });
      try {
        const r = await fetch("https://archive-api.open-meteo.com/v1/archive?" + q, { signal: AbortSignal.timeout(180000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        data = await r.json(); tier = k; break;
      } catch (e) { console.log(`${a}-${b} 변수세트${k} 실패: ${e.message}`); }
    }
    if (!data) { console.log(`${a}-${b} 건너뜀`); continue; }

    const rows = {};
    data.hourly.time.forEach((t, i) => {
      const date = t.slice(0, 10);
      (rows[date] ||= []).push({ i, min: +t.slice(11, 13) * 60 + +t.slice(14, 16) });
    });
    for (const [date, list] of Object.entries(rows)) {
      const sr = sunriseLocal(date); if (!sr) continue;
      const s = severity(features(data.hourly, list, sr));
      if (s == null) continue;
      sevs.push(s);
      (byDoy[doy(date)] ||= []).push(s);
      (byMonth[+date.slice(5, 7)] ||= []).push(s);
      dayS[date] = Math.round(s * 100) / 100;
    }
    console.log(`${a}-${b} 완료 · 누적 ${sevs.length}일`);
  }

  if (sevs.length < 1000) { console.error("표본이 너무 적습니다: " + sevs.length); process.exit(1); }

  const s0 = calibrate(sevs, ANCHOR_DAYS / 365);
  const clim = {};
  for (let dy = 1; dy <= 366; dy++) {
    let acc = 0, n = 0;
    for (let k = -7; k <= 7; k++) {
      const d = ((dy + k - 1) % 366 + 366) % 366 + 1;
      for (const s of (byDoy[d] || [])) { acc += prob(s, s0); n++; }
    }
    clim[dy] = n ? Math.round(acc / n * 1e4) / 1e4 : null;
  }
  const monthly = {};
  for (let m = 1; m <= 12; m++) {
    const arr = byMonth[m];
    monthly[m] = arr ? Math.round(arr.reduce((a, s) => a + prob(s, s0), 0) / arr.length * 1e4) / 1e4 : null;
  }

  const out = { v: 5, years: YEARS, anchor: ANCHOR_DAYS, s0, clim, monthly, dayS,
                n: sevs.length, tier, built: new Date().toISOString() };
  await writeFile(OUT, JSON.stringify(out));
  console.log(`저장 완료 · ${sevs.length}일 표본 · s0=${s0.toFixed(3)} · 변수세트 ${tier}`);
};

main().catch(e => { console.error(e); process.exit(1); });
