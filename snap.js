const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('file:///C:/Users/blitv/flash-arena/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    pickLang('he'); curLang='he'; selLang='he';
    document.documentElement.dir='rtl'; document.documentElement.lang='he';
    applyTranslations();
    document.querySelectorAll('.page').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
    const app = document.getElementById('p-app');
    app.style.display='flex'; app.classList.add('active');
    try { renderMissions(); } catch(e) {}
    try { renderAchievements(); } catch(e) {}
  });
  await page.waitForTimeout(1000);
  // Home top
  await page.screenshot({ path: 'b1_home.png' });
  // Home scrolled to cards
  await page.evaluate(() => { document.getElementById('s-home').scrollTop = 350; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'b2_cards.png' });
  // Home scrolled to secondary cards
  await page.evaluate(() => { document.getElementById('s-home').scrollTop = 700; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'b3_cards2.png' });
  // Leaderboard
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display='none'; });
    document.getElementById('s-lb').classList.add('active');
    document.getElementById('s-lb').style.display='block';
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'b4_lb.png' });
  // Feed
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display='none'; });
    document.getElementById('s-feed').classList.add('active');
    document.getElementById('s-feed').style.display='flex';
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'b5_feed.png' });
  // Profile top
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display='none'; });
    document.getElementById('s-pf').classList.add('active');
    document.getElementById('s-pf').style.display='block';
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'b6_profile.png' });
  // Achievements
  await page.evaluate(() => { document.getElementById('s-pf').scrollTop = 480; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'b7_ach.png' });
  await browser.close();
  console.log('All before screenshots saved');
})();
