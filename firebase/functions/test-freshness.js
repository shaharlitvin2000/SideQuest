process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';
process.env.GCLOUD_PROJECT = 'flasharena-f35b1';
process.env.FIREBASE_CONFIG = JSON.stringify({
  databaseURL: 'https://flasharena-f35b1-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'flasharena-f35b1'
});

const fns = require('./index.js');
const admin = require('firebase-admin');
const db = admin.database();

const NOW = Date.parse('2026-08-03T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function ts(daysAgo) { return NOW - daysAgo * DAY; }

async function seed() {
  const feed = {
    // Case A: too young (10 days old) -- must NOT be touched at all (no forYouEligible field set)
    postYoung: { uid: 'u1', timestamp: ts(10), caption: 'young post' },

    // Case B: exactly at the 28-day boundary, LOW recent views (2 in last week) -> should become ineligible
    postOldLowViews: { uid: 'u1', timestamp: ts(29), caption: 'old, quiet' },

    // Case C: 29 days old, HIGH recent views (6 in last week) -> should stay/become eligible
    postOldHighViews: { uid: 'u1', timestamp: ts(29), caption: 'old, still popular' },

    // Case D: already checked 10 days ago (within the 30-day recheck window) -> must be SKIPPED this run
    postRecentlyChecked: { uid: 'u1', timestamp: ts(200), forYouEligible: false, freshnessCheckedAt: ts(10), caption: 'checked recently' },

    // Case E: checked 40 days ago (overdue for a recheck), now has high recent views -> should flip back to eligible
    postComeback: { uid: 'u1', timestamp: ts(400), forYouEligible: false, freshnessCheckedAt: ts(40), caption: 'a year old, went viral again' }
  };

  const postViews = {
    postOldLowViews: {
      viewer1: { lastAt: ts(2), count: 1 },
      viewer2: { lastAt: ts(3), count: 1 },
      viewer3: { lastAt: ts(20), count: 1 } // outside the 7-day window, must NOT count
    },
    postOldHighViews: {
      viewer1: { lastAt: ts(1), count: 1 },
      viewer2: { lastAt: ts(2), count: 1 },
      viewer3: { lastAt: ts(3), count: 1 },
      viewer4: { lastAt: ts(4), count: 1 },
      viewer5: { lastAt: ts(5), count: 1 },
      viewer6: { lastAt: ts(6), count: 1 }
    },
    postComeback: {
      viewer1: { lastAt: ts(1), count: 1 },
      viewer2: { lastAt: ts(2), count: 1 },
      viewer3: { lastAt: ts(3), count: 1 },
      viewer4: { lastAt: ts(4), count: 1 },
      viewer5: { lastAt: ts(5), count: 1 }
    }
  };

  await db.ref('feed').set(feed);
  await db.ref('postViews').set(postViews);
}

function assert(cond, label) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + label);
  if (!cond) process.exitCode = 1;
}

(async () => {
  await seed();
  const result = await fns.runForYouFreshnessCheck(NOW);
  console.log('runForYouFreshnessCheck result:', result);

  const after = (await db.ref('feed').once('value')).val();

  assert(after.postYoung.forYouEligible === undefined, 'young post (10d) untouched, no forYouEligible field');
  assert(after.postOldLowViews.forYouEligible === false, 'old post with 2 recent views -> ineligible');
  assert(after.postOldLowViews.freshnessCheckedAt === NOW, 'old-low-views freshnessCheckedAt stamped');
  assert(after.postOldHighViews.forYouEligible === true, 'old post with 6 recent views -> eligible');
  assert(after.postRecentlyChecked.freshnessCheckedAt === ts(10), 'recently-checked post (10d ago) was SKIPPED, timestamp unchanged');
  assert(after.postRecentlyChecked.forYouEligible === false, 'recently-checked post value unchanged (still false)');
  assert(after.postComeback.forYouEligible === true, 'stale ineligible post with 5 fresh views flips back to eligible');
  assert(after.postComeback.freshnessCheckedAt === NOW, 'comeback post freshnessCheckedAt updated to now');

  assert(result.checked === 3, 'exactly 3 posts were due for a check this run (low/high/comeback)');

  console.log('\nDone.');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
