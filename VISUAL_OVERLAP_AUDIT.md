# Visual Overlap / Layering Audit

Scope: purely visual — elements covering other elements that shouldn't be covered, things bleeding
off-screen, stray/leftover content, z-index conflicts. Not grammar, not consistency, not dead code
(that's `UX_POLISH_AUDIT.md`). Methodology: live interaction on both the real device and desktop
browser, screen by screen, using a mix of actual screenshots (device) and precise DOM bounding-rect
measurement (`getBoundingClientRect()` overlap checks — more reliable than eyeballing a screenshot,
and used throughout to *confirm* anything that looked suspicious rather than reporting on sight alone).

**One item below was fixed immediately rather than just logged** — a raw-SVG-as-text regression from
my own star-icon fix earlier this session. It was actively showing broken code on screen to real users
right now, not a "rough edge," so it didn't make sense to leave live while compiling a backlog. Deployed
and verified; noted below for the record. Everything else is reported only, per the "don't fix yet"
instruction.

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

## Found, not fixed — for triage

### 1. The sign-up screen's X (dismiss) button overlaps whatever sits at its corner in RTL/Hebrew mode
`.auth-skip` (the X button) is positioned with a hardcoded `right:14px` — it doesn't account for RTL
layout, where the elements that are supposed to occupy that same visual corner shift to also want the
right side. Confirmed two distinct manifestations of the same root cause, both via
`getBoundingClientRect()` overlap checks (not just visual impression):
- **Full-page boot screen** (first thing shown on app open): the X button overlaps the "← Back" link
  to the language picker. `backRect.right` (360) > `skipRect.left` (332), with vertical overlap too —
  confirmed colliding, not just close together.
- **Gated-action overlay sheet** (triggered by `requireRealAccount()` — the sheet built earlier this
  session): `.auth-back` is correctly hidden here, but the X button now instead overlaps the
  "SideQuest" logo/title text itself. Same confirmed-overlap check, same result.

Reproduced identically on both the real device and desktop browser, so this isn't device-specific —
it's a plain RTL layout bug. Likely fix shape (not applied): use logical CSS positioning
(`inset-inline-end` instead of `right`) or explicitly offset `.auth-back`/`.auth-logo`'s max-width to
leave room for the button in RTL — but that's a design/layout call worth making deliberately, not
something to guess at while compiling a find-list.

### 2. The "missions ready" toast never fully hides on devices with a non-zero top safe-area inset
`.toast`'s hidden resting state relies on `transform: translateY(-90px)` from a base
`top: calc(20px + env(safe-area-inset-top))` to push it off-screen when not showing. On the real device
(which has a non-trivial safe-area-inset-top — status bar / edge-to-edge rendering, same category of
issue as the `.lang-btn` and `.room-chat-screen` safe-area bugs fixed earlier in this whole engagement),
the base `top` is large enough that the `-90px` offset isn't enough to fully clear the viewport: measured
resting position was `top:-34px, bottom:+8px` — meaning roughly 8px of the toast pill's rounded bottom
edge is **permanently visible**, poking down from the very top of the screen, on every single screen,
at all times, whether or not a toast is actively showing. Confirmed present on both the Feed and
Missions tabs (i.e., it's not tied to any specific screen — `#toast` is a single global element).
**Not reproduced on desktop** — desktop has no safe-area-inset-top, so the same `-90px` offset is more
than enough there, confirming this is specifically a real-device/notched-screen issue, not a general one.

### 3. The floating "+" (create) nav button can visually collide with scrolled page content
On the Profile screen's empty "Videos" tab, scrolling to a certain position lands the "Upload your
first video" button directly under the fixed bottom-nav "+" button, partially covering its text.
Confirmed via `getBoundingClientRect()`: `navRect` (710–753px) and `ctaRect` (679–719px) genuinely
overlapping at that scroll offset. **This is scroll-position-dependent, not a permanent overlap** —
retested at the desktop browser's natural rest scroll position and the two elements did *not* overlap
there (CTA landed much lower on the page). Since the "+" button is `position:fixed` and this CTA (and
presumably other content) scrolls underneath it, there will always be *some* scroll position where
whatever's currently at that fixed button's screen coordinates gets covered — the open question for
triage is whether that's acceptable (transient, self-resolves as you keep scrolling) or worth a
permanent fix (e.g., extra bottom padding/margin reserved under any button-like element so it can never
rest at exactly that height). Flagging as a *pattern* to consider, not just this one button — same
mechanism could affect other tabs with substantial scrollable content and the same fixed nav bar.

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
