process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';
process.env.GCLOUD_PROJECT = 'flasharena-f35b1';
process.env.FIREBASE_CONFIG = JSON.stringify({
  databaseURL: 'https://flasharena-f35b1-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'flasharena-f35b1'
});

const fns = require('./index.js');
const admin = require('firebase-admin');
const db = admin.database();

function assert(cond, label) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label);
  if (!cond) process.exitCode = 1;
}

async function seed() {
  await db.ref('feed').set({
    postA: { uid: 'author1', timestamp: Date.now(), caption: 'mission proof', missionId: 0 },
    postB: { uid: 'author2', timestamp: Date.now(), caption: 'general video', isUserVideo: true }
  });
  await db.ref('userRatings').remove();
  await db.ref('userInteractions').remove();
  await db.ref('reports').remove();
}

async function run() {
  await seed();

  // Case 1: first-time rating
  const r1 = await fns.rateVideoImpl('rater1', 'postA', 4);
  assert(r1.ratingCount === 1 && r1.ratingAvg === 4, 'first rating: count=1, avg=4');
  let post = (await db.ref('feed/postA').once('value')).val();
  assert(post.ratingSum === 4 && post.ratingCount === 1, 'postA aggregate after 1st rating');
  let userRating = (await db.ref('userRatings/rater1/postA').once('value')).val();
  assert(userRating && userRating.stars === 4, 'userRatings stored rater1=4 on postA');

  // Case 2: second distinct rater
  const r2 = await fns.rateVideoImpl('rater2', 'postA', 2);
  assert(r2.ratingCount === 2 && r2.ratingAvg === 3, 'second rating: count=2, avg=(4+2)/2=3');

  // Case 3: rater1 changes their mind (4 -> 1) — count should NOT increase, sum should shift by delta
  const r3 = await fns.rateVideoImpl('rater1', 'postA', 1);
  assert(r3.ratingCount === 2, 'updating an existing rating does not increase ratingCount');
  post = (await db.ref('feed/postA').once('value')).val();
  assert(post.ratingSum === 3, 'ratingSum after update: was 4+2=6, rater1 4->1 (delta -3) => 3'); // 1+2=3
  assert(Math.abs(post.ratingAvg - 1.5) < 1e-9, 'ratingAvg after update = 3/2 = 1.5');

  // Case 4: self-rating rejected
  let selfRateErr = null;
  try { await fns.rateVideoImpl('author1', 'postA', 5); } catch (e) { selfRateErr = e; }
  assert(selfRateErr && selfRateErr.code === 'invalid-argument', 'author cannot rate their own video');

  // Case 5: invalid stars rejected
  let badStarsErr = null;
  try { await fns.rateVideoImpl('rater3', 'postA', 6); } catch (e) { badStarsErr = e; }
  assert(badStarsErr && badStarsErr.code === 'invalid-argument', 'stars=6 rejected as invalid-argument');

  // Case 6: rating a nonexistent post
  let notFoundErr = null;
  try { await fns.rateVideoImpl('rater3', 'ghostPost', 3); } catch (e) { notFoundErr = e; }
  assert(notFoundErr && notFoundErr.code === 'not-found', 'rating a nonexistent post -> not-found');

  // Case 7: logInteraction wrote a 'rate' entry with stars for rater2 on postA
  const interSnap = await db.ref('userInteractions/rater2').once('value');
  let sawRateEntry = false;
  interSnap.forEach(c => { const v = c.val(); if (v && v.type === 'rate' && v.postId === 'postA' && v.stars === 2) sawRateEntry = true; });
  assert(sawRateEntry, 'logInteraction recorded a rate entry with stars for rater2');

  // Case 8: moderation auto-flag fires once at >=5 ratings and avg<=1.5, not before
  await db.ref('feed/postB').update({ ratingSum: 0, ratingCount: 0 });
  await fns.rateVideoImpl('r1', 'postB', 1);
  await fns.rateVideoImpl('r2', 'postB', 1);
  await fns.rateVideoImpl('r3', 'postB', 1);
  await fns.rateVideoImpl('r4', 'postB', 1);
  let reportsBefore = (await db.ref('reports').once('value')).numChildren();
  assert(reportsBefore === 0, 'no auto-flag report yet at 4 one-star ratings');
  await fns.rateVideoImpl('r5', 'postB', 1); // 5th 1-star -> avg 1.0, should trigger
  const reportsSnap = await db.ref('reports').once('value');
  let flagged = null;
  reportsSnap.forEach(c => { const v = c.val(); if (v && v.reason === 'auto_low_rating' && v.postId === 'postB') flagged = v; });
  assert(!!flagged, 'auto_low_rating report filed at 5x 1-star (avg=1.0)');
  assert(flagged && flagged.reportedUid === 'author2', 'flagged report targets the video author (author2)');
  const postBAfter = (await db.ref('feed/postB').once('value')).val();
  assert(!!postBAfter.moderationFlaggedAt, 'postB marked moderationFlaggedAt');

  // Case 9: a 6th 1-star rating should NOT create a second report (fires once)
  await fns.rateVideoImpl('r6', 'postB', 1);
  const reportsSnap2 = await db.ref('reports').once('value');
  let flagCount = 0;
  reportsSnap2.forEach(c => { const v = c.val(); if (v && v.reason === 'auto_low_rating' && v.postId === 'postB') flagCount++; });
  assert(flagCount === 1, 'auto-flag fires only once per post, not again on the 6th 1-star');

  console.log('\nDone.');
  process.exit(process.exitCode || 0);
}

run().catch(e => { console.error(e); process.exit(1); });
