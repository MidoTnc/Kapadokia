/**
 * 진짜 브라우저에서 손가락 동작을 재현한다.
 * jsdom 은 스크롤을 흉내내지 못해서, 사용자가 겪은 바로 그 상황(화면을 넘기려다
 * 날짜가 눌리는 것)은 여기서만 검증된다. CDP 로 실제 터치 이벤트를 쏜다.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const stub = fs.readFileSync('shot.mjs', 'utf8').split('const stub = `')[1].split('`;')[0];
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m)); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.addInitScript(stub);
await page.goto('file://' + process.cwd() + '/cappadocia-balloon.html');
await page.waitForTimeout(2500);

const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }]
});
const swipe = async (x, y, dy, steps = 8) => {
  await touch('touchStart', x, y);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', x, y + dy * i / steps); await page.waitForTimeout(16); }
  await touch('touchEnd', x, y + dy);
  await page.waitForTimeout(350);
};
/* 관성 스크롤이 멎을 때까지 기다린다.
   화면이 아직 흐르는 중에 누르면 탭으로 안 잡히는 게 맞다 — 그 탭은 스크롤을 멈추는 동작이다. */
const settle = async () => {
  let prev = -1, now = await page.evaluate(() => window.scrollY);
  while (prev !== now) { prev = now; await page.waitForTimeout(120); now = await page.evaluate(() => window.scrollY); }
};
const tapAt = async (x, y) => {
  await settle();
  await touch('touchStart', x, y);
  await page.waitForTimeout(60);
  await touch('touchEnd', x, y);
  await page.waitForTimeout(250);
};

const openCal = async () => {
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(x => { x.open = x.textContent.includes('날짜 고르기'); });
    document.querySelector('#btnClearTrip').click();
  });
  await page.waitForTimeout(200);
};
/* 화면 밖으로 밀려난 칸은 CDP 터치가 닿지 않는다. 보이게 한 뒤 좌표를 다시 잰다. */
const tapCell = async (sel) => {
  const l = page.locator(sel);
  await l.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await settle();
  const box = await l.boundingBox();
  await tapAt(box.x + box.width / 2, box.y + box.height / 2);
};
const anchored = () => page.evaluate(() => !!document.querySelector('#months .c.anchor'));
const boxOf = k => page.locator(`#months .c.sel[data-k="${k}"]`).boundingBox();
const dayKey = n => page.evaluate(i => {
  const els = [...document.querySelectorAll('#months .c.sel[data-k]')];
  return els[i] ? els[i].dataset.k : null;
}, n);

console.log('\n[1] 달력 — 스크롤과 탭 구분');
{
  await openCal();
  const k = await dayKey(6);

  // 칸이 화면 안에 실제로 보여야 한다. 안 그러면 터치가 허공을 찍고
  // 테스트가 통과한 것처럼 보인다 (실제로 그렇게 헛통과한 적이 있다).
  const l = page.locator(`#months .c.sel[data-k="${k}"]`);
  await l.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -200));
  await settle();
  const box = await l.boundingBox();
  ok(box.y > 0 && box.y + box.height < 780, `스와이프 시작점이 화면 안에 있다 (y=${Math.round(box.y)})`);

  // 날짜 칸 위에서 시작하는 세로 스와이프 = 스크롤이어야 한다
  const before = await page.evaluate(() => window.scrollY);
  await swipe(box.x + box.width / 2, box.y + box.height / 2, -220);
  const after = await page.evaluate(() => window.scrollY);
  ok(after > before, `날짜 위에서 쓸어올리면 화면이 스크롤된다 (${before} → ${after})`);
  ok(!(await anchored()), '그때 날짜는 선택되지 않는다  ← 사용자가 겪은 문제');

  // 관성이 멎으면 곧바로 다시 눌려야 한다
  await settle();
  ok(!(await anchored()), '관성 스크롤 중에 눌러도 선택되지 않는다 (그 탭은 스크롤을 멈추는 동작)');

  // 제자리 탭은 선택돼야 한다
  const k2 = await dayKey(8);
  await tapCell(`#months .c.sel[data-k="${k2}"]`);
  ok(await anchored(), '제자리로 톡 누르면 시작일이 잡힌다');

  // 두 번째 탭으로 확정
  const k3 = await dayKey(11);
  await tapCell(`#months .c.sel[data-k="${k3}"]`);
  const trip = await page.evaluate(() => [document.querySelector('#cfgTripS').value, document.querySelector('#cfgTripE').value]);
  ok(trip[0] === k2 && trip[1] === k3, `두 번째 탭에 확정 (${trip[0]} ~ ${trip[1]})`);
}

console.log('\n[2] 운항 기록 — 스크롤 중에는 기록이 바뀌지 않는다');
{
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(x => { x.open = x.textContent.includes('운항 기록'); });
  });
  await page.waitForTimeout(250);
  await page.locator('#logcal .lc[data-k="2026-08-12"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  await page.waitForTimeout(250);

  const snap = () => page.evaluate(() => JSON.parse(localStorage.getItem('cb.log') || '{}')['2026-08-12']);
  const b0 = await snap();
  const box = await page.locator('#logcal .lc[data-k="2026-08-12"]').boundingBox();
  await swipe(box.x + box.width / 2, box.y + box.height / 2, -200);
  const b1 = await snap();
  ok(JSON.stringify(b0) === JSON.stringify(b1),
    `기록 칸 위에서 쓸어올려도 값이 안 바뀐다 (${b0 && b0.s} → ${b1 && b1.s})`);

  await page.locator('#logcal .lc[data-k="2026-08-12"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  await page.waitForTimeout(350);
  const box2 = await page.locator('#logcal .lc[data-k="2026-08-12"]').boundingBox();
  await tapAt(box2.x + box2.width / 2, box2.y + box2.height / 2);
  const b2 = await snap();
  ok(JSON.stringify(b0) !== JSON.stringify(b2), `제자리 탭은 바꾼다 (${b0 && b0.s} → ${b2 ? b2.s : '지움'})`);
  ok(await page.locator('#gundo #btnUndo').count() > 0, '되돌리기 버튼이 뜬다');
  await page.locator('#gundo #btnUndo').click();
  ok(JSON.stringify(await snap()) === JSON.stringify(b0), '되돌리면 원래대로');
}

console.log('\n[3] 가로 스크롤이 생기지 않는다');
{
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 1, `가로 넘침 ${over}px`);
}

await b.close();
console.log(`\n${fail ? `실패 ${fail}건` : '전부 통과'} (${pass}건)`);
process.exit(fail ? 1 : 0);
