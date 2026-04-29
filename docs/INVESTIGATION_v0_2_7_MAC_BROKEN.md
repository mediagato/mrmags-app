# Investigation: v0.2.7 Functionally Broken on Mac

**Date:** 2026-04-29
**Trigger:** Steve smoke-tested v0.2.7 on a borrowed Apple Silicon Mac. Reported:
1. Git install prompt at first launch (unexpected)
2. No menu bar icon visible
3. No memory_save toast / notification
4. App technically running (process visible, HTTP API on `:11436` responsive) but no UI surface

CI was green. Reality was broken. This is the source-side investigation while Steve isn't at the Mac.

---

## Finding 1 (HIGH CONFIDENCE) — Tray icon files are wrong format for Mac

### Evidence

`icon/trayTemplate.png`: **16×16 RGBA**
`icon/trayTemplate@2x.png`: **32×32 RGBA**
`icon/tray.png`: **16×16 RGBA** (used on Win/Linux — fine there)

### Why this breaks on Mac

Mac menu bar template images have specific format requirements:

- **Dimensions:** 22×22 @1x, 44×44 @2x (the "compact" status item size that fits the modern menu bar). 16×16 is too small — Mac does NOT auto-scale up.
- **Content:** **monochrome black on transparent alpha**. The OS uses the alpha channel to render the icon and auto-tints for light/dark menu bar appearance.
- **`setTemplateImage(true)`** tells Mac "treat the alpha channel as the visible mask" — but only works as expected when the source IS actually a monochrome template. Color content + setTemplateImage=true → undefined rendering: silhouette, blank, or blank-but-clickable depending on Mac version.

### Code path

`main.js:168-178` (`trayIconPath()`):
```js
const want = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
```
Returns the path. `nativeImage.createFromPath()` loads it. `setTemplateImage(true)` is set on Mac (line 530-532). Tray is created (line 533).

The fallback `tray.setTitle('Mr. Mags')` (line 538-540) fires ONLY if `iconFile` is null. Since trayTemplate.png exists in the bundle, `iconFile` is non-null, fallback never fires, and Mac is left with a tray that has a malformed template image.

### Plus: dock is hidden

`main.js:475`: `if (process.platform === 'darwin' && app.dock) app.dock.hide();`

This is intentional (menu-bar-only app). But combined with the malformed tray icon, Mr. Mags has **zero visual presence** on Mac:
- No dock icon (intentional)
- No menu bar icon (broken — this finding)
- No window opens automatically until first-run welcome dialog fires (which depends on tray click → showMainWindow)

So the app launches, runs HTTP, but is functionally invisible to the user. Exactly Steve's report.

### Fix

Regenerate the Mac tray template files:

- `icon/trayTemplate.png` — 22×22, monochrome (any single shade — black is conventional), transparent alpha for the rest
- `icon/trayTemplate@2x.png` — 44×44, same content principle

Implementation options:
- **Steve regenerates from the chalkboard design** — keeps UX consistency. He's done the icon design work for v0.2.x; new tray template is a small redo.
- **Auto-derive at build time** — script that takes the colored source icon, converts to grayscale + alpha-only mask, outputs at correct dimensions. Removes the manual step long-term.

Best to ship as a single icon-replacement commit (no code changes needed elsewhere — the `setTemplateImage(true)` call, the path resolution, the fallback are all already correct).

### Verification when Steve has Mac access

```bash
# After fix is applied + new build is installed:

# 1. Confirm template files are correct format
file /Applications/Mr.\ Mags.app/Contents/Resources/app/icon/trayTemplate.png
# Should report: PNG image data, 22 x 22, 8-bit gray+alpha (or similar)

# 2. Confirm a menu bar item registers
osascript -e 'tell application "System Events" to count menu bar items of menu bar 2 of (first process whose name is "Mr. Mags")'
# Should be > 0

# 3. Visual check: open the menu bar, look for the Mr. Mags icon top-right
```

The `gui-smoke-mac` job in `.github/workflows/build-mac.yml` already automates check #2 — once the self-hosted runner is online, the regression catches itself on every push.

---

## Finding 2 (LOWER CONFIDENCE) — Git install prompt is probably NOT from Mr. Mags

### Evidence

Searched `main.js`, `server/`, `lib/` for:
- `spawn`, `exec`, `execSync`, `child_process` invocations → no `git`-related calls
- Direct `'git'` / `"git"` references → none
- `npm install` / postinstall hooks → none at runtime (only at build)
- Auto-update mechanisms → not implemented in v0.2.7

### What likely caused it

Apple's "Install Command Line Developer Tools" prompt fires when ANY process invokes a tool like `git`, `make`, `clang`, `xcrun`, `svn`, etc. — even if the calling process is just running them in a shell or as part of diagnostic exploration.

Most likely scenarios:
- **Steve had Terminal open** during the install/first-launch dance (running `ls`, `which`, etc.) and at some point ran `git` to check something — Apple's prompt fired from THAT, not from Mr. Mags
- **Another app on the Mac** triggered it concurrently (Homebrew install, VSCode, IDE, package manager)
- **A first-launch system check** unrelated to Mr. Mags (less likely — usually only happens on explicit dev-tool invocation)

### Verification when Steve has Mac access

```bash
# Check if CLT is installed (prompt only fires when missing)
xcode-select -p
# Output: /Applications/Xcode.app/Contents/Developer  (CLT installed) — no prompt would fire
# Or:     /Library/Developer/CommandLineTools         (standalone CLT) — no prompt would fire
# Or:     command not found / "no developer tools"   (CLT missing) — prompt CAN fire

# Trace what spawned the prompt by checking install logs around the time
log show --last 30m --predicate 'subsystem == "com.apple.install"' | head -50
log show --last 30m --predicate 'process CONTAINS "Mr. Mags"' | head -50
```

If the second `log show` (filtered to Mr. Mags processes) shows NO references to git/clt around the prompt time, the prompt was from elsewhere — not Mr. Mags's fault. Confirms the hypothesis.

### Conclusion

Don't fix what isn't broken. If the prompt fires again on a clean Mac (no Terminal activity), then look harder. For now the missing-tray-icon (Finding 1) is the real bug.

---

## Finding 3 (DEFERRED) — No notification toast

Steve reported never seeing the bottom-of-screen toast that confirms `memory_save` fired. Two possibilities:

1. **macOS notification permission was never requested** — first-launch notification needs explicit permission via Apple's API. If we never ask, all `Notification` API calls fail silently.
2. **Notification API works but is racing the close-of-window** — toast appears, then immediately disappears, user doesn't see it.

Without Mac access I can't tell which. **Deferred until Steve verifies**: launch v0.2.7 on Mac, save a memory through Claude, watch the macOS Notification Center (top-right) for any new entry. If nothing in Notification Center either → permission issue. If it's there but transient → race condition.

The fix path differs by which one — let's wait for the data point.

---

## Compounded effect

Together, these findings explain the full "v0.2.7 looks dead on Mac" experience:

- App launches successfully (HTTP works, MCP works — both confirmed by /health responding)
- Dock icon hidden by design
- Tray icon malformed → invisible (Finding 1)
- No notifications visible (Finding 3, hypothesis)
- → User sees nothing happening

Fix Finding 1 first (icon regeneration) — that alone should restore the menu bar interaction surface and make the app usable. Finding 3 follows once Steve can verify.

---

## When Steve is back at the Mac

Order of operations:

1. Verify Finding 1 is the issue: run the `osascript` count check above — expect 0 currently
2. Apply the fix (icon regeneration, single-commit update to mrmags-app, new build, install)
3. Re-run the smoke test from `c:/tmp/wayslap_mockup_*` style — should now show a menu bar icon
4. Verify Finding 2: run `xcode-select -p` to confirm CLT state, decide whether the git prompt is real
5. Verify Finding 3: trigger a memory_save via Claude, watch Notification Center
6. Register the borrowed Mac as a self-hosted GHA runner per [`SELF_HOSTED_MAC_RUNNER.md`](SELF_HOSTED_MAC_RUNNER.md) so this regression class never ships uncaught again

The `gui-smoke-mac` job in `.github/workflows/build-mac.yml` (gated `workflow_dispatch` until the runner exists) does the NSStatusBar count assertion automatically once you flip its `if:` to `push`.

---

## Related

- `docs/SMOKE_TEST_GAPS.md` — why this got through CI
- `docs/SELF_HOSTED_MAC_RUNNER.md` — the runner setup that catches the regression class
- Memory: `handoff_2026_04_29_morning_mac_broken.md` — the original incident report
