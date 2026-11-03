# AGENTS INSTRUCTIONS FOR ANDROID STUDIO

## ACTIVE PRIORITY
Currently executing **Packet L7.4** (`38_gemini_3.1_pro_L7_4_build_a_discrete_go_or_c_helper_only_if_the_boundary_is_simpler_than_h.md`).
Assigned model: **gemini-3.1-pro**.

Read and execute the instructions specified in:
`file:///home/mars/StudioProjects/Office-Equity-Open-Notebook/.agent/CURRENT_TASK.md`

## MECHANICAL VERIFICATION RULES
1. Never guess build or test outcomes.
2. Run mechanical checks after every file edit:
   `export PATH="$PWD/.local_tools/node-v22.14.0-linux-x64/bin:$PATH"`
   `npm run build:types`
3. Keep diffs strictly focused on this packet's deliverables.

---

# CODX BRIDGE WORKFLOW (GitHub offboarding)

## Context
This checkout has NO GitHub connection (edu account: no github/copilot access).
GitHub Copilot (the "bridge agent") reviews and publishes our work. Do NOT
attempt `git push` to any HTTPS/SSH remote; there is no remote access. All
publishing happens through the bridge agent in the Copilot worktree at:
`C:\Users\cruzmars\copilot-worktrees\Office-Equity-Open-Notebook\oe-marscruz-sturdy-pancake`

## Branch rules
1. NEVER commit to `main` directly. `main` is a read-only sync target.
2. Create a new branch for every task: `codex/<short-kebab-topic>`
   Example: `codex/fix-port-conflict-recovery`
3. One logical task per branch. Do not mix unrelated changes.
4. Branch off current `main`: `git switch -c codex/<topic> main`

## Commit rules
1. Commit early and often; small atomic commits with clear messages.
2. Message format: `type(scope): short imperative summary`
   Types: feat, fix, docs, chore, refactor, test, ci
   Example: `fix(api): recover from port conflict during SSE reconnect`
3. Do not include secrets, credentials, API keys, or tokens in code or commits.
4. Do not amend or rebase branches once a bridge sync has been announced
   (Copilot may have already fetched them). If you must revise, add new
   commits on top of the branch instead.

## Commit trailer
Append this trailer to every commit message body:
`Co-authored-by: Codex (local bridge) <noreply@openai.com>`

## Mechanical verification (mandatory before requesting bridge review)
1. `npm run build:types` must pass with zero errors.
2. `node scripts/orchestrator/verifier.js` must pass all suites.
3. Never report success without having actually run the command.

## Requesting bridge sync
When a task is done and verified:
1. `git fetch origin` is NOT possible (no network). Skip it.
2. Announce: branch name, one-line task summary, verification result.
3. STOP. The bridge agent does the rest (fetch, review, verify, PR, merge).

## Receiving bridge results
The bridge agent merges our branches into GitHub `main` via pull requests.
To pull merged results back into this checkout, ask the user to say
"sync from bridge" — the user or bridge agent will run:
   `git fetch codex-origin` (or an equivalent local fetch)
   `git switch main`
   `git merge --ff-only <updated-main-ref>`
Do not guess remote names. Wait for explicit sync instruction.

## Never do
- Do not `git push` to origin/upstream (will fail; no network/auth).
- Do not edit files under `docs/compliance/` unless the task explicitly says so.
- Do not modify `.agent/CURRENT_TASK.md` or `.agent/autopilot/` unless instructed.
- Do not run destructive commands: `git reset --hard`, `git clean -fdx`,
  `git filter-branch`, or anything rewriting shared history.
