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
const OUT = new URL("../data/log.json", import.meta.url);

const SITES = [
  { name: "balloonstatus", url: "https://balloonstatus.com/cappadocia/today/" },
  { name: "toursce",       url: "https://toursce.com/cappadocia-hot-air-balloon-flight-status-cancellation-checker/" },
  { name: "epicturkey",    url: "https://epicturkeytravel.com/cappadocia-balloon-flight-status/" }
];

const UA = "Mozilla/5.0 (compatible; balloon-log/1.0; +https://github.com)";
const pad = n => String(n).padStart(2, "0");
const todayLocal = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
};

/* 본문에서 운항/취소 판정. 예보 문단의 단어까지 세지 않도록 상단만 본다. */
function verdict(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const head = text.slice(0, 2500);            // 오늘 상태는 항상 상단에 있다
  const neg = (head.match(/cancell?ed|closed|no flights?|not flying|grounded|iptal/g) || []).length;
  const pos = (head.match(/flew|flying|are operating|flyable|will fly|flights operate/g) || []).length;
  if (!neg && !pos) return null;
  if (neg === pos) return null;                // 애매하면 기록하지 않는다
  return neg > pos ? "cancelled" : "flew";
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

/* Open-Meteo 실황으로 과거 날짜 자동 추정 (앱과 같은 기준) */
async function autoLabels(days = 60) {
  const q = new URLSearchParams({
    latitude: LAT, longitude: LON, timezone: TZ, wind_speed_unit: "kn",
    hourly: "wind_speed_10m,wind_gusts_10m,precipitation,visibility,wind_speed_850hPa,temperature_2m,dew_point_2m",
    daily: "sunrise", past_days: String(days), forecast_days: "1"
  });
  const d = await (await fetch("https://api.open-meteo.com/v1/forecast?" + q, { signal: AbortSignal.timeout(40000) })).json();
  const sun = {};
  d.daily.time.forEach((t, i) => sun[t] = d.daily.sunrise[i]);

  const rows = {};
  d.hourly.time.forEach((t, i) => {
    const date = t.slice(0, 10);
    const min = +t.slice(11, 13) * 60 + +t.slice(14, 16);
    (rows[date] ||= []).push({ i, min });
  });

  const out = {};
  for (const [date, list] of Object.entries(rows)) {
    const sr = sun[date]; if (!sr) continue;
    const srMin = +sr.slice(11, 13) * 60 + +sr.slice(14, 16);
    const lo = srMin - 105, hi = srMin + 120;  // 일출 -45분~+2시간 (1시간 해상도 여유)
    let w = -1, g = -1, wal = -1, pr = 0, vi = Infinity, dd = Infinity, n = 0;
    for (const { i, min } of list) {
      if (min < lo || min > hi) continue;
      n++;
      w = Math.max(w, d.hourly.wind_speed_10m[i] ?? -1);
      g = Math.max(g, d.hourly.wind_gusts_10m[i] ?? -1);
      wal = Math.max(wal, d.hourly.wind_speed_850hPa?.[i] ?? -1);
      pr += d.hourly.precipitation[i] ?? 0;
      vi = Math.min(vi, d.hourly.visibility?.[i] ?? Infinity);
      const t = d.hourly.temperature_2m?.[i], td = d.hourly.dew_point_2m?.[i];
      if (t != null && td != null) dd = Math.min(dd, t - td);
    }
    if (!n || w < 0) continue;
    // 앱과 같은 기준: 지상 10kt(규정) · 850hPa 16kt · 저층제트 · 시정 2000m(규정) · 복사안개
    let s = Math.max(0, (w - 10) / 2.5) * 2 + Math.max(0, (g - 15) / 4);
    if (wal >= 0) {
      s += Math.max(0, (wal - 16) / 5) * 1.5;
      s += Math.max(0, (wal - w - 8) / 4) * 1.2;
    }
    if (pr > 0.2) s += 3.5;
    if (vi < 2000) s += 3.5; else if (vi < 5000) s += 1;
    if (dd < 2.2 && w < 7) s += 1.5;
    out[date] = { s: s < 1.9 ? "flew" : "cancelled", src: "auto", note: `s=${s.toFixed(2)}` };
  }
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
    if (!prev || prev.src === "auto") {
      log[today] = {
        s: flew >= canc ? "flew" : "cancelled",
        src: "scrape",
        agree,                                   // 불일치 여부를 기록에 남긴다
        note: votes.map(v => `${v.site}:${v.v}`).join(", ")
      };
      console.log(`기록: ${today} → ${log[today].s}${agree ? "" : " (사이트 불일치)"}`);
    }
  } else {
    console.log("스크래핑으로 오늘 상태를 정하지 못함");
  }

  // 2) 비어 있는 과거 날짜만 기상 추정으로 채움
  let filled = 0;
  try {
    const auto = await autoLabels(60);
    for (const [date, rec] of Object.entries(auto)) {
      if (date > today) continue;
      if (log[date]) continue;                   // 기존 기록은 손대지 않는다
      log[date] = rec; filled++;
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
  console.log(`자동 추정 ${filled}일 추가 · 누적 ${store.counts.total}일 (실측 ${store.counts.measured})`);
};

main().catch(e => { console.error(e); process.exit(1); });
