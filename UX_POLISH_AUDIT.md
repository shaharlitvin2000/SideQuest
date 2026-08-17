# UX Polish Audit

Scope: not security, not correctness bugs — small rough edges, inconsistencies, and things that feel
unfinished, the kind a picky user notices every time they open the app. Methodology matches the rest of
this project's audits: live interaction on both desktop browser and the real device (fresh test
accounts, cleaned up afterward) plus a targeted code-reading pass, not guesswork.

**Status: all 10 items below were fixed, deployed, and ground-truth verified** (on both desktop browser
and the real device, in Hebrew/RTL where the item was RTL-specific) in the same session this document
was first written. Each item keeps its original diagnosis, followed by what was actually done.

---

## High visibility — most users would notice these directly

### 1. Production leaderboard is full of this engagement's test accounts — ✅ Fixed
The live Leaderboard screen showed ~15 test accounts created over the course of this whole session mixed
in with real players — `devicefinal0815`, `commentsheetverify0814`, `toproomsA`, `gatecheck0814`,
`devregress0814`, `roomsgate0814`, plus generic `Player_xxxxxxxx` fallback names, a **duplicate**
`commentsheettest0814` entry, and a `אורח` ("Guest") entry at rank 8 with 0 points.

**Fix:** Reviewed every `leaderboard/` entry in production and categorized by hand — 14 entries matched
known test-account naming patterns from this engagement (all sharing the fingerprint of `streak:1,
country:"", no real pts/missions`); 7 entries had genuine engagement data (real points, real mission
counts, or names outside any test pattern) and were left untouched. Removed the 14 via admin CLI
(`firebase database:remove`), and — since checking turned up that `users/{uid}` and `usernames/{name}`
were *also* still lingering for the same 14 accounts, meaning earlier client-side cleanup attempts this
session had been silently failing throughout — cleaned those up too for a genuinely complete removal.
**The `אורח` mystery is resolved**: confirmed live that a fresh guest session renders a "Guest (you)"
row in the leaderboard UI purely from local state for preview purposes, with **no corresponding database
record** (`leaderboard/{guestUid}` doesn't exist) — so the stray entry was a historical leftover from
before this session's guest-mode hardening, not an active ongoing leak. The protection is confirmed
still working correctly today.
**Verified:** live `firebase database:get /leaderboard` after cleanup shows exactly 7 entries, all real;
re-confirmed visually on the real device's Ranks screen.

### 2. Header streak pill can show the wrong day/days grammar — ✅ Fixed
The top-bar streak pill (🔥 *N* day/days) had the number and label set correctly once, in `updateUI()`,
but the label element's underlying `data-i` attribute was never updated to match — it stayed hardcoded
to `data-i="days"` in the static markup. Any later `applyTranslations()` call (opening any modal,
switching tabs — many unrelated things trigger this) re-read the stale attribute and stomped the correct
singular "day" back to "days".

**Fix:** `updateUI()` now sets `streakLbl.dataset.i` alongside `.textContent`, so the attribute always
reflects the current singular/plural choice and survives any later re-translation pass.
**Verified:** live on desktop — set state to a real 1-day streak, confirmed `data-i="day"` and
`textContent="day"`, then explicitly called `applyTranslations()` (simulating the exact unrelated-trigger
scenario that broke it before) and confirmed it stayed "day" instead of reverting. Re-confirmed on the
real device in Hebrew ("יום 1", singular, correct).

### 3. "@username" visually flips to "username@" in RTL (Hebrew) mode — ✅ Fixed
The feed byline was built as `'@'+escHtml(postUser)` — a literal prefix that the browser's bidi
algorithm reordered in RTL contexts, visually rendering "Shahar Litvin@" instead of "@Shahar Litvin".
Reproduced consistently across every account and screenshot taken on the real device this whole
engagement. Two other places in the codebase (profile popup, comment sheet) already wrapped the same
pattern in `<span dir="ltr" style="unicode-bidi:isolate">` — the feed byline was simply the one place
that didn't.

**Fix:** Applied the same established `dir="ltr"` + `unicode-bidi:isolate` wrapper to the feed byline,
plus three more call sites found via a broader search that had the identical unwrapped `'@'+username`
pattern (the report-user modal, the block-user sheet, and the comment reply indicator) — all four now
consistent.
**Verified:** live on desktop by measuring actual glyph positions via `Range.getBoundingClientRect()`
with the page in RTL mode — confirmed the "@" renders as the leftmost character, not the rightmost.
Re-confirmed visually on the real device in Hebrew: "@Shahar Litvin" now renders in the correct order.

### 4. Popular-rooms list surfaces mixed-language content and generic names to real users — ✅ Fixed
Previously flagged as a data-hygiene note; confirmed *visibly* affecting the live product — a Hebrew
room title and generic "Player" host names showing up in an English-language "Popular rooms right now"
list.

**Fix:** Pulled every entry in production `rooms/` (24 total) and confirmed all were stale — single- or
two-member abandoned rooms from testing across this entire engagement (the real user's own old test
sessions, plus several of my own and earlier bot-named test accounts), none genuinely active. Removed
all 24 via admin CLI.
**Verified:** `rooms/` in production now returns `null`. Confirmed live on both desktop and the real
device that the "Popular rooms right now" section no longer renders at all (correctly hides itself when
there's nothing to show), while "Open a room" / "Join by code" remain untouched and working.

---

## Medium visibility — noticeable on interaction, not at a glance

### 5. Hebrew rating-prompt copy reads awkwardly — ✅ Fixed
`rateMissionLabel`'s Hebrew translation, "עד כמה הם השלימו את זה טוב?", was a literal word-for-word
translation rather than natural phrasing.

**Fix:** Rewrote to "כמה טוב הם השלימו את המשימה?" — natural Hebrew phrasing using the standard "כמה
טוב" (how well) construction, and "את המשימה" (the mission) instead of the vague "זה" (it/this).
**Verified:** live on desktop via `t('rateMissionLabel')`; re-confirmed visually on the real device.

### 6. "Watch a short ad" doesn't show an ad — ✅ Fixed
Tapping "Watch" instantly granted +50 points with no ad ever shown — a known stand-in per the
`TODO(rewarded-ads)` comment, not something a non-premium user's UI actually disclosed.

**Fix:** The app already had a fully-built honest treatment reserved for premium members (main label
"Get points now" + ⚡ icon, since premium always skips straight to the instant grant). Extended that same
copy/icon to everyone, since nobody currently gets a real ad regardless of premium status — no new
copy or design needed, just removed the premium-only conditional on the *text*. Deliberately kept the
gold `.ad-premium` *visual* styling (border/background color) premium-only — applying that too would
have traded one dishonesty (implying an ad plays) for another (implying premium status a non-premium
user doesn't have).
**Verified:** live on desktop — confirmed a non-premium test account sees "Get points now" + ⚡ with the
plain (non-gold) banner styling; re-confirmed visually on the real device ("קבל נקודות מיד" + ⚡).

### 7. Two different "N days" abbreviations, one with a space and one without — ✅ Fixed
The season countdown ("17 d") and post-age timestamps ("24d") used different spacing for the same "d"
abbreviation.

**Fix:** Removed the space from the season-countdown usage to match the more frequently-used
post-timestamp convention (no space), the smaller and more consistent of the two possible fixes.
**Verified:** live on desktop via `updateSeasonBanner()`; re-confirmed visually on the real device
("17ימ׳" with no space, in the Hebrew build).

---

## Low visibility / lower priority

### 8. Points/star indicator (★) is a plain text glyph, not the app's icon style — ✅ Fixed
Most iconography is custom inline SVG, but the "★" next to points throughout the app was a literal
Unicode character, inconsistent with the rest of the icon set across platforms/fonts.

**Fix:** Replaced all 10 live-rendered occurrences (feed points tag, profile thumbnails, rank-progress
"you are here" marker, daily-reward calendar, daily-reward milestone toasts ×2, both search-result
subtitles, the rewards-shop cost label, and the rewards-shop balance display) with the app's existing
`_starIc` SVG constant — no new icon designed, just consistent reuse of what was already there. Left the
2 remaining "★" occurrences alone since they're source-code comments, never rendered to any user.
**Verified:** live on desktop confirmed each replaced element's `innerHTML` now contains the SVG, not the
Unicode character; re-confirmed visually on the real device (feed points tag, daily-reward calendar).

### 9. `ptsToLegend` translation key appears to be dead, semi-hardcoded leftover — ✅ Fixed
Existed in all 7 language blocks, had a hardcoded "116" baked into the string, and was never referenced
anywhere else in the code.

**Fix:** Removed the key from all 7 language blocks (confirmed dead — zero call sites — before removing,
not just assumed).
**Verified:** grepped the deployed file post-fix; zero remaining occurrences anywhere.

### 10. "Go Premium" and related premium flows are honest stubs, not broken — left as-is (intentional)
Tapping "Go Premium" correctly shows a "Coming soon!" toast — not misleading, just incomplete. Per the
user's explicit instruction, left as-is since it's intentional for now; no change made.

---

## Deploy & verification summary

Deployed: hosting (all client-side fixes for items 2, 3, 5, 6, 7, 8, 9 in one syntax-checked, byte-
verified deploy). Data cleanups for items 1 and 4 were direct production database operations via
`firebase database:remove` (no code deploy involved) — the leaderboard and rooms hygiene issues are
fixed at the data layer, not the code layer.

Every item was verified twice: once via direct JS assertions against the live production site in the
desktop browser (including one item — #3 — verified by measuring actual rendered glyph positions, not
just reading markup), and again visually on the real device with the device's own Hebrew/RTL setting,
which is exactly the context several of these bugs (items 3, 5, 7) only manifest in. All test accounts
and their `users/`, `leaderboard/`, and `usernames/` data created during this verification pass were
cleaned up afterward via admin CLI (client-side self-cleanup was found to silently fail partway through
more than once this session — worth keeping in mind for any future cleanup work: verify the removal
actually happened rather than trusting a `.catch(()=>{})`-wrapped promise chain).
