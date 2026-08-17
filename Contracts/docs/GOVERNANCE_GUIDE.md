# MultisigTreasury Governance Guide

This guide defines how the hardened `MultisigTreasury.sol` is governed: which
operations require which approval level, how the timelock works, how to run a
proposal end-to-end, and how to respond to emergencies.

## 1. Approval model

Every transaction is classified into one of four tiers at execution time. The
classification is deterministic (based on the calldata selector for self-calls
and on `value > threshold` for transfers), so the required confirmation level
can never be gamed by reordering.

| Tier        | Operations                                                        | Confirmations              | Timelock | Error when unmet                   |
| :---------- | :---------------------------------------------------------------- | :------------------------- | :------- | :--------------------------------- |
| Ordinary    | Transfers with `value <= threshold`                               | 1                          | No       | `requires at least one confirmation` |
| Large       | Transfers with `value > threshold`                                | `required`                 | Yes      | `insufficient confirmations for large tx` |
| Sensitive   | `updateLimits`, `updateTimelock`, `updateSensitiveRequired`       | `sensitiveRequired`        | Yes      | `insufficient confirmations for sensitive action` |
| Emergency   | `emergencyFreeze`, `unfreezeInternal`                             | All owners (unanimous)     | No       | `insufficient confirmations for emergency action` |

### Constructor invariants

- `0 < required <= owners.length`
- `required <= sensitiveRequired <= owners.length`
- `1 day <= timelockDelay <= 7 days`

`sensitiveRequired` is therefore always **at least** as strict as the base
multisig threshold, and the recommended production value is unanimous approval
(`sensitiveRequired == owners.length`).

## 2. Timelock rules

- `timelockDelay` is bounded to **1–7 days** (`MIN_TIMELOCK_DELAY` /
  `MAX_TIMELOCK_DELAY`). Values outside this range are rejected at deployment
  and by `updateTimelock`.
- Every proposal records `minExecuteTime = submission timestamp + timelockDelay`.
- **Timelocked operations** (large transfers, sensitive changes) revert with
  `timelock not elapsed` until `block.timestamp >= minExecuteTime`.
- **Emergency operations bypass the timelock** so a freeze can take effect the
  moment all owners confirm — but they pay for that speed with unanimity.
- Ordinary transfers (≤ threshold) execute immediately after one confirmation.
- Changing `timelockDelay` only affects **new** proposals; pending proposals
  keep their original `minExecuteTime`.

## 3. Proposal lifecycle (runbook)

Proposals are executed through the treasury itself, so all steps are
on-chain, auditable, and event-logged.

### 3.1 Propose

Any owner submits the transaction:

```js
// Large transfer (timelocked, requires `required` confirmations)
await treasury.connect(owner).submitTransaction(recipient, value, "0x");

// Sensitive parameter change (timelocked, requires `sensitiveRequired`)
const data = treasury.interface.encodeFunctionData("updateLimits", [daily, weekly, threshold]);
await treasury.connect(owner).submitTransaction(treasury.address, 0, data);
```

Emits `SubmitTransaction(owner, txIndex, to, value, data, minExecuteTime)`.

### 3.2 Confirm

Each owner calls `confirmTransaction(txIndex)`. Confirmations are tracked per
proposal and can be revoked with `revokeConfirmation(txIndex)` (while
unfrozen). While the treasury is frozen, **only unfreeze proposals** can be
confirmed.

### 3.3 Wait for the timelock

For timelocked operations, wait until `minExecuteTime`. Monitor proposals:

```js
const tx = await treasury.getTransaction(txIndex);
// { to, value, data, executed, numConfirmations, created, minExecuteTime }
```

### 3.4 Execute

Any address can execute a fully-approved proposal once the timelock has
elapsed. The execution flow validates state consistency **before** (tier
classification, confirmations, timelock, spending limits, structural
invariants) and **after** (re-checks invariants and that the proposal is still
marked executed — i.e. no reentrant corruption).

```js
await treasury.connect(anyone).executeTransaction(txIndex);
```

## 4. Emergency procedures

### Freeze (no timelock, unanimous)

```js
const data = treasury.interface.encodeFunctionData("emergencyFreeze");
const idx = await treasury.connect(owner0).submitTransaction(treasury.address, 0, data);
await treasury.connect(owner1).confirmTransaction(idx);
await treasury.connect(owner2).confirmTransaction(idx);
await treasury.connect(owner0).executeTransaction(idx); // immediate
```

While frozen:

- Non-unfreeze execution reverts with `frozen`.
- Non-unfreeze confirmations revert with `frozen` (only unfreeze confirmable).
- Deposits (`receive`) remain available.

### Unfreeze (no timelock, unanimous)

```js
const data = treasury.interface.encodeFunctionData("unfreezeInternal");
const idx = await treasury.connect(owner0).submitTransaction(treasury.address, 0, data);
await treasury.connect(owner0).confirmTransaction(idx); // even while frozen
await treasury.connect(owner1).confirmTransaction(idx);
await treasury.connect(owner2).confirmTransaction(idx);
await treasury.connect(owner0).executeTransaction(idx); // immediate
```

## 5. Governance parameter changes

All parameter changes are **sensitive** operations: they require
`sensitiveRequired` confirmations and the timelock.

| Function                    | Purpose                        | Bounds enforced                          |
| :-------------------------- | :----------------------------- | :--------------------------------------- |
| `updateLimits(d, w, t)`     | Daily/weekly limits, threshold | none (spend limits only cap transfers)   |
| `updateSensitiveRequired(n)`| Sensitive-action threshold     | `1 ≤ n ≤ owners.length`, `n ≥ required`  |
| `updateTimelock(delay)`     | Timelock delay                 | `1 day ≤ delay ≤ 7 days`                 |

Because these functions are `only self`, they can only be changed through an
approved multisig proposal — never directly. Raising the threshold requires the
**current** threshold; lowering it also does.

## 6. Monitoring

Subscribe to these events for audit and alerting:

- `SubmitTransaction` / `ConfirmTransaction` / `RevokeConfirmation` /
  `ExecuteTransaction` — full proposal lifecycle, indexed by owner and txIndex.
- `LimitsUpdated` / `SensitiveRequiredUpdated` / `TimelockUpdated` —
  governance parameter changes.
- `EmergencyFrozen` / `EmergencyUnfrozen` — circuit-breaker transitions.
- `Deposit` — treasury inflows.

Alert on: any `EmergencyFrozen`, failed `ExecuteTransaction` reverts
(`tx failed`), and confirmation counts approaching sensitive thresholds.

## 7. Testing

```bash
cd Contracts
npx hardhat test test/MultisigTreasury.test.js
```

Coverage highlights:

- Timelock expiration (revert before, success after) for large transfers and
  sensitive changes; emergency ops execute without waiting.
- Threshold variations: 1-confirm ordinary, `required` large, `sensitiveRequired`
  sensitive, unanimous emergency; plus governance-driven threshold changes.
- Concurrent proposals with independent confirmation/execution state.
- Reentrancy: a malicious recipient cannot execute another proposal during
  execution (`reentrant call`).
- Constructor and update validation for the 1–7 day timelock range and
  `sensitiveRequired` invariants.

## 8. Deployment

`scripts/deploy/deploy.sh` compiles, runs the treasury test suite as a gate,
performs governance sanity checks, deploys, and prints verification steps. See
[DEPLOYMENT.md](../DEPLOYMENT.md) for the full procedure.
