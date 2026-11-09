# ADR 002: Credential Migration, Rotation and Recovery

* **Status:** Accepted
* **Date:** 2026-11-09
* **Packet ID:** F04 (credential recovery)
* **Deciders:** Modernization Taskforce / Lead Architect
* **Consulted:** Security & Quality Leads
* **Related:** [CREDENTIAL_STORE_HANDOFF.md](../../compliance/ferpa/CREDENTIAL_STORE_HANDOFF.md), ADR 001

---

## Context and Problem Statement

The credential re-port replaced the fixed `root`/`root` SurrealDB password with a per-install random one. It left one case unresolved: a datastore created by an older build has no `secrets.json`, and SurrealDB applies initial root credentials **only** when no root user exists yet. A freshly generated password therefore has no effect on an upgraded datastore.

The previous behaviour was to reuse the historical `root` password indefinitely. That cannot stand: it leaves every upgraded installation running on a password published in this repository, and it makes the store unable to distinguish "legitimately uses the development default" from "upgrade that was never migrated".

This ADR defines the migration, rotation, failure and recovery behaviour **before** any credential code changes, and is the acceptance matrix against which the implementation is tested.

## Decision Drivers

1. **No silent fallback to a default credential.** No cell may resolve to `root`.
2. **No lockout.** A datastore must never end up with a password that no component knows.
3. **Ordering matters.** Rotation must commit before the new password is persisted; persisting first destroys the only reference to a password the datastore does not yet accept.
4. **Crash safety.** A crash at any step must be recoverable on the next launch without operator intervention or data loss.
5. **Actionability.** Every stopping path names the condition and what the operator must do.

## Verified SurrealDB 2.6.5 behaviour

Established empirically against the pinned runtime before designing (see [Verification](#verification)):

| Observation | Consequence for the design |
| --- | --- |
| Starting an existing datastore with `--user`/`--pass` logs *"Credentials were provided, and no root users were found"* only when creating root; otherwise the flag is ignored and the server starts normally | Starting the server is safe and non-destructive; it is not how the password is discovered |
| `POST /sql` with no credentials returns `403` | An unauthenticated probe cannot be mistaken for success |
| `POST /sql` with a wrong password returns `401` | Wrong password is distinguishable from unreachable |
| `DEFINE USER OVERWRITE root ON ROOT PASSWORD '…' ROLES OWNER` succeeds and the **old** password immediately returns `401` while the new one returns `200` | Rotation is atomic and effective; it is the correct primitive |
| The datastore directory contains `test.db/` plus `LOG`, `CURRENT`, `IDENTITY` | Datastore presence is already detected correctly |

`403` and `401` must both be treated as "these credentials do not authenticate"; a connection error is a different outcome and must not be retried as if it were an auth failure.

### `/sql` media types decide whether a statement runs at all

The `/sql` endpoint selects a *dialect* from the request media types, and only one combination executes raw SurrealQL:

| `Content-Type` | `Accept` | Result |
| --- | --- | --- |
| `text/plain` | `application/json` | The statement executes and the results come back as JSON. **This is the only combination the migration uses.** |
| `text/plain` | `*/*` | `415 Unsupported Media Type` |
| `application/json` | any | `200` with the statement echoed back and `status: "OK"` — **the statement is not executed** |

The third row is the dangerous one: a "successful" rotation that returns `200` while doing nothing would leave the launcher believing the datastore holds the provisioned password when it still accepts the old one. `postSurrealSql` therefore pins both headers explicitly and never sends `application/json` as the request type. Any future change to those two headers must be re-verified against a live server, not against a mock.

The probe statement is `INFO FOR ROOT;` — `SELECT 1` is not valid SurrealQL and fails with a parse error that would otherwise be misread as an authentication failure.

## The Matrix

Rows are the datastore state; columns are what happens when the migration attempts authentication. Every cell terminates in **started with provisioned credentials** or **stopped with an actionable message**. There is deliberately no cell that starts on `root`.

| Datastore | `secrets.json` | `root` authenticates | `root` rejected | Datastore unreachable |
| --- | --- | --- | --- | --- |
| Absent | absent | n/a — no legacy state; **generated** path creates a password and starts | — | — |
| Present | valid | **stored** | **stored** | **stored**; the password is known, so start and let the service report reachability |
| Present | absent | **MIGRATE** — provision, rotate, persist, start | **STOP**: `legacy-unmigrated` with "the existing datastore does not accept the legacy credential; an operator must supply the current password" | **STOP**: "the datastore exists but could not be reached to migrate it" |
| Present | corrupt | **STOP**: `invalid-secrets-file`, file left untouched — it may hold the only copy | same | same |
| Present | wrong password (valid file, password rejected) | **STOP**: `invalid-secret-value` is *not* raised here; the file decodes, so the condition is "stored credential rejected by the datastore" and the backend reports it | same | start; the password is known |

Notes on the two cells that use up their whole column: a corrupt or undecodable `secrets.json` is never repaired, rewritten or bypassed. It may be the only remaining record of a password the datastore still accepts, so overwriting it converts a recoverable problem into a permanent lockout. This holds even when `root` would authenticate, because a `root`-authenticating datastore plus an unreadable secrets file is precisely the state where an operator is most likely to need the bytes.

## Migration sequence

Ordering is the whole decision. The new password is persisted to a **recovery file before rotation**, not after:

1. Generate a 24-byte base64url password.
2. Write `.migration-pending` — obfuscated and ACL-restricted to the current user — containing that password.
3. Start SurrealDB.
4. Authenticate with the legacy `root` credential. If this fails, stop; the datastore is untouched and `.migration-pending` is discarded.
5. `DEFINE USER OVERWRITE root ON ROOT PASSWORD '<new>' ROLES OWNER`.
6. Write `secrets.json` with the new password.
7. Delete `.migration-pending`.

Why step 2 precedes step 5: a crash between rotation and persisting would otherwise leave a datastore whose password exists only in a destroyed variable — an unrecoverable lockout. With the recovery file, the window is covered.

### Crash safety of each step

| Crash point | On-disk state | Next launch |
| --- | --- | --- |
| After 2, before 5 | Recovery file present, datastore still on `root`, no `secrets.json` | `root` still authenticates; retry the migration. The stale recovery file is overwritten. **Idempotent.** |
| Between 5 and 6 | Recovery file present, datastore on the **new** password, no `secrets.json` | `root` no longer authenticates, but the recovery file holds the new password: complete by writing `secrets.json` and deleting the recovery file. **Recovered.** |
| Between 6 and 7 | `secrets.json` valid, stale recovery file | Resolve as `stored`. The recovery file is stale because `secrets.json` already exists; delete it. **No-op with cleanup.** |
| After 7 | `secrets.json` valid, no recovery file | Resolve as `stored`. **No-op.** |

The `.migration-pending` file must never override a valid `secrets.json`. Its only roles are to complete an interrupted rotation and to be discarded otherwise.

### Idempotency

A migrated install resolves as `stored` on every subsequent launch: `secrets.json` exists, so the legacy-unmigrated path is never entered. A second migration therefore cannot run. Running the migration twice from a clean legacy state produces one rotation and one `secrets.json`.

## Consequences

**Positive.** Upgraded installations reach a per-install password with content intact. No path produces `root`. Every failure stops with a message naming the condition. A crash at any point is recoverable.

**Negative.** Migration requires the datastore to be reachable at first launch after upgrade, so an upgrade with the service down stops instead of starting and healing later. This is accepted: starting on an unknown credential is the outcome being eliminated. Recovery requires the recovery file, which is per-install and not backed up; an operator who deletes both `secrets.json` and `.migration-pending` after a rotation-in-flight crash must supply the password by hand.

**Neutral.** The `legacy-unmigrated` source remains in the contract as the *input* to migration and as the failure message for the rejected cell. It is no longer a terminal state.

## Verification

The SurrealDB rows above were confirmed against `surrealdb 2.6.5 for windows on x86_64`, downloaded from the URL and matched against the SHA-256 in `scripts/prepare-runtime.js`:

```text
DD9B6FA15EDACBDE96D490DD5727B49B5CF40DF80F29074C7DC17ACB974F509F  surreal.exe
```

Rotation was verified by observing `INFO FOR ROOT` return `200` with the new password and `401` with the old one after `DEFINE USER OVERWRITE`.

The implementation is tested against a **real** datastore created by the legacy code path, asserting row sequence and content preservation, not against a mock.
