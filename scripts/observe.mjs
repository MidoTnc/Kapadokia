/**
 * 실측 수집 — 모델 예측값이 아니라 실제로 잰 값과 실제 판정을 모은다.
 *
 *   1) SHM Kapadokya (민항청 슬롯센터, 원본)  → data/shm.json
 *      구역별(A/B/C, 2~5구역) 깃발과 "해당 시간" 을 그대로 기록한다.
 *      전날 오전에 다음 날 판정이 미리 올라오므로 '내일 공식 판정' 이 생긴다.
 *   2) 네브셰히르 공항 METAR (30분 간격 실측) → data/metar.json
 *      최근 24시간은 aviationweather.gov, 과거는 Iowa State 아카이브로 채운다.
 *   3) 이 실측으로 로그에 투표한다 (src:"shm" — 재발행 사이트보다 우선).
 *
 * 브라우저에서 못 하는 이유: CORS. 여기(Actions)는 그 제약이 없다.
 */
import { readFile, writeFile } from "node:fs/promises";

const SHM_URL = "https://shmkapadokya.kapadokya.edu.tr/en/";
const METAR_URL = "https://aviationweather.gov/api/data/metar?ids=LTAZ&format=json&hours=24";
const IOWA = (y1, m1, d1, y2, m2, d2) =>
  "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=LTAZ" +
  "&data=sknt,gust,drct,vsby,tmpc,dwpc,skyc1,skyl1" +
  `&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}` +
  "&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3";

const OUT_SHM = new URL("../data/shm.json", import.meta.url);
const OUT_METAR = new URL("../data/metar.json", import.meta.url);
const OUT_LOG = new URL("../data/log.json", import.meta.url);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const pad = n => String(n).padStart(2, "0");
const METAR_KEEP_DAYS = 400;         // 실측은 학습 재료라 오래 둔다 (약 2만 행, 1MB 남짓)
const BACKFILL_FROM = "2026-04-01";  // 판정 기록이 시작된 달

async function get(url, ms = 30000) {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept": "*/*" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}
const plain = html => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");

/* ─────────────────────────────────────────────────────────────
   1) SHM Kapadokya
   실제 문구 (2026-09-07 확인):
     "SECTOR A"  "Meteorological conditions have been considered unsuitable for flight for the set margin of time."
     "Date and hour of update : 07.09.2026 - 09:04"
     "Relevant date and margin of hours : 08.09.2026 - 02:45 - 16:05"
     "2.AREA" ... "unsuitable For secondary flights"   (깃발 class: red-flag)
   ───────────────────────────────────────────────────────────── */
const dmyToISO = s => { const m = s.match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

function parseSHM(html) {
  const t = plain(html);
  const names = ["SECTOR A", "SECTOR B", "SECTOR C", "2.AREA", "3.AREA", "4.AREA", "5.AREA"];
  const sectors = {};
  for (let i = 0; i < names.length; i++) {
    const a = t.indexOf(names[i]);
    if (a < 0) continue;
    // 다음 구역 이름이 나오기 전까지가 이 구역의 설명이다
    let b = t.length;
    for (const n of names) {
      if (n === names[i]) continue;                 // 설명문 안에 자기 이름이 또 나온다 ("2.AREA is unsuitable")
      const j = t.indexOf(n, a + names[i].length); if (j > 0 && j < b) b = j;
    }
    const seg = t.slice(a, b).toLowerCase();
    let state = null;
    if (/\bunsuitable\b/.test(seg)) state = "no";
    else if (/\bsuitable\b/.test(seg)) state = "yes";
    else if (/not available/.test(seg)) state = "no";
    else if (/\bavailable\b/.test(seg)) state = "yes";
    const upd = (seg.match(/date and hour of update\s*:\s*([\d.]+\s*-\s*[\d:]+)/) || [])[1] || null;
    const win = (seg.match(/relevant date and margin of hours\s*:\s*([\d.]+)\s*-\s*([\d:]+)\s*-\s*([\d:]+)/) || []);
    sectors[names[i]] = {
      state,
      updated: upd ? upd.replace(/\s+/g, "") : null,
      date: win[1] ? dmyToISO(win[1]) : null,
      from: win[2] || null, to: win[3] || null
    };
  }
  // 깃발 색은 HTML class 에만 있다. 문구와 어긋나면 문구를 믿되 기록은 남긴다.
  const flags = (html.match(/\b(red|yellow|green)-flag\b/gi) || []).map(s => s.toLowerCase().replace("-flag", ""));

  const main = ["SECTOR A", "SECTOR B", "SECTOR C"].map(n => sectors[n]).filter(Boolean);
  if (!main.length) return null;
  const date = main.find(s => s.date)?.date || null;
  const yes = main.filter(s => s.state === "yes").length, no = main.filter(s => s.state === "no").length;
  const verdict = no === main.length ? "cancelled" : (yes > 0 ? "flew" : null);
  const updISO = (() => {
    const u = main.find(s => s.updated)?.updated;      // "07.09.2026-09:04"
    if (!u) return null;
    const m = u.match(/(\d{2})\.(\d{2})\.(\d{4})-(\d{2}):(\d{2})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+03:00` : null;
  })();
  return { date, verdict, mainYes: yes, mainNo: no, updated: updISO, flags, sectors };
}

/* ─────────────────────────────────────────────────────────────
   2) METAR
   ───────────────────────────────────────────────────────────── */
/* rawOb 에서 직접 뽑는다. JSON 필드가 비어 오는 경우가 있어 원문이 더 믿을 만하다.
   "METAR LTAZ 070650Z 03014G25KT 350V060 9999 SCT035 21/09 Q1024" */
function parseRaw(raw) {
  const o = {};
  const w = raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (w) { o.drct = w[1] === "VRB" ? null : +w[1]; o.sknt = +w[2]; o.gust = w[3] ? +w[3] : null; }
  if (/\bCAVOK\b/.test(raw)) o.vsby = 10000;
  else { const v = raw.match(/\s(\d{4})(?:\s|$)/); if (v) o.vsby = +v[1]; }   // m
  const td = raw.match(/\s(M?\d{2})\/(M?\d{2})\s/);
  if (td) { const f = s => (s[0] === "M" ? -1 : 1) * +s.replace("M", ""); o.tmpc = f(td[1]); o.dwpc = f(td[2]); }
  const c = raw.match(/\b(FEW|SCT|BKN|OVC)(\d{3})\b/);
  if (c) { o.sky = c[1]; o.base = +c[2] * 100; }          // ft AGL
  return o;
}

async function fetchMetarLive() {
  const j = JSON.parse(await get(METAR_URL));
  const rows = {};
  for (const m of j) {
    const iso = m.reportTime ? m.reportTime.replace(" ", "T").slice(0, 16) + "Z" :
      (m.obsTime ? new Date(m.obsTime * 1000).toISOString().slice(0, 16) + "Z" : null);
    if (!iso) continue;
    const p = parseRaw(m.rawOb || "");
    rows[iso] = [p.sknt ?? m.wspd ?? null, p.gust ?? m.wgst ?? null, p.drct ?? (typeof m.wdir === "number" ? m.wdir : null),
                 p.vsby ?? null, p.tmpc ?? m.temp ?? null, p.dwpc ?? m.dewp ?? null, p.sky || null, p.base ?? null];
  }
  return rows;
}

/* Iowa State ASOS 아카이브 CSV: station,valid,sknt,gust,drct,vsby,tmpc,dwpc,skyc1,skyl1  (M = 결측, vsby 는 마일) */
async function fetchMetarArchive(fromISO, toISO) {
  const [y1, m1, d1] = fromISO.split("-").map(Number), [y2, m2, d2] = toISO.split("-").map(Number);
  const csv = await get(IOWA(y1, m1, d1, y2, m2, d2), 120000);
  const rows = {};
  const lines = csv.trim().split("\n");
  const head = lines[0].split(",");
  const ix = k => head.indexOf(k);
  const num = s => (s == null || s === "M" || s === "" ) ? null : +s;
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (c.length < 4) continue;
    const valid = c[ix("valid")];                          // "2026-08-28 02:50"
    if (!valid) continue;
    const iso = valid.replace(" ", "T").slice(0, 16) + "Z";
    const vis = num(c[ix("vsby")]);
    rows[iso] = [num(c[ix("sknt")]), num(c[ix("gust")]), num(c[ix("drct")]),
                 vis == null ? null : Math.round(vis * 1609.34), num(c[ix("tmpc")]), num(c[ix("dwpc")]),
                 c[ix("skyc1")] === "M" ? null : c[ix("skyc1")] || null, num(c[ix("skyl1")])];
  }
  return rows;
}

const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayUTC = () => new Date().toISOString().slice(0, 10);

/* ─────────────────────────────────────────────────────────────
   main
   ───────────────────────────────────────────────────────────── */
const main = async () => {
  const wantBackfill = process.argv.includes("--backfill") || process.env.METAR_BACKFILL === "true";

  // ── SHM ──
  let shm = { history: [] };
  try { shm = JSON.parse(await readFile(OUT_SHM, "utf8")); } catch { }
  shm.history ||= [];
  try {
    const html = await get(SHM_URL);
    const snap = parseSHM(html);
    if (snap) {
      snap.fetched = new Date().toISOString();
      shm.latest = snap;
      // 같은 (해당일, 갱신시각) 은 한 번만 남긴다
      const key = `${snap.date}|${snap.updated}`;
      if (!shm.history.some(h => `${h.date}|${h.updated}` === key)) shm.history.push(snap);
      shm.history = shm.history.slice(-400);
      console.log(`SHM: ${snap.date} → ${snap.verdict ?? "판독불가"} (A/B/C 가능 ${snap.mainYes} · 불가 ${snap.mainNo}) · 갱신 ${snap.updated}`);
      if (!snap.verdict) {
        // 판독 실패 시 구조를 로그에 남겨 다음에 파서를 고칠 수 있게 한다
        const t = plain(html); const i = t.indexOf("SECTOR A");
        console.log("SHM 판독 실패 — 원문 발췌:", t.slice(Math.max(0, i - 100), i + 500));
      }
    } else {
      console.log("SHM: 구역 정보를 찾지 못함");
      const t = plain(html); console.log("SHM 원문 발췌:", t.slice(0, 800));
    }
  } catch (e) { console.log("SHM: 실패 (" + e.message + ")"); }
  shm.updated = new Date().toISOString();
  await writeFile(OUT_SHM, JSON.stringify(shm, null, 1) + "\n");

  // ── METAR ──
  let metar = { station: "LTAZ", name: "Nevşehir Kapadokya Airport", lat: 38.771, lon: 34.521, elev_m: 944,
                cols: ["sknt", "gust", "drct", "vsby_m", "tmpc", "dwpc", "sky", "base_ft"], rows: {} };
  try { const j = JSON.parse(await readFile(OUT_METAR, "utf8")); if (j && j.rows) metar = j; } catch { }
  metar.rows ||= {};

  const before = Object.keys(metar.rows).length;
  try {
    const live = await fetchMetarLive();
    Object.assign(metar.rows, live);
    console.log(`METAR 실시간: ${Object.keys(live).length}행`);
  } catch (e) { console.log("METAR 실시간: 실패 (" + e.message + ")"); }

  // 과거 채우기: 요청했거나, 시작일부터의 커버리지가 비어 있으면
  const days = Object.keys(metar.rows).map(k => k.slice(0, 10));
  const covered = new Set(days);
  let missing = 0;
  for (let d = BACKFILL_FROM; d <= addDays(todayUTC(), -2); d = addDays(d, 1)) if (!covered.has(d)) missing++;
  if (wantBackfill || missing > 14) {
    try {
      const arch = await fetchMetarArchive(BACKFILL_FROM, todayUTC());
      let added = 0;
      for (const [k, v] of Object.entries(arch)) if (!metar.rows[k]) { metar.rows[k] = v; added++; }
      console.log(`METAR 아카이브: ${Object.keys(arch).length}행 받아 ${added}행 추가 (빈 날 ${missing}일이었음)`);
    } catch (e) { console.log("METAR 아카이브: 실패 (" + e.message + ")"); }
  } else {
    console.log(`METAR 아카이브: 건너뜀 (빈 날 ${missing}일)`);
  }

  // 오래된 행 정리
  const cutoff = addDays(todayUTC(), -METAR_KEEP_DAYS);
  for (const k of Object.keys(metar.rows)) if (k.slice(0, 10) < cutoff) delete metar.rows[k];
  const keys = Object.keys(metar.rows).sort();
  metar.rows = Object.fromEntries(keys.map(k => [k, metar.rows[k]]));
  metar.updated = new Date().toISOString();
  metar.count = keys.length;
  metar.first = keys[0] || null; metar.last = keys[keys.length - 1] || null;
  await writeFile(OUT_METAR, JSON.stringify(metar) + "\n");
  console.log(`METAR 누적 ${keys.length}행 (${before} → ${keys.length}) · ${metar.first} ~ ${metar.last}`);

  // ── SHM 판정을 로그에 반영 ──
  // 전날 미리 올라온 판정은 '예비'다. 해당 날짜 당일(또는 그 뒤)에 갱신된 것만 확정으로 본다.
  // 같은 날 여러 번 갱신되면 마지막 것이 이긴다 (새벽 재평가로 뒤집히는 경우).
  try {
    const store = JSON.parse(await readFile(OUT_LOG, "utf8"));
    store.log ||= {};
    const finalByDate = {};
    for (const h of shm.history) {
      if (!h.date || !h.verdict || !h.updated) continue;
      if (h.updated.slice(0, 10) < h.date) continue;            // 예비 판정
      const cur = finalByDate[h.date];
      if (!cur || h.updated > cur.updated) finalByDate[h.date] = h;
    }
    let wrote = 0;
    for (const [date, h] of Object.entries(finalByDate)) {
      const prev = store.log[date];
      if (prev && (prev.src === "official" || prev.src === "manual")) continue;   // 사람 기록은 안 건드린다
      const rec = { s: h.verdict, src: "shm", agree: true,
        note: `SHM A/B/C 가능 ${h.mainYes}·불가 ${h.mainNo} (${h.updated.slice(0, 16)})` };
      if (prev && prev.src === "shm" && prev.s === rec.s && prev.note === rec.note) continue;
      store.log[date] = rec; wrote++;
      console.log(`SHM → 로그: ${date} ${rec.s}${prev ? ` (이전 ${prev.src}:${prev.s} 대체)` : ""}`);
    }
    if (wrote) {
      store.updated = new Date().toISOString();
      await writeFile(OUT_LOG, JSON.stringify(store, null, 1) + "\n");
    }
    console.log(`SHM → 로그: ${wrote}일 기록`);
  } catch (e) { console.log("로그 반영 실패: " + e.message); }
};

export { parseSHM, parseRaw };
if (process.argv[1] && process.argv[1].endsWith("observe.mjs")) {
  main().catch(e => { console.error(e); process.exit(1); });
}
