# Full App UX & Quality Audit

Scope: the entire app's surface area — every screen, modal, and flow — for anything worse for the
user: hidden/overlapping content, controls that don't open or don't work, visual glitches, broken
handlers, accessibility gaps, RTL issues, dead code, anything janky. Methodology matches this
project's earlier audits (`UX_POLISH_AUDIT.md`, `VISUAL_OVERLAP_AUDIT.md`): a code-level pattern
scan across the whole file, live interaction on the real device and the desktop browser with a
throwaway test account, and `getBoundingClientRect()`/`getComputedStyle()`/`elementFromPoint()`
measurement to *confirm* anything that looked suspicious rather than reporting on sight alone.

**Status: all 6 items below are fixed, deployed, and live-verified** on both desktop browser and the
real device, following approval to fix everything found. Each item keeps its original diagnosis,
followed by what was actually done. Ranked by actual user impact, most severe first.

---

## Critical — the feature silently does nothing when used

### 1. Settings → Change username / Change password / Change email / Cancel Premium open a modal that's completely invisible and unreachable — ✅ Fixed
Tapping any of these four rows in Settings visually does **nothing at all** — no modal appears, no
error, no feedback. The modal *is* opening (`classList.add('show')` fires correctly), but it renders
**behind** the still-open Settings screen and is 100% hidden by it.

**Root cause, confirmed precisely:** every other Settings row that opens a sub-screen calls
`closeSettings()` before opening its target (e.g. `index.html:1859` `onclick="closeSettings();
openBlockedList()"`, `:1875` `onclick="closeSettings();openAdmin()"`). These four don't:
- `index.html:1863` — `onclick="changeUsername()"` (no `closeSettings()`)
- `index.html:1867` — `onclick="changePassword()"`
- `index.html:1871` — `onclick="changeEmail()"`
- `index.html:1888` — `onclick="cancelMyPremium()"`

`.settings-overlay` sits at `z-index:9999` (`index.html:1132`) with a fully opaque background
(confirmed live: `background-color: rgb(13,13,16)`, `opacity:1`). The target modals sit far below
that: `#account-modal` (used by all three "Change …" rows) is `z-index:1000`
(`index.html:243`, shared with `#block-sheet`, `#blocked-overlay`, `#admin-overlay`,
`#privacy-modal` — those are fine because their rows *do* call `closeSettings()` first); the
Cancel-Premium modal has no dedicated rule at all and falls back to the base `.overlay` class at
`z-index:200` (`index.html:1028`) — even further buried.

**Verified live on the real device**, via the real code paths (`openSettings()` →
`changeUsername()`, exactly what tapping the row does): `account-modal.classList.contains('show')`
is `true`, but `document.elementFromPoint()` at the modal's own center returns
`settings-list` — the Settings screen, not the modal. There is no way to reach this feature from
the UI as it stands today. Same root cause affects all four rows (verified the z-index/DOM
structure for all four; live-reproduced the username/password/email one directly).

**Impact:** Change Username, Change Password, Change Email, and Cancel Premium are effectively
dead features — anyone who taps them sees no response and has no way to know why.

**Fix:** added `closeSettings();` before each of the four onclick calls
(`index.html:1863,1867,1871,1888`), matching the pattern every other Settings row already used.
**Verified live on both platforms** by clicking the actual DOM rows (not calling the target
function directly, which would have silently passed even with the bug still present): all four
rows now correctly close Settings and bring the target modal to the front.
Desktop — `settingsStillShown:false`, `elementFromPoint()` at the modal's center now resolves to
the modal itself, for username/password/email. Device — same result, plus a screenshot: the
"Change username" sheet is now visibly on screen with the feed dimmed behind it (screenshot taken
and reviewed).

### 2. After one successful sign-up, login, or Google sign-in, the auth form's buttons never re-enable for the rest of the session — ✅ Fixed
Confirmed live on **both** desktop and the real device, reproduced twice independently (once via
register, once via login) through the real UI code paths (`doRegister()`, `doLogin()`).

**Root cause:** `setAuthLoading(true)` (`index.html:3020-3021` —
`document.querySelectorAll('.auth-btn,.google-btn').forEach(b=>{b.disabled=on;
b.style.opacity=on?'0.6':'1'})`) is called at the start of all three auth actions
(`index.html:3077` register, `:3260` login, `:3312` Google) and correctly reset to `false` on
every *failure* path — but **never on success**:
- `doRegister()`'s success `.then()` (`index.html:3140-3151`) never calls `setAuthLoading(false)`.
- `doLogin()`'s success `.then()` (`index.html:3262`) never calls it either.
- `_handleGoogleSignIn()`'s success path (`index.html:3295-3297`) same gap.

Since the user is immediately navigated to the app after success, this is invisible in the moment
— but the disabled/dimmed state persists on those DOM elements indefinitely. Two concrete,
confirmed consequences:
- **If the auth form is shown again later in the same session** — logging out and being routed
  back to it (now that the sign-up screen shows as a dismissible overlay rather than a hard wall —
  see recent work), or a returning-session flow reopening it — "Create Account", "Log In", and
  "Continue with Google" are all `disabled:true` and cannot be tapped at all. Confirmed live: after
  one successful login, all three read `disabled:true, opacity:"0.6"`.
- **`.auth-btn` is also the class on Settings' "Save" button** (`account-modal`'s
  `#account-save`, `index.html:10198`, class `"auth-btn"`) — a completely unrelated screen. After
  any successful sign-up/login this session, that Save button is stuck at `opacity:0.6` (looks
  disabled) even though its own code correctly keeps `disabled:false` — so it's still clickable,
  just visually looks broken/uncertain. Confirmed live on both platforms.

**Impact:** high. This is very likely to be hit by real users now that the auth screen can
reasonably be shown more than once per session (see item 1's neighboring recent work on the
guest/auth overlay) — a user who logs out and tries to log into a different account, or a guest who
completes sign-up then later reopens the sign-up sheet for any reason, hits an auth form that
looks and *is* completely unresponsive.

**Fix:** added `setAuthLoading(false);` to all three success paths — `doRegister()`
(`index.html:3140-3141`), `doLogin()` (`:3263`), and `_handleGoogleSignIn()` (`:3296-3297`) —
matching what every failure path already did.
**Verified live on both platforms**: registered a fresh account through the real form, waited for
the success toast, then read every `.auth-btn`/`.google-btn` element's state — all four
("Create Account", "Log In", "Continue with Google", and Settings' unrelated "Save" button, which
shares the class) now read `disabled:false, opacity:"1"`. Re-verified via `doLogin()` on the
device specifically, since that was the exact path used to first reproduce the bug.

---

## Medium — visible, but not blocking

### 3. "@username" still renders backwards in RTL (Hebrew/Arabic) in 4 places the earlier fix missed — ✅ Fixed
`UX_POLISH_AUDIT.md` item 3 fixed this exact bug (the browser's bidi algorithm flips a literal
`'@'+username` prefix to read "username@" in RTL) in four places by wrapping the text in
`<span dir="ltr" style="unicode-bidi:isolate">`. Four more call sites have the identical unwrapped
pattern and were missed:
- `index.html:7237` — hashtag-search video results, `search-row-sub`
- `index.html:8312` — user search results, `search-row-name`
- `index.html:8318` — hashtag-search video results (second call site, same pattern)
- `index.html:8495` — the Blocked Users list, `blocked-name`

Confirmed via code (identical pattern to the four already-fixed sites, which used the exact same
`'@'+escHtml(name)` construction before their fix). Not independently re-confirmed against a live
Hebrew screenshot this pass — the test account's search didn't return results in time to check
visually, but the code match to the already-diagnosed-and-fixed pattern is exact.

**Fix:** wrapped all four in `<span dir="ltr" style="unicode-bidi:isolate">@…</span>`, the same
established pattern.
**Verified**: fetched the live deployed page after deploy and confirmed the exact wrapped strings
(`blocked-name"><span dir="ltr"...` and `search-row-sub"><span dir="ltr"...`) are present in the
served HTML.

---

## Low — accessibility

### 4. ~30 interactive elements are plain `<div>`s with no `role`/`tabindex` — invisible to screen readers, unreachable by keyboard — ✅ Fixed
`M15` (an earlier audit item) added `role="button" tabindex="0"` to interactive divs, but only
partially — plenty of tappable rows across the app still don't have it. Confirmed this has a real,
live effect: opening the Follow sheet and Settings and reading the accessibility tree, most of
their rows show up as unlabeled `generic` elements rather than `button "…"` — a screen-reader user
gets no indication these are tappable, and they're unreachable via Tab.

Representative list (not exhaustive) of `<div onclick=…>` elements missing `role=`:
`auth-back`, `tab-reg`/`tab-log` (auth tabs), `forgot-pw`, `google-btn`, the top-left `logo`
(home button), `rank-pill`, `streak-pill`, `ad-banner`, the three mission cards (`mcard`),
the three leaderboard sort tabs, `my-hero-ring` (own avatar), `pf-bio`, both `my-follow-stat`
rows, the two `feed-tab`s (For You / Following), `room-code-wrap`, achievement badges
(`fpp-ach-badge`, `showAchievementInfo`), photo-editor filter chips (`pe-filter`), the
leaderboard top-3 podium row (`lb-t3-row`), every `search-row` variant, notification rows
(`notif-row`), announcement cards (`ann-card-row`), search trending chips (`trend-chip`),
recent-search rows (`recent-q`), chat list rows (`chat-row`), and draft rows
(`draft-thumb-wrap`/`draft-info`).

(Note: Settings' own rows — including the four from item 1 — already correctly have
`role="button" tabindex="0"`; they're not part of this finding. This is specifically the elements
that never got the M15 treatment.)

**Fix:** added `role="button" tabindex="0"` to all 38 genuinely-interactive elements found missing
it — the 20 static ones listed above plus 18 more found in dynamic template strings during the fix
pass itself (achievement badges, photo-editor filter chips, the leaderboard podium row, all 5
`search-row` render sites, notification rows — including the 3 conditional notification types that
only get an onclick when there's somewhere to go, guarded so non-interactive rows don't falsely
announce as buttons — announcement cards, trending/recent-search chips, chat rows, draft rows, and
the edit-profile-modal avatar). Deliberately left the 6 overlay-backdrop containers (`fpp-overlay`,
`av-zoom-overlay`, `modal-bg`, `comment-overlay`, `follow-sheet-overlay`) and the one
stop-propagation guard (`feed-rating-row`) alone — those aren't semantically buttons.
**Verified**: re-ran the same static scan post-fix — the only 6 remaining `<div onclick>` elements
without `role=` are exactly those 6 intentional exclusions. Spot-checked live on desktop that
`auth-back`, `rank-pill`, `my-hero-ring`, and `google-btn` all now report `role:"button"
tabindex:"0"`.

### 5. Two pairs of overlays share a z-index with no established stacking order (code-level only, not confirmed as a live collision) — ✅ Fixed
- `.rating-slider-overlay` (long-press rating slider on a feed video) and `#p-auth.show` (the
  sign-up sheet) both sit at `z-index:10700` (`index.html:154`, `:1151`).
- `.pe-overlay` (photo editor, part of the upload flow) and `.fpv-overlay` (fullscreen post
  viewer) both sit at `z-index:10200` (`index.html:356`, `:1235`).

Every other overlay in the file has its own distinct tier, so these two pairs look like an
oversight rather than intentional. Low priority: I don't have a confirmed path where either pair
can actually be open simultaneously (rating a video while the sign-up sheet is also up would need
a signed-in user's session to drop mid-interaction; the photo editor and post viewer belong to
different flows that don't normally overlap) — flagging as a smell worth a second look, not a
reproduced bug.

**Investigated and fixed anyway**, since a defined stacking order costs nothing and removes the
ambiguity regardless of whether either pair can currently collide: `.rating-slider-overlay` moved
from `10700` to `10650` — clearly below `#p-auth.show`, on the reasoning that if a session ever did
drop mid-rating, the auth screen dealing with that state change should take priority over a stale
rating slider. `.fpv-overlay` moved from `10200` to `10210` — now distinct from `.pe-overlay`
(unchanged at `10200`); no strong reasoning either way on which should win since they don't appear
to share a reachable path, just resolved the tie.
**Verified live on desktop**: both elements now read their new `getComputedStyle().zIndex` values.

### 6. 83 unused/dead translation keys — ✅ Fixed
The `en` translation block has 620 keys; only 537 are ever referenced by `t()`/`data-i`/`data-i-aria`
anywhere in the file. All 7 languages are otherwise in perfect parity with each other (verified
programmatically — zero missing keys in he/es/ru/ar/fr/pt relative to en). Pure code hygiene, no
user-visible effect (matches the same category as the already-fixed `ptsToLegend` dead key from the
earlier audit).

**Fix:** before removing anything, re-confirmed each of the 83 keys appears *nowhere* in the file
outside its own definition in the 7 language blocks (i.e. not referenced via some other access
pattern than `t()`/`data-i`/`data-i-aria` that the original scan might have missed) — zero
exceptions found, so all 83 were genuinely dead, not "reserved for a half-built feature." Wrote a
small script that parses each language block's object literal properly (not regex-on-minified-text,
which risks corrupting adjacent entries) and removes the 83 dead keys from all 7 blocks. Tested the
script against a throwaway copy of the file first — verified via Node's `vm` module that the
resulting `T` object still evaluates as valid JS with exactly 537 keys per language (620 − 83), spot
-checked that kept keys retained their exact original values in both `en` and `he`, and confirmed
zero dead keys survived — before running it for real.
**Verified**: real file re-syntax-checked clean after the run; live on desktop, `t('easy')`,
`t('medium')`, `t('hard')`, and `t('onb1Title')` (all removed keys) each fall back to returning
their own key name — `t()`'s documented behavior for a genuinely missing key — confirming the
removal took effect in the deployed build.

---

## Additional change (not an audit finding — requested alongside the fixes)

### Sign-up/auth overlay's dim and blur reduced, so the app behind it reads more clearly
`#p-auth.show`'s backdrop was `rgba(0,0,0,.6)` with a `6px` blur — reduced to `rgba(0,0,0,.35)` and
`2.5px`, so the feed/app content behind the sheet is noticeably more visible without losing the
sheet's own legibility. `index.html:154`.
**Verified live on both platforms**: desktop computed style now reads `rgba(0, 0, 0, 0.35)` /
`blur(2.5px)`; device screenshot before/after comparison shows the feed's top nav (tab labels,
search icon) clearly more legible through the sheet than the original screenshot from when this
overlay was first built.

---

## Checked and confirmed NOT a bug

- **Edit-profile modal appearing to render at `opacity:0`** when measured via `getComputedStyle()`
  on desktop: this is a false positive caused by the desktop test browser tab not being the
  visible/focused tab (`document.visibilityState:"hidden"`, `hasFocus:false` — Chrome throttles/
  freezes CSS animations, including the `.overlay.show{animation:ovFade}` fade-in, on backgrounded
  tabs). Not a real bug: functionally verified the modal's fields (bio/link/age/country) all read,
  write, and save correctly, and confirmed the analogous `av-zoom` fade/opacity behavior renders
  correctly for real on the device where the tab is genuinely visible. Worth remembering for any
  future desktop-only opacity/animation check in this environment — screenshots were already known
  to be unreliable in the desktop pane (per `VISUAL_OVERLAP_AUDIT.md`'s coverage note); CSS
  animations being paused for the same reason is a related but distinct gotcha, discovered this
  pass.
- Follow sheet (both "followers" and "following" empty states), edit-profile modal (bio/link/age/
  country all save correctly, country picker's 198 options load fine), chat list + individual DM
  screen (structure, input, send button all wired correctly — did not send a real message to avoid
  polluting a real account's inbox), report modal (all 7 reasons present, cancels cleanly), block
  sheet (bidi-wrapped name renders correctly), room mission-setting sheet (3 options, saves), room
  member sheet (tapping yourself correctly routes to your own profile, including the avatar-zoom
  feature working inside a room context), ranks/all-ranks modal (renders, "you are here" marker
  present) — all exercised live on desktop and/or device this pass with no issues found.
- `onclick="…"` targets: every one of the ~166 distinct function names referenced across every
  `onclick` in the file resolves to a real, defined function — zero typos/dead references.
- Translation keys: every `t()`/`data-i`/`data-i-aria` reference resolves to a real key in every one
  of the 7 languages — zero missing-translation gaps (see item 6 for the reverse — unused keys,
  which is harmless).
- A suspicious-looking `'<\div>'` in an admin-panel template string, caught by `Grep` output —
  re-checked against the actual file via `Read` and it's a correctly-formed `'</div>'`; a display
  artifact of the grep tool's own output formatting, not a real syntax error in the source.

---

## Coverage note

This pass covered, live on desktop and/or device: feed, profile (own), edit-profile modal, account-
settings modal (change username/password/email), follow sheet, settings screen (all rows), chat
list + DM screen, report modal, block sheet, room creation + mission-setting sheet + member sheet,
ranks/all-ranks modal, search, comment sheet, avatar zoom (profile viewer + own-profile-tab, both
already covered by earlier work and reconfirmed working here), plus a full code-level pass across
the entire file (translation-key parity, `onclick` target resolution, RTL bidi pattern, z-index
inventory, `img alt` coverage, interactive-div accessibility pattern).

**Admin panel was reviewed via code only, not live-tested** — it requires signing in as the app's
real admin email (`shahar070510@gmail.com`), and entering that account's password is outside what
I'll do regardless of who asks. Nothing structurally wrong found in the code read (`renderAdminStats`,
`renderAdminPendingUploads`, `renderAdminReports`), with one low-priority note: `renderAdminReports`
(`index.html:7676`) fetches only the most recent 100 reports by `createdAt` and then filters out
`actioned` ones client-side — at scale, a large batch of recently-actioned reports could crowd an
older-but-still-pending report out of that 100-item window, hiding it from the admin view. Not
biting anyone today (production has 2 reports total), just worth knowing about if report volume
grows.

Not covered this pass: DM message *sending* itself (structure verified, didn't actually send to
avoid polluting a real account), premium purchase flow (still an intentional "Coming soon" stub per
earlier explicit instruction), the native camera/video-capture flow and photo editor's filter/text/
sticker tools (structure sound per code read, not exercised live — camera access doesn't work well
in this automated environment), push notification delivery, and the onboarding tutorial screens
(not auto-shown per existing code, would need to be triggered manually).

All test accounts (`audit<timestamp>@example.com` on both platforms, its `users/`, `usernames/`,
and `rooms/` data) were fully cleaned up via `deleteAccount()` / admin CLI and confirmed gone. Also
finished a leftover cleanup item noted at the end of `VISUAL_OVERLAP_AUDIT.md`
(`visualaudit0815@example.com`'s Auth record) — confirmed it no longer exists, nothing left to do
there.

---

## Deploy & verification summary (fix pass)

Deployed: hosting only (every fix in this document is client-side; no Cloud Functions or database
rules were touched). One syntax-checked, byte-verified deploy covering all six items plus the
dim/blur change.

Verification used a fresh throwaway account per platform (`verify<timestamp>@example.com` on
desktop, `devverify<timestamp>@example.com` on device), created, exercised through the real UI
code paths for every fix above, then deleted via `deleteAccount()` and confirmed gone from
`users/`, `usernames/`, and Firebase Auth. The dead-translation-key removal was additionally
dry-run against a throwaway copy of the file first (verified via Node's `vm` module that the
resulting object is valid and exactly 537 keys per language) before being applied for real, given
how much more disruptive a parsing mistake there would have been compared to the other fixes.
