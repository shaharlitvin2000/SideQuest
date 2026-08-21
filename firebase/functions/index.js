const functions = require('firebase-functions');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const express = require('express');
const crypto = require('crypto');
const { defineSecret } = require('firebase-functions/params');

admin.initializeApp();
const db = admin.database();

// ══════════════════════════════════════════════════════════════════
// BUNNY.NET STREAM — video hosting (images stay on Firebase Storage)
// Library ID + CDN host are public; the API key is a secret (never sent to the client).
// Set it with:  firebase functions:secrets:set BUNNY_API_KEY
// ══════════════════════════════════════════════════════════════════
const bunnyApiKey = defineSecret('BUNNY_API_KEY');
const BUNNY_LIBRARY_ID = 710175;
const BUNNY_CDN_HOST = 'vz-a21c2c74-90a.b-cdn.net';

// Delete a video from the Bunny Stream library. Returns true on success (404 = already gone).
async function bunnyDeleteVideo(guid, apiKey) {
  if (!guid) return false;
  try {
    const r = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${guid}`, {
      method: 'DELETE',
      headers: { AccessKey: apiKey, Accept: 'application/json' },
    });
    return r.ok || r.status === 404;
  } catch (e) {
    console.error('[Bunny] delete error', guid, e);
    return false;
  }
}

// Best-effort delete of a Firebase-Storage-hosted file given its public download URL (the shape
// compressUploadedVideo writes to mediaURL/thumbnailURL for mission "proof" uploads). Silently
// no-ops for non-Storage URLs (e.g. Bunny-hosted videos, cleaned up separately above) so it's
// safe to call unconditionally on any post's mediaURL/thumbnailURL.
async function deleteFirebaseStorageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const m = url.match(/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)/);
  if (!m) return false;
  try {
    await admin.storage().bucket().file(decodeURIComponent(m[1])).delete();
    return true;
  } catch (e) {
    if (e.code !== 404) console.error('[Storage] delete error', url, e.message);
    return false;
  }
}

// Room codes (_roomGenCode() client-side) are 5 uppercase letters/digits, but roomCode is taken
// as free-form client input and interpolated straight into `rooms/${roomCode}/...` RTDB paths
// via the Admin SDK, which bypasses security rules entirely -- a `/` (or `.`, `#`, `$`, `[`, `]`)
// in roomCode would redirect the read/write to an unintended location. Alphanumeric-only blocks
// all of those while still accepting every code the app actually generates.
function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9]{1,20}$/.test(code);
}

// Guest browsing signs guests in via Anonymous Auth so `context.auth`/`auth != null` DB rules
// keep working unmodified -- but that also means a guest's context.auth.uid is real and passes
// every plain "!uid" check below. Interactive actions (like, follow, rate, comment, post, room
// actions, watch ads) are meant to prompt sign-up instead, and the client already does that --
// this is the server-side half, since a client-side redirect alone isn't real enforcement.
function isAnonymousCaller(context) {
  return context.auth?.token?.firebase?.sign_in_provider === 'anonymous';
}

// ══════════════════════════════════════════════════════════════════
// RATE LIMITING & ABUSE DETECTION
// ══════════════════════════════════════════════════════════════════

const BLOCKED_USERNAMES = new Set([
  'admin', 'moderator', 'support', 'flash', 'arena', 'system',
  'bot', 'test', 'root', 'admin123', 'null', 'undefined',
  'delete', 'drop', 'hack', 'exploit', 'cheat', 'spam'
]);

const ABUSE_THRESHOLDS = {
  likesPerMinute: 15,
  commentsPerMinute: 10,
  accountsPerIP: 5,
  missionsPerMinute: 3,
  followsPerMinute: 20
};

// Shared across every Cloud Function instance via RTDB (a server-only path -- the root rule
// defaults to no client read/write, and nothing grants one for `rateLimits/`) instead of the
// in-process Maps this used to be. Cloud Functions autoscale horizontally; instances don't share
// memory, so per-uid/IP thresholds were bypassable simply by request volume/timing landing on
// different instances. RTDB is already this project's datastore, so this needed no new service.
// addAbuseScore uses .transaction() specifically to avoid a lost-update race between two
// concurrent invocations for the same uid landing on different instances -- the exact scenario
// this item exists to close -- same reasoning as the atomic view/watch-time counters elsewhere.

// RTDB keys can't contain '.', '#', '$', '[', ']', or '/' -- IPv4 addresses are full of dots.
function sanitizeIPKey(ip) {
  return String(ip || 'unknown').replace(/[.#$\[\]/]/g, '_');
}

// Track IP-based signup attempts
async function trackIPSignup(ip) {
  const ref = db.ref(`rateLimits/ipSignups/${sanitizeIPKey(ip)}`);
  const result = await ref.transaction(cur => {
    if (!cur || Date.now() - cur.timestamp > 3600000) {
      return { count: 1, timestamp: Date.now() };
    }
    return { count: cur.count + 1, timestamp: cur.timestamp };
  });
  return result.committed ? result.snapshot.val().count : 1;
}

async function addAbuseScore(uid, points, reason) {
  const ref = db.ref(`rateLimits/abuseScores/${uid}`);
  const result = await ref.transaction(cur => {
    if (!cur || Date.now() - cur.timestamp > 3600000) {
      return { score: points, timestamp: Date.now(), reasons: [reason] };
    }
    // Cap stored reasons at 20 -- only ever used for a diagnostic log line, an unbounded array
    // for a runaway/bot account would just be wasted storage.
    const reasons = (cur.reasons || []).slice(-19);
    reasons.push(reason);
    return { score: cur.score + points, timestamp: cur.timestamp, reasons };
  });
  return result.committed ? result.snapshot.val().score : points;
}

// Returns { blocked, score, reasons } instead of a bare boolean so the two call sites that log
// the score/reasons on block don't need a second read to get data this call already fetched.
async function checkAbuseScore(uid) {
  const ref = db.ref(`rateLimits/abuseScores/${uid}`);
  const snap = await ref.once('value');
  const abuse = snap.val();
  if (!abuse) return { blocked: false };

  if (Date.now() - abuse.timestamp > 3600000) {
    ref.remove().catch(() => {});
    return { blocked: false };
  }

  // shared hourly budget; raised from 50 so engaged users who like/comment a lot aren't falsely
  // blocked (bots doing hundreds still trip it)
  return { blocked: abuse.score > 100, score: abuse.score, reasons: abuse.reasons };
}

// ══════════════════════════════════════════════════════════════════
// MISSIONS & CONTENT MODERATION SETUP
// ══════════════════════════════════════════════════════════════════

const MISSIONS = [
  { pts: 150, title: 'Ask a stranger one question', category: 'social' },
  { pts: 250, title: 'Stand completely still for 60 seconds', category: 'dare' },
  { pts: 400, title: 'Find a place you\'ve never been to', category: 'explore' }
];

// ══════════ CONTENT MODERATION ══════════
// Keyword blocklist + light, conservative normalization. Goal: catch only CLEAR offensive content
// (explicit threats, blunt slurs, explicit sexual/violent terms) while never blocking innocent words.
// Matching is anchored to word boundaries (with Hebrew/Arabic affixes) so a keyword sitting inside a
// longer innocent word does not trigger (e.g. Arabic "قتل" inside another word, English "meth" in
// "something"). Borderline cases are intentionally let through — the manual report flow covers them.
// ⚠️ KEEP THIS WHOLE MODERATION BLOCK IDENTICAL in index.html and firebase/functions/index.js —
//    there is no shared module between the single-file client and the Cloud Functions. Edit both.
// TODO(ai-moderation): for the uncertain middle band (looks suspicious but no keyword hit), add an
//    AI moderation pass (Perspective API / OpenAI Moderation) called ONLY on that ambiguous slice so
//    cost stays near-zero. This free keyword gate stays as the fast first layer.
const HARMFUL_KEYWORDS = {
  hateful: [
    'nazi','nazism','swastika','heil','hitler','fuhrer','auschwitz','kkk','whitepride','whitesupremacy','goebbels','himmler',
    'נאצי','נאציזם','היטלר','גזען','גזענות',
    'מוות לערבים','מוות ליהודים',
    'نازي','هتلر','عنصري','عنصرية','ابادة',
    'الموت للعرب','الموت لليهود'
  ],
  danger: [
    'murder','massacre','beheading','torture','bloodbath','manslaughter',
    'רצח','לרצוח','רוצח','לשחוט','שחיטה','דקירה','פיגוע','מחבל','לחסל',
    'قتل','اقتل','ذبح','تفجير','مفجر','طعن','ارهاب','ارهابي'
  ],
  dangerousActs: [
    'trainsurfing','subwaysurf','carsurf','cliffjump','balconyjump','chokinggame','blackoutchallenge','firechallenge','tidepod','drinkbleach','skullbreaker','benadrylchallenge',
    'אתגר חנק','מסילת רכבת','לשתות אקונומיקה',
    'تحدي الاختناق'
  ],
  sexual: [
    'porn','porno','nude','nudity','nsfw','onlyfans','xxx','rape','molestation','childporn','pedophile','pedophilia',
    'פורנו','עירום','אונס','לאנוס','זונה','שרמוטה','זיון','לזיין','זנות','פדופיל','פדופיליה',
    'اباحي','بورنو','اغتصاب','اغتصب','مغتصب','عاهرة','شرموطة','قحبة','دعارة','تحرش','بيدوفيل'
  ],
  selfharm: [
    'selfharm','suicide','selfinjury',
    'התאבדות','להתאבד','אובדנות','אובדני',
    'انتحار','ينتحر'
  ],
  drugs: [
    'cocaine','heroin','methamphetamine','fentanyl',
    'קוקאין','הרואין',
    'كوكايين','هيروين'
  ],
  harassment: [
    'killyourself','kys',
    'תמות','שתמות','לך תמות','אני אהרוג אותך',
    'ساقتلك','سادمرك'
  ]
};
// Long, unambiguous terms no innocent word contains — safe to match even in the fully "squeezed"
// text (all separators removed), which is what defeats spaced-out evasion like  n a z i .
const EVASION_PRONE = [
  'nazi','hitler','auschwitz','whitesupremacy','whitepride','blackoutchallenge','benadrylchallenge','skullbreaker','molestation','onlyfans','childporn','pedophile','pedophilia','fentanyl','methamphetamine','crystalmeth','killyourself',
  'נאצי','היטלר','התאבדות','פדופיליה','פדופיל','גזענות',
  'نازي','هتلر','اغتصاب','انتحار','عنصرية','ارهابي','بيدوفيل'
];
// Innocent tokens to never flag (safety net; token matching already clears these). Extend if needed.
const MOD_ALLOWLIST = new Set(['grape','therapist','methodology','skill','skilled','assassinate','shiitake','scunthorpe']);
const _MOD_SEP = /[^a-z\p{Script=Hebrew}\p{Script=Arabic}]+/gu;
const _MOD_STRIP = /[^a-z\p{Script=Hebrew}\p{Script=Arabic}]/gu;
// Light normalization: lowercase, drop hidden/bidi chars, strip diacritics (Latin+Hebrew+Arabic),
// unify Arabic letter shapes and Hebrew final letters, undo digit-leetspeak, collapse 3+ repeats.
function _modNorm(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKD')
    .replace(/[\p{M}ـ]/gu, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ').replace(/ף/g, 'פ').replace(/ץ/g, 'צ')
    .replace(/[0-9]/g, m => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' }[m] || m))
    .replace(/(.)\1{2,}/g, '$1');
}
// keyword normalized to letters only (single word) or letters+single spaces (phrase)
function _modKw(kw) { return _modNorm(kw).replace(_MOD_SEP, ' ').trim(); }
// Does one token equal the keyword once known Hebrew/Arabic/English affixes are allowed?
function _modAffixHit(token, kw) {
  if (token.indexOf(kw) < 0) return false;
  let pfx, sfx;
  if (/\p{Script=Hebrew}/u.test(kw)) {
    pfx = ['', 'ו', 'ה', 'ב', 'כ', 'ל', 'מ', 'ש', 'וה', 'שה', 'לה', 'מה', 'וב', 'ול', 'כש', 'לכ'];
    sfx = ['', 'ים', 'ות', 'ה', 'י', 'נו', 'תי', 'תם', 'כם', 'יה', 'ם', 'נ'];
  } else if (/\p{Script=Arabic}/u.test(kw)) {
    pfx = ['', 'ال', 'لل', 'بال', 'كال', 'وال', 'فال', 'و', 'ف', 'ب', 'ك', 'ل', 'س'];
    sfx = ['', 'ون', 'ين', 'ه', 'ها', 'هم', 'هن', 'وا', 'ي', 'نا', 'كم', 'ات', 'هما'];
  } else {
    pfx = [''];
    sfx = ['', 's', 'es', 'ed', 'ing', 'er', 'ers'];
  }
  for (let i = 0; i < pfx.length; i++) for (let j = 0; j < sfx.length; j++) {
    if (token === pfx[i] + kw + sfx[j]) return true;
  }
  return false;
}
function hasHarmfulContent(text) {
  const base = _modNorm(text);
  if (!base) return false;
  const squeezed = base.replace(_MOD_STRIP, '');
  if (!squeezed) return false;
  const spaced = ' ' + base.replace(_MOD_SEP, ' ').trim() + ' ';
  const tokens = spaced.split(' ');
  for (const category in HARMFUL_KEYWORDS) {
    for (const raw of HARMFUL_KEYWORDS[category]) {
      const kw = _modKw(raw);
      if (!kw) continue;
      if (kw.indexOf(' ') >= 0) {
        if (spaced.indexOf(kw) >= 0) return true;
      } else {
        for (let t = 0; t < tokens.length; t++) {
          const tok = tokens[t];
          if (tok && !MOD_ALLOWLIST.has(tok) && _modAffixHit(tok, kw)) return true;
        }
      }
    }
  }
  for (let e = 0; e < EVASION_PRONE.length; e++) {
    const ek = _modKw(EVASION_PRONE[e]).replace(/ /g, '');
    if (ek && squeezed.indexOf(ek) >= 0) return true;
  }
  return false;
}

// Helper: Check email verification for user actions
function validateEmailVerified(context) {
  if (!context.auth || !context.auth.token || !context.auth.token.email_verified) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please verify your email first (check your inbox)'
    );
  }
}

function getIsraelDate() {
  // Intl with the IANA zone is DST-exact (Node 20 ships full ICU) — no manual offset math.
  // en-CA formats as YYYY-MM-DD, matching the client's ilDayStr().
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ══════════════════════════════════════════════════════════════════
// USERNAME VALIDATION
// ══════════════════════════════════════════════════════════════════

async function validateUsername(username) {
  if (!username || username.length < 3 || username.length > 30) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Username must be 3-30 characters'
    );
  }

  if (BLOCKED_USERNAMES.has(username.toLowerCase())) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'This username is not allowed'
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Username can only contain letters, numbers, underscores, and dashes'
    );
  }

  // Check for visually confusable usernames (prevent impersonation)
  const confusables = { 'l': 'I', '0': 'O', '1': 'l', 'Il': 'l1' };
  const normalized = username.toLowerCase()
    .replace(/l/g, 'I').replace(/0/g, 'O').replace(/1/g, 'l');

  const existingSnap = await db.ref('usernames').once('value');
  if (existingSnap.exists()) {
    const allUsernames = existingSnap.val();
    for (const existing in allUsernames) {
      const existingNorm = existing.toLowerCase()
        .replace(/l/g, 'I').replace(/0/g, 'O').replace(/1/g, 'l');
      if (normalized === existingNorm && existing.toLowerCase() !== username.toLowerCase()) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Username too similar to existing account. Try a different name.'
        );
      }
    }
  }

  const duplicateSnap = await db.ref('usernames')
    .orderByValue()
    .equalTo(username.toLowerCase())
    .once('value');

  if (duplicateSnap.exists()) {
    throw new functions.https.HttpsError(
      'already-exists',
      'Username already taken'
    );
  }
}

// ══════════════════════════════════════════════════════════════════
// VALIDATE USERNAME — also unused from the client, see the note above registerUser below.
// ══════════════════════════════════════════════════════════════════

exports.validateUsername = functions.https.onCall(async (data, context) => {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  const username = (data.username || '').trim();

  if (!username) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Username is required'
    );
  }

  await validateUsername(username);

  return { available: true, username: username };
});

// ══════════════════════════════════════════════════════════════════
// REGISTER USER WITH USERNAME VALIDATION
// ══════════════════════════════════════════════════════════════════

const registerLimiter = rateLimit({
  windowMs: 3600000, // 1 hour
  max: 5, // 5 registrations per hour per IP
  keyGenerator: (req) => req.ip || req.connection.remoteAddress
});

function assessBotRisk(email, username, ip) {
  let riskScore = 0;

  // 1. Username patterns
  const botPatterns = /bot|admin|test|user\d{6,}|xxx|spam|hack|root|system/i;
  if (botPatterns.test(username)) {
    riskScore += 25;
    console.log(`[AntiBot] Username red flag: ${username}`);
  }

  // 2. Disposable email check
  const disposableDomains = [
    'tempmail', '10minutemail', 'mailinator', 'guerrillamail',
    'throwaway', 'yopmail', 'fake', 'trashmail', 'sharklasers'
  ];
  const emailDomain = email.split('@')[1];
  if (disposableDomains.some(d => emailDomain.includes(d))) {
    riskScore += 30;
    console.log(`[AntiBot] Disposable email: ${emailDomain}`);
  }

  // 3. Email patterns
  if (!/^[^@]+@[^@]+\.[^@]{2,}$/.test(email)) {
    riskScore += 15;
  }
  if (email.includes('+')) {
    riskScore += 10;  // +tag emails often used for spam
  }

  // 4. Username entropy (too simple)
  const uniqueChars = new Set(username.toLowerCase()).size;
  if (uniqueChars < 3) {
    riskScore += 20;  // "aaa" or "111" - obviously a bot
  }

  return riskScore;
}

// registerUser and validateUsername (below) are deployed but never called from the client —
// the live signup path is doRegister() in index.html, which creates the Firebase Auth user
// directly and claims the username via the usernames/ transaction, with none of the anti-bot
// risk scoring or IP throttling these two implement. Left defined rather than deleted: this is
// real, working anti-abuse logic that duplicates none of the moderation fixes made elsewhere
// today, and could be wired up later without rewriting it. If genuinely not wanted, both are
// safe to remove — nothing else calls exports.registerUser or exports.validateUsername.
exports.registerUser = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const email = (data.email || '').trim().toLowerCase();
  const username = (data.username || '').trim();
  const ip = context.rawRequest?.ip || 'unknown';

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (!email || !username) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Email and username are required'
    );
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Please enter a valid email address'
    );
  }

  // Anti-bot risk assessment
  const riskScore = assessBotRisk(email, username, ip);
  if (riskScore >= 50) {
    console.log(`[AntiBot] High risk signup - score: ${riskScore}, user: ${username}, email: ${email}`);
    throw new functions.https.HttpsError(
      'permission-denied',
      'Unable to create account. Please check your information and try again.'
    );
  }

  // Check IP-based signup rate (prevent account farms)
  const signupCount = await trackIPSignup(ip);
  if (signupCount > 5) {
    console.log(`[IPBlock] IP ${ip} exceeded signup limit: ${signupCount} attempts`);
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Too many accounts from this network. Try again in 1 hour.'
    );
  }

  // Validate username
  await validateUsername(username);

  // Create user record in database
  const userData = {
    email: email,
    username: username,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    pts: 0,
    totalMissionsDone: 0,
    missionsDate: getIsraelDate(),
    completedMissionsToday: {},
    verified: false,
    blocked: false
  };

  // Store username mapping for deduplication
  const updates = {};
  updates[`users/${uid}`] = userData;
  updates[`usernames/${uid}`] = username.toLowerCase();
  // Public leaderboard entry (only non-sensitive fields)
  updates[`leaderboard/${uid}`] = { username: username, pts: 0, missions: 0 };

  await db.ref().update(updates);

  return {
    success: true,
    message: 'User registered. Please verify your email.',
    uid: uid
  };
});

// ══════════════════════════════════════════════════════════════════
// VERIFY EMAIL
// ══════════════════════════════════════════════════════════════════

exports.verifyEmail = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (!context.auth.token.email_verified) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please verify your email through the link sent to your inbox'
    );
  }

  // Update user as verified
  await db.ref(`users/${uid}`).update({
    verified: true,
    verifiedAt: admin.database.ServerValue.TIMESTAMP
  });

  return { success: true, message: 'Email verified successfully' };
});

// ══════════════════════════════════════════════════════════════════
// MISSION COMPLETION - ATOMIC, IDEMPOTENT, SERVER-SIDE VERIFICATION
// ══════════════════════════════════════════════════════════════════

exports.completeMission = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const missionId = data.missionId;
  const missionTitle = data.missionTitle || '';

  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (missionId < 0 || missionId >= MISSIONS.length) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid mission ID');
  }

  // Note: missionTitle may be translated, so we don't validate it strictly
  // The missionId is the authoritative source of which mission this is

  // ===== SECURITY CHECKS =====
  // Email verification is NOT required: the client never enforced it, so gating
  // here would lock out existing unverified users. Anti-abuse still applies below
  // (abuse scoring, blocked check, atomic daily-limit) which is the real protection.

  const abuseCheck1 = await checkAbuseScore(uid);
  if (abuseCheck1.blocked) {
    console.log(`[Abuse] User ${uid} blocked - score: ${abuseCheck1.score}, reasons:`, abuseCheck1.reasons);
    throw new functions.https.HttpsError(
      'permission-denied',
      'Suspicious activity detected. Please try again later.'
    );
  }

  const userSnap = await db.ref(`users/${uid}`).once('value');
  const userData = userSnap.val();

  if (!userData) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  if (userData.blocked === true) {
    throw new functions.https.HttpsError('permission-denied', 'Account blocked');
  }

  const today = getIsraelDate();
  const completedKey = `completedMissionsToday/${missionId}`;

  // ATOMIC TRANSACTION
  // Note: RTDB transactions may first run with null even when data exists —
  // we must return the value unchanged (not throw) so Firebase retries with real data.
  let txnAbortReason = null;
  const result = await db.ref(`users/${uid}`).transaction(existing => {
    if (existing === null) {
      return existing;
    }

    txnAbortReason = null;

    // A new day resets the daily missions FIRST (everything else persists),
    // otherwise yesterday's completions would block today's missions
    if (existing.missionsDate !== today) {
      existing.missionsDate = today;
      existing.completedMissionsToday = {};
      existing.adsWatched = 0;
    }

    if (existing.completedMissionsToday && existing.completedMissionsToday[missionId]) {
      txnAbortReason = 'ALREADY_COMPLETED';
      return; // abort transaction
    }

    const completedCount = existing.completedMissionsToday ?
        Object.keys(existing.completedMissionsToday).length : 0;
    if (completedCount >= 3) {
      txnAbortReason = 'DAILY_LIMIT_REACHED';
      return; // abort transaction
    }

    const earned = MISSIONS[missionId].pts;
    existing.pts = (existing.pts || 0) + earned;
    existing.seasonPts = (existing.seasonPts || 0) + earned;  // monthly season score (reset by rolloverSeason)
    existing.totalMissionsDone = (existing.totalMissionsDone || 0) + 1;

    if (!existing.completedMissionsToday) {
      existing.completedMissionsToday = {};
    }
    existing.completedMissionsToday[missionId] = Date.now();
    existing.updatedAt = Date.now();

    return existing;
  });

  if (!result.committed) {
    if (txnAbortReason === 'ALREADY_COMPLETED') {
      throw new functions.https.HttpsError('already-exists', 'Mission already completed today');
    }
    if (txnAbortReason === 'DAILY_LIMIT_REACHED') {
      throw new functions.https.HttpsError('resource-exhausted', 'Daily mission limit (3) reached');
    }
    throw new functions.https.HttpsError('internal', 'Transaction failed');
  }

  if (!result.snapshot.exists()) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const newUserData = result.snapshot.val();

  // Abuse tracking - check again after transaction to prevent race conditions
  await addAbuseScore(uid, 5, 'mission_completion');
  const abuseCheck2 = await checkAbuseScore(uid);
  if (abuseCheck2.blocked) {
    console.log(`[Abuse] User ${uid} flagged after mission - score: ${abuseCheck2.score}`);
    // Note: Mission is already completed, but user is now on abuse watch list
  }

  // Update public leaderboard entry (only non-sensitive fields)
  await db.ref(`leaderboard/${uid}`).update({
    username: newUserData.username || 'Player',
    pts: newUserData.pts || 0,
    missions: newUserData.totalMissionsDone || 0,
    streak: newUserData.streak || 0,
    seasonPts: newUserData.seasonPts || 0
  });

  // Create post in feed
  const postRef = db.ref('feed').push();
  const post = {
    uid: uid,
    username: newUserData.username || 'Player',
    missionTitle: missionTitle,
    missionId: missionId,
    pts: MISSIONS[missionId].pts,
    timestamp: admin.database.ServerValue.TIMESTAMP,
    status: 'verified',
    views: 0,
    likes: 0,
    mediaURL: null,
    mediaType: null
  };

  // Verify content
  const checkText = missionTitle + (newUserData.username || '');
  if (hasHarmfulContent(checkText)) {
    post.status = 'rejected';
    post.rejectionReason = 'Harmful content detected';

    await db.ref(`users/${uid}/badUploads`).transaction(cur => (cur || 0) + 1);

    const badSnap = await db.ref(`users/${uid}/badUploads`).once('value');
    const badCount = badSnap.val() || 0;
    if (badCount >= 2) {
      await db.ref(`users/${uid}/blocked`).set(true);
    }
  }

  await postRef.set(post);

  // Notify followers that this user completed a mission (verified posts only, capped to avoid spam)
  if (post.status === 'verified') {
    try {
      const followersSnap = await db.ref(`followers/${uid}`).limitToFirst(30).once('value');
      const sends = [];
      followersSnap.forEach(c => {
        sends.push(sendPushNotification(
          c.key,
          '🎯 ' + (newUserData.username || 'A friend') + ' completed a mission',
          missionTitle,
          { type: 'friend_mission', byUid: uid, postId: postRef.key }
        ).catch(() => {}));
      });
      await Promise.all(sends);
    } catch (e) { console.error('[Friend Mission Notify]', e); }
  }

  return {
    success: true,
    earned: MISSIONS[missionId].pts,
    newPoints: newUserData.pts,
    totalMissionsDone: newUserData.totalMissionsDone,
    postId: postRef.key
  };
});

// ══════════════════════════════════════════════════════════════════
// FOLLOW USER - ATOMIC DUAL-WRITE WITH ABUSE TRACKING
// ══════════════════════════════════════════════════════════════════

exports.followUser = functions.https.onCall(async (data, context) => {
  validateEmailVerified(context);

  const uid = context.auth?.uid;
  const targetUid = data.targetUid;
  const targetUsername = data.targetUsername || 'Player';

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (uid === targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'Cannot follow yourself');
  }

  // Check abuse
  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Too many follows. Please wait a moment.'
    );
  }

  const [targetSnap, blockedByTargetSnap, blockedByMeSnap] = await Promise.all([
    db.ref(`users/${targetUid}`).once('value'),
    db.ref(`userBlocked/${targetUid}/${uid}`).once('value'),
    db.ref(`userBlocked/${uid}/${targetUid}`).once('value')
  ]);
  if (!targetSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }
  if (blockedByTargetSnap.exists() || blockedByMeSnap.exists()) {
    throw new functions.https.HttpsError('permission-denied', 'Cannot follow this user');
  }

  const userSnap = await db.ref(`users/${uid}`).once('value');
  const userName = userSnap.val()?.username || 'Player';

  const timestamp = admin.database.ServerValue.TIMESTAMP;

  // Track abuse
  await addAbuseScore(uid, 1, 'follow');

  // Atomic dual-write
  await db.ref().update({
    [`follows/${uid}/${targetUid}`]: { username: targetUsername, at: timestamp },
    [`followers/${targetUid}/${uid}`]: { username: userName, at: timestamp }
  });

  // In-app inbox entry only — the push itself is sent by notifyNewFollower, which triggers off
  // the followers/{targetUid}/{uid} write just above. Sending it here too used to mean every
  // follow pushed the target twice with different wording for the same event.
  await writeNotification(targetUid, 'follow', uid, userName);

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// UNFOLLOW USER - ATOMIC DUAL-DELETE
// ══════════════════════════════════════════════════════════════════

exports.unfollowUser = functions.https.onCall(async (data, context) => {
  validateEmailVerified(context);

  const uid = context.auth?.uid;
  const targetUid = data.targetUid;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  await db.ref().update({
    [`follows/${uid}/${targetUid}`]: null,
    [`followers/${targetUid}/${uid}`]: null
  });

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// REPORT USER - WITH SAFETY CHECKS
// ══════════════════════════════════════════════════════════════════

exports.reportUser = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const reportedUid = data.reportedUid;
  const reason = data.reason;  // 'harassment', 'spam', 'abuse', 'inappropriate'
  const details = (data.details || '').trim().substring(0, 500);
  const postId = data.postId ? String(data.postId).slice(0, 60) : null;

  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (uid === reportedUid) {
    throw new functions.https.HttpsError('invalid-argument', 'Cannot report yourself');
  }

  const validReasons = ['harassment', 'spam', 'abuse', 'inappropriate', 'hate_speech', 'scam', 'nudity', 'violence'];
  if (!validReasons.includes(reason)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid reason');
  }

  // Validate details field (plain text only, no HTML/scripts)
  if (details && (details.includes('<') || details.includes('>') || details.includes('javascript:'))) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Report details cannot contain HTML or scripts'
    );
  }

  // Check if already reported recently
  const recentReports = await db.ref('reports')
    .orderByChild('byUid')
    .equalTo(uid)
    .once('value');

  const reportsArray = [];
  recentReports.forEach(child => {
    const report = child.val();
    if (Date.now() - report.createdAt < 3600000) {  // 1 hour
      reportsArray.push(report);
    }
  });

  if (reportsArray.length >= 5) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Too many reports. Please wait before reporting again.'
    );
  }

  // Create report
  const reportRef = db.ref('reports').push();
  const reportData = {
    byUid: uid,
    reportedUid: reportedUid,
    reason: reason,
    details: details,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    status: 'pending'
  };
  if (postId) reportData.postId = postId;
  await reportRef.set(reportData);

  console.log(`[Report] ${uid} reported ${reportedUid} for ${reason}`);
  return { success: true, reportId: reportRef.key };
});

// ══════════════════════════════════════════════════════════════════
// BLOCK USER
// ══════════════════════════════════════════════════════════════════

exports.blockUser = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const blockedUid = data.blockedUid;
  const blockedUsername = data.blockedUsername ? String(data.blockedUsername).slice(0, 30) : 'Player';

  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (uid === blockedUid) {
    throw new functions.https.HttpsError('invalid-argument', 'Cannot block yourself');
  }

  // Add to blocked list (name kept alongside timestamp so the client's blocked-list UI can show
  // who this is without a separate lookup)
  await db.ref(`userBlocked/${uid}/${blockedUid}`).set({
    name: blockedUsername,
    timestamp: admin.database.ServerValue.TIMESTAMP
  });

  // Also unfollow if following
  await db.ref(`follows/${uid}/${blockedUid}`).remove();
  await db.ref(`followers/${blockedUid}/${uid}`).remove();

  console.log(`[Block] ${uid} blocked ${blockedUid}`);
  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// UNBLOCK USER
// ══════════════════════════════════════════════════════════════════

exports.unblockUser = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const blockedUid = data.blockedUid;

  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  await db.ref(`userBlocked/${uid}/${blockedUid}`).remove();
  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// MUTE USER - Hide their posts from feed
// ══════════════════════════════════════════════════════════════════

exports.muteUser = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const mutedUid = data.mutedUid;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (uid === mutedUid) {
    throw new functions.https.HttpsError('invalid-argument', 'Cannot mute yourself');
  }

  await db.ref(`userMuted/${uid}/${mutedUid}`).set({
    timestamp: admin.database.ServerValue.TIMESTAMP
  });

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// UNMUTE USER
// ══════════════════════════════════════════════════════════════════

exports.unmuteUser = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const mutedUid = data.mutedUid;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  await db.ref(`userMuted/${uid}/${mutedUid}`).remove();
  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// REDEMPTION OPTIONS (Server-side definition)
// ══════════════════════════════════════════════════════════════════

const REDEMPTION_OPTIONS = {
  'coffee_2': { pts: 200, name: '$2 Coffee', reward_type: 'gift_card', value: 2 },
  'amazon_10': { pts: 1000, name: '$10 Amazon', reward_type: 'gift_card', value: 10 },
  'amazon_25': { pts: 2500, name: '$25 Amazon', reward_type: 'gift_card', value: 25 },
  'amazon_50': { pts: 5000, name: '$50 Amazon', reward_type: 'gift_card', value: 50 },
  'amazon_100': { pts: 10000, name: '$100 Amazon', reward_type: 'gift_card', value: 100 },
  'paypal_5': { pts: 500, name: '$5 PayPal', reward_type: 'paypal', value: 5 },
  'paypal_10': { pts: 1000, name: '$10 PayPal', reward_type: 'paypal', value: 10 },
  'paypal_25': { pts: 2500, name: '$25 PayPal', reward_type: 'paypal', value: 25 },
  'spotify_10': { pts: 1000, name: '$10 Spotify', reward_type: 'gift_card', value: 10 },
  'googleplay_15': { pts: 1500, name: '$15 Google Play', reward_type: 'gift_card', value: 15 },
  'steam_20': { pts: 2000, name: '$20 Steam', reward_type: 'gift_card', value: 20 }
};

// ══════════════════════════════════════════════════════════════════
// REDEEM POINTS
// ══════════════════════════════════════════════════════════════════

exports.redeemPoints = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const redeemId = data.redeemId;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const option = REDEMPTION_OPTIONS[redeemId];
  if (!option) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid redemption option');
  }

  // Generate unique code
  const code = 'FLASH-' + Math.random().toString(36).substr(2, 9).toUpperCase();

  // Duplicate-check and point deduction happen in the SAME atomic transaction (both keyed off
  // users/{uid}/redeemedRecently), so two near-simultaneous requests for the same reward can no
  // longer both pass the duplicate check before either's deduction lands — only one can win.
  const now = Date.now();
  let txnAbortReason = null;
  const txn = await db.ref(`users/${uid}`).transaction(user => {
    // RTDB may first run with null even when data exists — return unchanged so Firebase retries with real data
    if (user === null) {
      return user;
    }

    txnAbortReason = null;

    const lastRedeemedAt = user.redeemedRecently && user.redeemedRecently[redeemId];
    if (lastRedeemedAt && (now - lastRedeemedAt) < 86400000) {  // 24 hours
      txnAbortReason = 'DUPLICATE';
      return;  // abort
    }

    const currentPts = user.pts || 0;
    if (currentPts < option.pts) {
      txnAbortReason = 'INSUFFICIENT';
      return;  // abort - not enough points
    }

    // Deduct points
    user.pts = currentPts - option.pts;
    if (!user.redeemedRecently) user.redeemedRecently = {};
    user.redeemedRecently[redeemId] = now;
    return user;
  });

  if (!txn.committed || !txn.snapshot.exists()) {
    if (txnAbortReason === 'DUPLICATE') {
      throw new functions.https.HttpsError(
        'already-exists',
        'You can only redeem this reward once per 24 hours'
      );
    }
    if (txnAbortReason === 'INSUFFICIENT') {
      const currentPts = txn.snapshot.exists() ? (txn.snapshot.val().pts || 0) : 0;
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Need ${option.pts} points, you have ${currentPts}`
      );
    }
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  // The points ARE deducted now (the transaction committed). From here, ANY failure must refund them —
  // otherwise the user pays real-money-worth of points for nothing.
  const newPts = txn.snapshot.val().pts || 0;

  // Create the redemption record. If this write fails, roll the deduction back and tell the user
  // clearly that they were NOT charged.
  const redemptionRef = db.ref('redemptions').push();
  try {
    await redemptionRef.set({
      byUid: uid,
      redeemId: redeemId,
      rewardType: option.reward_type,
      value: option.value,
      code: code,
      status: 'pending',
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
  } catch (recErr) {
    console.error(`[Redeem] record write failed for ${uid} (${redeemId}) — refunding ${option.pts} pts`, recErr);
    let restored = newPts + option.pts;
    try {
      const rf = await db.ref(`users/${uid}`).transaction(u => {
        if (u) {
          u.pts = (u.pts || 0) + option.pts;
          // Undo the duplicate-guard marker too — a refunded redemption must not block a retry for 24h.
          if (u.redeemedRecently) delete u.redeemedRecently[redeemId];
        }
        return u;
      });
      if (rf.committed && rf.snapshot.exists()) restored = rf.snapshot.val().pts || restored;
    } catch (e) {
      console.error(`[Redeem] REFUND FAILED for ${uid} — ${option.pts} pts owed, needs manual fix`, e);
    }
    await db.ref(`leaderboard/${uid}/pts`).set(restored).catch(() => {});
    await redemptionRef.remove().catch(() => {});   // clear any partial write
    // 'aborted' (not 'unavailable'/'internal') so the client's isFnUnavailable() Blaze-check doesn't
    // hijack it — the client maps this code to a clear "you were not charged" message.
    throw new functions.https.HttpsError('aborted', 'Redemption failed — your points were NOT charged. Please try again.');
  }

  // Record created → the redemption is real. Sync the leaderboard best-effort: a stale value here is
  // only cosmetic and must NOT fail a redemption that already succeeded (that would wrongly error the
  // user for a reward they DID get).
  await db.ref(`leaderboard/${uid}/pts`).set(newPts).catch(() => {});

  console.log(`[Redeem] ${uid} redeemed ${redeemId} for ${option.pts} pts - Code: ${code}`);

  return {
    success: true,
    redemptionId: redemptionRef.key,
    code: code,
    message: `Redeem code: ${code}`
  };
});

// ══════════════════════════════════════════════════════════════════
// GET REDEMPTION HISTORY
// ══════════════════════════════════════════════════════════════════

exports.getRedemptionHistory = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const redemptionsSnap = await db.ref('redemptions')
    .orderByChild('byUid')
    .equalTo(uid)
    .limitToLast(10)
    .once('value');

  const redemptions = [];
  redemptionsSnap.forEach(child => {
    redemptions.push({
      id: child.key,
      ...child.val()
    });
  });

  return {
    success: true,
    redemptions: redemptions.reverse()
  };
});

// Write an entry to a user's in-app notifications inbox (best-effort).
async function writeNotification(targetUid, type, fromUid, fromUsername, extra) {
  if (!targetUid || targetUid === fromUid) return;
  try {
    await db.ref(`notifications/${targetUid}`).push(Object.assign({
      type: type,
      byUid: fromUid || null,
      byUsername: fromUsername || 'Someone',
      createdAt: admin.database.ServerValue.TIMESTAMP,
      read: false
    }, extra || {}));
  } catch (e) { console.error('[writeNotification]', e); }
}

// Keep each user's inbox bounded: on every new notification, trim to the 100 newest.
// Central cap so notifications never grow unbounded (cost + endless list), regardless of source.
const MAX_NOTIFICATIONS = 100;
exports.trimNotifications = functions.database
  .ref('/notifications/{uid}/{nid}')
  .onCreate(async (snap, context) => {
    const uid = context.params.uid;
    const ref = db.ref(`notifications/${uid}`);
    const all = await ref.orderByChild('createdAt').once('value');
    const keys = [];
    all.forEach(c => { keys.push(c.key); });
    if (keys.length <= MAX_NOTIFICATIONS) return null;
    const updates = {};
    keys.slice(0, keys.length - MAX_NOTIFICATIONS).forEach(k => { updates[k] = null; });
    return ref.update(updates).catch(e => console.error('[trimNotifications]', e));
  });

// ══════════════════════════════════════════════════════════════════
// SEND PUSH NOTIFICATION
// ══════════════════════════════════════════════════════════════════

async function sendPushNotification(targetUid, title, body, data) {
  try {
    // Respect the user's push preference — skip if they turned notifications off.
    const prefSnap = await db.ref(`users/${targetUid}/pushEnabled`).once('value');
    if (prefSnap.val() === false) {
      console.log(`[Push] Skipped — ${targetUid} disabled notifications`);
      return;
    }
    // Get user's FCM tokens
    const tokensSnap = await db.ref(`users/${targetUid}/fcmTokens`).once('value');
    const tokens = tokensSnap.val() || {};

    if (Object.keys(tokens).length === 0) {
      console.log(`[Push] No FCM tokens for ${targetUid}`);
      return;
    }

    const messages = Object.entries(tokens).map(([token, tokenData]) => ({
      notification: {
        title: title,
        body: body,
        icon: 'https://flasharena-f35b1.web.app/icon-192.png'
      },
      data: {
        type: data.type || 'general',
        byUid: data.byUid || '',
        postId: data.postId || '',
        commentId: data.commentId || ''
      },
      token: token,
      webpush: {
        fcm_options: { link: 'https://flasharena-f35b1.web.app/' },
        notification: {
          title: title,
          body: body,
          tag: data.type || 'notification',
          icon: 'https://flasharena-f35b1.web.app/icon-192.png'
        }
      }
    }));

    if (messages.length > 0) {
      const response = await admin.messaging().sendAll(messages);
      console.log(`[Push] Sent ${response.successCount}/${messages.length} notifications to ${targetUid}`);
    }
  } catch (error) {
    console.error(`[Push] Error sending notifications:`, error);
  }
}

// ══════════════════════════════════════════════════════════════════
// SAVE POST - IDEMPOTENT WITH DEDUPLICATION
// ══════════════════════════════════════════════════════════════════

exports.savePost = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const postId = data.postId;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userSaveRef = db.ref(`userSaves/${uid}/${postId}`);
  const saveSnap = await userSaveRef.once('value');

  if (saveSnap.exists()) {
    throw new functions.https.HttpsError('already-exists', 'Already saved');
  }

  await userSaveRef.set({
    timestamp: admin.database.ServerValue.TIMESTAMP
  });

  // Increment saved count
  await db.ref(`feed/${postId}/savedCount`).transaction(cur => (cur || 0) + 1);

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// UNSAVE POST
// ══════════════════════════════════════════════════════════════════

exports.unsavePost = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const postId = data.postId;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userSaveRef = db.ref(`userSaves/${uid}/${postId}`);
  const saveSnap = await userSaveRef.once('value');

  if (!saveSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Not saved');
  }

  await userSaveRef.remove();
  await db.ref(`feed/${postId}/savedCount`).transaction(cur => Math.max(0, (cur || 1) - 1));

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// FOR YOU — rolling window of each user's last 20 content interactions.
// v1, deliberately simple: a fixed-size FIFO log per user (userInteractions/{uid}), fed by
// likePost (strong positive) and recordView (fast skip = negative, near-full watch =
// positive). feedCalculateEngagementScore (index.html) reads this back to nudge ranking
// toward categories/vibes/media types the user has recently responded well to. Hashtags are
// NOT used yet — they only exist as a reverse index (hashtags/{tag}/{postId}), there's no
// forward field on the post itself to know a given post's tags without an extra lookup per
// post, which didn't fit "simplest first pass."
// ══════════════════════════════════════════════════════════════════

const MAX_INTERACTIONS = 20;

function getPostContentSignals(post) {
  const category = (post.missionId != null && MISSIONS[post.missionId]) ? MISSIONS[post.missionId].category : null;
  return {
    category: category || null,
    vibe: post.music || null,
    mediaType: post.mediaType || null
  };
}

async function logInteraction(uid, postId, type, signals) {
  const ref = db.ref(`userInteractions/${uid}`);
  const entry = {
    postId: postId,
    type: type,
    category: signals.category,
    vibe: signals.vibe,
    mediaType: signals.mediaType,
    at: admin.database.ServerValue.TIMESTAMP
  };
  if (signals.stars != null) entry.stars = signals.stars;
  await ref.push(entry);
  // Trim to the last MAX_INTERACTIONS — a plain FIFO, not exact under rare concurrent
  // writes, but self-corrects on the next call. Good enough for a v1 preference signal.
  const snap = await ref.orderByKey().limitToLast(MAX_INTERACTIONS + 1).once('value');
  if (snap.numChildren() > MAX_INTERACTIONS) {
    const oldestKey = Object.keys(snap.val())[0];
    await ref.child(oldestKey).remove();
  }
}

// ══════════════════════════════════════════════════════════════════
// LIKE POST - IDEMPOTENT WITH DEDUPLICATION & ABUSE TRACKING
// ══════════════════════════════════════════════════════════════════

exports.likePost = functions.https.onCall(async (data, context) => {
  // Email verification intentionally NOT required (consistent with completeMission) —
  // otherwise non-verified users couldn't like. Inflation is prevented by the userLikes
  // dedup below + the RTDB rules (feed likes/views are write:false for clients).
  const uid = context.auth?.uid;
  const postId = data.postId;

  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  // Check abuse
  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Too many likes. Please wait a moment.'
    );
  }

  const userLikeRef = db.ref(`userLikes/${uid}/${postId}`);
  const postRef = db.ref(`feed/${postId}`);

  const likeSnap = await userLikeRef.once('value');
  if (likeSnap.exists()) {
    throw new functions.https.HttpsError('already-exists', 'Already liked');
  }

  // Verify post exists
  const postSnap = await postRef.once('value');
  const post = postSnap.val();

  if (!post) {
    throw new functions.https.HttpsError('not-found', 'Post not found');
  }

  const userSnap = await db.ref(`users/${uid}`).once('value');
  const user = userSnap.val();

  // Track abuse
  await addAbuseScore(uid, 1, 'like');

  await userLikeRef.set(true);
  await postRef.child('likes').transaction(cur => (cur || 0) + 1);

  // For You: a like is the strongest positive signal we have.
  await logInteraction(uid, postId, 'like', getPostContentSignals(post)).catch(() => {});

  // Send notification to post author
  if (post && post.uid && post.uid !== uid) {
    await writeNotification(post.uid, 'like', uid, user?.username, { postId: postId });
    await sendPushNotification(
      post.uid,
      '❤️ ' + (user?.username || 'Someone') + ' liked your video',
      post.missionTitle || 'Your post',
      {
        type: 'like',
        byUid: uid,
        postId: postId
      }
    ).catch(err => console.error('[Like Notify]', err));
  }

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// UNLIKE POST - IDEMPOTENT
// ══════════════════════════════════════════════════════════════════

exports.unlikePost = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const postId = data.postId;

  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userLikeRef = db.ref(`userLikes/${uid}/${postId}`);
  const likeSnap = await userLikeRef.once('value');
  if (!likeSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Not liked');
  }

  await userLikeRef.remove();
  await db.ref(`feed/${postId}/likes`).transaction(cur => Math.max(0, (cur || 1) - 1));

  // Remove the "liked your video" notification so unlike (and like→unlike→like) doesn't leave
  // stale/spammy entries. Best-effort: find the post author's like-notif from this user for this post.
  try {
    const authorSnap = await db.ref(`feed/${postId}/uid`).once('value');
    const authorUid = authorSnap.val();
    if (authorUid && authorUid !== uid) {
      const notifsSnap = await db.ref(`notifications/${authorUid}`)
        .orderByChild('byUid').equalTo(uid).once('value');
      const updates = {};
      notifsSnap.forEach(c => {
        const n = c.val();
        if (n && n.type === 'like' && n.postId === postId) updates[c.key] = null;
      });
      if (Object.keys(updates).length) await db.ref(`notifications/${authorUid}`).update(updates);
    }
  } catch (e) { console.error('[unlikePost notif cleanup]', e); }

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// RATE VIDEO - 5-STAR QUALITY/COMPLETION RATING
// Pure ranking signal, no pts awarded. Upserts the rater's own star (userRatings/{uid}/{postId})
// and keeps a running ratingSum/ratingCount/ratingAvg on the post, feeding both the For You
// preference profile (via logInteraction) and feedCalculateEngagementScore's post-popularity
// term on the client. A pile-up of 1-star ratings auto-files into the existing `reports` queue
// for manual review — same queue and admin panel as user-submitted reports.
// ══════════════════════════════════════════════════════════════════

const RATING_FLAG_MIN_COUNT = 5;
const RATING_FLAG_MAX_AVG = 1.5;

async function rateVideoImpl(uid, postId, stars) {
  if (!postId || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid rating');
  }

  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Too many ratings. Please wait a moment.'
    );
  }

  const postRef = db.ref(`feed/${postId}`);
  const postSnap = await postRef.once('value');
  const post = postSnap.val();

  if (!post) {
    throw new functions.https.HttpsError('not-found', 'Post not found');
  }
  if (post.uid === uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Cannot rate your own video');
  }

  await addAbuseScore(uid, 2, 'rate');

  const userRatingRef = db.ref(`userRatings/${uid}/${postId}`);
  const priorSnap = await userRatingRef.once('value');
  const prior = priorSnap.val();
  const delta = prior ? (stars - prior.stars) : stars;

  await userRatingRef.set({ stars: stars, ratedAt: admin.database.ServerValue.TIMESTAMP });

  const sumTx = await postRef.child('ratingSum').transaction(cur => (cur || 0) + delta);
  if (!prior) {
    await postRef.child('ratingCount').transaction(cur => (cur || 0) + 1);
  }
  const countSnap = await postRef.child('ratingCount').once('value');
  const newSum = sumTx.snapshot.val() || 0;
  const newCount = countSnap.val() || 0;
  const newAvg = newCount > 0 ? newSum / newCount : 0;
  await postRef.child('ratingAvg').set(newAvg);

  // For You: nudge the rater's preference profile toward/away from this content's category/vibe.
  await logInteraction(uid, postId, 'rate', Object.assign(getPostContentSignals(post), { stars: stars })).catch(() => {});

  // Quality/abuse net: enough consistent 1-2-star ratings queues the video for manual review,
  // same `reports` collection + admin panel as user-submitted reports. Fires once per post.
  if (newCount >= RATING_FLAG_MIN_COUNT && newAvg <= RATING_FLAG_MAX_AVG && !post.moderationFlaggedAt) {
    const reportRef = db.ref('reports').push();
    await reportRef.set({
      byUid: 'system',
      reportedUid: post.uid,
      postId: postId,
      reason: 'auto_low_rating',
      status: 'pending',
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    await postRef.child('moderationFlaggedAt').set(admin.database.ServerValue.TIMESTAMP);
  }

  return { success: true, ratingCount: newCount, ratingAvg: newAvg };
}

exports.rateVideo = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  return rateVideoImpl(uid, data.postId, Number(data.stars));
});
exports.rateVideoImpl = rateVideoImpl; // exposed only for the test script, not a real deployable trigger

// ══════════════════════════════════════════════════════════════════
// SUBMIT COMMENT - WITH CONTENT VERIFICATION & RATE LIMITING
// ══════════════════════════════════════════════════════════════════

exports.submitComment = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const postId = data.postId;
  const text = (data.text || '').trim();
  const parentId = data.parentId || null;  // For replies (client schema)

  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  if (!postId) {
    throw new functions.https.HttpsError('invalid-argument', 'Post ID required');
  }

  if (!text || text.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Comment cannot be empty');
  }

  if (text.length > 500) {
    throw new functions.https.HttpsError('invalid-argument', 'Comment too long (max 500 chars)');
  }

  // Disable @mentions to prevent harassment/spam notifications (feature disabled for safety)
  if (text.includes('@')) {
    throw new functions.https.HttpsError('invalid-argument', '@mentions are not yet supported');
  }

  // Check abuse
  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Too many comments. Please wait a moment.'
    );
  }

  // Verify content
  if (hasHarmfulContent(text)) {
    throw new functions.https.HttpsError('permission-denied', 'Comment contains prohibited content');
  }

  // Track abuse
  await addAbuseScore(uid, 2, 'comment');

  const [userSnap, postSnap] = await Promise.all([
    db.ref(`users/${uid}`).once('value'),
    db.ref(`feed/${postId}`).once('value')
  ]);
  const userData = userSnap.val();

  if (!userData) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const post = postSnap.val();
  if (!post) {
    throw new functions.https.HttpsError('not-found', 'Post not found');
  }
  if (post.uid !== uid) {
    const blockSnap = await db.ref(`userBlocked/${post.uid}/${uid}`).once('value');
    if (blockSnap.exists()) {
      throw new functions.https.HttpsError('permission-denied', 'Cannot comment on this post');
    }
  }

  const commentRef = db.ref(`comments/${postId}`).push();
  const commentId = commentRef.key;

  // Client schema: the app renders/orders comments by `at` and links replies by `parentId`.
  const commentData = {
    uid: uid,
    username: userData.username || 'Player',
    text: text,
    at: admin.database.ServerValue.TIMESTAMP
  };
  if (parentId) commentData.parentId = parentId;

  await commentRef.set(commentData);

  // If this is a reply, notify the parent comment's author
  if (parentId) {
    const parentSnap = await db.ref(`comments/${postId}/${parentId}`).once('value');
    const parentData = parentSnap.val();
    if (parentData && parentData.uid && parentData.uid !== uid) {
      // Single inbox entry (was duplicated before). inPost/inComment let the client deep-link.
      await writeNotification(parentData.uid, 'comment_reply', uid, userData.username, { inPost: postId, inComment: commentId });
      await sendPushNotification(
        parentData.uid,
        '💬 ' + (userData.username || 'Someone') + ' replied to you',
        text.slice(0, 80),
        { type: 'comment_reply', inPost: postId }
      ).catch(err => console.error('[Reply Notify]', err));
    }
  } else {
    // Top-level comment — notify the post author
    if (post.uid && post.uid !== uid) {
      await writeNotification(post.uid, 'comment', uid, userData.username, { inPost: postId });
      await sendPushNotification(
        post.uid,
        '💬 ' + (userData.username || 'Someone') + ' commented on your video',
        text.slice(0, 80),
        { type: 'comment', inPost: postId }
      ).catch(err => console.error('[Comment Notify]', err));
    }
  }

  return { success: true, commentId: commentId };
});

// ══════════════════════════════════════════════════════════════════
// LIKE COMMENT - WITH DEDUPLICATION
// ══════════════════════════════════════════════════════════════════

exports.likeComment = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const postId = data.postId;
  const commentId = data.commentId;

  if (!uid || isAnonymousCaller(context) || !postId || !commentId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields');
  }

  // Atomically add like (will only add if doesn't exist)
  const likeRef = db.ref(`commentLikes/${postId}/${commentId}/${uid}`);
  let likeAdded = false;

  const txn = await likeRef.transaction(cur => {
    if (cur !== null) {
      return;  // abort - already liked
    }
    likeAdded = true;
    return true;
  });

  if (!likeAdded) {
    throw new functions.https.HttpsError('already-exists', 'Already liked this comment');
  }

  // Increment like count
  await db.ref(`comments/${postId}/${commentId}/likeCount`)
    .transaction(cur => (cur || 0) + 1);

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// UNLIKE COMMENT
// ══════════════════════════════════════════════════════════════════

exports.unlikeComment = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const postId = data.postId;
  const commentId = data.commentId;

  if (!uid || isAnonymousCaller(context) || !postId || !commentId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields');
  }

  const likeRef = db.ref(`commentLikes/${postId}/${commentId}/${uid}`);
  const likeSnap = await likeRef.once('value');

  if (!likeSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Not liked');
  }

  await likeRef.remove();
  await db.ref(`comments/${postId}/${commentId}/likeCount`)
    .transaction(cur => Math.max(0, (cur || 1) - 1));

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// UPDATE POST MEDIA
// ══════════════════════════════════════════════════════════════════

exports.updatePostMedia = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  const postId = typeof data.postId === 'string' ? data.postId : '';
  const mediaUrl = data.mediaUrl ? String(data.mediaUrl).slice(0, 600) : null;
  const mediaType = (data.mediaType === 'image' || data.mediaType === 'video') ? data.mediaType : null;
  const bunnyGuid = data.bunnyGuid ? String(data.bunnyGuid).slice(0, 100) : null;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  if (!postId || !mediaUrl || !mediaType) {
    throw new functions.https.HttpsError('invalid-argument', 'Media is required');
  }

  const postSnap = await db.ref(`feed/${postId}`).once('value');
  const post = postSnap.val();

  if (!post || post.uid !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Cannot update this post');
  }

  // Attaching real media here (e.g. mission "proof" video/photo added after the post already
  // exists) is exactly as unmoderated as a fresh upload -- route it through the same
  // admin-approval gate createFeedPost posts get, rather than letting it go public unreviewed.
  const updates = {
    mediaURL: mediaUrl,
    mediaType: mediaType,
    isUserVideo: true,
    approved: false
  };
  if (bunnyGuid) updates.bunnyGuid = bunnyGuid;
  await db.ref(`feed/${postId}`).update(updates);

  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// BATCH VERIFY POSTS - SCHEDULED NIGHTLY
// ══════════════════════════════════════════════════════════════════

exports.batchVerifyPosts = functions
  .runWith({ secrets: [bunnyApiKey] })
  .pubsub.schedule('every 24 hours').onRun(async (context) => {
  const snap = await db.ref('feed').once('value');
  let verified = 0, rejected = 0;

  const updates = {};
  const bunnyGuids = [];
  const storageUrls = [];

  snap.forEach(child => {
    const post = child.val();
    if (!post) return;

    const checkText = (post.caption || '') + (post.username || '') + (post.missionTitle || '');
    if (hasHarmfulContent(checkText)) {
      updates[`feed/${child.key}`] = null;
      if (post.bunnyGuid) bunnyGuids.push(post.bunnyGuid);
      if (post.mediaURL) storageUrls.push(post.mediaURL);
      if (post.thumbnailURL) storageUrls.push(post.thumbnailURL);
      rejected++;

      const uid = post.uid;
      db.ref(`users/${uid}/badUploads`).transaction(cur => {
        const newCount = (cur || 0) + 1;
        if (newCount >= 2) {
          db.ref(`users/${uid}/blocked`).set(true);
        }
        return newCount;
      });
    } else {
      verified++;
    }
  });

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
    // free the deleted posts' hosted media too (best-effort — never block the batch)
    if (bunnyGuids.length) {
      const key = bunnyApiKey.value();
      await Promise.allSettled(bunnyGuids.map(g => bunnyDeleteVideo(g, key)));
    }
    if (storageUrls.length) {
      await Promise.allSettled(storageUrls.map(u => deleteFirebaseStorageUrl(u)));
    }
  }

  console.log(`[Batch Verify] Verified: ${verified}, Rejected: ${rejected}, Bunny cleaned: ${bunnyGuids.length}`);
  return { verified, rejected };
});

// ══════════════════════════════════════════════════════════════════
// CLEANUP OLD POSTS - SCHEDULED WEEKLY
// ══════════════════════════════════════════════════════════════════

exports.cleanupOldPosts = functions
  .runWith({ secrets: [bunnyApiKey] })
  .pubsub.schedule('0 3 * * 0').timeZone('Asia/Jerusalem').onRun(async (context) => {
  // Disabled 2026-08-01 per explicit request: posts/videos are no longer auto-deleted after
  // 30 days, neither from feed/ nor from Bunny. Left the weekly trigger and secret binding in
  // place (harmless no-op) rather than removing the function, in case a different retention
  // policy replaces this later.
  const deleted = 0;
  console.log('[Cleanup] Disabled — no posts deleted (auto-deletion turned off).');
  return { deleted };
});

// ══════════════════════════════════════════════════════════════════
// FOR YOU FRESHNESS DECAY - SCHEDULED DAILY
//
// This is a separate layer from the per-user "For You" personalization (userInteractions/
// logInteraction above) -- it decides which posts are even IN the For You candidate pool,
// regardless of who's looking. It never deletes or hides a post anywhere else (profile grid,
// saved, direct links, Following feed all still show it) -- it only sets feed/{postId}/
// forYouEligible, which loadFeed() on the client filters on for the For You tab specifically.
//
// Rule: once a post turns ~28 days old, and every ~30 days after that (so a 1-year-old post
// has been re-checked roughly a dozen times by then), count how many distinct viewers watched
// it in the last 7 days (postViews/{postId}/*/lastAt). Below FRESHNESS_MIN_RECENT_VIEWS ->
// dropped from For You. At/above it -> (re)included, so a post that goes viral again a year
// later can come back. There is no real production traffic yet to calibrate the threshold
// against, so treat the number below as a starting point, not gospel.
// ══════════════════════════════════════════════════════════════════
const FRESHNESS_MIN_AGE_MS = 28 * 24 * 60 * 60 * 1000;  // first check once a post turns ~28 days old
const FRESHNESS_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;  // then re-check every ~30 days, indefinitely
const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;    // "recent" = last 7 days
const FRESHNESS_MIN_RECENT_VIEWS = 5;                    // tune once there's real traffic data
const FRESHNESS_BATCH_LIMIT = 500;                       // cap per run so one invocation can't run long/expensive

// Exported so it can be unit-tested directly against the RTDB emulator without needing the
// scheduler or a live Cloud Functions environment (see firebase/functions/test-freshness.js).
async function runForYouFreshnessCheck(now) {
  now = now || Date.now();
  const feedSnap = await db.ref('feed').orderByChild('timestamp')
    .endAt(now - FRESHNESS_MIN_AGE_MS).limitToFirst(FRESHNESS_BATCH_LIMIT).once('value');

  const updates = {};
  let checked = 0, madeEligible = 0, madeIneligible = 0;
  const tasks = [];

  feedSnap.forEach(child => {
    const post = child.val();
    const postId = child.key;
    const lastChecked = post.freshnessCheckedAt || 0;
    if (now - lastChecked < FRESHNESS_RECHECK_MS) return; // not due for a (re)check yet

    tasks.push((async () => {
      const viewsSnap = await db.ref(`postViews/${postId}`).once('value');
      let recentViews = 0;
      viewsSnap.forEach(v => {
        const rec = v.val();
        if (rec && rec.lastAt && (now - rec.lastAt) <= FRESHNESS_WINDOW_MS) recentViews++;
      });
      const eligible = recentViews >= FRESHNESS_MIN_RECENT_VIEWS;
      updates[`feed/${postId}/forYouEligible`] = eligible;
      updates[`feed/${postId}/freshnessCheckedAt`] = now;
      checked++;
      if (eligible) madeEligible++; else madeIneligible++;
    })());
  });

  await Promise.all(tasks);
  if (Object.keys(updates).length) await db.ref().update(updates);
  return { checked, madeEligible, madeIneligible };
}

exports.refreshForYouFreshness = functions
  .pubsub.schedule('0 4 * * *').timeZone('Asia/Jerusalem').onRun(async (context) => {
  const result = await runForYouFreshnessCheck();
  console.log(`[Freshness] Checked ${result.checked} posts — ${result.madeEligible} eligible, ${result.madeIneligible} ineligible`);
  return result;
});
exports.runForYouFreshnessCheck = runForYouFreshnessCheck; // exposed for the emulator test script only

// ══════════════════════════════════════════════════════════════════
// SYNC FOLLOW CREATED
// ══════════════════════════════════════════════════════════════════

exports.syncFollowCreated = functions.database
  .ref('follows/{uid}/{targetUid}')
  .onCreate(async (snapshot, context) => {
    const { uid, targetUid } = context.params;
    const followData = snapshot.val();

    if (!followData) return;

    // Increment follower count
    await db.ref(`users/${targetUid}/followerCount`).transaction(cur => (cur || 0) + 1);
    await db.ref(`users/${uid}/followingCount`).transaction(cur => (cur || 0) + 1);
  });

// ══════════════════════════════════════════════════════════════════
// SYNC FOLLOW DELETED
// ══════════════════════════════════════════════════════════════════

exports.syncFollowDeleted = functions.database
  .ref('follows/{uid}/{targetUid}')
  .onDelete(async (snapshot, context) => {
    const { uid, targetUid } = context.params;

    await db.ref(`users/${targetUid}/followerCount`).transaction(cur => Math.max(0, (cur || 1) - 1));
    await db.ref(`users/${uid}/followingCount`).transaction(cur => Math.max(0, (cur || 1) - 1));
  });

// ══════════════════════════════════════════════════════════════════
// PROCESS MENTIONS IN COMMENTS (@username)
// ══════════════════════════════════════════════════════════════════

exports.processMentionsInComment = functions.database
  .ref('comments/{postId}/{commentId}')
  .onCreate(async (snapshot, context) => {
    const comment = snapshot.val();
    const { postId, commentId } = context.params;

    if (!comment || !comment.text) return;

    // Extract mentions from text
    const MENTION_REGEX = /@([a-zA-Z0-9_-]{3,30})/g;
    const mentions = new Set();
    let match;
    while ((match = MENTION_REGEX.exec(comment.text)) !== null) {
      mentions.add(match[1].toLowerCase());
    }

    if (mentions.size === 0) return;

    // Find users with those usernames and notify them
    const updates = {};
    const notifyPromises = [];

    for (const mentionedUsername of mentions) {
      // Find user by username in usernames index
      const userSnap = await db.ref('usernames')
        .orderByValue()
        .equalTo(mentionedUsername)
        .once('value');

      userSnap.forEach(child => {
        const mentionedUid = child.key;

        // Create notification for mentioned user (push-ID key, not Date.now(), to avoid collisions)
        const nkey = db.ref(`notifications/${mentionedUid}`).push().key;
        updates[`notifications/${mentionedUid}/${nkey}`] = {
          type: 'mentioned',
          byUid: comment.uid,
          byUsername: comment.username || 'Player',
          inPost: postId,
          inComment: commentId,
          createdAt: admin.database.ServerValue.TIMESTAMP,
          read: false
        };
      });
    }

    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
      console.log(`[Mentions] Processed ${mentions.size} mentions in comment ${commentId}`);
    }
  });

// ══════════════════════════════════════════════════════════════════
// PARSE AND CREATE HASHTAGS FROM POSTS
// ══════════════════════════════════════════════════════════════════

exports.parseAndCreateHashtags = functions.database
  .ref('feed/{postId}')
  .onCreate(async (snapshot, context) => {
    const post = snapshot.val();
    const postId = context.params.postId;

    if (!post) return;

    // Extract hashtags from caption and mission title
    const text = ((post.caption || '') + ' ' + (post.missionTitle || '')).toLowerCase();
    const hashtagRegex = /#([a-zA-Z0-9_]{1,30})/g;

    const hashtags = new Set();
    let match;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtags.add(match[1].toLowerCase());
    }

    if (hashtags.size === 0) return;

    // Create hashtag entries for discovery
    const updates = {};
    const now = admin.database.ServerValue.TIMESTAMP;

    hashtags.forEach(tag => {
      updates[`hashtags/${tag}/${postId}`] = {
        uid: post.uid,
        timestamp: now,
        likes: 0,
        username: post.username || 'Player'
      };

      // Also increment hashtag popularity counter
      updates[`hashtagStats/${tag}/postCount`] = admin.database.ServerValue.increment(1);
      updates[`hashtagStats/${tag}/lastUpdated`] = now;
    });

    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
      console.log(`[Hashtags] Created ${hashtags.size} hashtags for post ${postId}`);
    }
  });

// Update hashtag stats when a post is deleted
exports.removePostHashtags = functions.database
  .ref('feed/{postId}')
  .onDelete(async (snapshot, context) => {
    const post = snapshot.val();
    const postId = context.params.postId;

    if (!post) return;

    const text = ((post.caption || '') + ' ' + (post.missionTitle || '')).toLowerCase();
    const hashtagRegex = /#([a-zA-Z0-9_]{1,30})/g;

    const hashtags = new Set();
    let match;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtags.add(match[1].toLowerCase());
    }

    if (hashtags.size === 0) return;

    const updates = {};
    hashtags.forEach(tag => {
      updates[`hashtags/${tag}/${postId}`] = null;
      updates[`hashtagStats/${tag}/postCount`] = admin.database.ServerValue.increment(-1);
    });

    await db.ref().update(updates);
    console.log(`[Hashtags] Removed ${hashtags.size} hashtags from deleted post ${postId}`);
  });

// ══════════════════════════════════════════════════════════════════
// CALCULATE CREATOR ANALYTICS - Scheduled Daily
// ══════════════════════════════════════════════════════════════════

exports.calculateCreatorAnalytics = functions.pubsub
  .schedule('every 6 hours')
  .onRun(async (context) => {
    try {
      // Recalculating for every user ever registered, every 6 hours forever, doesn't scale --
      // most of that cost buys nothing for an account that hasn't opened the app in months.
      // `lastActive` ('YYYY-MM-DD', already written on every session -- see finishLoad() client-
      // side) sorts correctly as a plain string, so a 30-day cutoff bounds the read directly
      // instead of downloading every user and filtering in memory. An account with no lastActive
      // at all (pre-dates that field, or never opened the app since) sorts before any cutoff and
      // is correctly excluded -- it's exactly as stale as this filter intends to skip.
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const usersSnap = await db.ref('users').orderByChild('lastActive').startAt(cutoff).once('value');
      const users = usersSnap.val() || {};

      let processed = 0;
      let failed = 0;

      for (const uid in users) {
        try {
          // Get all posts by this user
          const postsSnap = await db.ref('feed')
            .orderByChild('uid')
            .equalTo(uid)
            .once('value');

          const posts = postsSnap.val() || {};
          let totalViews = 0;
          let totalLikes = 0;
          let totalComments = 0;
          let totalWatchTime = 0;
          let postCount = 0;
          let avgWatchPercent = 0;

          for (const postId in posts) {
            const post = posts[postId];
            totalViews += post.views || 0;
            totalLikes += post.likes || 0;
            postCount++;

            // Get comments count
            const commentsSnap = await db.ref(`comments/${postId}`)
              .once('value');
            totalComments += (commentsSnap.val() ? Object.keys(commentsSnap.val()).length : 0);

            // Watch time tracking
            totalWatchTime += post.avgWatchTime || 0;
          }

          if (postCount > 0) {
            avgWatchPercent = Math.round((totalWatchTime / postCount) * 100);
          }

          // Calculate engagement rate
          const engagementRate = postCount > 0
            ? Math.round(((totalLikes + totalComments) / (totalViews || 1)) * 100)
            : 0;

          // Update user analytics
          await db.ref(`users/${uid}/stats`).update({
            totalViews: totalViews,
            totalLikes: totalLikes,
            totalComments: totalComments,
            totalPosts: postCount,
            avgWatchPercent: avgWatchPercent,
            engagementRate: engagementRate,
            avgLikesPerPost: postCount > 0 ? Math.round(totalLikes / postCount) : 0,
            avgViewsPerPost: postCount > 0 ? Math.round(totalViews / postCount) : 0,
            calculatedAt: admin.database.ServerValue.TIMESTAMP
          });

          processed++;

        } catch (userError) {
          console.error(`[Analytics] Error for user ${uid}:`, userError);
          failed++;
        }
      }

      console.log(`[Analytics] Calculated for ${processed} users, ${failed} failed`);
      return { processed, failed };

    } catch (error) {
      console.error('[Analytics] Fatal error:', error);
      throw error;
    }
  });

// Track post views when post is loaded/viewed
exports.trackPostView = functions.database
  .ref('feed/{postId}')
  .onWrite(async (change, context) => {
    const postId = context.params.postId;
    const post = change.after.val();

    if (!post) return;

    // Initialize view count if the field is genuinely missing (legacy posts created before
    // `views` existed). Checking `post.views === undefined` instead of the previous `!post.views`
    // matters: `views` is 0 (falsy) for every post from the moment it's created, so `!post.views`
    // stayed true after the "initializing" write too -- that write is itself a write to this
    // trigger's own path, re-firing onWrite, which saw `views:0` as falsy again and rewrote it
    // again, on every single future write to the post (likes, comments, anything), forever.
    if (post.views === undefined) {
      await change.after.ref.update({ views: 0 });
    }
  });

// Maintained counters for adminGetDashboard -- RTDB has no server-side count aggregation, so an
// exact totalUsers/totalPosts figure otherwise meant downloading the entire users/feed subtree on
// every dashboard load just to call .numChildren() on it (the data itself was thrown away right
// after). Keeping a running total via transaction() (atomic under concurrent creates/deletes) on
// every create/delete costs one small write per event instead, and the dashboard read becomes a
// single O(1) path lookup regardless of how large either collection grows. Backfilled once via
// admin CLI to the actual counts at the time this was introduced -- these triggers only maintain
// the running total from here on, they don't (and don't need to) reconstruct history.
exports.onUserCreatedCounter = functions.database.ref('users/{uid}').onCreate(async () => {
  await db.ref('stats/totalUsers').transaction(v => (v || 0) + 1);
});
exports.onUserDeletedCounter = functions.database.ref('users/{uid}').onDelete(async () => {
  await db.ref('stats/totalUsers').transaction(v => Math.max(0, (v || 0) - 1));
});
exports.onPostCreatedCounter = functions.database.ref('feed/{postId}').onCreate(async () => {
  await db.ref('stats/totalPosts').transaction(v => (v || 0) + 1);
});
exports.onPostDeletedCounter = functions.database.ref('feed/{postId}').onDelete(async () => {
  await db.ref('stats/totalPosts').transaction(v => Math.max(0, (v || 0) - 1));
});

// ══════════════════════════════════════════════════════════════════
// RECORD VIEW — unique views, repeat views, and watch time.
// Called from the client when a viewer finishes watching a post.
// ══════════════════════════════════════════════════════════════════
exports.recordView = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  const postId = String(data.postId || '');
  let watchMs = parseInt(data.watchMs || 0);
  let completionRate = parseInt(data.completionRate || 0);
  if (!postId) throw new functions.https.HttpsError('invalid-argument', 'Missing postId');
  if (!(watchMs >= 0) || watchMs > 600000) watchMs = 0; // cap at 10 min to reject bad values
  if (!(completionRate >= 0) || completionRate > 100) completionRate = 0;

  // Per-viewer record decides unique vs repeat
  let wasFirst = false;
  await db.ref(`postViews/${postId}/${uid}`).transaction(v => {
    if (v === null) {
      wasFirst = true;
      return { firstAt: Date.now(), lastAt: Date.now(), count: 1, watchMs: watchMs };
    }
    v.count = (v.count || 0) + 1;
    v.lastAt = Date.now();
    v.watchMs = (v.watchMs || 0) + watchMs;
    return v;
  });

  // Aggregate counters on the post itself (don't count the author's own views as unique). Each
  // field uses its own transaction rather than a read-then-.update() on a separately-fetched
  // snapshot -- concurrent viewers of the same popular post would otherwise race and lose
  // increments, same bug class already fixed for redeemPoints.
  const postSnap = await db.ref(`feed/${postId}`).once('value');
  const post = postSnap.val();
  if (!post) return { success: true };
  const isOwn = post.uid === uid;
  const postRef = db.ref(`feed/${postId}`);

  if (wasFirst && !isOwn) {
    await postRef.child('views').transaction(cur => (cur || 0) + 1);
  } else if (!wasFirst) {
    await postRef.child('repeatViews').transaction(cur => (cur || 0) + 1);
  }
  if (watchMs > 0) {
    await postRef.child('watchMs').transaction(cur => (cur || 0) + watchMs);
  }

  // For You: only log the clear cases (fast skip / near-full watch) — skip the ambiguous
  // middle so the signal stays clean. Don't log the author's own views of their own post.
  if (!isOwn) {
    let type = null;
    if (completionRate >= 75) type = 'complete';
    else if (completionRate < 20) type = 'skip';
    if (type) {
      await logInteraction(uid, postId, type, getPostContentSignals(post)).catch(() => {});
    }
  }

  return { success: true, unique: wasFirst };
});

// ══════════════════════════════════════════════════════════════════
// TRENDING CALCULATION - Scheduled every 6 hours
// ══════════════════════════════════════════════════════════════════

exports.calculateTrending = functions.pubsub
  .schedule('every 6 hours')
  .onRun(async (context) => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const week = 7 * day;

    // Only ever considers posts <7 days old, but used to fetch the entire feed (every post ever
    // created) to filter that down in memory -- a full download that only grows as post history
    // grows, even though the result never needed anything older than a week. `feed` is already
    // indexed on `timestamp`, so bound the read itself to the same 7-day window instead.
    const feedSnap = await db.ref('feed').orderByChild('timestamp').startAt(now - week).once('value');
    const posts = [];

    feedSnap.forEach(child => {
      const post = child.val();
      const age = now - (post.timestamp || 0);

      if (post.status === 'verified') {
        const likes = post.likes || 0;
        const views = post.views || 0;
        const engagement = views > 0 ? (likes / views) : 0;

        // Trending score: engagement + recency boost
        const recencyBoost = Math.max(0.5, 1 - (age / week));
        const trendingScore = engagement * 100 + (likes * 0.5) + (recencyBoost * 10);

        posts.push({
          id: child.key,
          ...post,
          trendingScore: trendingScore
        });
      }
    });

    // Sort by trending score
    posts.sort((a, b) => b.trendingScore - a.trendingScore);

    // Save top 100 trending posts
    const trendingUpdate = {};
    posts.slice(0, 100).forEach((post, idx) => {
      trendingUpdate[`trending/${idx}/${post.id}`] = {
        trendingScore: post.trendingScore,
        timestamp: now
      };
    });

    await db.ref().update(trendingUpdate);
    console.log(`[Trending] Updated top ${Math.min(100, posts.length)} posts`);

    return { count: Math.min(100, posts.length) };
  });

// ══════════════════════════════════════════════════════════════════
// GET TRENDING POSTS
// ══════════════════════════════════════════════════════════════════

exports.getTrendingPosts = functions.https.onCall(async (data, context) => {
  const trendingSnap = await db.ref('trending').once('value');
  const trendingIds = [];

  trendingSnap.forEach(child => {
    trendingIds.push(...Object.keys(child.val() || {}));
  });

  if (trendingIds.length === 0) {
    return { success: true, posts: [] };
  }

  // Fetch full post data
  const posts = [];
  for (const postId of trendingIds.slice(0, 50)) {
    const postSnap = await db.ref(`feed/${postId}`).once('value');
    const post = postSnap.val();
    if (post) {
      posts.push({
        id: postId,
        ...post
      });
    }
  }

  return { success: true, posts: posts };
});

// ══════════════════════════════════════════════════════════════════
// SEARCH SYSTEM - Indexes for discovery
// ══════════════════════════════════════════════════════════════════

exports.searchUsers = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError('permission-denied', 'Too many searches. Please wait a moment.');
  }
  await addAbuseScore(uid, 1, 'search');

  const query = (data.query || '').trim().toLowerCase().substring(0, 50);

  if (!query || query.length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Query too short');
  }

  // Search by username prefix
  const usersSnap = await db.ref('users').once('value');
  const results = [];

  usersSnap.forEach(child => {
    const user = child.val();
    const username = (user.username || '').toLowerCase();

    if (username.includes(query)) {
      results.push({
        uid: child.key,
        username: user.username,
        pts: user.pts || 0,
        followers: user.followerCount || 0
      });
    }
  });

  // Sort by follower count (most popular first)
  results.sort((a, b) => b.followers - a.followers);

  return {
    success: true,
    results: results.slice(0, 20)
  };
});

exports.searchVideos = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError('permission-denied', 'Too many searches. Please wait a moment.');
  }
  await addAbuseScore(uid, 1, 'search');

  const query = (data.query || '').trim().toLowerCase().substring(0, 50);

  if (!query || query.length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Query too short');
  }

  // Search by mission title or hashtags
  const feedSnap = await db.ref('feed').once('value');
  const results = [];

  feedSnap.forEach(child => {
    const post = child.val();
    const missionTitle = (post.missionTitle || '').toLowerCase();
    const caption = (post.caption || '').toLowerCase();

    if (missionTitle.includes(query) || caption.includes(query)) {
      results.push({
        id: child.key,
        ...post
      });
    }
  });

  // Sort by likes (most popular first)
  results.sort((a, b) => (b.likes || 0) - (a.likes || 0));

  return {
    success: true,
    results: results.slice(0, 30)
  };
});

exports.searchHashtags = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError('permission-denied', 'Too many searches. Please wait a moment.');
  }
  await addAbuseScore(uid, 1, 'search');

  const query = (data.query || '').trim().toLowerCase().substring(0, 50);

  if (!query || query.length < 1) {
    throw new functions.https.HttpsError('invalid-argument', 'Query too short');
  }

  // Search hashtags by name
  const hashtagsSnap = await db.ref('hashtagStats').once('value');
  const results = [];

  hashtagsSnap.forEach(child => {
    const tag = child.key;
    const stats = child.val();

    if (tag.includes(query)) {
      results.push({
        tag: tag,
        postCount: stats.postCount || 0
      });
    }
  });

  // Sort by popularity
  results.sort((a, b) => b.postCount - a.postCount);

  return {
    success: true,
    results: results.slice(0, 20)
  };
});

// ══════════════════════════════════════════════════════════════════
// COMPRESS UPLOADED VIDEOS - Storage Trigger
// ══════════════════════════════════════════════════════════════════

exports.compressUploadedVideo = functions.storage
  .object()
  .onFinalize(async (object) => {
    // Lazy-loaded here (not at module top level) so the heavy fluent-ffmpeg dependency
    // only costs cold-start time for THIS trigger, not every other function in this file.
    const ffmpeg = require('fluent-ffmpeg');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const bucket = admin.storage().bucket();
    const filePath = object.name;

    // Only process videos in missions/ folder
    if (!filePath.startsWith('missions/')) return;
    if (!object.contentType || !object.contentType.startsWith('video/')) return;

    const fileName = path.basename(filePath);
    const tmpDir = os.tmpdir();
    const localPath = path.join(tmpDir, `orig_${fileName}`);
    const compressedPath = path.join(tmpDir, `comp_${fileName}.mp4`);
    const thumbnailPath = path.join(tmpDir, `thumb_${fileName}.jpg`);

    try {
      console.log(`[Compress] Starting: ${fileName} (${object.size} bytes)`);

      // Download original file
      await bucket.file(filePath).download({ destination: localPath });

      // Compress video with FFmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(localPath)
          .outputOptions([
            '-vcodec libh264',
            '-crf 23',
            '-b:v 2500k',
            '-maxrate 4000k',
            '-bufsize 8000k',
            '-vf scale=1280:720:force_original_aspect_ratio=decrease',
            '-c:a aac',
            '-b:a 128k',
            '-movflags +faststart'
          ])
          .output(compressedPath)
          .on('end', () => {
            console.log(`[Compress] Video compressed: ${fileName}`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`[Compress] FFmpeg error:`, err);
            reject(err);
          })
          .run();
      });

      // Generate thumbnail from video
      await new Promise((resolve, reject) => {
        ffmpeg(localPath)
          .screenshot({
            timestamps: ['1'],
            filename: `thumb_${fileName}.jpg`,
            folder: tmpDir,
            size: '280x498'
          })
          .on('end', () => {
            console.log(`[Compress] Thumbnail generated: ${fileName}`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`[Compress] Thumbnail error:`, err);
            reject(err);
          });
      });

      // Upload compressed video
      const compressedDestination = `compressed/${fileName}`;
      await bucket.upload(compressedPath, {
        destination: compressedDestination,
        metadata: {
          contentType: 'video/mp4',
          metadata: {
            original: filePath,
            compressed: true
          }
        }
      });
      console.log(`[Compress] Uploaded compressed: ${compressedDestination}`);

      // Upload thumbnail
      const thumbDestination = `thumbnails/thumb_${fileName}.jpg`;
      await bucket.upload(thumbnailPath, {
        destination: thumbDestination,
        metadata: {
          contentType: 'image/jpeg',
          metadata: {
            videoFile: fileName
          }
        }
      });
      console.log(`[Compress] Uploaded thumbnail: ${thumbDestination}`);

      // Verify ownership and update post with compressed URLs
      const postId = object.metadata?.postId;
      const uploaderId = object.metadata?.userId;
      if (postId && uploaderId) {
        // Verify post exists and belongs to uploader
        const postSnap = await db.ref(`feed/${postId}`).once('value');
        const post = postSnap.val();

        if (!post) {
          console.error(`[Compress] Post ${postId} not found`);
          return;
        }

        if (post.uid !== uploaderId) {
          console.error(`[Compress] Ownership mismatch: post uid ${post.uid} vs uploader ${uploaderId}`);
          return;
        }

        const bucketName = bucket.name;
        const compressedUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/compressed%2F${encodeURIComponent(fileName)}?alt=media`;
        const thumbUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/thumbnails%2Fthumb_${encodeURIComponent(fileName)}.jpg?alt=media`;

        await db.ref(`feed/${postId}`).update({
          mediaURL: compressedUrl,
          thumbnailURL: thumbUrl,
          status: 'verified',
          compressedAt: admin.database.ServerValue.TIMESTAMP
        });
        console.log(`[Compress] Updated post ${postId} with compressed URLs`);
      } else {
        console.error(`[Compress] Missing postId or userId in metadata for ${fileName}`);
      }

      // Cleanup temp files
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
      if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);

      // The original pre-compression upload is superseded by the compressed copy the post now
      // points at -- nothing ever reads it again, so keeping it in Storage was pure waste.
      await bucket.file(filePath).delete().catch(() => {});

      console.log(`[Compress] Complete: ${fileName} - Original: ${object.size} bytes`);

    } catch (error) {
      console.error(`[Compress] Error processing ${fileName}:`, error);

      // Mark post as failed
      const postId = object.metadata?.postId;
      if (postId) {
        await db.ref(`feed/${postId}`).update({
          status: 'compression_failed',
          error: error.message
        });
      }

      // Cleanup
      [localPath, compressedPath, thumbnailPath].forEach(p => {
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch(e) {}
        }
      });

      throw error;
    }
  });

// ══════════════════════════════════════════════════════════════════
// DELETE ACCOUNT - SERVER-SIDE ONLY
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════

async function sendPushTo(uid, title, body, data) {
  try {
    // Respect the user's push preference — skip if they turned notifications off.
    const prefSnap = await db.ref(`users/${uid}/pushEnabled`).once('value');
    if (prefSnap.val() === false) return false;
    const snap = await db.ref(`fcmTokens/${uid}/token`).once('value');
    const token = snap.val();
    if (!token) return false;

    await admin.messaging().send({
      token: token,
      notification: { title: title, body: body },
      data: data || {},
      webpush: {
        notification: { icon: 'https://flasharena-f35b1.web.app/icon-192.png' },
        fcmOptions: { link: 'https://flasharena-f35b1.web.app/' }
      }
    });
    return true;
  } catch (err) {
    // Remove dead tokens so we stop trying them
    if (err.code === 'messaging/registration-token-not-registered') {
      await db.ref(`fcmTokens/${uid}`).remove().catch(() => {});
    }
    console.warn(`[Push] send to ${uid} failed:`, err.message);
    return false;
  }
}

// New chat message → notify the recipient
exports.notifyNewMessage = functions.database
  .ref('chats/{chatId}/messages/{msgId}')
  .onCreate(async (snapshot, context) => {
    const msg = snapshot.val();
    if (!msg || !msg.from) return;

    const chatId = context.params.chatId;
    const recipient = chatId.split('_').find(u => u !== msg.from);
    if (!recipient) return;

    const senderSnap = await db.ref(`users/${msg.from}/username`).once('value');
    const senderName = senderSnap.val() || 'Someone';
    const preview = String(msg.text || '').slice(0, 80);

    await sendPushTo(recipient, `💬 ${senderName}`, preview, { type: 'message', chatId: chatId });
  });

// New follower → notify the followed user
exports.notifyNewFollower = functions.database
  .ref('followers/{uid}/{followerUid}')
  .onCreate(async (snapshot, context) => {
    const uid = context.params.uid;
    const followerUid = context.params.followerUid;
    if (uid === followerUid) return;

    const nameSnap = await db.ref(`users/${followerUid}/username`).once('value');
    const name = nameSnap.val() || 'Someone';

    await sendPushTo(uid, '👥 New follower!', `${name} started following you`, { type: 'follower' });
  });

// Daily missions reset → morning reminder to everyone with a token
exports.dailyMissionsPush = functions.pubsub
  .schedule('0 8 * * *')
  .timeZone('Asia/Jerusalem')
  .onRun(async () => {
    const snap = await db.ref('fcmTokens').once('value');
    // The same physical device's token can end up stored under more than one uid — e.g. a
    // guest session's uid plus the real account it later signed into, or any uid whose
    // fcmTokens/{uid} entry never got cleaned up. Dedup by token so that device gets one push,
    // not one per stale uid still pointing at it.
    const seenTokens = new Set();
    const sends = [];
    snap.forEach(child => {
      const token = child.val() && child.val().token;
      if (!token || seenTokens.has(token)) return;
      seenTokens.add(token);
      sends.push(sendPushTo(child.key, '⚡ New missions are live!',
        "Today's 3 missions are waiting. Complete them before midnight!", { type: 'daily' }));
    });
    await Promise.all(sends);
    console.log(`[Push] Daily reminder sent to ${sends.length} users`);
  });

// Evening streak reminder — only for users who haven't completed a mission today
exports.streakReminderPush = functions.pubsub
  .schedule('0 18 * * *')
  .timeZone('Asia/Jerusalem')
  .onRun(async () => {
    const today = getIsraelDate();
    const [tokensSnap, usersSnap] = await Promise.all([
      db.ref('fcmTokens').once('value'),
      db.ref('users').once('value')
    ]);

    // Same dedup as dailyMissionsPush — a stale/orphaned uid can share a device's token with
    // the account actually signed in there, which would otherwise send that one device the
    // reminder once per uid pointing at it.
    const seenTokens = new Set();
    const sends = [];
    tokensSnap.forEach(child => {
      const uid = child.key;
      const token = child.val() && child.val().token;
      if (!token || seenTokens.has(token)) return;
      const user = usersSnap.child(uid).val() || {};
      const doneToday = user.missionsDate === today &&
        user.completedMissionsToday && Object.keys(user.completedMissionsToday).length > 0;
      if (!doneToday && (user.streak || 0) > 0) {
        seenTokens.add(token);
        sends.push(sendPushTo(uid, '🔥 Your streak is in danger!',
          `Complete a mission today to keep your ${user.streak}-day streak alive`, { type: 'streak' }));
      }
    });
    await Promise.all(sends);
    console.log(`[Push] Streak reminders sent to ${sends.length} users`);
  });

// ══════════════════════════════════════════════════════════════════
// DIRECT MESSAGES (CHAT)
// ══════════════════════════════════════════════════════════════════

function chatIdFor(a, b) {
  return [a, b].sort().join('_');
}

exports.sendMessage = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const toUid = String(data.toUid || '');
  const text = String(data.text || '').trim().slice(0, 500);
  const img = String(data.img || '').trim();
  const isImg = !text && !!img;   // image message (no text) — routed here so direct writes can be locked

  if (!toUid || toUid === uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid recipient');
  }
  if (isImg) {
    if (img.length >= 600) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid image');
    }
  } else {
    if (!text) {
      throw new functions.https.HttpsError('invalid-argument', 'Message is empty');
    }
    if (hasHarmfulContent(text)) {
      throw new functions.https.HttpsError('invalid-argument', 'Message contains inappropriate content');
    }
  }

  // Recipient must exist and must not have blocked the sender. "DMs from people I follow
  // only" was previously enforced only in the client's openChatWith() gate — that's a UX
  // convenience, not a security boundary, so it's re-checked here too.
  const [targetSnap, senderSnap, blockSnap, dmRestrictedSnap, targetFollowsSenderSnap] = await Promise.all([
    db.ref(`users/${toUid}/username`).once('value'),
    db.ref(`users/${uid}`).once('value'),
    db.ref(`userBlocked/${toUid}/${uid}`).once('value'),
    db.ref(`users/${toUid}/privacy/dmFollowersOnly`).once('value'),
    db.ref(`follows/${toUid}/${uid}`).once('value')
  ]);
  if (!targetSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }
  if (blockSnap.exists()) {
    throw new functions.https.HttpsError('permission-denied', 'Cannot message this user');
  }
  if (dmRestrictedSnap.val() === true && !targetFollowsSenderSnap.exists()) {
    throw new functions.https.HttpsError('permission-denied', 'This user only accepts messages from people they follow');
  }
  const sender = senderSnap.val() || {};
  if (sender.blocked === true) {
    throw new functions.https.HttpsError('permission-denied', 'Account blocked');
  }

  const chatId = chatIdFor(uid, toUid);
  const msgRef = db.ref(`chats/${chatId}/messages`).push();
  const now = Date.now();
  const msg = isImg ? { from: uid, img: img, at: now } : { from: uid, text: text, at: now };
  const preview = isImg ? '📷' : text;

  const updates = {};
  updates[`chats/${chatId}/members/${uid}`] = true;
  updates[`chats/${chatId}/members/${toUid}`] = true;
  updates[`chats/${chatId}/messages/${msgRef.key}`] = msg;
  updates[`chatMeta/${uid}/${chatId}`] = {
    peerUid: toUid, peerName: targetSnap.val(), lastText: preview, lastAt: now, unread: 0
  };
  updates[`chatMeta/${toUid}/${chatId}/peerUid`] = uid;
  updates[`chatMeta/${toUid}/${chatId}/peerName`] = sender.username || 'Player';
  updates[`chatMeta/${toUid}/${chatId}/lastText`] = preview;
  updates[`chatMeta/${toUid}/${chatId}/lastAt`] = now;
  updates[`chatMeta/${toUid}/${chatId}/unread`] = admin.database.ServerValue.increment(1);

  await db.ref().update(updates);

  return { success: true, chatId: chatId, messageId: msgRef.key };
});

exports.markChatRead = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  const chatId = String(data.chatId || '');
  // chatId is "uidA_uidB" — caller must be one of the two participants
  if (!chatId.split('_').includes(uid)) {
    throw new functions.https.HttpsError('permission-denied', 'Not your chat');
  }
  await db.ref(`chatMeta/${uid}/${chatId}/unread`).set(0);
  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// STEP 2 (cont.) — server-side moderation for the remaining direct-write
// paths: general feed uploads, room posts, room chat, room mission text.
// Same shape as submitComment/sendMessage above: client uploads media
// first (Bunny/Storage, already secured), then calls one of these to
// write the DB record so hasHarmfulContent() runs server-side and can't
// be bypassed. RTDB rules for feed/$postId, rooms/.../chat/$mid and
// rooms/.../posts/$pid now require data.exists() (or .write:false for
// chat), so clients can no longer create these directly.
// ══════════════════════════════════════════════════════════════════

exports.createFeedPost = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const caption = String(data.caption || '').trim();
  const mediaURL = data.mediaURL ? String(data.mediaURL).slice(0, 600) : null;
  const mediaType = (data.mediaType === 'image' || data.mediaType === 'video') ? data.mediaType : null;
  const bunnyGuid = data.bunnyGuid ? String(data.bunnyGuid).slice(0, 100) : null;
  const music = data.music ? String(data.music).slice(0, 20) : null;
  const roomCodeRaw = data.roomCode ? String(data.roomCode).trim() : null;
  const roomCode = (roomCodeRaw && isValidRoomCode(roomCodeRaw)) ? roomCodeRaw : null;

  if (!mediaURL || !mediaType) {
    throw new functions.https.HttpsError('invalid-argument', 'Media is required');
  }

  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError('permission-denied', 'Too many uploads. Please wait a moment.');
  }

  if (hasHarmfulContent(caption)) {
    throw new functions.https.HttpsError('permission-denied', 'Caption contains prohibited content');
  }

  await addAbuseScore(uid, 3, 'feed_post');

  const userSnap = await db.ref(`users/${uid}`).once('value');
  const userData = userSnap.val();
  if (!userData) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }
  if (userData.blocked === true) {
    throw new functions.https.HttpsError('permission-denied', 'Account blocked');
  }

  const postRef = db.ref('feed').push();
  await postRef.set({
    uid: uid,
    username: userData.username || 'Player',
    caption: caption,
    mediaURL: mediaURL,
    mediaType: mediaType,
    bunnyGuid: bunnyGuid,
    timestamp: admin.database.ServerValue.TIMESTAMP,
    views: 0,
    likes: 0,
    status: 'pending',
    isUserVideo: true,
    approved: false,
    music: music
  });

  if (roomCode) {
    try {
      // The main feed post above already succeeded regardless -- a room ban only blocks the
      // cross-post into that specific room, same as sendRoomChat, not the upload itself.
      const bannedSnap = await db.ref(`rooms/${roomCode}/banned/${uid}`).once('value');
      if (bannedSnap.val() !== true) {
        await db.ref(`rooms/${roomCode}/posts`).push({
          uid: uid,
          name: userData.username || 'Player',
          caption: caption,
          mediaURL: mediaURL,
          mediaType: mediaType,
          at: admin.database.ServerValue.TIMESTAMP
        });
      }
    } catch (e) { console.error('[createFeedPost] room cross-post failed', e); }
  }

  return { success: true, postId: postRef.key };
});

exports.sendRoomChat = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const roomCode = String(data.roomCode || '').trim();
  const text = String(data.text || '').trim().slice(0, 300);

  if (!roomCode || !isValidRoomCode(roomCode)) {
    throw new functions.https.HttpsError('invalid-argument', 'Room code required');
  }
  if (!text) {
    throw new functions.https.HttpsError('invalid-argument', 'Message is empty');
  }
  if (hasHarmfulContent(text)) {
    throw new functions.https.HttpsError('invalid-argument', 'Message contains prohibited content');
  }

  const [bannedSnap, userSnap] = await Promise.all([
    db.ref(`rooms/${roomCode}/banned/${uid}`).once('value'),
    db.ref(`users/${uid}`).once('value')
  ]);
  if (bannedSnap.val() === true) {
    throw new functions.https.HttpsError('permission-denied', 'You are banned from this room');
  }
  const userData = userSnap.val();
  if (!userData) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  await db.ref(`rooms/${roomCode}/chat`).push({
    uid: uid,
    name: userData.username || 'Player',
    text: text,
    at: admin.database.ServerValue.TIMESTAMP
  });

  return { success: true };
});

exports.setRoomMission = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const roomCode = String(data.roomCode || '').trim();
  const mission = String(data.mission || '').trim().slice(0, 140);

  if (!roomCode || !mission || !isValidRoomCode(roomCode)) {
    throw new functions.https.HttpsError('invalid-argument', 'Room code and mission required');
  }
  if (hasHarmfulContent(mission)) {
    throw new functions.https.HttpsError('invalid-argument', 'Mission text contains prohibited content');
  }

  const metaSnap = await db.ref(`rooms/${roomCode}/meta`).once('value');
  const meta = metaSnap.val();
  if (!meta) {
    throw new functions.https.HttpsError('not-found', 'Room not found');
  }
  if (meta.host !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Only the host can change the mission');
  }

  const changed = mission !== meta.mission;
  await db.ref(`rooms/${roomCode}/meta/mission`).set(mission);

  if (changed) {
    const announceText = String(data.announceText || '').trim().slice(0, 300);
    if (announceText && !hasHarmfulContent(announceText)) {
      const userSnap = await db.ref(`users/${uid}`).once('value');
      const userData = userSnap.val() || {};
      await db.ref(`rooms/${roomCode}/chat`).push({
        uid: uid,
        name: userData.username || 'Player',
        text: announceText,
        at: admin.database.ServerValue.TIMESTAMP
      });
    }
  }

  return { success: true, changed: changed };
});

// Powers the "Popular rooms" quick-join list on the Missions tab. Reads the whole rooms/ tree
// server-side (Admin SDK) so the client never has to -- rooms/ is readable by any authenticated
// user today, but pulling the entire tree just to rank three rows client-side doesn't scale and
// leaks every room's roster to every viewer. Open to guests too (browsing, not joining, is fine
// for anonymous sessions -- the actual join still goes through roomJoinByCode() -> requireRealAccount()
// client-side and the existing rooms/$code/members write rule server-side).
exports.getTopRooms = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  // Rooms are fully off-limits to guests now -- including just browsing which ones are active.
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const snap = await db.ref('rooms').once('value');
  const rooms = snap.val() || {};

  const list = Object.keys(rooms).map(code => {
    const r = rooms[code] || {};
    const meta = r.meta || {};
    const memberCount = r.members ? Object.keys(r.members).length : 0;
    return {
      code: code,
      mission: String(meta.mission || '').slice(0, 140),
      hostName: String(meta.hostName || '').slice(0, 40),
      memberCount: memberCount
    };
  }).filter(r => r.memberCount > 0)
    .sort((a, b) => b.memberCount - a.memberCount)
    .slice(0, 3);

  return { rooms: list };
});

exports.editFeedCaption = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const postId = String(data.postId || '').trim();
  const caption = String(data.caption || '').trim().slice(0, 200);

  if (!postId || !caption) {
    throw new functions.https.HttpsError('invalid-argument', 'Post ID and caption required');
  }
  if (hasHarmfulContent(caption)) {
    throw new functions.https.HttpsError('permission-denied', 'Caption contains prohibited content');
  }

  const postSnap = await db.ref(`feed/${postId}`).once('value');
  const post = postSnap.val();
  if (!post) {
    throw new functions.https.HttpsError('not-found', 'Post not found');
  }
  if (post.uid !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Not your post');
  }

  await db.ref(`feed/${postId}/caption`).set(caption);
  return { success: true };
});

exports.editComment = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const postId = String(data.postId || '').trim();
  const commentId = String(data.commentId || '').trim();
  const text = String(data.text || '').trim().slice(0, 500);

  if (!postId || !commentId || !text) {
    throw new functions.https.HttpsError('invalid-argument', 'Post ID, comment ID and text required');
  }
  if (hasHarmfulContent(text)) {
    throw new functions.https.HttpsError('permission-denied', 'Comment contains prohibited content');
  }

  const commentSnap = await db.ref(`comments/${postId}/${commentId}`).once('value');
  const comment = commentSnap.val();
  if (!comment) {
    throw new functions.https.HttpsError('not-found', 'Comment not found');
  }
  if (comment.uid !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Not your comment');
  }

  await db.ref(`comments/${postId}/${commentId}`).update({ text: text, edited: true });
  return { success: true };
});

exports.changeUsername = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const username = String(data.username || '').trim();
  if (username.length < 3 || username.length > 30) {
    throw new functions.https.HttpsError('invalid-argument', 'Username must be 3-30 characters');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    throw new functions.https.HttpsError('invalid-argument', 'Username can only contain letters, numbers, _ and -');
  }
  if (hasHarmfulContent(username)) {
    throw new functions.https.HttpsError('permission-denied', 'Username contains prohibited content');
  }

  const dupSnap = await db.ref('users').orderByChild('username').equalTo(username).once('value');
  let taken = false;
  dupSnap.forEach(c => { if (c.key !== uid) taken = true; });
  if (taken) {
    throw new functions.https.HttpsError('already-exists', 'Username already taken');
  }

  const oldUsernameSnap = await db.ref(`users/${uid}/username`).once('value');
  const oldUsername = oldUsernameSnap.val();
  const renaming = (oldUsername || '').toLowerCase() !== username.toLowerCase();

  // Claim the new name in the same forward registry doRegister's uniqueness transaction uses
  // (usernames/{name} -> uid), so a rename can't collide with a name someone else claims between
  // the dupSnap check above and this write.
  if (renaming) {
    const claimResult = await db.ref(`usernames/${username.toLowerCase()}`).transaction(cur => cur === null ? uid : undefined);
    if (!claimResult.committed) {
      throw new functions.https.HttpsError('already-exists', 'Username already taken');
    }
  }

  const updates = {};
  updates[`users/${uid}/username`] = username;
  updates[`leaderboard/${uid}/username`] = username;
  // usernames/{uid} is the reverse index (uid -> name) processMentionsInComment relies on to
  // resolve @mentions -- without updating it, mentions of the new name never resolved.
  updates[`usernames/${uid}`] = username.toLowerCase();
  await db.ref().update(updates);

  // Release the old forward reservation now that the new one is claimed, so the old name becomes
  // available again instead of staying permanently reserved.
  if (renaming && oldUsername) {
    await db.ref(`usernames/${oldUsername.toLowerCase()}`).remove().catch(() => {});
  }

  return { success: true, username: username };
});

// ══════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════════════════

// Admin emails from environment or default (should be set in Cloud Functions env vars)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'shahar070510@gmail.com').split(',').map(e => e.trim().toLowerCase());

function requireAdmin(context) {
  const email = (context.auth?.token?.email || '').toLowerCase();
  if (!context.auth || !ADMIN_EMAILS.includes(email)) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access only');
  }
}

exports.adminGetDashboard = functions.https.onCall(async (data, context) => {
  requireAdmin(context);

  // totalUsers/totalPosts come from maintained counters (see onUserCreatedCounter etc.) instead of
  // downloading the full users/feed nodes. The "recent" lists and pending counts are bounded, indexed
  // queries instead of full-node scans -- reports/redemptions are always created with an explicit
  // status: 'pending' (see reportUser, rateVideoImpl's auto-flag, and the redeem flow, and both nodes
  // are server-write-only), so there's no legacy "missing status" case the old `|| !r.status` covered.
  const [statsSnap, usersSnap, reportsSnap, redemptionsSnap, pendingReportsSnap, pendingRedemptionsSnap] = await Promise.all([
    db.ref('stats').once('value'),
    db.ref('users').orderByChild('createdAt').limitToLast(100).once('value'),
    db.ref('reports').orderByChild('createdAt').limitToLast(100).once('value'),
    db.ref('redemptions').orderByChild('createdAt').limitToLast(100).once('value'),
    db.ref('reports').orderByChild('status').equalTo('pending').once('value'),
    db.ref('redemptions').orderByChild('status').equalTo('pending').once('value')
  ]);

  const stats = statsSnap.val() || {};

  const users = [];
  usersSnap.forEach(c => {
    const u = c.val() || {};
    users.push({
      uid: c.key, username: u.username, email: u.email,
      pts: u.pts || 0, missions: u.totalMissionsDone || 0,
      blocked: u.blocked === true, createdAt: u.createdAt || 0
    });
  });

  const reports = [];
  reportsSnap.forEach(c => reports.push({ id: c.key, ...c.val() }));

  const redemptions = [];
  redemptionsSnap.forEach(c => redemptions.push({ id: c.key, ...c.val() }));

  return {
    stats: {
      totalUsers: stats.totalUsers || 0,
      totalPosts: stats.totalPosts || 0,
      pendingReports: pendingReportsSnap.numChildren(),
      pendingRedemptions: pendingRedemptionsSnap.numChildren()
    },
    users: users.sort((a, b) => b.createdAt - a.createdAt),
    reports: reports.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    redemptions: redemptions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  };
});

exports.adminUpdateRedemption = functions.https.onCall(async (data, context) => {
  requireAdmin(context);
  const id = String(data.id || '');
  const status = String(data.status || '');
  if (!id || !['fulfilled', 'rejected', 'pending'].includes(status)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid id or status');
  }
  await db.ref(`redemptions/${id}/status`).set(status);
  return { success: true };
});

exports.adminUpdateReport = functions.https.onCall(async (data, context) => {
  requireAdmin(context);
  const id = String(data.id || '');
  const status = String(data.status || '');
  if (!id || !['reviewed', 'actioned', 'pending'].includes(status)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid id or status');
  }
  await db.ref(`reports/${id}/status`).set(status);
  if (status === 'reviewed' || status === 'actioned') {
    const reportSnap = await db.ref(`reports/${id}`).once('value');
    const report = reportSnap.val();
    if (report) {
      // Resolving an auto-flagged-for-low-ratings report (the admin looked and decided the video
      // is fine) restores its visibility -- otherwise a flagged post would stay hidden forever
      // even after being cleared, since nothing else ever unsets moderationFlaggedAt.
      if (report.reason === 'auto_low_rating' && report.postId) {
        await db.ref(`feed/${report.postId}/moderationFlaggedAt`).remove();
      }
      // Let the reporter know their report was looked at -- previously the only feedback was a
      // generic "thanks" toast at submission time, with no signal that anything happened after.
      // No fromUid/fromUsername: this is a system/admin action, not attributable to another user.
      if (report.byUid && report.byUid !== 'system') {
        await writeNotification(report.byUid, 'report_resolved', null, null, {});
      }
    }
  }
  return { success: true };
});

exports.adminSetBlocked = functions.https.onCall(async (data, context) => {
  requireAdmin(context);
  const uid = String(data.uid || '');
  const blocked = data.blocked === true;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing uid');
  }
  await db.ref(`users/${uid}/blocked`).set(blocked);
  return { success: true };
});

// Sync the caller's public leaderboard entry from their user record.
// Called on login so existing users (created before the leaderboard node) appear too.
exports.syncLeaderboard = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const snap = await db.ref(`users/${uid}`).once('value');
  const user = snap.val();
  if (!user || !user.username) {
    return { success: false };
  }

  const entry = {
    username: user.username,
    pts: user.pts || 0,
    missions: user.totalMissionsDone || 0
  };

  // Optional country code (2-letter, from client locale) for the Country tab
  const country = String(data.country || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) {
    entry.country = country;
  }

  await db.ref(`leaderboard/${uid}`).update(entry);

  return { success: true };
});

// Create a user record for accounts that signed in without email registration
// (e.g. Google sign-in). Safe to call repeatedly — does nothing if record exists.
exports.ensureUser = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const snap = await db.ref(`users/${uid}`).once('value');
  if (snap.exists()) {
    return { success: true, created: false };
  }

  const email = (context.auth.token.email || '').toLowerCase();
  // Sanitize display name into a valid username; fall back to email prefix
  let username = String(context.auth.token.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  if (username.length < 3) {
    username = (email.split('@')[0] || 'player').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  }
  if (username.length < 3) {
    username = 'player_' + uid.slice(0, 6);
  }

  const userData = {
    email: email,
    username: username,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    pts: 0,
    totalMissionsDone: 0,
    missionsDate: getIsraelDate(),
    completedMissionsToday: {},
    verified: false,
    blocked: false,
    // The client's consent checkbox already gated the sign-in that got us here
    // (doGoogle() has no equivalent to doRegister()'s own agreedToTerms/consentAt write).
    agreedToTerms: true,
    consentAt: admin.database.ServerValue.TIMESTAMP
  };

  const updates = {};
  updates[`users/${uid}`] = userData;
  updates[`usernames/${uid}`] = username.toLowerCase();
  updates[`leaderboard/${uid}`] = { username: username, pts: 0, missions: 0 };
  await db.ref().update(updates);

  console.log(`[EnsureUser] Created record for ${uid} (${username})`);
  return { success: true, created: true, username: username };
});

exports.updateBio = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  const bio = String(data.bio || '').trim().slice(0, 120);
  if (bio && hasHarmfulContent(bio)) {
    throw new functions.https.HttpsError('invalid-argument', 'Bio contains inappropriate content');
  }
  const updates = {};
  updates[`users/${uid}/bio`] = bio || null;
  updates[`leaderboard/${uid}/bio`] = bio || null;
  await db.ref().update(updates);
  return { success: true };
});

// Server-side ad reward: +50 pts, max 10/day (Israel time), keeps leaderboard in sync
// ══════════════════════════════════════════════════════════════════
// DAILY LOGIN REWARD — streak with milestones.
// The streak keeps counting past 7 days; it only resets (cleanly, to 1) when a
// full day is missed. Days 1..30 come from the table below; from day 31 on it's
// a flat daily cap, with a milestone every 30th day.
// Milestone days: 7 (week), 14, 21, and every 30th day.
// ══════════════════════════════════════════════════════════════════
const DAILY_REWARDS = [
  20, 25, 30, 35, 45, 55, 150,        // 1..7    — day 7 = one week
  60, 65, 70, 72, 74, 76, 200,        // 8..14   — day 14 = two weeks
  78, 80, 82, 84, 86, 88, 250,        // 15..21  — day 21 = three weeks
  90, 91, 92, 94, 95, 96, 97, 98, 300 // 22..30  — day 30 = one month
];
const DAILY_CAP = 100;                // flat reward per day from day 31 on
const DAILY_MILESTONE_REWARD = 300;   // every 30th day after that (60, 90, ...)

function dailyRewardFor(day) {
  if (day <= 0) return DAILY_REWARDS[0];
  if (day <= DAILY_REWARDS.length) return DAILY_REWARDS[day - 1];
  return (day % 30 === 0) ? DAILY_MILESTONE_REWARD : DAILY_CAP;
}
// The milestone day number (7/14/21/30/60/...), or 0 when this day isn't one.
function dailyMilestoneFor(day) {
  return (day === 7 || day === 14 || day === 21 || (day > 0 && day % 30 === 0)) ? day : 0;
}

exports.claimDailyReward = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const today = getIsraelDate();
  // Yesterday's Israel date, derived from today's date string (day-accurate)
  const yParts = today.split('-').map(Number);
  const yDate = new Date(Date.UTC(yParts[0], yParts[1] - 1, yParts[2]) - 86400000);
  const yStr = yDate.toISOString().slice(0, 10);

  let reward = 0, day = 1, milestone = 0, abort = null;
  const result = await db.ref(`users/${uid}`).transaction(u => {
    if (u === null) return u; // retry with real data
    abort = null;
    if (u.lastDailyClaim === today) { abort = 'CLAIMED'; return; }
    // Consecutive day? (claimed yesterday) → the streak keeps growing, with no 7-day
    // wrap-around. Missed a full day → a clean reset to 1, no credit carried over.
    // NOTE: dailyClaimStreak already meant "consecutive claim days" before this change,
    // so existing streaks carry over untouched — only the streak→reward mapping moved.
    const claimStreak = (u.lastDailyClaim && u.lastDailyClaim === yStr)
      ? (u.dailyClaimStreak || 0) + 1
      : 1;
    day = claimStreak;
    reward = dailyRewardFor(day);
    milestone = dailyMilestoneFor(day);
    u.pts = (u.pts || 0) + reward;
    u.seasonPts = (u.seasonPts || 0) + reward;
    u.lastDailyClaim = today;
    u.dailyClaimStreak = claimStreak;
    // Personal best, kept separately so breaking a streak never erases the record.
    u.longestDailyStreak = Math.max(u.longestDailyStreak || 0, claimStreak);
    return u;
  });

  if (!result.committed) {
    if (abort === 'CLAIMED') {
      throw new functions.https.HttpsError('already-exists', 'Already claimed today');
    }
    throw new functions.https.HttpsError('internal', 'Transaction failed');
  }

  const u = result.snapshot.val();
  await db.ref(`leaderboard/${uid}`).update({ pts: u.pts || 0, seasonPts: u.seasonPts || 0 });

  // A milestone is a real event, so it gets a real inbox entry. The "streak in danger"
  // reminder is deliberately NOT stored — the client renders it from today's state, so it
  // self-clears on claim and never eats into MAX_NOTIFICATIONS.
  // TODO(push): send a real push for the daily reward once the native layer ships.
  if (milestone) {
    await writeNotification(uid, 'streak_milestone', null, null, { day: milestone });
  }

  return {
    success: true,
    reward: reward,
    day: day,
    streak: u.dailyClaimStreak || 1,
    longest: u.longestDailyStreak || day,
    milestone: milestone,
    dayInCycle: ((day - 1) % 7) + 1, // legacy field — older cached clients still read it
    newPoints: u.pts || 0
  };
});

// ══════════════════════════════════════════════════════════════════
// REFERRAL — both inviter and new user get a one-time bonus.
// The referral code is simply the inviter's uid (link: ?ref=<uid>).
// ══════════════════════════════════════════════════════════════════
const REFERRAL_REWARD = 200;

exports.claimReferral = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  const refUid = String(data.refUid || '');
  if (!refUid || refUid === uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid referral');
  }

  // The new user must not already be referred, and the account must be young (anti-abuse)
  const meSnap = await db.ref(`users/${uid}`).once('value');
  const me = meSnap.val();
  if (!me) throw new functions.https.HttpsError('not-found', 'User not found');
  if (me.referredBy) {
    throw new functions.https.HttpsError('already-exists', 'Referral already used');
  }
  if (me.createdAt && (Date.now() - me.createdAt) > 7 * 86400000) {
    throw new functions.https.HttpsError('failed-precondition', 'Referral window expired');
  }

  // Referrer must exist
  const refSnap = await db.ref(`users/${refUid}`).once('value');
  if (!refSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Inviter not found');
  }

  // Award the new user
  const meTxn = await db.ref(`users/${uid}`).transaction(u => {
    if (u === null) return u;
    if (u.referredBy) return; // abort - already referred
    u.referredBy = refUid;
    u.pts = (u.pts || 0) + REFERRAL_REWARD;
    u.seasonPts = (u.seasonPts || 0) + REFERRAL_REWARD;
    return u;
  });
  if (!meTxn.committed) {
    throw new functions.https.HttpsError('already-exists', 'Referral already used');
  }

  // Award the inviter
  const refTxn = await db.ref(`users/${refUid}`).transaction(u => {
    if (u === null) return u;
    u.pts = (u.pts || 0) + REFERRAL_REWARD;
    u.seasonPts = (u.seasonPts || 0) + REFERRAL_REWARD;
    u.referralCount = (u.referralCount || 0) + 1;
    return u;
  });

  // Keep leaderboards in sync
  const meVal = meTxn.snapshot.val();
  await db.ref(`leaderboard/${uid}`).update({ pts: meVal.pts || 0, seasonPts: meVal.seasonPts || 0 });
  if (refTxn.committed) {
    const refVal = refTxn.snapshot.val();
    await db.ref(`leaderboard/${refUid}`).update({ pts: refVal.pts || 0, seasonPts: refVal.seasonPts || 0 });
    await writeNotification(refUid, 'referral', uid, me.username, {});
  }

  return { success: true, reward: REFERRAL_REWARD, newPoints: meVal.pts || 0 };
});

// NOTE: this still trusts the client's word that an ad actually played — there is no AdMob/ad-network
// server-side-verification callback wired up yet (see the TODO at the watchAd call site in index.html).
// MIN_AD_INTERVAL_MS and the abuse-score charge below only raise the cost of naive scripted looping
// (can't claim faster than a real rewarded video would take, and repeated abuse burns the same hourly
// abuse budget as every other action); neither actually proves a real ad was shown. Closing this for
// real needs SSV from the ad network (or a signed reward token it hands back) checked here server-side.
const MIN_AD_INTERVAL_MS = 20000;

exports.watchAd = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid || isAnonymousCaller(context)) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  if (!context.auth.token.email_verified) {
    throw new functions.https.HttpsError('permission-denied', 'Please verify your email first');
  }
  if ((await checkAbuseScore(uid)).blocked) {
    throw new functions.https.HttpsError('permission-denied', 'Suspicious activity detected. Please try again later.');
  }

  const today = getIsraelDate();
  let abortReason = null;

  const result = await db.ref(`users/${uid}`).transaction(u => {
    if (u === null) return u; // first run may be null — let Firebase retry
    abortReason = null;
    if (u.blocked === true) { abortReason = 'BLOCKED'; return; }
    if (u.lastAdClaimAt && (Date.now() - u.lastAdClaimAt) < MIN_AD_INTERVAL_MS) { abortReason = 'TOO_SOON'; return; }
    if (u.adsDate !== today) { u.adsDate = today; u.adsWatched = 0; }
    if ((u.adsWatched || 0) >= 10) { abortReason = 'LIMIT'; return; }
    u.adsWatched = (u.adsWatched || 0) + 1;
    u.lastAdClaimAt = Date.now();
    u.pts = (u.pts || 0) + 50;
    u.seasonPts = (u.seasonPts || 0) + 50;  // monthly season score (reset by rolloverSeason)
    return u;
  });

  await addAbuseScore(uid, 5, 'watch_ad');

  if (!result.committed) {
    if (abortReason === 'LIMIT') {
      throw new functions.https.HttpsError('resource-exhausted', 'Daily ad limit (10) reached');
    }
    if (abortReason === 'BLOCKED') {
      throw new functions.https.HttpsError('permission-denied', 'Account blocked');
    }
    if (abortReason === 'TOO_SOON') {
      throw new functions.https.HttpsError('failed-precondition', 'Please wait before claiming another ad reward');
    }
    throw new functions.https.HttpsError('internal', 'Transaction failed');
  }
  if (!result.snapshot.exists()) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const u = result.snapshot.val();
  await db.ref(`leaderboard/${uid}`).update({ pts: u.pts || 0, seasonPts: u.seasonPts || 0 });

  return { success: true, newPoints: u.pts || 0, adsWatched: u.adsWatched || 0 };
});

// ══════════════════════════════════════════════════════════════════
// MONTHLY SEASON ROLLOVER — archives top players and resets seasonPts.
// Runs at 00:05 on the 1st of every month (Israel time). Lifetime `pts`
// is never touched — only the monthly `seasonPts` competition resets.
// ══════════════════════════════════════════════════════════════════
exports.rolloverSeason = functions.pubsub
  .schedule('5 0 1 * *')
  .timeZone('Asia/Jerusalem')
  .onRun(async (context) => {
    // Label the season that just ended (previous month)
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const seasonId = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

    // Archive top 10 by seasonPts
    const lbSnap = await db.ref('leaderboard').orderByChild('seasonPts').limitToLast(10).once('value');
    const winners = [];
    lbSnap.forEach(child => {
      const d = child.val();
      winners.push({ uid: child.key, username: d.username || 'Player', seasonPts: d.seasonPts || 0 });
    });
    winners.reverse();
    await db.ref(`seasonWinners/${seasonId}`).set({ endedAt: admin.database.ServerValue.TIMESTAMP, winners });

    // Reset seasonPts for every user and every leaderboard entry
    const [usersSnap, lbAllSnap] = await Promise.all([
      db.ref('users').once('value'),
      db.ref('leaderboard').once('value')
    ]);
    const updates = {};
    usersSnap.forEach(c => { updates[`users/${c.key}/seasonPts`] = 0; });
    lbAllSnap.forEach(c => { updates[`leaderboard/${c.key}/seasonPts`] = 0; });
    await db.ref().update(updates);

    console.log(`[Season] Rolled over ${seasonId}: ${winners.length} winners archived, seasonPts reset`);
    return null;
  });

exports.updateLanguage = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid;
  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  const lang = String(data.lang || '').toLowerCase().trim();
  const ALLOWED_LANGS = ['en', 'he', 'ar', 'fr', 'es', 'de', 'pt', 'it', 'ja', 'ko', 'zh', 'ru'];
  if (!ALLOWED_LANGS.includes(lang)) {
    throw new functions.https.HttpsError('invalid-argument', 'Unsupported language');
  }
  await db.ref(`users/${uid}/lang`).set(lang);
  return { success: true };
});

// ══════════════════════════════════════════════════════════════════
// BUNNY VIDEO — create a video object + presigned TUS signature so the client
// can upload the file DIRECTLY to Bunny without ever seeing the API key.
// ══════════════════════════════════════════════════════════════════
exports.createBunnyVideo = functions
  .runWith({ secrets: [bunnyApiKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    const apiKey = bunnyApiKey.value();
    const title = (typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : 'SideQuest video').slice(0, 200);

    // 1) Create the video object in the library
    const createRes = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`, {
      method: 'POST',
      headers: { AccessKey: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!createRes.ok) {
      const txt = await createRes.text().catch(() => '');
      throw new functions.https.HttpsError('internal', 'Bunny create failed: ' + createRes.status + ' ' + txt.slice(0, 200));
    }
    const created = await createRes.json();
    const guid = created.guid;
    if (!guid) throw new functions.https.HttpsError('internal', 'Bunny returned no guid');

    // 2) Presigned TUS signature: sha256(libraryId + apiKey + expiration + videoId).
    //    The client sends these as headers to https://video.bunnycdn.com/tusupload — the key stays here.
    const expiration = Date.now() + 60 * 60 * 1000; // valid 1h (ms since epoch)
    const signature = crypto.createHash('sha256')
      .update('' + BUNNY_LIBRARY_ID + apiKey + expiration + guid)
      .digest('hex');

    return { guid, libraryId: BUNNY_LIBRARY_ID, cdnHost: BUNNY_CDN_HOST, expiration, signature };
  });

// Delete a Bunny video. Caller must be the post's author (feed/$postId/uid) or an admin.
exports.deleteBunnyVideo = functions
  .runWith({ secrets: [bunnyApiKey] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    const uid = context.auth.uid;
    const postId = typeof data?.postId === 'string' ? data.postId : '';
    const email = (context.auth.token?.email || '').toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(email);

    // Which guid may this caller delete? Admins may pass one directly (used by the feed-wipe). A
    // non-admin's guid is NOT trusted — a caller could own post X yet pass someone else's guid Y. So
    // for non-admins we read the guid straight from the post they own: you can only ever delete YOUR
    // OWN video, never an arbitrary guid.
    let guid = '';
    if (isAdmin) {
      guid = typeof data?.guid === 'string' ? data.guid : '';
      if (!guid && postId) {
        const s = await db.ref(`feed/${postId}/bunnyGuid`).once('value');
        guid = s.val() || '';
      }
      if (!guid) throw new functions.https.HttpsError('invalid-argument', 'guid required');
    } else {
      if (!postId) throw new functions.https.HttpsError('permission-denied', 'Not allowed');
      const snap = await db.ref(`feed/${postId}`).once('value');
      const post = snap.val();
      if (!post || post.uid !== uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not the post author');
      }
      guid = post.bunnyGuid || '';
      if (!guid) return { success: true, skipped: true };   // image post / nothing on bunny
    }

    const ok = await bunnyDeleteVideo(guid, bunnyApiKey.value());
    if (!ok) throw new functions.https.HttpsError('internal', 'Bunny delete failed');
    return { success: true };
  });

// Admin-only: delete a single feed post AND free its bunny video + comments. Deleting from the main
// feed removes the SOURCE (the video is no longer shown anywhere), so bunny is cleaned too — unlike a
// room copy. Runs via Admin SDK so it works on any user's post (feed rules only allow self-deletes).
exports.adminDeletePost = functions
  .runWith({ secrets: [bunnyApiKey] })
  .https.onCall(async (data, context) => {
    requireAdmin(context);
    const postId = typeof data?.postId === 'string' ? data.postId : '';
    if (!postId) throw new functions.https.HttpsError('invalid-argument', 'postId required');

    const snap = await db.ref(`feed/${postId}`).once('value');
    const post = snap.val();
    // best-effort media cleanup — a hiccup on either side must not block removing the post
    if (post && post.bunnyGuid) {
      await bunnyDeleteVideo(post.bunnyGuid, bunnyApiKey.value());
    }
    if (post) {
      await Promise.allSettled([deleteFirebaseStorageUrl(post.mediaURL), deleteFirebaseStorageUrl(post.thumbnailURL)]);
    }
    await db.ref(`feed/${postId}`).remove();
    await db.ref(`comments/${postId}`).remove().catch(() => {});
    return { success: true };
  });

// Admin-only: approve a pending user upload so it becomes visible in the public feed.
// User-uploaded videos have no automated content-moderation check (no image/video analysis) —
// until one exists, every upload stays invisible to other users (approved:false, checked by the
// client's isSafePost()) until an admin looks at it here and flips this.
exports.adminApprovePost = functions.https.onCall(async (data, context) => {
  requireAdmin(context);
  const postId = typeof data?.postId === 'string' ? data.postId : '';
  if (!postId) throw new functions.https.HttpsError('invalid-argument', 'postId required');
  await db.ref(`feed/${postId}/approved`).set(true);
  return { success: true };
});

// Admin-only: flip a user's premium flag manually (for testing the premium gating).
// Call from an admin account: firebase.functions().httpsCallable('setPremium')({ uid, value:true })
// TODO(premium-purchase): a REAL subscription purchase must set premium server-side, never from
//   the client. When Play Billing / Stripe is wired, verify the purchase in a webhook/callable and
//   run `db.ref('users/'+uid+'/premium').set(true)` from that server-verified context only.
exports.setPremium = functions.https.onCall(async (data, context) => {
  requireAdmin(context);
  const uid = typeof data?.uid === 'string' ? data.uid.trim() : '';
  if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid required');
  const value = !!data?.value;
  await db.ref(`users/${uid}/premium`).set(value);
  return { success: true, uid, premium: value };
});

// Cancel premium. A signed-in user can cancel ONLY their own (we use context.auth.uid and ignore
// any client-supplied uid). An admin may cancel anyone by passing { uid }.
// TODO(premium-purchase): with real billing this must NOT be an instant removal. Standard subscription
//   behaviour is: keep premium ACTIVE until the paid period ends, then stop it from renewing. So this
//   should instead cancel the recurring Play Billing / Stripe subscription server-side here, and let a
//   billing webhook flip users/$uid/premium to false only when the paid period actually expires. That
//   prevents buy-cancel-rebuy abuse and refund farming.
exports.cancelPremium = functions.https.onCall(async (data, context) => {
  const callerUid = context.auth?.uid;
  if (!callerUid) throw new functions.https.HttpsError('unauthenticated', 'Sign in required');
  const requestedUid = typeof data?.uid === 'string' ? data.uid.trim() : '';
  // Default target is the caller. Cancelling anyone else is admin-only — a normal user passing
  // someone else's uid trips requireAdmin() and is rejected, so they can never affect other accounts.
  let targetUid = callerUid;
  if (requestedUid && requestedUid !== callerUid) {
    requireAdmin(context);
    targetUid = requestedUid;
  }
  await db.ref(`users/${targetUid}/premium`).set(false);
  return { success: true, uid: targetUid, premium: false };
});

exports.deleteAccount = functions
  .runWith({ secrets: [bunnyApiKey] })
  .https.onCall(async (data, context) => {
  const uid = context.auth?.uid;

  if (!uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }
  // No email_verified gate here (there used to be one): email verification isn't otherwise
  // enforced anywhere in the app, so requiring it just for deletion would silently block most
  // real users from ever being able to delete their own account -- the opposite of what this
  // endpoint is for.

  console.log(`[Delete] User ${uid} requesting account deletion`);

  try {
    const updates = {};
    updates[`users/${uid}`] = null;
    updates[`follows/${uid}`] = null;
    updates[`followers/${uid}`] = null;
    updates[`userLikes/${uid}`] = null;
    updates[`userSaves/${uid}`] = null;
    updates[`leaderboard/${uid}`] = null;
    updates[`usernames/${uid}`] = null;
    updates[`notifications/${uid}`] = null;
    // Separate root-level node from users/{uid}/fcmTokens — sendPushTo() and the scheduled
    // broadcast pushes read this one directly. Without clearing it, a deleted account's device
    // token stays registered forever and keeps receiving broadcast pushes under a uid that no
    // longer exists.
    updates[`fcmTokens/${uid}`] = null;

    // Release the actual username reservation too (usernames/{uid} above is a separate reverse
    // index, uid -> name; the forward registry that doRegister's uniqueness transaction and
    // signup's duplicate-check use is usernames/{name} -> uid). Without this the chosen username
    // stays permanently squatted even after the account is gone.
    const userSnap = await db.ref(`users/${uid}`).once('value');
    const username = userSnap.val() && userSnap.val().username;
    if (username) updates[`usernames/${String(username).toLowerCase()}`] = null;

    const feedSnap = await db.ref('feed')
      .orderByChild('uid')
      .equalTo(uid)
      .once('value');

    const bunnyGuids = [];
    const storageUrls = [];
    feedSnap.forEach(child => {
      updates[`feed/${child.key}`] = null;
      updates[`comments/${child.key}`] = null;
      const p = child.val();
      if (p && p.bunnyGuid) bunnyGuids.push(p.bunnyGuid);
      if (p && p.mediaURL) storageUrls.push(p.mediaURL);
      if (p && p.thumbnailURL) storageUrls.push(p.thumbnailURL);
    });

    // Comments this user left on OTHER people's posts (the feedSnap loop above only wipes
    // comment threads on the user's OWN posts). No index exists for "comments by uid" -- same
    // full-scan tradeoff exportMyData already makes for the same reason.
    const allCommentsSnap = await db.ref('comments').once('value');
    allCommentsSnap.forEach(postComments => {
      postComments.forEach(c => {
        const v = c.val();
        if (v && v.uid === uid) updates[`comments/${postComments.key}/${c.key}`] = null;
      });
    });

    // Chats this user is party to -- delete the shared thread entirely (both sides' history)
    // rather than leaving the other participant with a conversation from a ghost account.
    const chatMetaSnap = await db.ref(`chatMeta/${uid}`).once('value');
    chatMetaSnap.forEach(c => {
      const chatId = c.key;
      updates[`chats/${chatId}`] = null;
      const otherUid = chatId.split('_').find(u => u !== uid);
      if (otherUid) updates[`chatMeta/${otherUid}/${chatId}`] = null;
    });
    updates[`chatMeta/${uid}`] = null;

    await db.ref().update(updates);

    // Remove the user's hosted media too (best-effort; DB already cleaned above). allSettled +
    // the helpers returning false/never throwing guarantee that one failed video/file can NEVER
    // abort the rest of the cleanup or fail the account deletion.
    if (bunnyGuids.length) {
      const key = bunnyApiKey.value();
      await Promise.allSettled(bunnyGuids.map(g => bunnyDeleteVideo(g, key)));
    }
    if (storageUrls.length) {
      await Promise.allSettled(storageUrls.map(u => deleteFirebaseStorageUrl(u)));
    }

    // Delete the Firebase Auth record itself -- without this, the account "deletion" only ever
    // wiped the database, and the same credentials could sign straight back in afterward.
    try {
      await admin.auth().deleteUser(uid);
    } catch (authError) {
      if (authError.code !== 'auth/user-not-found') throw authError;
    }

    console.log(`[Delete] Account deleted for user ${uid}`);

    return {
      success: true,
      message: 'Account deleted successfully'
    };
  } catch (error) {
    console.error(`[Delete] Error deleting account ${uid}:`, error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to delete account: ' + error.message
    );
  }
});
