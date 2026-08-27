/**
 * 다른 벌룬 사이트들의 날짜별 예보를 모아 data/forecasts.json 에 저장한다.
 * 브라우저는 CORS 때문에 남의 사이트를 못 읽으므로 서버(Actions)에서 대신 읽는다.
 *
 * 모든 값은 "뜰 가능성(%)"으로 통일한다. 취소 위험도로 표기하는 곳은 100에서 뺀다.
 * 판독에 실패하면 그 사이트는 그냥 비운다 — 틀린 숫자를 넣느니 없는 게 낫다.
 */
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../data/forecasts.json", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

const pad = n => String(n).padStart(2, "0");
const todayParts = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: +p.year, m: +p.month, d: +p.day };
};

/* "29 Aug" 또는 "Aug 29" → 2026-08-29.
   연도가 없으므로, 오늘보다 2개월 이상 과거로 나오면 다음 해로 넘긴다. */
function toISO(monName, day) {
  const m = MON[String(monName).slice(0, 3).toLowerCase()];
  if (!m || !day) return null;
  const t = todayParts();
  let y = t.y;
  const cand = new Date(Date.UTC(y, m - 1, day));
  const now = new Date(Date.UTC(t.y, t.m - 1, t.d));
  if ((cand - now) / 864e5 < -60) y += 1;
  return `${y}-${pad(m)}-${pad(day)}`;
}

function plain(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

async function get(url) {
  const r = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9"
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

/* balloonstatus: "Fri 28 Aug 52% Moderate Risk" — 이미 '뜰 가능성' */
function parseBalloonStatus(html) {
  const t = plain(html), out = {};
  const re = /\b(?:mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{1,3})\s*%/gi;
  let m;
  while ((m = re.exec(t))) {
    const iso = toISO(m[2], +m[1]); const v = +m[3];
    if (iso && v >= 0 && v <= 100) out[iso] = v;
  }
  return out;
}

/* toursce: "Friday, Aug 28 ... Cancel Risk Low 20%" — 취소 위험도라 100에서 뺀다 */
function parseToursCE(html) {
  const t = plain(html), out = {};
  const re = /([a-z]{3})[a-z]*\s+(\d{1,2})\b[^%]{0,160}?cancel\s*risk\s*(?:low|medium|high|very high)?\s*(\d{1,3})\s*%/gi;
  let m;
  while ((m = re.exec(t))) {
    const iso = toISO(m[1], +m[2]); const risk = +m[3];
    if (iso && risk >= 0 && risk <= 100) out[iso] = 100 - risk;
  }
  return out;
}

/* epicturkeytravel: 실제 형식은 "Fri · 28 Aug ... Aloft (~2,000 m): 4.3 kt ⚠️ Marginal Conditions".
   날짜가 "일 월" 순서이고 라벨이 한참 뒤에 온다. 숫자가 없어 밴드 중앙값으로 근사한다. */
function parseEpic(html) {
  const t = plain(html), out = {};
  const re = /(\d{1,2})\s+([a-z]{3})[a-z]*\b[\s\S]{0,260}?(flight likely|marginal conditions|flight unlikely)/gi;
  const band = { "flight likely": 85, "marginal conditions": 50, "flight unlikely": 20 };
  let m;
  while ((m = re.exec(t))) {
    const iso = toISO(m[2], +m[1]);
    if (iso && out[iso] == null) out[iso] = band[m[3].toLowerCase()];
  }
  return out;
}

const SOURCES = [
  { name: "Balloon Status", url: "https://balloonstatus.com/cappadocia/forecast/", parse: parseBalloonStatus, exact: true },
  { name: "ToursCE", url: "https://toursce.com/cappadocia-hot-air-balloon-flight-status-cancellation-checker/", parse: parseToursCE, exact: true },
  { name: "Epic Turkey", url: "https://epicturkeytravel.com/cappadocia-balloon-flight-status/", parse: parseEpic, exact: false }
];

const main = async () => {
  let store = { sources: {}, notes: {} };
  try { store = JSON.parse(await readFile(OUT, "utf8")); } catch { }
  store.sources ||= {}; store.notes ||= {};

  for (const src of SOURCES) {
    try {
      const got = src.parse(await get(src.url));
      const n = Object.keys(got).length;
      if (n >= 3) {
        store.sources[src.name] = got;                 // 통째로 교체 (지난 예보는 의미 없음)
        store.notes[src.name] = src.exact ? "사이트가 밝힌 수치" : "라벨을 숫자로 근사";
        console.log(`${src.name}: ${n}일 수집`);
      } else {
        console.log(`${src.name}: ${n}일뿐 — 판독 실패로 보고 갱신하지 않음`);
      }
    } catch (e) {
      console.log(`${src.name}: 실패 (${e.message})`);
    }
  }

  store.updated = new Date().toISOString();
  await writeFile(OUT, JSON.stringify(store, null, 1) + "\n");
  console.log("사이트 " + Object.keys(store.sources).length + "곳 기록");
};

main().catch(e => { console.error(e); process.exit(1); });
