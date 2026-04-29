# Smoke Test Gaps — Why v0.2.7 Mac-Broken Got Through CI

## What happened

On 2026-04-29 morning, Steve smoke-tested Mr. Mags v0.2.7 on a borrowed Apple Silicon Mac. The build had passed CI on `macos-latest` cleanly. Real-user experience:

1. **Git install prompt at first launch** — macOS demanded Command Line Developer Tools because the app spawned `git` somewhere
2. **No menu bar icon** — the tray surface that's the entire interaction model on Mac never appeared
3. **No memory_save notifications** — the bottom-of-screen toast confirming brain ate a memory never fired
4. **App technically running** — process visible in `ps`, HTTP API on port 11436 responsive, but GUI surface entirely missing

CI was green. Reality was broken. Why?

## Root causes of the gap

### 1. CI tests the binary, not the GUI

The existing `build-mac.yml` smoke job tests:
- HTTP API up at `localhost:11436/health` ✓
- MCP relay spawns and answers `tools/list` with `memory_save` ✓
- Memory write + read round-trip via HTTP ✓

It does NOT test:
- Whether the menu bar icon (NSStatusItem) registered correctly
- Whether the user can interact with the app (no UI assertions)
- Whether macOS Notification Center permissions were requested / granted
- Whether the app launches without firing OS-level prompts (Command Line Tools, accessibility, etc.)

A build where the binary process boots and the HTTP server comes up but the tray icon registration silently fails will pass smoke and fail in front of users — exactly v0.2.7's failure mode on Mac.

### 2. GHA Mac runners come with Xcode Command Line Tools pre-installed

Apple's macOS images for GitHub Actions ship with the full developer toolchain baked in — `git`, `make`, `clang`, the works. So if Mr. Mags spawns `git` indirectly (probably via electron-updater or an npm dep that shells out for some metadata), the call succeeds silently on GHA.

On a fresh user Mac that doesn't have Xcode CLT, the same call triggers Apple's "Install Command Line Developer Tools?" dialog, blocking the user with a prompt nobody told them was coming. This is the classic CI-environment-vs-user-environment divergence.

### 3. GHA `macos-latest` lags behind current macOS

`macos-latest` is currently macOS 14 Sonoma; macOS 15 Sequoia (released fall 2025) is `macos-15`. Apple Silicon Macs that have updated to Sequoia are running:

- Different Gatekeeper UI flows (Path B "Open Anyway" path, not Path A "right-click → Open")
- Updated NSStatusItem registration semantics
- Stricter notification permission model

If a tray icon registration regression specifically affects Sequoia 15+, our `macos-latest` smoke would not catch it because we're testing on Sonoma.

## What would have caught these bugs

### Catches the GUI-invisible class

Add to the smoke test, post-launch:

```bash
# Verify the tray icon registered. Probes NSStatusBar items via osascript.
ITEM_COUNT=$(osascript -e 'tell application "System Events" to count menu bar items of menu bar 2 of (first process whose name is "Mr. Mags")' 2>/dev/null || echo "0")
[ "$ITEM_COUNT" -gt "0" ] || { echo "FAIL: Mr. Mags menu bar icon not present"; exit 1; }
echo "✓ menu bar icon registered ($ITEM_COUNT items)"
```

### Catches the unexpected-prompt class

Trace `git` invocations during launch and assert none fired:

```bash
# Wrap the binary so we know if it spawned git
fs_usage -w -f exec -t 30 -p $(pgrep -f "Mr. Mags") | grep -E "(git|xcrun|svn)" > /tmp/fs.log &
FS_PID=$!
open -n "/Applications/Mr. Mags.app"
sleep 25
kill $FS_PID 2>/dev/null
[ ! -s /tmp/fs.log ] || { echo "FAIL: app spawned unexpected dev-tool process"; cat /tmp/fs.log; exit 1; }
echo "✓ no unexpected git/xcrun/svn invocations"
```

`fs_usage` requires sudo on macOS — needs adjustment for unprivileged runs. Alternative: run the app under `dtruss` or a custom env where PATH points to instrumented stubs that log calls.

### Catches Sequoia-specific regressions

Add a second smoke job targeting `macos-15` (or the self-hosted runner if it's on Sequoia):

```yaml
smoke-sequoia:
  runs-on: [self-hosted, macOS, ARM64, real-mac]
  needs: build-mac
  steps:
    # download .dmg artifact from build-mac, run same smoke + GUI assertions
```

The self-hosted runner on Elizabeth's borrowed Mac (per `SELF_HOSTED_MAC_RUNNER.md`) gives us this for free, in a real user env without Xcode CLT, on whatever macOS version that machine is running.

## Action items

1. Extend `build-mac.yml` smoke job with NSStatusBar item count check (5 lines, catches the most visible bug class)
2. Add a `git`-invocation tracer (medium-effort, surfaces the dev-tool prompt before it bites users)
3. Stand up the self-hosted runner per `SELF_HOSTED_MAC_RUNNER.md` (~10 min once token issued)
4. Add a parallel smoke job targeting the self-hosted runner — same .dmg, real env (same number of lines)

Per `feedback_test_one_first` — start with item 1 (smallest, most diagnostic), verify it actually fails on a known-broken build, then layer the rest.

## Larger lesson

Build-success ≠ install-success ≠ functional-success. We learned this on Win during the v0.2.x marathon (asar packaging breaking MCP spawn, frozen `confirm()` dialogs, stale PGlite locks). The same lesson on Mac with different specifics. The pattern is: every CI environment has invisible affordances that mask bugs only real-user environments expose.

The right architecture is layered smoke:

- **Layer 1: Build smoke** — does the binary compile and ship? (`macos-latest` does this)
- **Layer 2: Process smoke** — does the binary launch and answer HTTP/MCP probes? (current `build-mac` does this)
- **Layer 3: GUI smoke** — does the tray icon appear, do notifications fire, does the user have something to click? (gap until we add it)
- **Layer 4: Environment smoke** — does this work on a fresh user Mac with no developer tools and modern macOS? (gap until self-hosted runner ships)

Each layer catches a different class of bug. Skipping any layer means the bugs in that class ship.

## Related

- `docs/SELF_HOSTED_MAC_RUNNER.md` — Layer 4 plan
- Memory: `handoff_2026_04_29_morning_mac_broken.md` — incident report
- Memory: `project_mrmags_followups.md` (item 3) — testlab smoke harness, originally framed for Win, applies equally to Mac
