# Morrow's computer: the E2B template

This folder is the recipe for the computer Morrow's agents use for analysis (profile
`morrow.computer` v1, ADR-0029 item 1; build order PR 8). It is a small Linux image with
Python and its data libraries (numpy, pandas, matplotlib, openpyxl, XlsxWriter), all from
Debian's own signed packages. The recipe adds no browser, no network tool, no compiler and
no secret.

E2B's own build adds things around the recipe. Before it, E2B installs tools of its own
(among them curl, socat, git, iptables, an SSH server and sudo), leaves the root account
with no password, and adds its own user `user`. After it, E2B gives `user` an empty
password and sudo without a password, and lets every user write to `/usr/local`. It is E2B,
not the image, that keeps the sandbox off the internet.

Agent code runs as the user `agent`. As E2B builds it, that would leave easy ways from
`agent` to root. So, just before it switches to `agent`, the recipe closes them: it locks
root's password, lets only root use `su` and `sudo` (so `agent` cannot reach `user`
either), and removes the SSH server. If any of that does not take, the build stops. Build order PR 9's check then tries
each way as `agent` and records the answers (`agent_canary` in `template.json`).

- `e2b.Dockerfile`: the recipe.
- `template.json`: the record of your build. It stays empty until you build, and Claude fills
  it in from what you send back.

**You build it. Claude never does** (ADR-0029 owner question 1). It runs in your own Terminal
with your own E2B login. No key is typed, pasted or saved by these steps: the E2B command line
keeps its own login on your Mac.

## Before you start

- Your E2B project `Morrow-staging` exists, with its US$20 usage limit.
- Node is installed (the same one Morrow uses).
- You are in your Morrow folder, on `main`, after this PR has merged:

```zsh
cd ~/Desktop/Morrow && git switch main && git pull
```

## Build it (about 5 to 10 minutes)

1. Sign in to E2B. A browser window opens; sign in there.

   ```zsh
   npx --yes @e2b/cli@2.22.3 auth login
   ```

2. Check which project the command line uses. It must say `Morrow-staging`.

   ```zsh
   npx --yes @e2b/cli@2.22.3 auth info
   ```

   If it names another project, choose `Morrow-staging`:

   ```zsh
   npx --yes @e2b/cli@2.22.3 auth configure
   ```

3. Build the template, exactly as written (2 vCPU and 1 GiB, as the profile says):

   ```zsh
   npx --yes @e2b/cli@2.22.3 template create morrow-computer-v1 --path infra/e2b/morrow-computer --dockerfile e2b.Dockerfile --cpu-count 2 --memory-mb 1024
   ```

   It ends with a line saying the build of `morrow-computer-v1` finished.

4. List it, and send Claude the part about `morrow-computer-v1` (the template id, the build id,
   the envd version and the date). These are names and numbers, not secrets.

   ```zsh
   npx --yes @e2b/cli@2.22.3 template list --format json
   ```

5. Sign the command line out of E2B again if you like:

   ```zsh
   npx --yes @e2b/cli@2.22.3 auth logout
   ```

The build may use a little of the project's usage. Nothing starts a sandbox yet:
Morrow's runtime switch stays off until the check in build order PR 9 has passed on exactly
this build.

## If something goes wrong

- **"You must be logged in"**: run step 1 again. If E2B's command line still refuses your
  login for builds, stop and tell Claude. The fallback your ADR allows is a build-only E2B key
  that you keep in a file under `~/.config/morrow/staging/` and that only your own builds read;
  Claude then gives you the exact steps. Never paste a key into the chat.
- **The build fails**: send Claude the last 30 lines of the output. Claude changes the recipe
  in a pull request, and you build again. A build that stops at the step with `passwd -l root`
  means E2B changed what its build adds; never remove that step to make the build pass.
- **Never** build from another folder or another copy of the recipe, and never change
  `e2b.Dockerfile` by hand: the record pins this exact file (`recipe_sha256` in
  `template.json`), and any change means a new build and a new check.

## What Claude does with your answer

Claude records the build in `template.json` (the template id, the build id, the envd version
and the date) and pins the template id in the broker. E2B starts a template's newest finished
build, and its documents name no way to start one exact build, so the record's build id is
what Build order PR 9's check compares against: that check runs on made-up data and shows that
nothing inside can reach the internet, that Morrow's code inside cannot read the sandbox's
token or become root (every try in `agent_canary`), and that the time limit kills the
sandbox without pausing it. Only after that can the switch go on. **Never build `morrow-computer-v1` again** outside a reviewed pull request: a
new build replaces what the pin starts, so it needs a new record and a new check.
