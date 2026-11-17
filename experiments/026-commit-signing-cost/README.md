# 026 — signing a commit costs 8 ms, reading the signature back costs 15

## Problem

A repo can require signed commits (`commit.gpgsign`). The advice online says the
cost is negligible, and the choice between SSH and GPG is usually argued on
setup friction, not on time. An agent that commits in a fresh container never
has a warm `gpg-agent`, and a reviewer or CI gate that checks signatures touches
every commit, not one. Where does the time actually land?

## Hypothesis

Written before the first run: SSH signing adds under 30 ms per commit and stays
flat as the staged tree grows; GPG pays over 250 ms on a cold agent, because the
agent has to start. If GPG cold costs more than 5× SSH, the org mandates
`gpg.format=ssh` for agent commits. The decision it changes: whether signing is
cheap enough to require, and which mechanism to require.

## Method

`bench.js` builds a throwaway repo per case under `/tmp/signbench`, with an
ed25519 SSH key and a passphrase-less ed25519 GPG key generated at start-up.
Four modes — unsigned, `gpg.format=ssh`, GPG with a running agent, GPG with the
agent killed before every commit — across four staged sizes: an empty commit,
1 file, 200 files and 1,000 files of 8 KiB (8 MB). Three runs each; the table
reports the median. `git add` and a `sync` run outside the timer, so the number
is the commit itself. The cold cases record whether the agent was confirmed dead
each run: it was, on all 12.

Then a verification block: 100 SSH-signed commits, timed three ways — a plain
`git log`, `--format=%G?` (which verifies every commit) and
`--show-signature -n 20`. Then a rewrite block: 50 empty commits rebased with
`--root --force-rebase -x true`, unsigned, SSH and GPG.

Noise floor: a bare `git --version` spawn is 1.6 ms, and repeated identical runs
spread by 0.3 ms. The 1,000-file case swings between 13 and 63 ms on this
container's filesystem — the same case, alternating, with `gc.auto` off and
`sync` before the commit — so only the difference between modes is trusted
there. Host: 6 vCPU, Linux 6.12, git 2.47.3, Bun 1.4.4.

## Results

One `git commit`, median of three runs, milliseconds:

| staged           | unsigned | SSH   | GPG warm | GPG cold |
| ---------------- | -------- | ----- | -------- | -------- |
| empty            | 5.6      | 13.2  | 13.7     | 17.9     |
| 1 file           | 5.9      | 13.3  | 14.0     | 18.2     |
| 200 files (1.6 MB) | 16.5   | 24.4  | 24.7     | 29.0     |
| 1,000 files (8 MB) | 62.6   | 70.5  | 71.4     | 75.4     |

The signing tax is flat: SSH +7.3 ms on an empty commit and +7.9 ms on 8 MB;
GPG warm +8.1 and +8.8; GPG with a dead agent +12.3 and +12.8. Starting
`gpg-agent` costs 4.7 ms, not hundreds — the agent is started on demand inside
the same call ([GnuPG manual](https://www.gnupg.org/documentation/manuals/gnupg26/gpg-agent.1.html)).

Reading signatures back, 100 signed commits:

| command                      | total     | per commit |
| ---------------------------- | --------- | ---------- |
| `git log --format=%h`        | 7.6 ms    | 0.08 ms    |
| `git log --format=%h %G?`    | 1,526 ms  | 15.3 ms    |
| `git log --show-signature -n 20` | 306 ms | 15.3 ms    |

`git verify-commit` alone is 17.8 ms per commit, and one bare `ssh-keygen`
spawn is 6.2 ms, so git pays an `ssh-keygen -Y verify` process per commit plus
its own parse.

A rewrite pays the tax per commit, because `commit.gpgsign=true` makes the
rebase sign every commit it writes:

| rebase 50 commits | median  | per commit |
| ----------------- | ------- | ---------- |
| unsigned          | 161 ms  | 3.2 ms     |
| SSH               | 540 ms  | 10.8 ms    |
| GPG warm          | 565 ms  | 11.3 ms    |

## Verdict: PARTIAL

### What worked

- The signing tax is small and flat, as predicted: about 8 ms per commit for
  either mechanism, from an empty commit to 8 MB staged.
- SSH is marginally cheaper than GPG cold (7.3 against 12.3 ms), and it removes
  a daemon from the picture.

### What didn't

- The prediction of over 250 ms for a cold GPG agent was wrong by 20×. A dead
  agent costs 4.7 ms; the 5× rule that would have chosen SSH never fires (1.6×).
  Blogs quote *YubiKey* signing at about 100 ms per signature; that is hardware
  round-trip, and it does not transfer to a file-backed key.

### Surprises

- Verification is the expensive side. `%G?` costs 200× a plain log and grows
  with history: 1.5 s per 100 commits, so 15 s per 1,000. A squash of 50 commits
  costs 380 ms more when signed. Nothing about the commit suggests this.

### Recommendation for the real build

- Require signing; it fits any commit budget. Prefer `gpg.format=ssh`: one less
  daemon, and the same key the agent already uses to push.
- Never gate on `--show-signature` or `%G?` across a long range. Check the tip,
  or cap the range, or let the forge verify at ingest and trust its badge.

## Limits

Passphrase-less keys only: a pinentry prompt would dominate, and none was
measured. ed25519 only, no RSA, no hardware token. GitHub-side verification is
not measured. The 1,000-file absolute numbers carry a 50 ms filesystem swing.
`git add` ran outside the timer, so a tool that stages and commits in one call
pays more than this table shows.
