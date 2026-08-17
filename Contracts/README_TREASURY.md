Multisig Treasury
=================

Overview
--------

`MultisigTreasury.sol` provides a hardened multi-signature treasury with:

- **M-of-N approval tiers** — ordinary transfers, large transfers, sensitive
  parameter changes, and emergency operations each have their own confirmation
  threshold.
- **Timelocks (1–7 days)** — risky operations (large transfers and sensitive
  parameter changes) cannot execute until their timelock elapses.
- **Emergency operations** — freeze/unfreeze bypass the timelock but require
  **unanimous** approval from every owner.
- **Configurable daily/weekly spending limits** with rolling windows.
- **Reentrancy protection** and **pre/post-execution state-consistency
  validation**.
- **Audit events** for every state change.
- **Upgrade-safe storage layout** (reserved `__gap` slots).

Approval tiers
--------------

| Operation                          | Confirmations required            | Timelock |
| :--------------------------------- | :-------------------------------- | :------- |
| Transfer ≤ threshold               | 1                                 | No       |
| Transfer > threshold               | `required` (base M-of-N)          | Yes      |
| Sensitive parameter change         | `sensitiveRequired` (≥ required)  | Yes      |
| Emergency freeze / unfreeze        | All owners (unanimous)            | No       |

Sensitive operations are the self-call functions `updateLimits`,
`updateTimelock`, and `updateSensitiveRequired`. They are timelocked and need
the higher `sensitiveRequired` threshold. Raising or lowering governance
parameters always requires the **currently configured** `sensitiveRequired`.

Emergency freeze / unfreeze
---------------------------

- Freeze: submit `emergencyFreeze()` as a self-call
  (`submitTransaction(address(this), 0, abi.encodeWithSelector(this.emergencyFreeze.selector))`),
  collect **all** owner confirmations, and execute — the freeze is effective
  immediately, no timelock.
- While frozen, only unfreeze proposals can be confirmed or executed; all other
  execution is blocked.
- Unfreeze: submit `unfreezeInternal()` as a self-call. It can be confirmed
  even while frozen and also requires unanimous approval with no timelock.

Timelock
--------

`timelockDelay` is bounded to `[1 days, 7 days]` (see `MIN_TIMELOCK_DELAY` /
`MAX_TIMELOCK_DELAY`). At submission, every proposal records
`minExecuteTime = block.timestamp + timelockDelay`; execution of timelocked
operations reverts with `timelock not elapsed` until that time passes. Changing
the delay affects **new** proposals only.

Quick test
----------

From the `Contracts` folder:

```bash
npm install      # or pnpm install
npx hardhat test test/MultisigTreasury.test.js
```

The suite covers timelock expiration, threshold variations (base vs sensitive
vs unanimous), concurrent proposals, revocations, emergency freeze/unfreeze,
governance parameter updates, reentrancy protection, and constructor
validation.

Deployment
----------

See [DEPLOYMENT.md](./DEPLOYMENT.md) for governance initialization procedures
and [scripts/deploy/deploy.sh](./scripts/deploy/deploy.sh) for one-shot
deployment:

```bash
TREASURY_OWNERS="0xOwner1,0xOwner2,0xOwner3" \
TREASURY_REQUIRED=2 \
TREASURY_SENSITIVE_REQUIRED=3 \
TREASURY_TIMELOCK_DAYS=2 \
./scripts/deploy/deploy.sh
```

Governance runbook
------------------

See [docs/GOVERNANCE_GUIDE.md](./docs/GOVERNANCE_GUIDE.md) for the full
propose → confirm → timelock → execute runbook, monitoring guidance, and
emergency procedures.
