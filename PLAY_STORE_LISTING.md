# Google Play Store Listing — Side Quest

> Drafted 2026-07-31 to replace the stale FlashArena/TWA-era version. Marked ⚠️ where a
> human decision or asset is still needed before this can be submitted — see the
> "Still missing" section at the bottom for the actionable list.

## App name (30 chars max)
Side Quest: Real-Life Missions
<!-- 30/30 chars -->

## Short description (80 chars max)
Complete real missions, climb the leaderboard, and win real rewards!
<!-- 68/80 chars -->

## Full description (4000 chars max)

⚡ Side Quest turns your everyday life into a game!

Every day you get real-life missions — talk to a stranger, explore somewhere new, take on a dare. Complete them, snap a photo or video as proof, and earn points.

🎯 DAILY MISSIONS
Fresh challenges every day. Easy, medium and hard — the harder the mission, the more points you earn. Keep your streak alive for bonus rewards.

🕹️ CHALLENGE ROOMS
Create or join a room with a 5-character code and do missions together with friends in real time — shared chat, shared feed, one host in charge.

🏆 LEADERBOARDS
Compete with friends, your country, and the whole world. Climb the all-time rankings and become a Legend.

🎬 SHARE YOUR WINS
Your mission proofs become posts in a TikTok-style feed. Get likes, comments and followers. Discover what others are doing with hashtags and search.

💬 CHAT WITH FRIENDS
Send direct messages, follow your favorite creators, and build your crew.

🎁 REAL REWARDS
Trade your points for gift cards and PayPal cash in the Rewards Shop.

🛡️ SAFE BY DESIGN
All content is filtered and moderated, you control who can message you, and you can make your profile private any time.

Side Quest is for ages 13+. Missions take place in the real world — always stay safe and follow local laws.

Privacy Policy: https://flasharena-f35b1.web.app/privacy.html
Terms of Service: https://flasharena-f35b1.web.app/terms.html

<!--
⚠️ Premium is deliberately NOT mentioned above: setPremium/cancelPremium exist in
the backend but there's no real purchase flow yet (admin-granted only). Advertising
a paid tier Play Store can't verify you actually sell would misrepresent the app's
monetization — add a "Go Premium" bullet once real Play Billing is wired up (see
P2 item 18 in the punch list).
-->

## Category
Social

## Tags
social, missions, challenges, rewards, leaderboard

## Content rating questionnaire — key answers
- User-generated content: YES (with moderation, reporting, and blocking)
- Users can communicate: YES (direct messages, comments, room chat — all server-moderated as of this pass)
- Shares user location: NO (only coarse country from locale)
- Digital purchases: NO *(true today — Premium isn't purchasable yet; flip this the moment real billing ships, see ⚠️ above)*
- Violence/sexuality/profanity: NO (prohibited and moderated — filter now covers English/Hebrew/Arabic)
- Target age: 13+ (age-affirmation checkbox required at signup, verified in code)

## Data Safety form — declare these
Collected:
- Email address (account management) — required
- Username (account management, visible to others) — required
- Photos & videos (app functionality, user content) — required for missions
  - ⚠️ Videos are hosted on **Bunny.net** (third-party video CDN), not just Firebase — declare it as a data processor here too, and add it to the Privacy Policy (see the separate gap list from item 2)
- Messages (app functionality) — direct messages + room chat, stored
- Approximate location (country only, from locale) — app functionality
- Device push token (Firebase Cloud Messaging) — app functionality, notifications ⚠️ *(not in the old listing — add it, matches the Privacy Policy gap)*
- Crash logs & diagnostics (Sentry)
All data encrypted in transit (HTTPS). Users can request deletion (in-app account deletion).

## Assets checklist
- [ ] App icon 512x512 — ⚠️ `icon-512.png`/`icon-192.png` at the repo root are the OLD orange-bolt-on-navy "FlashArena" mark; the app (and the Android build) now uses a blue bolt on white. **These are live on the deployed PWA manifest right now** — anyone installing the web app to their home screen today gets the wrong icon. Needs regenerating from the current logo at real resolution (no 512px source of the new logo exists in the repo yet, only the 192px Android mipmap — upscaling that will look soft). Your call on whether to upscale as a stopgap or re-export from source.
- [ ] Feature graphic 1024x500 — ⚠️ `feature-graphic.png` exists at the right dimensions but is the OLD "FlashArena" branding/colors — needs a redo to match current identity.
- [ ] Phone screenshots (2-8) — see note below, I can capture these from the live app.
- [x] Privacy policy URL — /privacy.html *(content gaps tracked separately — see item 2 report)*
- [x] Terms URL — /terms.html *(same)*

## Packaging (native Capacitor — NOT the TWA/PWABuilder path the old doc described)
The app already has a real Android Studio project (`android/`) via Capacitor 8.4.2,
App ID `com.sidequest.app`, configured in **Remote mode** (loads the live Firebase
Hosting URL, so `firebase deploy` updates the app instantly without a rebuild).
Native Google Sign-In is wired up. What's left for a store submission:
1. Generate a **signed release build** (currently only a debug APK has been built/tested) — needs a real upload keystore, `android/app/build.gradle` release signing config, and a release AAB build (`./gradlew bundleRelease`).
2. Regenerate app icon/feature-graphic assets (above).
3. Take Play Store screenshots (below).
4. Fill in the Data Safety form + content rating questionnaire above in Play Console.
5. Upload the AAB, attach the listing content above, submit for review.

## Note on screenshots
I can capture live screenshots of the current app (feed, missions, ranks, profile,
a challenge room) at phone resolution using the deployed site — that's mechanical,
not a design decision, so I'll do that next unless you'd rather they come from the
actual native Android build once it's signed and installed.

## Still missing (needs you, not just me)
- Real app icon (512px) + feature graphic redone in current branding
- Signed release keystore + release build
- Final review of the Data Safety form / content rating in Play Console itself (I can only draft the answers, not submit them — that needs your Play Console account)
- A Google Play Developer account ($25 one-time), if not already set up
