const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('C:/Users/blitv/flash-arena/index.html', 'utf8');
const start = html.indexOf('<script>');
const end = html.indexOf('</script>', start);
if (start === -1 || end === -1) { console.error('script block not found'); process.exit(1); }
try {
  new vm.Script(html.slice(start + 8, end), { filename: 'inline.js' });
  console.log('JS OK');
} catch (e) { console.error('SYNTAX ERROR: ' + e.message); process.exit(1); }
// t() emoji-strip sanity
const T = { en: { x: 'Hello 🎁 World ✓' } };
const curLang = 'en';
function t(key){var s=(T[curLang]&&T[curLang][key])||T['en'][key]||key;if(typeof s==='string'){s=s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu,'').replace(/ {2,}/g,' ').trim();}return s;}
console.log('t-strip: "' + t('x') + '"');
for (const key of ['watch', 'start', 'dailyReward', 'social', 'dare', 'explore', 'm0title']) {
  if (!html.includes('data-i="' + key + '"')) { console.error('MISSING data-i: ' + key); process.exit(1); }
}
JSON.parse(fs.readFileSync('C:/Users/blitv/flash-arena/manifest.webmanifest', 'utf8'));
console.log('data-i + manifest OK');
