# Flash Arena — Launch Checklist

Status legend: ✅ done · ⏳ needs you · 🔒 needs Blaze plan

## 1. Upgrade to Blaze 🔒
Firebase Console → Usage and billing → Modify plan → Blaze (pay-as-you-go).
Set a budget alert (e.g. $10/mo) so there are no surprises.

## 2. Deploy Cloud Functions ⏳ (after Blaze)
```
firebase deploy --only functions
```
This activates: notification creation + push, secure points/redeem,
referral awards, scheduled jobs (season rollover, nightly verify, trending).

## 3. Web Push key (VAPID) ⏳
Console → Project settings → Cloud Messaging → Web Push certificates →
copy the "Key pair" and paste it into index.html:
```
const VAPID_KEY='...';     // currently empty
```
Then redeploy hosting. Without it, push won't register on devices.

## 4. Re-secure the database rules ⏳ (after functions are live)
Today rules are relaxed so the client can write its own points/leaderboard
(needed for the free plan). This lets users cheat. Once functions are live:
- switch firebase.json `database.rules` to `FIREBASE_RULES_SECURE.json`
  (server writes points; client can't), then `firebase deploy --only database`.
- Re-test: complete a mission, claim daily reward, leaderboard updates.

## 5. Storage CORS (optional) ⏳
Only needed for the avatar-ring dominant-color on OLD photos. New uploads
already store the color locally. To enable for everyone:
```
gsutil cors set cors.json gs://flasharena-f35b1.firebasestorage.app
```
(Run from Google Cloud Shell if gsutil isn't installed locally.)

## 6. Content moderation ⏳
- Client-side hate/profanity filter is active on posts & comments. ✅
- Stand up the admin review flow (admin-dashboard.html) and set ADMIN_EMAILS
  env on functions to review the `reports` queue.

## 7. Legal & compliance ✅/⏳
- Terms & Privacy pages exist and are now linked (signup + settings). ✅
- Age 13+ and terms consent required at signup; recorded on the account. ✅
- Review the Terms/Privacy text with the actual data you collect. ⏳
- Decide how real rewards are funded & fulfilled. ⏳

## 8. Play Store (only if shipping as an app) ⏳
- Wrap the PWA as a TWA (Bubblewrap) → signed AAB.
- Listing assets exist: feature-graphic.png, PLAY_STORE_LISTING.md.
- Fill Data Safety form + content rating + privacy policy URL.

## Already done ✅
Design system, full Hebrew localization, PWA (install + offline),
auth, feed/leaderboard/chat/profile/achievements, notifications mute toggle,
GDPR export + delete, content filter, hosting deployed.
