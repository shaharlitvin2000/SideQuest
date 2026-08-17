# Visual Overlap / Layering Audit

Scope: purely visual — elements covering other elements that shouldn't be covered, things bleeding
off-screen, stray/leftover content, z-index conflicts. Not grammar, not consistency, not dead code
(that's `UX_POLISH_AUDIT.md`). Methodology: live interaction on both the real device and desktop
browser, screen by screen, using a mix of actual screenshots (device) and precise DOM bounding-rect
measurement (`getBoundingClientRect()` overlap checks — more reliable than eyeballing a screenshot,
and used throughout to *confirm* anything that looked suspicious rather than reporting on sight alone).

**Status: all 4 items below are now fixed, deployed, and live-verified.** One (the raw-SVG-as-text
regression) was fixed immediately on discovery, mid-sweep, since it was actively showing broken code to
real users right now, not a "rough edge" — deployed ahead of the rest of this document being written.
The other 3 were originally reported only, per a "don't fix yet" instruction, and fixed in a later pass
once asked for.

---

## Fixed immediately (not a backlog item — an active regression)

### 0. Daily-reward milestone text showed raw SVG markup as literal text
Opening the Daily Reward modal, the "N days to next milestone" line displayed the literal string
`<svg viewBox="0 0 24 24" width="11" ...></svg>150` instead of a star icon followed by "150" — the
actual HTML source of the star icon, printed as text.

**Root cause:** introduced during this session's earlier star-icon unification pass (`UX_POLISH_AUDIT.md`
item 8). That fix correctly replaced the "★" Unicode character with the app's `_starIc` SVG constant in
10 places, but one of them — `daily-ms-line` — was being written via `.textContent`, not `.innerHTML`.
`.textContent` doesn't parse markup, so the SVG string rendered as visible text instead of an icon. All
9 other replacement sites were already using `.innerHTML` or template-literal HTML insertion, so this
was the one spot that got missed.

**Fix:** changed that one assignment from `.textContent` to `.innerHTML` (`index.html`, `updateDailyDot`
area, the `nx.innerHTML=...` line for `#daily-ms-line`).

**Verified:** live on the real device — `#daily-ms-line`'s `innerHTML` now contains an actual `<svg>`
element (`hasSvg: true`), and the on-screen milestone line correctly shows "עוד 6 ימים לאבן הדרך הבאה —
⭐150" with a rendered gold star, not raw markup. Screenshotted before and after.

Deployed: hosting only, byte-for-byte verified against production after deploy.

---

## Fixed (originally left open for triage, now resolved)

### 1. The sign-up screen's X (dismiss) button overlapped whatever sits at its corner in RTL/Hebrew mode — ✅ Fixed
`.auth-skip` (the X button) was positioned with a hardcoded `right:14px` — it didn't account for RTL
layout, where the elements that are supposed to occupy that same visual corner shift to also want the
right side. Two distinct manifestations of the same root cause, both confirmed via
`getBoundingClientRect()` overlap checks:
- **Full-page boot screen**: the X button overlapped the "← Back" link to the language picker.
- **Gated-action overlay sheet** (`requireRealAccount()`): `.auth-back` is hidden there, but the X
  button instead overlapped the "SideQuest" logo/title text.

**Fix:** added `[dir="rtl"] .auth-skip{right:auto;left:14px}`, matching the app's existing
`[dir="rtl"]` override pattern used for `.chevron`/`.ad-cta svg`/`.ann-card-arrow` elsewhere in the
file — the button now floats to the opposite physical corner in RTL instead of colliding with content
that's also shifted to the right.
**Verified live on the real device** (fresh app-data clear, real relaunch, Hebrew selected): measuring
the actual rendered glyphs (not just the outer flex box, which — discovered while verifying — stretches
to the full row width in both cases since it's a `column`-direction flex child with default
`align-items:stretch`, so a raw bounding-box check alone would have kept reporting a false-positive
overlap) — the back-link's chevron+text render at x:314–360, the skip button now sits at x:14–52, no
overlap. Same result for the overlay sheet: the logo text renders at x:256–360 (via `Range.
getBoundingClientRect()` on the text node), skip button at x:14–52. Deployed and byte-verified live.

### 2. The "missions ready" toast never fully hid on devices with a non-zero top safe-area inset — ✅ Fixed
`.toast`'s hidden resting state relied on a flat `translateY(-90px)` on top of a base
`top: calc(20px + env(safe-area-inset-top))` — on a device with a real inset, the fixed -90px offset
wasn't enough to clear the now-taller base position, leaving ~8px of the pill permanently visible at
the top of every screen.

**Fix:** made the hidden-state offset scale with the same inset instead of being a flat number —
`transform:translateX(-50%) translateY(calc(-90px - env(safe-area-inset-top,0px)))`. The inset now
cancels out of the resting position algebraically regardless of its size (base `top` adds it, the
transform subtracts it), reproducing desktop's already-correct behavior on any device.
**Verified live on the real device**: resting `top`/`bottom` went from `-34px / +8.13px` (visibly
poking through) to `-70px / -27.87px` (fully off-screen), matching desktop's own measurement almost
exactly. Deployed and byte-verified live.

### 3. The floating "+" (create) nav button could visually collide with scrolled page content — ✅ Fixed
The "+" button (`.nav-create`) pokes 20px above the bottom nav bar's own box via a negative top margin
(`margin:-20px 8px 0`) to get its floating look. `.screen` (the scroll container shared by Home,
Ranks, and Profile) reserved a flat `padding-bottom:76px` to keep content clear of the nav bar — sized
for the bar's own height, but not for that extra 20px poke, and not scaling with
`env(safe-area-inset-bottom)` the way the bar's own padding does. On a device with a large gesture-nav
inset, the bar (and the button's poke zone above it) grows taller than the flat 76px reservation,
letting scrolled-to-bottom content (e.g. Profile's empty-state "Upload your first video" CTA) land
underneath the button.

**Fix:** `padding-bottom:calc(76px + env(safe-area-inset-bottom, 0px))` on `.screen` — since 76px
already comfortably exceeds the bar's base height plus the 20px poke (by the same margin the original
flat value had on a zero-inset device), adding the inset on top keeps that same margin at any inset
size instead of only at zero. Fixes the pattern for every `.screen`-based tab (Home, Ranks, Profile),
not just this one CTA.
**Verified live on the real device** (a device with a 48px safe-area-inset-bottom — computed
`padding-bottom` now correctly reads `124px`): scrolled Profile's empty state to its natural rest
position, CTA bottom edge at y:530, nav button top edge at y:710 — a clear ~180px gap, no overlap.
Deployed and byte-verified live.

---

## Checked and confirmed NOT a bug (verified, not just assumed)

- **Room chat floating box appearing to cover the room's "no videos yet" empty-state text**: confirmed
  via `elementFromPoint()` that this is the empty-state text being legitimately covered by the
  intentionally-draggable, intentionally-floating chat panel — expected behavior for a movable overlay
  sitting on top of content, not an unintended collision.
- **GDPR banner and onboarding modal both being `position:fixed` and geometrically "overlapping"**: both
  are full-viewport modals by design, stacked via z-index (GDPR shows first, onboarding follows) — this
  is correct, intentional stacking, not a layering bug. Caught by an automated fixed-element-overlap
  scanner and manually reviewed to confirm it's a false positive of that detection method, not a real
  issue.
- Mission detail modal, Daily Reward modal (after the fix above), Settings, Notifications panel, Search,
  comment sheet (re-confirmed the earlier backdrop fix still holds), and the upload-source picker sheet
  were all screenshotted on the real device and show no overlap issues.

---

## Coverage note

Real device: language picker, full-page auth screen, feed, missions/home, daily reward modal (before
and after the fix), room creation + room chat floating box, profile (including scrolled achievements/
empty-state area), settings, notifications, search, comment sheet, gated-action auth overlay sheet
(as a guest), upload-source picker. Desktop: re-verified every finding above that isn't inherently
screenshot-dependent, using precise DOM measurement instead of relying on the browser pane's screenshot
compositing (which was unreliable this session — noted rather than skipped). Not covered in this pass:
Ranks/leaderboard modal states beyond the base screen, chat/DMs, admin panel, room mission-setting sheet,
follow sheet, block/report sheets, and the account-deletion/edit-profile modals — a follow-up pass could
extend to these if wanted.

All test accounts and their `users/`, `leaderboard/`, `usernames/`, and `rooms/` data created during this
audit were cleaned up via admin CLI afterward. One test account's Firebase Auth record
(`visualaudit0815@example.com`, used for the real-device pass) is still pending deletion — its database
records are already fully removed, but the device disconnected from ADB again before the Auth-record
deletion step could run; low priority since no data is left behind, but worth finishing next time the
device is connected.
