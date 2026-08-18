# Launch Readiness Audit

Comprehensive pre-launch pass across auth/onboarding, safety/moderation, cross-cutting UX,
backend (Cloud Functions/DB rules), and i18n/RTL/accessibility. Premium features and payments
are explicitly out of scope (deferred separately).

Status legend: `[ ]` not started · `[~]` in progress · `[x]` fixed & verified

**All 8 blockers + all 11 High-severity + all 18 Medium-severity items fixed and deployed**
(hosting + database rules + Cloud Functions, all verified byte-for-byte/live). 11 of 12 Low
severity items are fixed; L9 remains explicitly flagged for a design-confirmation decision rather
than guessed at, same as M9's unbounded-query remainder.

---

## 🔴 Blockers

- [x] **B1 — Age/ToS consent bypass via Google sign-in from the Log In tab.** *(fixed: `_handleGoogleSignIn` now checks Firebase's `additionalUserInfo.isNewUser` after any Google sign-in — web or native — and if a brand-new account was created without consent having been given, deletes the just-created account, signs out, switches to the Sign Up tab, and shows the consent error. Closes the bypass regardless of which tab the Google button was clicked from.)*
  `index.html:3019-3028` (`doGoogle`). The consent gate is
  `if(consent && consent.offsetParent!==null && !consent.checked)`. The checkbox only exists in
  the `#auth-reg` block; on the Log In tab it's `display:none`, so `offsetParent` is `null` and
  the whole check is skipped — regardless of whether Google sign-in is creating a brand-new
  account. `doGoogle` never distinguishes new vs. existing users before calling
  `signInWithPopup`, and the follow-up `ensureUser` call carries no consent flag. This is the
  app's only age/ToS acceptance step and it's trivially skippable via a very common user habit
  (tapping "Log In" first).

- [x] **B2 — Account deletion fails for most real users (no re-authentication).** *(fixed: `deleteMyAccount()` now re-authenticates before deleting — for password accounts it opens the existing account-modal to collect the current password and reauthenticates via `EmailAuthProvider`; for Google accounts it re-triggers the Google sign-in flow (native or popup) and reauthenticates via that credential. Deletion itself only proceeds after successful re-auth, via a new `_performAccountDeletion()`.)*
  `index.html:3142-3177` (`deleteMyAccount`). Never re-authenticates before calling
  `auth.currentUser.delete()`, unlike the password-change flow which does
  `reauthenticateWithCredential` (line 2995). Session timeout is intentionally disabled app-wide
  (line 2522-2525), so most users won't have a "recent" login and will hit Firebase's
  `auth/requires-recent-login` error — surfaced only as a raw untranslated `err.message` with no
  retry/re-auth path. Apple/Google require a *working* in-app deletion flow.

- [x] **B3 — No content moderation gate on user-uploaded videos before they go public.** *(fixed via admin-approval gate, per user decision: `createFeedPost` now writes `approved:false` on every upload; `isSafePost()` hides any `isUserVideo` post from the public feed until `approved===true` (including legacy rows with no `approved` field at all, which default to hidden rather than silently visible); `updatePostMedia` (attaching real media to an existing post after the fact, e.g. mission "proof" video) resets the post to `isUserVideo:true, approved:false` too, closing that same gap. Added a new admin-only `adminApprovePost` callable and a "Pending Uploads" section in the admin panel (Approve / Reject, reusing `adminDeletePost` for reject) so the admin tooling built for B4 now doubles as the moderation queue. The uploader still sees their own pending upload immediately on their own profile grid (unaffected — that view queries `feed` directly, not through `isSafePost()`) with a "Pending review" badge instead of the normal caption. DB rules updated to formally validate the new `isUserVideo`/`approved` fields. Note: this is a human-review gate, not automated content detection — every upload needs a manual look before it's public, which will become a bottleneck past a single admin's review capacity; layering real AI content-scanning (Cloud Vision/Video Intelligence) on top later remains the natural next step and was intentionally left out of this pass since it needs a new paid GCP API enabled on the project.)*
  `index.html:3963-3970` (`isSafePost`) and `functions/index.js:2725-2739` (`createFeedPost`).
  `isSafePost()` explicitly exempts `isUserVideo` posts from the pending-status check, so
  uploads render in the feed instantly. The only check anywhere in the path is a text keyword
  filter on the caption/username (`hasHarmfulContent`) — no image/video-frame analysis exists at
  all (no Vision/SafeSearch call, no human review queue). Nudity/violence/gore with an innocuous
  caption goes straight to every viewer's feed.

- [x] **B4 — Admin panel is read-only; can't actually remove content or ban users.** *(fixed: added "Remove Post" and "Ban User" buttons to the admin report list, wired to the existing `adminDeletePost`/`adminSetBlocked` callables with confirm dialogs; also switched `adminResolve` from a direct client DB write to the `adminUpdateReport` callable, and tightened `reports/$reportId/status` in the DB rules so only the admin can change status on an existing report — previously any authenticated user could flip their own report to "actioned" to bury it.)*
  `index.html:7124-7171` (`renderAdminReports`/`adminResolve`) vs.
  `functions/index.js:3468-3484` (`adminDeletePost`) and `functions/index.js:3008-3017`
  (`adminSetBlocked`). The shipped admin UI only flips a report's status to `'actioned'`; it
  never calls the takedown/ban functions, and no button in the markup exposes them
  (`index.html:9601-9610`). The backend support exists and is properly gated by `requireAdmin`,
  but there is no way to invoke it from the app — reported content stays live indefinitely from
  the admin's real workflow.

- [x] **B5 — Blocking doesn't stop follows or comments (server or client).** *(fixed: added a block check to the `followUser` callable (defense in depth); more importantly, moved `follows`/`followers` DB rules' `.write` down to the per-target/per-follower level and added a block check directly in the rules — `root.child('userBlocked/...')` — so a blocked relationship can't be bypassed via a direct client write either. `submitComment` now looks up the post owner and rejects with `permission-denied` if either side has blocked the other, mirroring the pattern `sendMessage` already used for DMs. Comment rules didn't need a rules-level change since comment creation was already funneled exclusively through `submitComment` — the existing `.write` rule only ever permitted self-delete.)*
  Follows: `FIREBASE_RULES_PRODUCTION.json:164-181` and `functions/index.js:691-746`
  (`followUser`) never reference `userBlocked`; the client's `followUser()`
  (`index.html:8239-8261`) writes directly via `db.ref().update()`, bypassing the cloud function
  entirely. Comments: `functions/index.js:1474-1568` (`submitComment`) never checks
  `userBlocked/{postOwnerUid}/{commenterUid}`, and the DB rules for `comments`
  (`FIREBASE_RULES_PRODUCTION.json:93-114`) have no block check either — contrast with
  `sendMessage` (`functions/index.js:2622-2637`), which does check blocks correctly. A blocked
  user can still follow you and keep commenting on your videos indefinitely.

- [x] **B6 — Banned (`blocked:true`) accounts can still upload videos.** *(fixed: `createFeedPost` now checks `userData.blocked === true` right after fetching the uploader's user record, same as `completeMission`/`sendMessage` already did, and rejects with `permission-denied` before the post is written.)*
  `functions/index.js:2692-2739` (`createFeedPost`) checks `checkAbuseScore` and runs
  `hasHarmfulContent` on the caption, but never checks `userData.blocked === true` — unlike
  `completeMission` (line 543-544) and `sendMessage` (line 2639-2641), which both correctly
  reject blocked accounts. The primary content-creation surface is the one path banning doesn't
  stop.

- [x] **B7 — Android hardware back button exits the app from any screen.** *(fixed: added `_handleAndroidBack()` in `index.html`, a registry of every overlay/sheet/modal in the app (~35 of them) checked innermost-first, closing whichever is open via its real close function (so cleanup like stopping the camera stream or unsubscribing chat listeners still happens) and returning `true`; if nothing is open and the active screen isn't Home, it navigates to Home instead. `MainActivity.onBackPressed()` now calls this via `evaluateJavascript` and only backgrounds the app (`moveTaskToBack`, not `finish()`, so the app resumes instantly rather than cold-starting) when it returns `false`. Verified with a Playwright test covering all four cases: nothing open on Home (backgrounds), non-Home screen (navigates to Home), an open overlay (closes it, doesn't also navigate), and the settings panel (closes via its real `closeSettings()`, including its scroll-lock cleanup). Requires a new APK build to take effect on-device.)*
  No `onBackPressed` override in `MainActivity.java`, and no `App.addListener('backButton', ...)`
  / `popstate` / `history.pushState` usage anywhere in `index.html` — confirmed via full-file
  search. The app is a single-page div-show/hide UI with zero browser history entries. Capacitor's
  default back-button behavior falls through to `finish()` since there's nothing to go back
  through. Pressing back mid-comment-sheet, mid-DM, in settings, or on the feed — from literally
  any screen — kills the app instead of closing the current overlay/screen. Single most common
  Android interaction pattern; every session hits it eventually.

- [x] **B8 — Cloud Function self-retriggering write loop (`trackPostView`).** *(fixed: changed the guard from `!post.views` to `post.views === undefined`. Since every post is created with `views:0` (falsy but defined), the old check stayed true forever — the "initializing" write was itself a write to the trigger's own path, re-firing `onWrite`, which saw `views:0` as falsy again and rewrote it again, on every future write to that post (likes, comments, anything), not just once at creation. The `=== undefined` check only ever fires for a genuinely missing field, and the corrective write itself makes the field defined, so it can never re-fire for that post again.)*
  `functions/index.js:2042-2054`. On RTDB `onWrite` trigger for `feed/{postId}`, checks
  `if (!post.views)` and writes `change.after.ref.update({ views: 0 })` back to the same path
  it's watching. Posts are created with `views: 0` explicitly (`completeMission` line 638,
  `createFeedPost` line 2734) — `0` is falsy in JS, so the very first invocation re-writes to its
  own trigger path, re-firing itself. RTDB `onWrite` fires per write operation regardless of
  whether the value actually changed. Real risk of runaway invocations, cost, and possible
  service disruption at launch, on every single post creation.

---

## 🟠 High

- [x] **H1 — Signup interrupted mid-flow silently loses username + consent record.** *(fixed: `applyLoadedData`'s `!data` branch now also writes `agreedToTerms:true, consentAt:TIMESTAMP` to `users/{uid}` — safe because the only way a Firebase Auth account can exist with no DB record at all is via `doRegister`/`doGoogle`, both of which already gate on consent.)*
  `index.html:2871-2903` (`doRegister`) / `index.html:2579-2587` (`applyLoadedData`). If the app
  closes after `createUserWithEmailAndPassword` succeeds but before the `users/{uid}` record and
  username transaction complete, reopening hits `applyLoadedData`'s `!data` branch, which
  silently fabricates a fresh profile (`pts=0, streak=1`, username falls back to email prefix)
  and calls `saveUserData()` — whose payload (line 2543) never includes
  `agreedToTerms`/`consentAt`. Chosen username and consent record are both silently lost, no
  error shown.

- [x] **H2 — Auto-flag system for bad videos never actually hides them.** *(fixed: `isSafePost()` now hides any post with `moderationFlaggedAt` set; `adminUpdateReport` clears the flag when the admin resolves an `auto_low_rating` report, restoring visibility.)*
  `functions/index.js:1443-1456` (rating-based auto-flag) and `functions/index.js:1666-1709`
  (`batchVerifyPosts`). When a video hits ≥5 ratings averaging ≤1.5 stars, code creates a
  `reports` entry and sets `moderationFlaggedAt` — but never changes `feed/$postId/status`, and
  the client's `isSafePost()` never checks `moderationFlaggedAt` at all. `batchVerifyPosts`
  (nightly) only deletes posts whose caption/username trips the keyword filter. The one automated
  backstop for bad video content is silently inert.

- [x] **H3 — Reporting bypasses the server-side rate limit.** *(fixed: client now calls the `reportUser` callable (extended to accept `postId`) instead of writing directly; DB rules tightened to `reports/.write:false` so direct client writes are no longer possible at all, not just discouraged.)*
  `index.html:7101-7111` (`submitReport`) writes directly to `db.ref('reports').push(...)`,
  never calling `functions/index.js:774-835` (`exports.reportUser`), which enforces a
  5-reports-per-hour limit and sanitizes the `details` field. DB rules
  (`FIREBASE_RULES_PRODUCTION.json:250-260`) only validate required fields/reason enum, no rate
  limit. A malicious/automated client can flood the `reports` node with junk, burying real
  reports.

- [x] **H4 — Report categories omit nudity/violence/underage — urgent items buried in generic bucket.** *(fixed: added Nudity and Violence report categories to the modal, `reportUser`'s valid-reasons list, and the DB rules enum. An "Underage user" category was also added and then explicitly removed per user decision — kids often appear in videos with a parent present, so that category isn't a good fit and would generate noise. Nudity/Violence still close most of the original triage gap.)*
  `index.html:9640-9646` (report modal) offers only Spam, Inappropriate content,
  Harassment/bullying, Hate speech, Scam/fraud — mirrored by the fixed enum in
  `FIREBASE_RULES_PRODUCTION.json:257` / `functions/index.js:788`. No distinct
  nudity/sexual-content or underage-user category means the admin queue can't triage/prioritize
  the most urgent reports (e.g. suspected CSAM) — everything reads as generic "inappropriate."

- [x] **H5 — `deleteAccount` never deletes the Firebase Auth record.** *(fixed: added `admin.auth().deleteUser(uid)`; also removed a conflicting `email_verified` gate on the same function and consolidated the client's deletion flow onto this server callable — it was a separate, narrower, unused implementation before, discovered while fixing this.)*
  `functions/index.js:3522-3587`. Wipes the RTDB profile/posts/likes/etc. but never calls
  `admin.auth().deleteUser(uid)` (confirmed: `admin.auth()` isn't used anywhere in the file). The
  Auth account survives "deletion" — the user can sign back in with the same credentials at any
  time, contradicting the deletion promise and creating a data-retention/GDPR-style compliance
  gap.

- [x] **H6 — Orphaned Storage blobs leak forever.** *(fixed: added a `deleteFirebaseStorageUrl()` helper, wired into `adminDeletePost`, `batchVerifyPosts`, and `deleteAccount`; also stopped `compressUploadedVideo` from leaving the pre-compression original in Storage forever once the compressed copy takes over.)*
  No code path calls `bucket.file(...).delete()` on the actual asset objects (the only
  Storage-deletion-adjacent calls are transient local temp-file cleanup inside
  `compressUploadedVideo`, `functions/index.js:2445-2467`). When a post is removed
  (`adminDeletePost` line 3468-3484, `batchVerifyPosts` line 1666-1709, `deleteAccount` line
  3522-3587), only the Bunny-hosted video is cleaned up — the original upload, compressed video,
  thumbnail, and any Storage-hosted image post media leak forever, growing storage cost with no
  cleanup path.

- [x] *(fixed: `recordView` now uses `.transaction()` per counter field instead of a read-then-`.update()`.)* **H7 — View/watch-time counters aren't atomic (race condition, same bug class as the already-fixed `redeemPoints`).**
  `functions/index.js:2060-2116` (`recordView`), specifically 2086-2102. `views`,
  `repeatViews`, `watchMs` are updated via a plain read (`.once('value')`) followed by a separate
  `.update()` with computed values, not `db.ref(...).transaction()`. Every other counter in the
  file (`likes`, `savedCount`, `ratingSum`) correctly uses `.transaction()`. Concurrent viewers of
  a popular post will race and lose increments — view/watch-time counts silently undercount at
  real scale.

- [x] **H8 — No timeout on any Realtime Database read.** *(fixed: added a generic `onceWithTimeout()` helper (mirrors the existing `putWithTimeout`) and applied it to the 5 spinner-showing sites the audit named — feed, leaderboard, chat list, follow sheet, comments — so each now has a real error path instead of hanging forever on a flaky connection. Not applied to every `.once('value')` call in the file, only the ones with a visible loading state.)*
  `putWithTimeout` (`index.html:8066`) is the only timeout wrapper in the file, used only for
  Storage uploads. All `db.ref(...).once('value')` calls (comments 8449/8476, follow sheet 8382,
  chat list 7891, leaderboard 6672, feed 3990) have none. RTDB's `.once('value')` doesn't reject
  on connectivity loss — it waits indefinitely for reconnection, so `.catch()` never fires. On a
  flaky mobile connection (the normal case, not an edge case), spinners at e.g. 6670, 8373, 8432,
  7890 can hang forever with no way out short of force-quitting.

- [x] **H9 — "Continue →" arrow is baked as literal text into every translation; can't mirror for RTL.** *(fixed: split the button into a translated label span + a separate `.chevron` icon span, which already had the app's RTL-mirroring rule; stripped the trailing arrow from all 7 `continue` translations.)*
  `index.html:2077-2083` (`continue` key, all 7 languages), rendered via `index.html:1425/2357`.
  Unlike the app's own chevron icons, which correctly mirror via
  `[dir="rtl"] .chevron{transform:scaleX(-1)}` (line 963), this arrow is plain text inside the
  translated string and can never flip. On the very first screen of the app (language picker
  CTA), Hebrew/Arabic users see an arrow pointing the wrong direction for their reading order —
  hits 100% of the primary audience immediately.

- [x] **H10 — GDPR/privacy consent banner is 100% hardcoded English.** *(fixed: routed through `t()` using the same fragment-concatenation pattern as the existing Auth-screen consent text, reusing the already-translated `termsLink`/`privacyLink` words; added 5 new keys × 7 languages.)*
  `index.html:3180-3197` (`showGDPRNotice`). The entire cookie/privacy banner (heading,
  paragraph, Accept/Decline buttons) never routes through `t()`, unlike the equivalent Auth-screen
  consent text (`t('consentPre')`/`t('consentAnd')`, line 2360). Every first-time user sees this
  in English regardless of selected language — a legal/consent-adjacent notice.

- [x] **H11 — Hardcoded English toast strings break i18n for common actions.** *(fixed: all 4 now route through `t()` — 2 reused existing keys (`unfollowedDone`), 3 new keys added (`followingDone`, `backOnline`, `youAreOffline`) × 7 languages.)*
  `index.html:8274` `toast('👥 Unfollowed')`, `index.html:8322` `toast('👥 Following!')`,
  `index.html:9296` `toast('🌐 Back online')`, `index.html:9301` `toast('📡 You are offline')`.
  Every other toast in the file (~150+) is properly wrapped in `t(...)` — these read as clear
  oversights in frequently-hit code paths (follow/unfollow, connectivity changes).

---

## 🟡 Medium

- [x] **M1 — Login failure always says "wrong password," even for network errors.** *(fixed: `doLogin`'s catch now distinguishes `auth/network-request-failed`/`auth/too-many-requests`/`auth/internal-error`/timeout from real credential errors, showing a toast instead of the misleading inline "wrong password" message for the former.)*
  `index.html:3008-3017` (`doLogin`). The catch-all always displays the static translated "Wrong
  email or password," regardless of actual failure — including `auth/network-request-failed` or
  timeouts. Misleads users on a bad connection into a wrong-password/reset-password rabbit hole.

- [x] **M2 — No timeout on auth calls; hung request permanently disables the button.** *(fixed: added a generic `withTimeout()` helper (same pattern as `putWithTimeout`/`onceWithTimeout`) and applied it to login, the full multi-step registration chain, and forgot-password — a hang anywhere now reaches the existing error handling and re-enables the button instead of leaving it stuck.)*
  No timeout wraps register/login/forgot-password. `setAuthLoading(true)` disables the button but
  nothing re-enables it if the request hangs (contrast `putWithTimeout`, 25s, used elsewhere for
  Storage uploads).

- [x] **M3 — Account deletion is incomplete.** *(fixed: `deleteAccount` now releases the `usernames/{name}` forward reservation, deletes comments left on other users' posts (full scan, same tradeoff `exportMyData` already makes), and deletes chats the user was party to — both sides' history, plus the other participant's `chatMeta` entry. Notification references left in other users' inboxes were deliberately left alone: they're transient, self-expiring via `trimNotifications`, and finding them all would need scanning every user's inbox for a cosmetic, low-stakes gain.)*
  `index.html:3158-3167`. Removes `users/`, feed posts, follows/followers, `userLikes` — but
  never releases the `usernames/{name}` reservation, and never deletes comments on other users'
  posts, chat/messages, or notifications. Username stays permanently squatted; other surfaces
  keep dangling `uid` references to a deleted account.

- [x] **M4 — Deletion confirmation UI inconsistency.** *(fixed: replaced the two chained native `confirm()` calls with two chained themed `showConfirm({danger:true})` dialogs, matching the rest of the app's UI.)*
  `index.html:3143,3147` vs. `3063-3068`. Uses two chained native `confirm()` dialogs instead of
  the app's own themed `showConfirm()` component (used for logout) — renders as unstyled system
  dialogs in the Capacitor WebView, jarring against the custom RTL UI.

- [x] **M5 — First launch defaults to English before the language picker is easily reachable.** *(fixed: `bootToAuth()` now shows `p-lang` first when no language has ever been saved (a genuinely fresh install), and goes straight to `p-auth` as before for every other case (logout, session fallback, etc.) where a language is already saved. Verified via Playwright: fresh install → `p-lang`, returning user → `p-auth`.)*
  `index.html:2464-2471` vs. `1433`. `bootToAuth` defaults `curLang='en'` when nothing in
  `localStorage`; `p-lang` isn't shown pre-signup. Only reachable via the Sign Up tab's "← Back"
  link (labeled "Back," not framed as a language switch) — a non-obvious affordance for a
  Hebrew-RTL-first app's first-ever screen.

- [x] **M6 — Client-side block/unblock bypasses the cloud function, losing auto-unfollow-on-block.** *(fixed: `doBlock`/`unblockUser` now call the `blockUser`/`unblockUser` callables. Also extended `blockUser` server-side to accept/store the blocked user's display name (`name` field) so the client's blocked-list UI doesn't regress to showing "Player" for everyone.)*
  `index.html:7840-7852` (`doBlock`/`unblockUser`) write directly to `userBlocked/{uid}/{target}`,
  never calling `functions/index.js:841-880` (`exports.blockUser`/`unblockUser`), which
  additionally clears any existing follow relationship. A pre-existing follow between the two
  users silently survives a block via the real app flow.

- [x] **M7 — Comment-sheet spinner can hang permanently if `db` is null.** *(fixed: `openCommentSheet` now shows the same "couldn't load" fallback `loadCommentsFull`'s own catch uses, when `db`/`postId` aren't available instead of leaving the spinner in place forever.)*
  `index.html:8425-8437` (`openCommentSheet`). Spinner is always shown, but
  `loadCommentsFull(postId)` (the only code path that replaces that HTML) only runs `if(db&&postId)`.
  If `db` is null (guest/offline boot, or Firebase still mid-init), the spinner never clears —
  contrast `loadFeed`/`openChatList`/`showFollowSheet`, which all render an explicit fallback.

- [x] **M8 — Safety actions show success toasts even when the write silently failed.** *(fixed: `doBlock`/`unblockUser`/`muteUser`/`unmuteUser` all now await their write/callable and only update local state + show the success toast in the `.then()`; failures show a dedicated error toast (`errBlock`/`errUnblock`/`errMute`/`errUnmute`, new keys × 7 languages) instead of a false "success.")*
  `doBlock` (7843), `unblockUser` (7852), `muteUser` (7811), `unmuteUser` (7817) each swallow
  errors (`.catch(function(){})` or console-only) then unconditionally show a success toast and
  update local state. A user blocking a harasser on a bad connection sees "🚫 Blocked" even if the
  server-side write never landed — no retry, no error, no way to know moderation silently failed.

- [x] **M9 — Several unbounded full-collection reads in Cloud Functions will degrade at scale.** *(partially fixed: added auth checks + abuse-score rate limiting to `searchUsers`/`searchVideos`/`searchHashtags`, closing the unauthenticated-abuse vector. Discovered while fixing this that none of these three are actually called by the live client at all — the real search UI does its own bounded, client-side `limitToLast(200)` query instead — so the "degrades at scale" risk for these three specifically is more theoretical than live. **Not fixed, flagged for a product/engineering call**: `calculateCreatorAnalytics`, `calculateTrending`, and `adminGetDashboard` are genuinely live (scheduled jobs + admin-triggered) and still do unbounded full-collection reads that will degrade as the user/post base grows. A real fix means either rewriting to prefix-range queries (`orderByChild().startAt()/endAt()` — RTDB doesn't support arbitrary substring search, so this would also narrow search UX to prefix-only, a product tradeoff) or investing in a dedicated search/analytics service — too large a scope change to guess at silently.)*
  `calculateCreatorAnalytics` (1961-2039, every 6h, O(users × posts) serial reads),
  `calculateTrending` (2122-2170) and `adminGetDashboard` (2947-2984, on-demand from the admin
  panel) both do full `.once('value')` reads of entire top-level collections and process in JS
  memory. `searchUsers`/`searchVideos`/`searchHashtags` (2208-2305) additionally have **no
  `context.auth` check at all** and do full-collection substring scans — any unauthenticated
  caller can repeatedly trigger expensive scans (read-cost/DoS exposure).

- [x] **M10 — Room bans enforced for chat but not for cross-posting videos into the room.** *(fixed: `createFeedPost`'s room cross-post path now checks `rooms/{roomCode}/banned/{uid}` before pushing into the room, same as `sendRoomChat`. The main feed post itself still succeeds either way — only the room cross-post is skipped for a banned user.)*
  `createFeedPost`'s room cross-post path (2741-2752) never checks
  `rooms/{roomCode}/banned/{uid}`, unlike `sendRoomChat` (2776-2782), which does. A user banned
  from a room can still post videos into it.

- [x] **M11 — `roomCode` path-injection into RTDB via the Admin SDK.** *(fixed: added an `isValidRoomCode()` helper (alphanumeric only, 1-20 chars — matches everything `_roomGenCode()` actually generates while blocking `/`, `.`, `#`, `$`, `[`, `]`) and applied it in `createFeedPost` (invalid code just skips the room feature rather than failing the whole upload), `sendRoomChat`, and `setRoomMission` (both reject with `invalid-argument`).)*
  `functions/index.js:2703,2743,2763-2788,2804-2824`. `roomCode` comes straight from client input
  (`String(data.roomCode||'').trim()`) with no character allow-list, interpolated directly into
  `rooms/${roomCode}/...` paths via the Admin SDK — which bypasses all RTDB security-rule
  validation. A `/` in `roomCode` can redirect a write/read to an unintended nested location.

- [x] **M12 — `changeUsername` doesn't update the `usernames/{uid}` index.** *(fixed: now updates the reverse index (`usernames/{uid}` -> name, used by `processMentionsInComment`), claims the new name in the forward registry via a transaction (first-writer-wins, consistent with `doRegister`), and releases the old forward reservation so it's not permanently squatted.)*
  `functions/index.js:2902-2931`. Updates `users/{uid}/username` and
  `leaderboard/{uid}/username` but never touches `usernames/{uid}`, which
  `processMentionsInComment` (1852-1855) and the registration duplicate-check rely on. After a
  rename, @mentions of the new name never resolve, and the old name stays reserved forever.

- [x] **M13 — `updatePostMedia` missing input validation present elsewhere.** *(fixed: now whitelists `mediaType` to `'image'|'video'` and caps `mediaUrl`/`postId` length, matching `createFeedPost`'s existing validation.)*
  `functions/index.js:1637-1660`. Writes `mediaUrl`/`mediaType` straight from client input with
  no type whitelist or length cap, unlike `createFeedPost` (whitelists `mediaType`, caps
  `mediaURL` to 600 chars).

- [x] **M14 — Back-arrow glyphs hardcoded, don't mirror in RTL.** *(fixed: both the auth-screen back arrow and the follow-sheet chevron now use the app's existing `.chevron` class, which already had the `[dir="rtl"] .chevron{transform:scaleX(-1)}` mirror rule — they just weren't wearing the class.)*
  Auth screen `index.html:1433` (`←` before "Back," not covered by any `[dir="rtl"]` rule) and
  follow-sheet chevron `index.html:8401` (`›` with no `chevron`/`ann-card-arrow` class, so it's
  excluded from the app's own RTL-mirroring CSS). Both always point the LTR direction regardless
  of language.

- [x] **M15 — Hardcoded English aria-labels throughout; ~88 interactive divs with no role/tabindex.** *(fixed: added a `[data-i-aria]` mechanism to `applyTranslations()` (mirrors the existing `[data-i]` textContent loop, but sets `aria-label`) and applied it to all 30 static aria-label sites in the file (14 new translation keys × 7 languages, rest reused existing keys). Added `role="button" tabindex="0"` to the specifically-named groups — bottom nav (4), settings rows (12), language picker options — plus a delegated `keydown` listener so Enter/Space actually activates any `[role="button"]` div (role+tabindex alone doesn't make a div keyboard-operable, only labeled/focusable). Verified via Playwright: aria-label translates with language, and Enter-key on a nav item genuinely triggers navigation. Didn't hunt down literally all ~88 individual divs file-wide — covered the specifically-flagged high-traffic groups plus the aria-label translations, which was the bulk of the real impact.)*
  E.g. `index.html:1493` ("Notifications"), `1621` ("Edit"), `1706` ("Search"),
  `1727`/`1748`/`1794`/`1869` ("Close"/"Close chat"/"Back"), `1760`, `9512`, `9533`/`9534` — none
  pass through `t()`, so screen readers announce controls in English regardless of language.
  Separately, the primary bottom nav (`1859-1863`), all settings rows (`1799-1848`), and the
  language-picker options (`2384`) are `<div onclick>` with no `role`/`tabindex` — core navigation
  isn't reachable via keyboard/switch access (~88 such elements file-wide).

- [x] **M16 — Hardcoded "Player" fallback display name never translated.** *(fixed: added `playerFallback` key × 7 languages and replaced all 25 occurrences of the literal `'Player'` fallback with `t('playerFallback')`.)*
  ~20 occurrences, e.g. `index.html:2250`, `4238`, `6059`, `6610-6649` (leaderboard),
  `7226-7255` (notifications), `7706-7916` (search/chat/mute/block lists). User-visible text
  (`@Player`, "muted @Player") stays English even in a fully Hebrew session.

- [x] **M17 — `--faint:#66666E` text color is below WCAG AA contrast on dark backgrounds.** *(fixed: bumped to `#8C8C94`, which clears 4.5:1 against all three background shades (4.92:1 against the worst case, `--bg3`) while staying visibly dimmer than `--muted`. Single CSS variable, only 12 usages file-wide, so a global bump was low-risk rather than needing per-site changes.)*
  ~2.9–3.4:1 against `--bg`/`--bg2`/`--bg3`, below the 4.5:1 normal-text minimum. Applied to
  primary, non-decorative text: bottom-nav inactive icon/label (`975`), leaderboard rank numbers
  (`746`), inactive tab labels (`740`), achievement tile numbers (`601`).

- [x] **M18 — Mid-session language switch doesn't re-render already-built screens.** *(fixed: `applyTranslations()` now refreshes comments/notifications/chat list/chat window/rewards/drafts in place if they're open when the language changes. Deliberately did NOT force a full feed-slot re-render (post captions/timestamps) — feed captions are user content and never translated anyway, and forcibly busting `feedSlotCache` on every language switch would restart any mid-playback video, a worse regression than the minor "relative timestamp shows stale-language text until you scroll away and back" issue it would fix.)*
  `applyTranslations()` (`2349-2376`) only updates `[data-i]` elements plus a short hardcoded
  list, then re-renders achievements/leaderboard. Since every screen persists simultaneously in
  the DOM (`go()` just toggles a CSS class, `feedSlotCache` explicitly caches built post DOM),
  feed captions/timestamps, comments, notifications, chat list, rewards, and drafts rendered
  before a language switch keep showing the old language until their own render function happens
  to fire again.

---

## 🟢 Low

- [x] **L1 — Weak client-side email validation.** *(fixed: added a shared `isValidEmail()` helper (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` — deliberately not strict RFC-5322, since Firebase Auth is the real validator) and replaced all 4 `.includes('@')` call sites with it.)* `index.html:2823,2846` only checks
  `email.includes('@')`; malformed input is caught late by Firebase and surfaced via a raw,
  untranslated `e.message` (line 2921).

- [x] **L2 — Email verification sent but never enforced/checked; nag UI is dead code.** *(investigated, no code change: `index.html:2509-2510` has an explicit comment confirming this is deliberate — "Email-verification nag removed — the verification email is still sent at sign-up; enforcement can be added when on Blaze." This is a known, intentional state tied to the current Firebase billing plan, not an oversight — leaving as-is rather than silently re-enabling enforcement that was consciously turned off.)*
  `index.html:2503,2876,2489-2490`. `sendEmailVerification()` fires at signup, `emailVerified` is
  never read anywhere, and `showEmailVerificationPrompt()` is defined but never called.

- [x] **L3 — No real age verification, only an optional self-reported profile field.** *(fixed, per explicit direction to implement the standard mandatory-birthdate approach and flag only the genuinely disputed judgment call rather than guess on it — see below: added a required "Date of birth" field to the sign-up form. Age is computed client-side (calendar-accurate, not just a year subtraction) and checked before any network call — an under-13 birthdate blocks registration entirely with an inline error, and since the check happens before `createUserWithEmailAndPassword` is ever called, no account is created and no birthdate is ever transmitted for a rejected attempt. The birthdate is stored as a millis timestamp (not the raw date string) so the DB rule can also enforce the 13+ requirement server-side, as a numeric comparison against `now` — defense in depth against a client that skips the form and calls the Auth/DB SDKs directly (verified live: a direct bypass attempt with a fabricated under-13 birthdate was rejected with `PERMISSION_DENIED`). The field is locked immutable by the `users/$uid` rule once set, same as `email`/`createdAt` (verified: a later attempt to change it was also rejected).

  **Found and fixed in the course of verifying this**: adding `birthdate` to that same immutability invariant surfaced a pre-existing, unrelated data-integrity bug that predates this fix — `onAuthStateChanged` fires (and starts loading user data) as soon as `createUserWithEmailAndPassword` resolves, well before `doRegister()`'s own username-claim + `users/{uid}.set()` steps finish, so `applyLoadedData()`'s `!data` fallback (and `finishLoad()`'s own early writes, e.g. `lastActive`) could race ahead and create a partial record first. Once that happened, `doRegister()`'s own later, complete write included `email`/`createdAt` (and now `birthdate`) for the first time, but the rule's invariant can't distinguish "setting an immutable field for the first time" from "changing it away from an existing value" — both trip the same equality check, so the whole write was silently rejected and those fields were never actually persisted. This means real registrations may have been losing `email`/`createdAt` this way already, unnoticed, since the visible UX (success toast, landing in the app) looks identical either way. Fixed with a `_registering` guard flag: `setupAuthListener()` now defers calling `loadUserData()` until `doRegister()`'s own write has landed, instead of racing ahead of it.

  **Left alone, flagged rather than guessed**: Google sign-up doesn't collect a birthdate at all (`_handleGoogleSignIn()` just calls the `ensureUser` callable) — it doesn't go through this new form, so age verification currently only applies to email/password sign-up. Closing that gap would need a post-OAuth interstitial screen, a real design decision, not something to add silently. Also not addressed here, as previously flagged: what a mandatory birthdate field implies for COPPA/GDPR-K (data-minimization, retention, parental-consent obligations) beyond the reject-with-no-data-transmitted approach implemented — that's still a legal/compliance call, not a code one.)*
  `index.html` sign-up form (`#auth-reg`), `doRegister()`, `ageFromBirthdate()`, `applyLoadedData()`,
  `setupAuthListener()`; `FIREBASE_RULES_PRODUCTION.json` `users/$uid/birthdate`.
  Verified live on both desktop browser and the real device: under-13 rejected with no account
  created; a valid signup persists a complete record (username/email/birthdate/agreedToTerms/
  consentAt/createdAt all present, matching values); direct-bypass and post-creation-change
  attempts both rejected server-side. Test accounts and their `users`/`leaderboard`/`usernames`
  data cleaned up via admin CLI afterward; a small number of orphaned Firebase Auth records from
  this testing are still pending deletion (no associated data, low priority).

- [x] **L4 — No feedback loop to the reporter about the outcome of their report.** *(fixed: `adminUpdateReport` now sends the reporter a notification when their report is marked reviewed/actioned, via the existing `writeNotification` helper. New `report_resolved` notification type + `notifReportResolved` key × 7 languages.)*
  `index.html:7107-7108`. Only a generic submission-time toast; `reports/$reportId/status`
  exists server-side but is never surfaced back to the reporter.

- [x] **L5 — Hardcoded English empty-state strings in the followers/following sheet.** *(fixed: added `noFollowersYet`/`noFollowingYet` keys × 7 languages, replacing the raw literals.)*
  `index.html:8391` — `'No followers yet'` / `'Not following anyone yet'` are raw literals, not
  run through `t()`, unlike every other empty state in the file.

- [x] **L6 — `validateUsername` exported callable has no auth check and is dead code.** *(fixed: added the standard `unauthenticated` guard, matching the pattern used for the other dead-but-live search functions in M9. Left the function itself in place — a comment right above `registerUser` explicitly marks both it and `validateUsername` as "safe to remove," but actually removing dead code wasn't the ask here.)*
  `functions/index.js:268-340`/`390-396`. Never invoked by the live client, but still does a full
  unbounded read of the `usernames` node plus an `orderByValue` query on every call — free
  read-cost amplification surface for anyone who calls it directly.

- [x] **L7 — Abuse-score/rate-limiting state is in-process memory, not shared across instances.** *(fixed, per explicit direction to implement now: moved `abuseScores`/`ipSignups` from in-process Maps to RTDB, at a new server-only `rateLimits/` path (no client read/write is granted there, so it's covered by the root rule's default deny). RTDB was chosen over Firestore/Redis/Memorystore since it's already this project's datastore -- no new service to provision, no new dependency, no cost/latency profile change beyond what every other read/write in this file already has. `addAbuseScore` uses `.transaction()` specifically so two concurrent invocations for the same uid landing on different instances can't produce a lost update (same reasoning as the already-atomic view/watch-time counters) -- a plain read-then-write would have only partially fixed the problem this item exists to close. All 22 call sites across `likePost`, `submitComment`, `followUser`, `rateVideoImpl`, `createFeedPost`, `completeMission`, `watchAd`, the three search functions, and `registerUser` converted to the new `async`/`await` shape. `checkIPSignups` (a second function reading the old `ipSignups` Map) turned out to have zero callers -- removed rather than migrated, since leaving it would've meant a dangling reference to a Map that no longer exists.)*
  `functions/index.js` (`sanitizeIPKey`, `trackIPSignup`, `addAbuseScore`, `checkAbuseScore`) plus
  every call site listed above.
  **Verified live** (not just code review): confirmed `rateLimits/abuseScores/{uid}` is populated
  correctly after a real `likePost` call, from both the desktop browser and the real device.
  Directly wrote a score of 150 into that path via admin CLI (simulating what a *different*
  instance would have accumulated) and confirmed a subsequent `likePost` call from a live session
  was correctly blocked with "Too many likes" -- the actual cross-instance scenario this item
  exists to fix. Also verified the 1-hour expiry/reset path: an old (>1hr), high-score record was
  correctly treated as expired and reset rather than blocking. Confirmed the client genuinely
  cannot read `rateLimits/` directly (a stray debug read from the browser console returned
  `permission_denied`, as intended). Test accounts and rate-limit test data cleaned up via admin
  CLI afterward.

- [x] **L8 — Date/time formatting mostly ignores the selected language.** *(fixed: the two identified spots — chat-list last-message time and draft creation date — now pass `LOCALE_MAP[curLang]||'en-US'` instead of the browser/OS default. Left the many bare `.toLocaleNumber()`-style calls for point/count formatting alone — those are number formatting, not date/time, and out of this item's actual scope.)*
  `LOCALE_MAP` (`index.html:2065`) is defined but only actually used once
  (`index.html:6566`). Other spots (`7896`, `8925`) use the OS default locale instead — a
  Hebrew-selected user on an English-locale device sees English-formatted dates/times.

- [~] **L9 — Some UI regions pinned to a fixed physical side regardless of RTL.** *(flagged, not fixed — the room-chat panel and feed action column (like/comment/share) both explicitly stay on the same physical side regardless of language, which reads as deliberate (the feed actions column even has `direction:ltr` explicitly set). This matches a common short-video-app convention (TikTok/Reels keep the action rail on the same side too), so "fixing" it without confirmation risks breaking an intentional design choice. Left as-is pending an explicit call either way.)*
  `index.html:840` (`.room-chat-screen{right:10px}`) and `index.html:1140`
  (`.feed-actions{left:12px;direction:ltr}`) never mirror. May be an intentional design choice
  (common video-app convention) — worth an explicit confirm either way rather than assuming.

- [x] **L10 — Small touch targets on some dismiss/delete controls.** *(fixed: bumped padding on `.recent-x`/`.reply-cancel`/`.draft-del` to 10px, meaningfully closer to the ~44px guideline without risking the layout shifts a strict `min-width/height:44px` could cause in their tight list-row contexts — a judgment call given no live browser to visually verify the alternative.)*
  `index.html:1350` (`.reply-cancel{padding:2px 6px}`), `439` (`.recent-x{padding:6px}`), `1364`
  (`.draft-del{padding:6px}`) — effective tap area under the ~44×44px guideline.

- [x] **L11 — Several `<img>` tags with no `alt` attribute at all.** *(fixed: added `alt=""` to all 8 missing spots found (the original 7 plus one more introduced by this session's own B3/B4 admin-panel work) — empty alt since all are thumbnails/decorative previews where the surrounding context already conveys meaning.)*
  `index.html:3429, 3686, 4097, 7788, 8923, 9140, 9698`.

- [x] **L12 — A few leftover untranslated static strings.** *(fixed: room-join-code input placeholder now uses `data-i="roomCodePlaceholder"` (the existing `[data-i]` mechanism already handles INPUT placeholders); the resize handle's `title` is set directly by ID in `applyTranslations()` since a bare `<div title="">` isn't covered by either existing mechanism. 2 new keys × 7 languages.)*
  `title="Resize"` on the room-chat resize handle (`index.html:1756`); `placeholder="CODE"` on
  the room-join-code input has no `data-i` (`index.html:1587`).

---

## Notes

- Scope explicitly excludes premium features and payments (deferred separately, tracked
  elsewhere).
- Findings come from 5 parallel research passes: Auth & Onboarding, Social Safety & Moderation,
  Cross-cutting UX (loading/empty/error/offline), Cloud Functions & DB rules backend, and
  i18n/RTL/Accessibility.
- Working order: Blockers first (B1-B8), then High, then Medium, then Low as time allows. This
  file's checkboxes are the running source of truth for what's actually been fixed and verified
  vs. just found.

---

## Post-launch-audit bug reports

- [x] **Feed scroll stall (~0.5s freeze after a few swipes).** Reported after the B/H/M/L pass
  above was already complete. Root-caused via real tracing (not assumption): `feedSlide()`'s
  completion callback and `feedMountFollowing()`/`feedMountPosts()` all call
  `feedPreloadAhead(feedPeekAhead())` *synchronously*, right at the exact moment `feedAnimating`
  goes back to `false` and the next swipe becomes possible. That call builds full DOM (including
  a `<video>` element + `.load()`) for up to `FEED_PRELOAD_DEPTH` (3) posts on the main thread.
  Confirmed on the real connected device via `adb shell dumpsys gfxinfo <pkg> reset` +
  scripted swipes + `framestats`: before the fix, 99th-percentile frame time was **150ms** (8
  frames in the 150-250ms bucket across 6 swipes), Janky frames **9.64%**, High input latency
  **1191** frames, Slow UI thread **32** frames — landing exactly when input should be
  responsive, reading as a stall. Fixed by deferring all 3 `feedPreloadAhead(...)` call sites by
  one `requestAnimationFrame`, letting the browser paint the just-completed swipe before doing
  the background preload work. Re-measured on-device after deploying: 99th percentile **23-24ms**
  (zero frames in the 150ms+ bucket), Janky frames **4.9-6.1%**, High input latency 476-574,
  Slow UI thread 10-11 — confirmed twice. Deployed (hosting only, no functions/rules changes) and
  verified byte-for-byte live.

- [x] **Mission proof-upload silently fails to attach media (false success toast).** Found during
  the post-launch full verification pass via genuine live interaction (console warnings), not code
  review. `uploadMissionFile()`'s video branch (Bunny.net) and image branch (Firebase Storage) both
  wrote directly to `feed/{postId}` via `.update()` after uploading proof media for a completed
  mission. The `feed/$postId` DB rule only permits a full self-delete by the owner, so every such
  write was rejected with `permission_denied` (confirmed live: 6 warnings across different post
  IDs) — the code swallowed the failure and still showed `postedToFeed` success, so users believed
  their proof attached when it silently never did. Fixed by routing both branches through the
  existing `updatePostMedia` callable (already hardened for M13) instead of a direct client write;
  extended `updatePostMedia` to accept an optional `bunnyGuid` so the video branch doesn't lose that
  field. Since `updatePostMedia` sets `approved:false` on any media it attaches (consistent with
  B3's moderation gate for fresh uploads), mission-proof media now also goes through admin review
  before appearing in the feed, which is the correct/consistent behavior. Deployed
  (hosting + `functions:updatePostMedia`) and verified: live HTML byte-for-byte identical to local,
  both call sites confirmed present, `firebase functions:list` confirms `updatePostMedia` updated.

- [x] **B7's hardware back-button fix silently stopped working (regression, real device only).**
  Found during the post-launch full mobile verification pass via genuine on-device interaction, not
  code review. `MainActivity.onBackPressed()` (the B7 fix) was never being invoked on this device:
  logcat showed the back key dispatching through `Activity.onBackInvoked()` — the modern
  Predictive Back API (Android 13+/targetSdk 34+) — straight to a synthetic default lambda,
  bypassing the overridden `onBackPressed()` entirely. Reproduced live: opened the feed's native
  share sheet (`#share-modal`), pressed the hardware back button once, and the app fully backgrounded
  (`moveTaskToBack`) revealing the phone's Settings app underneath — instead of just closing the
  open sheet. `onBackPressed()` overrides are a legacy API that predictive-back-enabled devices can
  route around entirely. Fixed by registering a real `OnBackPressedCallback` via
  `getOnBackPressedDispatcher().addCallback(...)` in `onCreate()` instead of overriding
  `onBackPressed()` — this is the path the dispatcher actually invokes on both legacy and
  predictive-back devices. Rebuilt the debug APK, installed on the connected device, and
  re-verified the exact repro: share sheet open → back → sheet closes, feed reappears (no exit).
  A second back press (nothing open, not on the Missions "home" screen) correctly navigated to
  Missions first rather than exiting, matching `_handleAndroidBack()`'s intended "go home before
  exit" behavior — confirming the callback now fires reliably on every press.

- [x] **Rooms feature: end-to-end investigation (user reported it "doesn't feel like it's working
  perfectly," no specifics given).** Tested live on the real device (host, real UI) and browser
  (guest, real UI + direct DB/callable checks via a secondary Firebase app instance for genuine
  concurrent two-account testing) — create room, join via code, real-time chat both directions,
  member-count sync, M10 room-ban enforcement, kick, host handoff on leave, and empty-room
  auto-deletion. All of these worked correctly, including M10 specifically: banned a guest
  mid-session, confirmed the live "banned" listener fired in real time, confirmed their room chat
  was rejected server-side (`permission-denied`), and confirmed a subsequent `createFeedPost` with
  that `roomCode` still created the main feed post but was silently skipped from the room's post
  stream (`roomPostsCount` stayed 0) — exactly as designed. One real bug found and fixed:
  `roomDeleteVideo()` (the host/mod "remove this attempt" action) used the native browser
  `confirm()` dialog instead of the app's themed `showConfirm()` used by every other confirmation
  in the app, including the room-kick flow one call away in the same file — an unstyled system
  popup breaking the illusion of a native-feeling app mid-session, and a plausible source of the
  "doesn't feel right" impression. Fixed to match the `roomUserKick()` pattern exactly. Deployed
  (hosting only) and verified byte-for-byte live. Note: `deleteMyVideo()` (profile's own-video
  delete, outside Rooms) has the identical native-`confirm()` issue — left alone as out of scope
  for this investigation, flagged for a follow-up pass.

- [x] **Room chat panel overlapped the bottom action bar on real devices ("half the screen
  becomes unreadable" when chat is open).** Follow-up report on the same Rooms investigation.
  Reproduced live on the real device: opening the in-room chat box, its bottom edge (message
  input) visibly overlapped the "Chat"/"Upload" bottom action bar. Root cause found by comparing
  `getBoundingClientRect()` measurements in a mobile-viewport browser session against the same
  measurements implied by the real device: `.room-chat-screen` was positioned with a hardcoded
  `bottom:86px`, while `.room-bottom-bar` (the bar it needs to clear) sizes itself with
  `padding-bottom:calc(12px + env(safe-area-inset-bottom, 0px))`. On any device with a non-zero
  safe-area inset (this app renders edge-to-edge, so any gesture-nav or 3-button-nav Android
  device), the bottom bar grows taller by that inset but the chat box's fixed offset doesn't grow
  with it, so the two collide. (The box's own drag/resize-clamp logic already read the bottom
  bar's live `getBoundingClientRect()` and was unaffected — only the initial, undragged position
  was wrong, which is what everyone hits by default.) Fixed by changing the chat box's `bottom` to
  `calc(86px + env(safe-area-inset-bottom, 0px))`, mirroring the bottom bar's own inset handling.
  Deployed (hosting only) and re-verified with the exact original repro on the real device: opened
  the same room, opened chat — the input now sits with a clear gap above the action bar, no
  overlap, both with and without the on-screen keyboard active.

- [x] **Room chat message only appears to "send" after a ~2 second delay.** Third follow-up report
  on the same Rooms investigation. Measured with real timing (not code review): sent 5 messages in
  a row via the real `sendRoomChat` callable and timestamped both promise-resolution and the
  moment the message actually appeared in the live-synced array. First message (cold Cloud
  Function): **3830ms**. Next four (warm): **421–635ms** — and in every case the message became
  visible at the *exact same millisecond* the network call resolved, because `roomChatSend()` had
  no optimistic rendering: it cleared the input immediately but the message itself didn't render
  until the full round trip (callable invocation + server validation + DB write + realtime
  listener echo) finished. On a cold function — which is the common case for a lightly-used
  callable — that's the full ~4s with nothing on screen. Not a debounce/throttle or an unnecessary
  await; the server function itself (`exports.sendRoomChat`) was already lean (a parallelized
  `Promise.all` for its two required reads, one write, no redundant round trips) — the delay was
  entirely the client waiting on the network before showing anything. Fixed by making
  `roomChatSend()` push a temporary local message into `_roomChatArr` and re-render immediately on
  send (matching the optimistic-then-reconciled pattern `feedRateVideo()` already uses for star
  ratings elsewhere in the app), removing it again only if the server call fails. Re-measured after
  deploying: the message now appears in the DOM in **3ms** regardless of round-trip time, while the
  real server confirmation (1608ms in the re-test) completes transparently in the background.
  Deployed (hosting only) and verified byte-for-byte live.

- [x] **Fullscreen "already liked" video viewer could be nudged sideways (should be vertical-only).**
  Not a Rooms bug — separate report. "Opening a video you've already liked" is the profile's Liked
  grid → `openLikedPost()` → `openMediaViewer()`, the fullscreen `#mv-viewer`/`#mv-scroll` overlay
  (native scroll-snap, unlike the main feed which drives its own swipe via JS transforms and was
  never at risk). Root cause confirmed via `getComputedStyle`, not guessed: `.mv-scroll` set only
  `overflow-y:auto` — per the CSS overflow spec, leaving `overflow-x` at its default `visible`
  while `overflow-y` is non-visible makes the browser compute `overflow-x` to `auto` too, so the
  container was silently horizontally scrollable, and with `touch-action` left at its default
  `auto`, native horizontal panning/rubber-banding was fully live on a fullscreen video (the "slight
  sideways nudge/bounce" the user felt, since there's no real horizontal content to reveal). The
  app already has this exact pattern right (`.page`/`.screen` explicitly pair `overflow-x:hidden`
  with `overflow-y:auto`) — `.mv-scroll` was the one place it got missed. Fixed by adding
  `overflow-x:hidden;touch-action:pan-y` to `.mv-scroll`, matching the app's own established
  pattern. Verified live post-deploy: computed style now reads `overflowX:"hidden"`,
  `touchAction:"pan-y"`, and forcing `scrollLeft=500` programmatically on the container was
  ignored outright (stayed at 0) — hard-clamped, not just visually discouraged. Deployed (hosting
  only) and verified byte-for-byte live.

- [x] **New feature: TikTok-style guest browsing.** Users now land on the sign-up screen once,
  can dismiss it with an X to browse the feed without an account, and only get sent back to
  sign-up at the moment they try an action that needs a real account (like, follow, rate, comment,
  post, room create/join/post/chat, watch ad, avatar upload) — same pattern as TikTok. Built on
  Firebase Anonymous Auth (`continueAsGuest()` → `signInAnonymously()`) rather than opening
  `/feed` reads to the public, specifically so every existing `auth != null` DB rule and
  `context.auth.uid` check in the ~50 existing Cloud Functions kept working completely unchanged —
  guests get a real (if throwaway) `auth.uid`, so read access, view/analytics tracking, and abuse
  rate-limiting all continue to function exactly as before with zero server-side redesign.
  Implementation, in the order actually built (server hardening first, deliberately, since a
  client-side redirect alone is UX, not security):
  - **Server-side enforcement (the part that actually matters for security).** Audited all ~15
    gated actions to find which are Cloud Functions callables vs. raw client `db.ref().set()`
    calls. 9 callables (`likePost`, `unlikePost`, `likeComment`, `unlikeComment`, `rateVideo`,
    `submitComment`, `createFeedPost`, `sendRoomChat`, `watchAd`) got a shared
    `isAnonymousCaller(context)` guard added and now throw `unauthenticated` for an anonymous
    caller server-side, regardless of what the client UI does. The other 4 actions turned out to
    be **raw client writes with no callable at all** — `followUser()` (`follows`/`followers`),
    `roomCreate()`/`roomJoin()` (`rooms/$code/meta`, `.../members`), and `_doAvatarUpload()`
    (`users/$uid/avatarURL`+`avatarColor`, plus the Storage `avatars/` path) — these needed the
    anonymous check added directly to `FIREBASE_RULES_PRODUCTION.json` / `STORAGE_RULES_PRODUCTION.txt`
    instead.
  - **A real leak caught by ground-truth testing, not by inspection.** Signed in anonymously live
    against production and tried each hardened path directly via the console (not through the UI)
    to confirm actual rejection, not just that the UI *looks* gated. `likePost`/`submitComment`
    correctly threw, `follows`/room-create/room-join correctly hit `PERMISSION_DENIED` — but
    `users/{uid}/avatarURL` **succeeded** despite its own rule carrying the anonymous check. Root
    cause: Firebase RTDB evaluates `.write` at every ancestor of the written path, and the
    `users/$uid` parent rule (a large "certain fields must stay unchanged" invariant check) didn't
    have the anonymous check — since a less-restrictive ancestor rule already granted the write,
    the child-level restriction on `avatarURL` itself was moot. Added the same check to the
    `users/$uid` rule; re-tested live, now correctly rejected. Same reasoning caught a second,
    not-yet-exploited instance before it shipped: `saveUserData()` (called automatically as part of
    normal app boot, not user-initiated) would have silently written a throwaway guest entry into
    the public `leaderboard/{uid}` node every session, since that rule also had no anonymous check.
    Rather than patch every downstream rule one at a time, added `if(isGuestUser) return;` to the
    top of `saveUserData()` itself — guests have no pts/streak/missions to persist in the first
    place, so this is also the more correct fix, not just the more convenient one.
  - **Client-side UX.** New `isGuestUser` flag (set from `user.isAnonymous` in the auth listener),
    a `.auth-skip` X button on `p-auth` wired to `continueAsGuest()`, and a shared
    `requireRealAccount(msgKey)` helper that the same 16 call sites across the ~12 gated actions
    now use instead of a bare `if(!userUID)` toast — real accounts pass through unchanged, guests
    get routed to the sign-up screen (Sign Up tab), and a genuinely fully-logged-out state (should
    no longer really happen once guests always get an anonymous session, kept only as a defensive
    fallback) keeps the old toast since there's nowhere to send them mid-action. `continueAsGuest()`
    itself branches on whether it's the *first* dismissal (calls `signInAnonymously()`, letting
    `onAuthStateChanged` route to the feed) or a *gate-triggered* revisit while already a guest
    (just calls `showPage('p-app')` directly, since there's no new auth-state transition for the
    listener to react to and re-issuing `signInAnonymously()` would be a silent no-op).
  - **GDPR/onboarding/safety modals.** Turned out to need no relocation at all: `finishLoad()` —
    the function that calls `showGDPRNotice()`/`maybeShowOnboarding()`/`maybeShowSafety()` — already
    runs identically for any signed-in Firebase Auth user, real or anonymous, since `loadUserData()`
    already treats "no `/users/{uid}` record" as a normal "brand new user" case. Confirmed live: a
    fresh guest session shows the GDPR banner, then onboarding, then the safety modal, in the same
    order a real new signup gets.
  - **Verified end-to-end live against production** (not a staging/mocked environment): fresh
    sign-out → language picker → sign-up screen → X → `signInAnonymously()` → `isGuestUser` flips
    true → feed loads (3 real posts) → GDPR banner → onboarding → safety modal, all firing
    correctly; a gated action (`feedLikePost`, `roomCreate`) from that guest session correctly
    routes to the sign-up screen instead of the old toast; the X from *there* returns to the same
    feed session without a wasted re-auth call; and directly confirmed no `leaderboard/{uid}` or
    `users/{uid}` record exists for the guest session afterward.
  - **Re-confirmed live on the real device** with the user's explicit go-ahead to temporarily sign
    out their real account for the test (logged back in themselves afterward — no password was
    seen or handled by Claude at any point, only the app's own native "Continue with Google" /
    email-login screen was left ready for them). Real touch taps, not scripted: language picker →
    sign-up screen → X → guest session lands in `p-app` → tapped the like button on a real feed
    post → correctly routed to the sign-up screen (not a toast) → X returned to the exact same
    feed, like count unchanged. Same result as the browser pass, this time via genuine taps.
  - **Two more findings surfaced by the on-device walk, both fixed in the same pass:**
    1. The language-picker's "Continue" button (`.lang-btn`, `position:fixed;bottom:0`) had the
       identical missing-`env(safe-area-inset-bottom)` bug already fixed once this session for the
       room chat panel — on this device it rendered far enough under the system navigation bar
       that it was completely untappable by normal means (confirmed by repeated real taps landing
       on the OS's own back/home buttons instead of the app). Fixed with the same
       `calc(18px + env(safe-area-inset-bottom, 0px))` pattern already proven working on this exact
       device for `.room-chat-screen` and the GDPR banner. Deployed and confirmed the app no longer
       gets stuck at first boot on this device/nav-mode combination.
    2. Guest sessions can still reach account-management settings rows (Change username/password/
       email) that make no sense without a real account — not a security hole (the underlying
       actions aren't in the original 15-action list and would need their own audit), but a rough
       edge worth a follow-up pass since it wasn't in the original scope of this feature.
  - **Also fixed in the same pass** (separate user report, folded in since it touches the same
    `finishLoad()`/consent-modal code): the GDPR banner's "Decline" button previously only showed a
    toast — it never dismissed the banner or persisted any choice, so it would silently re-prompt
    on every single app open for anyone who declined. Now Decline also removes the banner and sets
    a `gdpr-declined-v1` flag (kept distinct from `gdpr-accepted-v1` rather than conflating the two
    choices), so a declined choice is respected going forward same as an accepted one. Audited the
    other three "shown once" flows (onboarding, safety modal, the native push-notification prompt)
    and found them already correctly persisting — this was the only broken one.

  Deployed: hosting (client changes), 9 Cloud Functions (`likePost`, `unlikePost`, `likeComment`,
  `unlikeComment`, `rateVideo`, `submitComment`, `createFeedPost`, `sendRoomChat`, `watchAd`),
  `FIREBASE_RULES_PRODUCTION.json`, `STORAGE_RULES_PRODUCTION.txt`. All verified live: functions
  confirmed present via `firebase functions:list`, RTDB rules confirmed byte-for-byte identical to
  local via `firebase database:get`, hosting confirmed byte-for-byte identical via direct fetch.

- **Top-3 rooms quick-join list (Missions tab, below Challenge Rooms).** New `getTopRooms` callable
  reads `rooms/`, filters to `memberCount > 0`, sorts by member count descending, returns the top 3
  (code, mission, hostName, memberCount) — deliberately left open to anonymous callers (any signed-in
  `uid`, guest or real) since browsing the popular-rooms list is allowed for guests; only the actual
  join is gated. Client renders up to 3 rows into `#top-rooms-list`; tapping a row calls the newly
  extracted `roomJoinByCode(code)` (refactored out of the existing manual-code `roomJoin()`), which
  goes through the same `requireRealAccount()` gate as every other join path.
  - **Verified live against production**, desktop browser: created 3 controlled test rooms (1, 2, and
    3 members) via a primary test account plus two secondary Firebase app instances impersonating
    other members. The 3-member room correctly ranked first. The two remaining slots were filled by
    other genuinely-active 2-member rooms already in the live `rooms/` tree, not by the deliberately-
    built 2-member test room — confirming `getTopRooms` is correctly querying and sorting real live
    data (ties broken by whatever the DB naturally returns) rather than something scoped to a single
    tester's rooms. Clicking a rendered row navigated into the correct room (`ROOM ZS7BK`, 3 in the
    room). Signed into an anonymous session and clicked a row: correctly redirected to the sign-up
    screen instead of joining, same as every other gated action. All 3 test accounts and all 3 test
    rooms deleted afterward (member removal → confirmed the room's `members` node empties, then a
    direct node removal since the auto-delete-on-empty behavior lives in the client's `roomClose()`
    flow, not an RTDB-level trigger, so a raw member removal doesn't cascade-delete on its own).
  - **Re-confirmed on the real device.** The device's PWA service worker was still serving a cached
    bundle from before this feature's deploy (`loadTopRooms`/`roomJoinByCode` were undefined in the
    live page despite the device loading from the production URL) — cleared its cache and
    unregistered the stale worker via Chrome DevTools Protocol over `adb forward`, reloaded, and
    confirmed the current build was now active. With the device already in an anonymous guest session
    from earlier testing, a genuine physical tap (not scripted) on a top-room row correctly opened the
    "Create account" sign-up screen rather than joining — screenshotted for confirmation. This is a
    reminder that a Hosting deploy alone doesn't guarantee already-installed devices see it
    immediately; worth keeping in mind if a future fix needs to reach existing users fast.
  - **Found, not fixed — pre-existing data hygiene, flagged for a decision rather than acted on
    unilaterally:** the live `rooms/` tree currently has ~24 leftover room codes, almost all single-
    member rooms hosted by the real user's own account from earlier testing sessions across this
    engagement, never cleaned up because they were abandoned (app closed/backgrounded) rather than
    exited via `roomClose()`. They don't break anything — `getTopRooms` filtering to `memberCount > 0`
    means they can still surface in the top-3 list ahead of genuinely-empty rooms, which is correct
    behavior, but it means the "popular rooms" list can currently show old 1-2-member test rooms
    instead of only genuinely fresh activity. Left as-is since deleting more of the real account's
    room history wasn't part of this task's scope.

  Deployed: hosting (client top-rooms UI + `roomJoinByCode` refactor), `getTopRooms` Cloud Function.
  Verified live: function confirmed via `firebase functions:list`, hosting confirmed byte-for-byte
  identical via direct fetch, end-to-end join/redirect behavior confirmed on both desktop browser and
  real device against live production data.

- **Guest display name.** Anonymous guest sessions were showing the internal `Player_xxxxxxxx`
  uid-suffix fallback as their display name (e.g. in the Missions-tab greeting) — looks like a random
  leaked identifier rather than an intentional guest label. Added a `guestDisplayName` translation key
  ("Guest" / "אורח" / "Invitado" / "Гость" / "ضيف" / "Invité" / "Convidado") and had the provisional-name
  assignment in `setupAuthListener()` use it for anonymous sessions instead of falling through to the
  uid-suffix.
  - **Caught a self-introduced regression before it reached the user.** The literal string "Guest" was
    already used elsewhere as a sentinel meaning "not a real known name yet" — `myName()` and
    `applyLoadedData()`'s `knownName` both check `userName!=='Guest'`. Making the actual guest display
    value equal that exact sentinel caused `applyLoadedData()`'s `!data` branch (the branch every guest
    takes, since they have no `users/{uid}` record) to treat the name as "unknown" and fall through to
    `user.email.split('@')[0]` — which throws, since anonymous Firebase users have no email. The
    uncaught exception silently aborted the rest of `loadUserData()`'s promise chain, meaning
    `finishLoad()` — and with it `applyTranslations()`, `showGDPRNotice()`, `maybeShowOnboarding()`,
    `maybeShowSafety()` — never ran for any guest session. Found via a live console-error check during
    verification (`TypeError: Cannot read properties of null (reading 'split')`), not by inspection.
    Fixed by widening the `knownName` sentinel check to `(userName!=='Guest'||isGuestUser)` so a
    guest's already-correct name is recognized as "known" and the fallback chain is never reached.
    Re-verified live afterward with an error-capturing harness (zero new errors) and confirmed the
    GDPR banner still fires on a fresh guest boot.
  - **Verified live**, desktop browser: fresh anonymous sign-in → greeting reads "Hey Guest" (was
    "Hey Player_xxxxxxxx"), confirmed via both the `userName` value and the rendered `#greeting`
    text after the real async boot chain settles (not by calling internal functions out of order).
  - **Re-verified on the real device** with a genuine physical tap on the sign-up screen's X button
    (not scripted): greeting correctly reads "היי אורח" ("Hey Guest") in the device's Hebrew locale —
    screenshotted for confirmation.

  Deployed: hosting only (two commits — the initial fix, then the sentinel-collision fix caught during
  the same verification pass). Verified live: hosting confirmed byte-for-byte identical via direct
  fetch after each deploy, guest boot chain confirmed error-free and GDPR/onboarding/safety modals
  confirmed still firing, on both desktop browser and real device.

- **Sign-up sheet: overlay instead of full-page navigation.** The sign-up screen `requireRealAccount()`
  shows for a gated action used to be a full `showPage('p-auth')` navigation — the underlying screen
  (feed, room, whatever the guest was doing) was torn down and replaced, so dismissing it meant
  re-entering that screen from scratch rather than truly resuming it. Changed to a TikTok-style sheet:
  `showAuthOverlay()` adds a `.show` class to `#p-auth` that makes it `position:fixed` with a blurred
  backdrop over the CURRENT screen (never hidden, never re-navigated), while `.auth-inner` becomes a
  bottom-sheet card reusing the exact `.overlay`/`.modal` visual language already used by every other
  modal in the app (slide-up animation, rounded top corners, `max-height:88vh` scroll). `closeAuthOverlay()`
  reverses it. The **initial boot screen is untouched** — still a full-page `showPage('p-auth')`, per the
  explicit requirement that only the gated-action prompt becomes a sheet.
  - **Caught before shipping:** `#p-auth.show{display:flex}` was silently losing to a stale inline
    `style="display:none"` left over from an earlier `showPage()` call (inline styles beat class
    selectors regardless of specificity) — the overlay class was applied but nothing rendered. Fixed
    with `display:flex!important`; re-verified live afterward.
  - Also wired into the existing Android hardware-back-button dispatcher (`_handleAndroidBack()`) as
    the highest-priority entry, and hidden the boot-only "← Back to language picker" link while in
    sheet mode (`#p-auth.show .auth-back{display:none}`) since it doesn't apply mid-action.
  - **Verified live**, desktop browser: triggering a gate (`openModal(0)` as a guest) confirmed the
    underlying Missions screen stays `display:flex`/mounted throughout, the sheet sits at
    `z-index:10700` (above every other overlay in the app, matching the existing `#confirm-modal`
    pattern), and both the X button and a simulated `_handleAndroidBack()` call correctly close just
    the sheet and land back on the exact same screen. Confirmed real (non-guest) accounts are
    unaffected — `openModal()` still opens the mission modal directly.
  - **Re-verified on the real device** with genuine physical taps: tapped "Start" on a mission as a
    guest → the sign-up sheet slid up over a visibly blurred, still-present Missions screen (screenshotted);
    tapped X → landed back on the identical Missions screen; reopened the sheet and pressed the actual
    hardware back button → it closed just the sheet (not the app), same landing screen.

- **Guests could earn points — full audit, now blocked at every path found.** Server-side, `pts` is
  meant to be earned only through anti-cheat-guarded Cloud Functions (`saveUserData()` already refuses
  to write it from the client), but three of those functions only checked `!uid` — and a guest's
  anonymous session has a `uid` — so nothing anonymous-specific was actually stopping them:
  `completeMission` (mission proof → points), `claimDailyReward` (the Daily Reward button), and
  `claimReferral` (auto-fires on boot for anyone who followed a `?ref=` link). All three now also
  reject `isAnonymousCaller(context)`, matching the same guard already on `watchAd`/`likePost`/etc.
  from the original guest-mode hardening pass.
  - **Client-side, the entry points had no gate at all**, meaning a guest could go through the full
    motions — take a mission photo, tap Mark Complete, or tap the Daily Reward's Claim button — and
    (before this fix) would have hit the crash/rejection only at the very last step, after already
    investing the effort. Added `requireRealAccount()` at `openModal(idx)` (the mission "Start" tap,
    before any photo/video capture) and at the top of `claimDaily()` (before its optimistic
    UI update, so a guest never even sees the points/confetti animate before being redirected).
  - **Found a fourth, purely client-authoritative path via code review, not live testing:**
    `claimAnnouncement()` (the "Claim" button on admin-broadcast announcements with a reward field)
    writes `pts` directly from the client with no server round-trip at all — by design, per its own
    comment, same as every other client-owned display counter. `saveUserData()`'s existing
    `if(isGuestUser)return` meant a guest's claim was never going to persist, but the UI still played
    the full reward animation (points count up, confetti, toast) first. Gated just the reward path —
    `if(r>0 && !requireRealAccount())return` — so a reward-less (purely informational) announcement can
    still be dismissed by a guest without interruption, but a real reward redirects to sign-up first.
  - **`maybeClaimReferral()` gets a silent skip, not a signup prompt**, since it fires automatically on
    every boot rather than from a direct tap — interrupting boot with a sheet would be jarring for
    something the guest never asked for. The pending `?ref=` code stays in `localStorage` untouched, so
    it claims correctly later if that same guest ever signs up for a real account.
  - Deliberately **left `redeemPoints` (the Rewards Shop) out of scope** — it's the spend side, not the
    earn side the user asked about, and a guest has 0 points to redeem regardless.
  - **Verified live against production**: called `completeMission`/`claimDailyReward`/`claimReferral`
    directly as an anonymous caller (bypassing the client entirely, simulating a direct API attacker) —
    all three now return `functions/unauthenticated`, where before this fix at least `completeMission`
    would have proceeded past the auth check into its own (unrelated, `not-found`-throwing) guard.
    Confirmed on the client that `claimDaily()` and a simulated `claimAnnouncement()` reward both
    correctly open the sign-up sheet with `pts` left completely unchanged, and confirmed a real
    (non-guest) test account still claims normally through the same code paths.
  - **Re-verified on the real device**: tapping a mission's "Start" button as a guest opened the
    sign-up sheet with 0 points showing throughout, both before and after dismissing.

  Deployed: hosting (overlay CSS/JS + all four client-side gates), 3 Cloud Functions (`completeMission`,
  `claimDailyReward`, `claimReferral`). Verified live: functions confirmed via `firebase functions:list`,
  hosting confirmed byte-for-byte identical via direct fetch, all gates confirmed on both desktop
  browser and real device against live production.

- **Rooms narrowed to zero guest access (further scope tightening).** Previously guests could browse
  the top-3 popular-rooms list (deliberately allowed, per the earlier decision) while joining/creating/
  chatting stayed gated. The user tightened this: guests should have no Rooms access at all, only feed
  scrolling. Since every concrete example in the request was Rooms-specific and the alternative reading
  (gate every tab, not just Rooms) would have reversed the already-shipped "browse everything, gate on
  action" plan, confirmed the narrower scope via AskUserQuestion before building.
  - **Client**: `loadTopRooms()` now checks `isGuestUser` and skips the fetch entirely for guests
    (hides `#top-rooms`, never calls the callable) — previously it just rendered whatever came back.
    "Open a room" / "Join by code" stay visible but continue to gate on tap (`roomCreate()` /
    `roomJoinByCode()` already had `requireRealAccount()`), consistent with every other gated control
    in the app rather than hiding controls outright.
  - **Server**: added `isAnonymousCaller(context)` to `getTopRooms`, which had deliberately been left
    open to guests before this change.
  - **Found via rule inspection, not live testing:** `rooms/.read` in the RTDB rules was `"auth != null"`
    — any anonymous session could still read the entire `rooms` tree directly (codes, hosts, chat,
    everything) via a raw client call, completely bypassing both the client gate and the `getTopRooms`
    callable's new check. Restricted it to `auth != null && auth.token.firebase.sign_in_provider !== 'anonymous'`,
    plus the same fix on the two narrower `banned`/`mods` sub-rules that had their own independent
    `.read` grants.
  - **Verified live against production**: guest session — `#top-rooms` never renders and stays hidden;
    calling `getTopRooms` directly and reading `rooms/` directly both now return `PERMISSION_DENIED`/
    `unauthenticated`, confirming no path (client, callable, or raw DB) leaks room data to an anonymous
    session anymore. Confirmed a real account is completely unaffected — top-rooms list still renders,
    `getTopRooms` still succeeds.
  - **Re-verified on the real device**: guest session's Missions tab shows the Challenge Rooms
    open/join controls exactly as before, but the popular-rooms list is entirely absent (screenshotted);
    tapping "Open a room" still correctly opens the sign-up sheet.

  Deployed: RTDB rules, `getTopRooms` Cloud Function, hosting. Verified live: rules confirmed
  byte-for-byte identical via `firebase database:get`, function confirmed via `firebase functions:list`,
  hosting confirmed byte-for-byte identical via direct fetch, all three enforcement layers confirmed on
  both desktop browser and real device against live production.

- **Broad regression pass across everything shipped this session — found and closed six more real
  guest-access gaps that predated this session's work but were never audited.** Requested as a final
  sanity check now that guest mode, top rooms, points gating, and the Rooms restriction were all live:
  exercise both a real account and a guest session, on the real device first and then desktop, across
  feed, missions, rooms, profile, ratings, chat, and uploads, and confirm nothing broke and nothing
  guests shouldn't reach is reachable.
  - **Real-account pass (device, then desktop): clean.** Like, comment, mission start, room create,
    room chat send (3ms optimistic UI still intact), and profile view all worked exactly as before —
    none of this session's gates or rule changes affected a real account anywhere.
  - **Guest pass surfaced a real, previously-unaudited hole: several features outside the original
    ~15-action list had no gate at all, client or server.** The original guest-mode build (and this
    session's later passes) only ever hardened the specific actions named at the time — profile
    editing, DMs, mute, block, report, and saving a post were never in that list and had nothing
    stopping a guest:
    - **Edit Profile** — tapping "+ Add bio" opened the full edit-profile sheet (bio/link/age/country)
      for a guest with no redirect at all. Confirmed exploitable live: a raw `set()` on
      `users/{uid}/profileCountry` as an anonymous session succeeded before the fix.
    - **Direct messages** — the chat list opened and `sendChatMessage()`/`sendChatImage()` had no gate;
      the `sendMessage` Cloud Function itself only checked for *a* uid, not a real one.
    - **Mute / Block / Report** — none of `muteUser()`, `doBlock()`, or `submitReport()` had a gate;
      `userMuted`/`userBlocked` allowed direct anonymous writes and `reportUser`/`blockUser`/
      `unblockUser` only checked for *a* uid.
    - **Save post** — `feedSavePost()` wrote straight to `userSaves/{uid}/{postId}` with no gate and no
      rule check.
  - **Fixed with the same defense-in-depth pattern as every other action this session**: a
    `requireRealAccount()` gate at each client entry point (`openEditProfile`, `sendChatMessage`,
    `sendChatImage`, `muteUser`, `submitReport`, `doBlock`, `feedSavePost`), `isAnonymousCaller(context)`
    added to `updateBio`, `sendMessage`, `reportUser`, `blockUser`, and `unblockUser`, and
    `auth.token.firebase.sign_in_provider !== 'anonymous'` added to the RTDB write rules for
    `users/$uid/{title,link,age,profileCountry}`, `userMuted/$uid`, `userSaves/$uid`, and
    `userBlocked/$uid`. Real accounts are unaffected — all read/write elsewhere in these paths already
    required `$uid === auth.uid`, which anonymous and real accounts alike satisfy for their own uid;
    only the new anonymous-exclusion clause changes anything, and only for guests.
  - **Verified live against production, both platforms**: every one of the 6 client gates now redirects
    to the sign-up sheet; all 5 hardened Cloud Functions and all 4 hardened RTDB paths were called
    directly as an anonymous session (bypassing the client entirely) and every single one returned
    `functions/unauthenticated` or `PERMISSION_DENIED`. Re-confirmed a real account still saves a
    profile edit, opens a room, and sends chat/room messages with zero errors through the same code
    paths.
  - **Not touched, flagged only**: the broader sweep found ~15 more Cloud Functions
    (`followUser`'s direct-write path is separately rule-protected already; `setRoomMission`,
    `editFeedCaption`, `editComment`, `changeUsername`, `syncLeaderboard`, `ensureUser`,
    `updateLanguage`, `cancelPremium`, `savePost`/`unsavePost`, `markChatRead`, `updatePostMedia`) that
    also lack `isAnonymousCaller` but have no confirmed client-reachable path for a guest today (either
    already gated upstream, or not wired to any guest-reachable UI). Left alone to keep this pass
    scoped to concretely-exploitable findings rather than a blanket rewrite of every callable; worth a
    dedicated follow-up pass. Also still open from earlier this session: guest sessions can still reach
    the account-management Settings rows (change username/password/email) — previously flagged, not
    part of this pass.

  Deployed: RTDB rules, 5 Cloud Functions (`updateBio`, `sendMessage`, `reportUser`, `blockUser`,
  `unblockUser`), hosting (6 new client-side gates). Verified live: rules confirmed byte-for-byte
  identical via `firebase database:get`, functions confirmed via `firebase functions:list`, hosting
  confirmed byte-for-byte identical via direct fetch, every gate and every hardened path confirmed
  directly against production on both the real device and desktop browser, for both guest and real
  accounts.

- **Comment sheet reported as covering the whole video; investigated and found the actual cause
  wasn't height.** `.comment-sheet` was already `height:72vh`, bottom-anchored via the overlay's
  `align-items:flex-end` — geometrically already a partial bottom sheet, confirmed live by forcing its
  open animation to completion and measuring: 72.0% of viewport height, 28% (227px on a 812px-tall
  screen) genuinely unobstructed by the sheet element itself. The actual cause was the shared
  `.comment-overlay` backdrop (`rgba(0,0,0,.6)` + `blur(6px)`, spanning the full viewport via
  `inset:0`) — the same treatment used for every focus-stealing modal in the app (confirmations,
  daily reward, etc.) — sitting on top of the visible 28% strip too, heavily dimming and blurring the
  video enough that it read as full-screen coverage even though the sheet itself wasn't. TikTok's
  actual comment sheet keeps the video crisp and playing above it, not blurred. Lightened
  `.comment-overlay`'s backdrop specifically to `rgba(0,0,0,.15)` with no blur, leaving every other
  modal's stronger backdrop untouched.
  - **Verified live on desktop browser** (the real device disconnected from ADB partway through this
    check and didn't reconnect — noted rather than silently skipped): re-measured after the fix with
    the same forced-animation technique — still 72.0% height, now with the lighter, blur-free backdrop
    confirmed via computed style. Confirmed submitting a comment through the sheet still works
    (input clears on send, no errors), and confirmed the guest gate on commenting is unaffected by the
    backdrop change (still correctly opens the sign-up sheet).

  Deployed: hosting only. Verified live: byte-for-byte identical via direct fetch; sheet
  geometry and new backdrop confirmed via forced-animation measurement; comment submission and the
  guest gate both re-confirmed working through the changed markup, on desktop browser (device
  re-verification still pending — reconnect and confirm next session).

- **Comment sheet backdrop fix re-confirmed on the real device** once it reconnected: the video stays
  crisp and clearly visible above the sheet (screenshotted), matching the desktop result exactly.

- **Found and fixed a real bug during this final confidence pass: a signed-out-without-logout
  transition could leak the previous real account's name into a fresh guest session.** The
  guest-display-name fix from earlier only overwrote `userName` when it was already empty or equal to
  the literal `'Guest'` sentinel — correct for the normal logout button (`_doLogoutConfirmed()`
  explicitly clears `userName` first) but not for any OTHER path to a signed-out state (session
  expiry, token invalidation, etc.), which don't clear it. Reproduced live on-device: signed into a
  real account, then went straight to `continueAsGuest()` without going through the logout button —
  the greeting showed "Hey devicefinal0815" (the stale real username) instead of "Hey Guest," even
  though `isGuestUser`/`isAnonymous` were both correctly `true`. Fixed by making the guest-name
  assignment in `setupAuthListener()` unconditional whenever `isGuestUser` is true, instead of gated
  behind the "not already known" check — a guest session should never preserve a pre-existing name,
  full stop. Re-verified live on-device with the exact same repro: greeting now correctly reads
  "היי אורח" ("Hey Guest") every time, screenshotted for confirmation. Also re-confirmed the
  Rooms-hidden state and the like gate both still fire correctly for this guest session afterward.
  - Cleaned up two orphaned test comments left over from earlier in this pass (their accounts had
    already been deleted via raw Auth `user.delete()` rather than the app's own `deleteAccount` flow,
    which is what actually cascades comment cleanup — so these were never going to disappear on their
    own) via `firebase database:remove` under admin credentials, since the normal client write rule
    requires being signed in as the comment's own author.

  Deployed: hosting only. Verified live: byte-for-byte identical via direct fetch; the exact
  repro that surfaced the bug re-tested clean on the real device; Rooms-hidden and the like gate
  re-confirmed unaffected.
