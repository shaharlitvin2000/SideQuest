# Flash Arena — Blaze Upgrade Checklist (do these in order)

The app runs fine on the free Spark plan today, EXCEPT uploads (Storage was never
enabled). Upgrading to Blaze unlocks Storage + push + secure server logic.
Tell Claude "I upgraded to Blaze" and it will walk you through + do the code work.

## 1. Upgrade to Blaze
Console → ⚙️ Usage and billing → Modify plan → **Blaze**.
Then set a **Budget alert** ($1–5). Blaze has a free tier — small usage stays $0.

## 2. Enable Storage  → fixes profile photos, chat images, mission/video uploads
Console → Storage → **Get Started** → Next → pick a location (eur3) → Done.
Then: `firebase deploy --only storage`
(rules already written in STORAGE_RULES_PRODUCTION.txt)

## 3. Web Push key (VAPID)  → push notifications to the phone
Console → Project settings → Cloud Messaging → Web Push certificates → copy "Key pair".
Paste it into index.html:  `const VAPID_KEY='...'`  (currently empty)
Then: `firebase deploy --only hosting`

## 4. Deploy Cloud Functions  → secure points, push, referrals, scheduled jobs
`firebase deploy --only functions`

## 5. ⚠️ Avoid double notifications (Claude will handle)
In-app notifications are created CLIENT-SIDE right now. If the functions also create
them, users get duplicates. Pick ONE source (remove the client calls OR the function).

## 6. ⚠️ Re-secure the rules — NOT a simple file swap (Claude will rewrite)
The old FIREBASE_RULES_SECURE.json would break the many client-side social features
(leaderboard, follows, notifications, comments, chat, blocking, privacy). Claude must
write a NEW rules version that locks down only points/anti-cheat (server writes points)
while keeping the social features working.

## 7. Test
Upload a photo, send a chat image, complete a mission (points), get a push, referral.

---
Make sure you're upgrading project **flasharena-f35b1** — NOT pixelbam (a separate project).
