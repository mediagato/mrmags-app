# Self-Hosted Mac Runner — Setup

The borrowed family Mac (Apple Silicon, kept on 24/7) hosts a GitHub Actions runner so we can smoke-test Mr. Mags in a real user environment on every push. Complements the GHA-hosted `macos-latest` runner without replacing it.

## Why

The CI smoke test on `macos-latest` validates the binary (HTTP API, MCP relay, memory round-trip) but not the GUI surface. The v0.2.7 install-success-but-functionally-broken bugs (git prompt, missing menu bar icon, no notifications) passed CI cleanly because:

- GHA runners ship with Xcode Command Line Tools pre-installed → masks anything in the app that spawns `git` indirectly
- GHA `macos-latest` lags behind current macOS → Sequoia 15+ tray-icon-registration regressions invisible
- Smoke job tests the binary's HTTP/MCP surface, not whether menu bar icons render

Self-hosted runner on a real personal Mac surfaces all three.

## Prerequisites

- The Mac is on, signed in to a regular user account (Elizabeth's), kept awake (no sleep on power)
- macOS 14 Sonoma or 15 Sequoia (or current Tahoe by the time you're reading this)
- Apple Silicon (M-series)
- Network reaches `api.github.com` (default — outbound HTTPS, no inbound port)
- ~500MB disk free for the runner + ~5GB for build artifacts during smoke runs

## Setup steps

Run these from Terminal on the Mac, signed in as the user the runner will run as.

### 1. Get the registration token

On your laptop (not the Mac):

1. Go to https://github.com/mediagato/mrmags-app/settings/actions/runners
2. Click **New self-hosted runner**
3. Select **macOS / ARM64**
4. Copy the `--token` value from step 2 of GitHub's instructions (it's a long string starting with `A...`)
5. The token is single-use and expires in ~1 hour, so do this right before step 3 below

### 2. Open Terminal on the Mac

(If Terminal isn't on the Dock, hit cmd+space and type "Terminal", press enter.)

### 3. One-paste install

Once you have the token from step 1, paste this single block into Terminal — replace `PASTE_TOKEN_HERE` with the real value:

```bash
TOKEN=PASTE_TOKEN_HERE \
  bash <(curl -fsSL https://raw.githubusercontent.com/mediagato/mrmags-app/main/scripts/setup-mac-runner.sh)
```

The script downloads the latest GHA runner (currently v2.334.0), unpacks under `~/actions-runner`, configures it for `mediagato/mrmags-app` with name `elizabeth-mac` and labels `self-hosted,macOS,ARM64,real-mac`, installs as a user-mode launchd service, starts it, and prints status.

If you'd rather see each step manually, the script is short — read it before pasting.

### 4. Verify the runner registered

Back on https://github.com/mediagato/mrmags-app/settings/actions/runners — `elizabeth-mac` should appear with a green dot.

### 5. Set the Mac to never sleep

System Settings → Battery (or Energy) → Power Adapter → enable **Prevent automatic sleeping when display is off** and **Wake for network access**. This is per-power-source on laptops, so make sure it's set for the source the Mac actually runs on (probably "Power Adapter" if it stays plugged in).

The screen sleeping is fine; the Mac itself sleeping is not.

## Targeting the runner from a workflow

The runner advertises labels `self-hosted, macOS, ARM64, real-mac`. To run a job on it, the workflow's `runs-on` block uses those labels:

```yaml
jobs:
  realistic-mac-smoke:
    runs-on: [self-hosted, macOS, ARM64, real-mac]
    steps:
      - uses: actions/checkout@v4
      # ... etc
```

The existing `build-mac` job stays on `macos-latest` (GHA-hosted) for clean-environment build verification. The new smoke job (when it ships) targets `real-mac` for environment-realism testing. Both run; both must pass.

## Maintenance

- **Runner auto-updates** — GitHub pushes new versions periodically; the runner detects and updates itself. No manual intervention needed.
- **Logs** — `~/actions-runner/_diag/` for runner-side, GitHub Actions UI for job-side.
- **First-launch security prompts on Mac** — first time a job installs the .dmg under Applications, macOS may prompt for permission. Approve once; future runs are silent. Captured in the smoke job's expected first-time noise.
- **Quarantine flag** — the smoke test strips it via `xattr -dr com.apple.quarantine` before launching the bundled .app. No need to touch Gatekeeper UI.

## Removing the runner

If you ever need to nuke it cleanly:

```bash
cd ~/actions-runner
./svc.sh stop
./svc.sh uninstall
./config.sh remove --token NEW_TOKEN_FROM_GITHUB_SETTINGS
cd ~ && rm -rf ~/actions-runner
```

GitHub Settings → Actions → Runners — the entry will disappear after `config.sh remove`.

## Troubleshooting

### Runner shows up offline in GitHub UI

`./svc.sh status` shows the launchd service. If it says `Stopped` or errors:

```bash
launchctl list | grep actions
# If you see it but with status not 0, check the log
tail -100 ~/actions-runner/_diag/Runner_*.log
```

Common causes:
- Mac was offline at registration — restart Wi-Fi, run `./svc.sh start`
- User logged out — run a job under user-mode service requires the user to be logged in. Switch to that user.

### Job hangs on macOS security prompt

First time a job tries to install Mr. Mags under /Applications, macOS may show a "Terminal wants access to..." dialog. Click Allow once. Future runs use the cached permission.

If the prompt is sitting there with nobody to click it, the job times out. Solution: log in as the runner's user, run the job manually once to clear all prompts, then re-enable hands-off mode.

### Runner stops working after macOS update

macOS updates can occasionally break service registrations. After an update:

```bash
cd ~/actions-runner
./svc.sh start
./svc.sh status
```

If still broken, uninstall + reinstall the service:

```bash
./svc.sh uninstall
./svc.sh install
./svc.sh start
```

## Privacy / what the runner does

- Polls `api.github.com` for queued jobs every few seconds (long-poll, not constant traffic)
- Downloads workflow definitions + source code when a job runs (the public mrmags-app repo only — runner is repo-scoped)
- Runs build/install/smoke commands inside `~/actions-runner/_work/` — isolated from the rest of the Mac
- Has access to whatever secrets the workflow declares (currently CLOUDFLARE_API_KEY etc. for tag-triggered publish — irrelevant for smoke jobs)
- Uses ~30MB RAM idle, spikes during job runs

It does NOT:
- Read user files outside the work directory
- Install kernel extensions, system services beyond the launchd entry
- Send telemetry beyond the GitHub long-poll
- Have network listening ports

## Related

- `.github/workflows/build-mac.yml` — existing build + smoke (runs on `macos-latest`)
- `docs/SMOKE_TEST_GAPS.md` (when authored) — analysis of why v0.2.7 Mac-broken bugs passed CI
- Memory: `handoff_2026_04_29_morning_mac_broken.md` — context for why this runner exists
