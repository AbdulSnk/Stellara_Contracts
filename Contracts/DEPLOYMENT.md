# Deployment Guide

## Testnet Deployment Steps

### 1. Prepare Environment

```bash
# Install Stellar CLI if not already installed
curl --proto '=https' --tlsv1.2 -sSf https://install.stellar.org | sh

# Verify installation
stellar version
```

### 2. Set Up Network Configuration

```bash
# Configure testnet
stellar config network add \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  testnet

# Set testnet as active network
stellar config network set testnet
```

### 3. Create Funded Account

```bash
# Generate new keypair
stellar keys generate my-account

# Fund account using testnet faucet
stellar network use testnet
# Visit: https://friendbot.stellar.org/?addr=GXXXXXX
```

### 4. Build WASM Binaries

```bash
# Build all contracts
cargo build --release --target wasm32-unknown-unknown

# Binaries located at:
# target/wasm32-unknown-unknown/release/trading_contract.wasm
# target/wasm32-unknown-unknown/release/academy_contract.wasm
# target/wasm32-unknown-unknown/release/social_rewards_contract.wasm
# target/wasm32-unknown-unknown/release/messaging_contract.wasm
```

### 5. Deploy Contracts

```bash
# Deploy trading contract
TRADING_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/trading_contract.wasm \
  --source my-account \
  --network testnet \
  --no-wait)

# Deploy academy contract
ACADEMY_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/academy_contract.wasm \
  --source my-account \
  --network testnet \
  --no-wait)

# Deploy social rewards contract
REWARDS_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/social_rewards_contract.wasm \
  --source my-account \
  --network testnet \
  --no-wait)

# Deploy messaging contract
MESSAGING_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/messaging_contract.wasm \
  --source my-account \
  --network testnet \
  --no-wait)
```

### 6. Initialize Contracts

```bash
# Initialize each contract
stellar contract invoke \
  --id $TRADING_ID \
  --source my-account \
  --network testnet \
  -- init

stellar contract invoke \
  --id $ACADEMY_ID \
  --source my-account \
  --network testnet \
  -- init

stellar contract invoke \
  --id $REWARDS_ID \
  --source my-account \
  --network testnet \
  -- init

stellar contract invoke \
  --id $MESSAGING_ID \
  --source my-account \
  --network testnet \
  -- init
```

> **⚠️ Initializer Protection**: Each contract can only be initialized **once**.
> Calling `init` a second time will be rejected. This is enforced by the
> `upgradeability` module which sets an `"init"` flag in persistent storage
> on the first call. See [UPGRADEABILITY.md](./UPGRADEABILITY.md) for details.

### 7. Verify Initializer Protection

After initializing each contract, verify that re-initialization is blocked:

```bash
# Attempt to re-initialize trading contract (MUST FAIL)
stellar contract invoke \
  --id $TRADING_ID \
  --source my-account \
  --network testnet \
  -- init 2>&1 && echo "FAIL: re-init allowed!" || echo "PASS: re-init blocked"

# Attempt to re-initialize messaging contract (MUST FAIL)
stellar contract invoke \
  --id $MESSAGING_ID \
  --source my-account \
  --network testnet \
  -- init 2>&1 && echo "FAIL: re-init allowed!" || echo "PASS: re-init blocked"
```

If any contract allows re-initialization, **do not proceed** — this indicates
a security vulnerability. Check that the contract uses the `upgradeability`
module's `initializer_guard()` or equivalent storage-key check.

You can also run the automated deployment script which performs these checks:

```bash
./scripts/deploy/deploy_upgradeable.sh --network testnet
```

### 8. Verify Deployment

```bash
# Check contract exists
stellar contract info --id $TRADING_ID --network testnet

# Test a function
stellar contract invoke \
  --id $TRADING_ID \
  --source my-account \
  --network testnet \
  -- get_stats
```

## Contract Addresses (Testnet)

Update these after deployment:

```
Trading Contract:     [DEPLOYED_ADDRESS]
Academy Contract:     [DEPLOYED_ADDRESS]
Social Rewards:       [DEPLOYED_ADDRESS]
Messaging Contract:   [DEPLOYED_ADDRESS]
```

## Mainnet Migration

When ready for mainnet:

1. Replace testnet RPC URLs with mainnet
2. Use mainnet account credentials
3. Re-deploy using mainnet network configuration
4. Update all contract addresses in frontend code
5. **Verify initializer protection** on all deployed contracts

## Multisig Treasury Governance Initialization

`MultisigTreasury.sol` is an EVM contract deployed with Hardhat. Its
constructor performs **governance initialization** in a single call:

```text
MultisigTreasury(owners, required, dailyLimit, weeklyLimit, threshold,
                 sensitiveRequired, timelockDelay)
```

| Parameter          | Meaning                                                        | Constraint                          |
| :----------------- | :------------------------------------------------------------- | :---------------------------------- |
| `owners`           | Multisig signers                                               | non-empty, unique, no zero address  |
| `required`         | Confirmations for transfers above `threshold`                  | `1 ≤ required ≤ owners.length`      |
| `dailyLimit`       | Daily spend cap (0 disables)                                   | any                                |
| `weeklyLimit`      | Weekly spend cap (0 disables)                                  | any                                |
| `threshold`        | Amount above which transfers need `required` confirmations     | any                                |
| `sensitiveRequired`| Confirmations for sensitive actions                            | `required ≤ sensitiveRequired ≤ owners.length` |
| `timelockDelay`    | Delay for risky operations                                     | `1 day ≤ delay ≤ 7 days`            |

### One-shot deployment script

```bash
cd Contracts

TREASURY_OWNERS="0xOwner1,0xOwner2,0xOwner3" \
TREASURY_REQUIRED=2 \
TREASURY_SENSITIVE_REQUIRED=3 \
TREASURY_TIMELOCK_DAYS=2 \
TREASURY_THRESHOLD_ETH=2 \
TREASURY_DAILY_LIMIT_ETH=5 \
TREASURY_WEEKLY_LIMIT_ETH=10 \
./scripts/deploy/deploy.sh --network <network>
```

`deploy.sh` compiles, **gates deployment on the treasury test suite**,
validates the governance parameters, deploys via
`scripts/deploy/treasury-deploy.js`, and prints post-deploy verification
commands. To deploy against a live network, add an RPC network entry to
`hardhat.config.js` (e.g. Sepolia or an L2) and pass `--network <name>`.

### Post-deployment verification checklist

- [ ] `getOwners().length` matches the intended signer set
- [ ] `required()` reflects the base multisig threshold
- [ ] `sensitiveRequired()` ≥ `required()`
- [ ] `timelockDelay()` is within 1–7 days
- [ ] Fund the treasury and confirm `Deposit` events are emitted
- [ ] Walk a full propose → confirm → execute cycle on a small transfer
- [ ] Walk a full emergency freeze (unanimous, immediate) → unfreeze cycle
- [ ] Record the treasury address in `README_TREASURY.md` and Frontend config

### Governing after deployment

All governance parameters (`updateLimits`, `updateTimelock`,
`updateSensitiveRequired`) can only be changed through approved, timelocked
multisig proposals targeting the treasury itself — see
[docs/GOVERNANCE_GUIDE.md](./docs/GOVERNANCE_GUIDE.md).

## Upgrade Safety

### Storage Layout Gaps

`MultisigTreasury` includes a `uint256[47] private __gap` at the end of its storage layout. This is the standard OpenZeppelin pattern for upgradeable contracts: it reserves 47 storage slots so that future state variables can be appended without shifting the positions of existing variables, which would corrupt proxy storage.

The gap was reduced from 50 to 47 slots when the hardened governance fields
were appended **before** it:

```text
... weekSpent        (slot 12)
sensitiveRequired    (slot 13)
timelockDelay        (slot 14)
_entered             (slot 15)  // reentrancy guard flag
__gap[47]            (slots 16–62)
```

The `Transaction` struct also gained `minExecuteTime` (housed in the array's
data region — no top-level slot shift).

**Rules when upgrading:**
- New state variables must be added **before** `__gap`, and `__gap` size must be reduced by the number of slots added.
- Never reorder or remove existing state variables.
- Run storage layout checks (`hardhat-upgrades` or `slither`) before deploying an upgraded implementation.

## Troubleshooting

### Build Issues

```bash
# Clean build
cargo clean
cargo build --release --target wasm32-unknown-unknown

# Check dependencies
cargo check
```

### Deployment Failures

```bash
# Verify account balance
stellar account info --source my-account --network testnet

# Check contract logs
stellar contract logs --id $CONTRACT_ID --network testnet
```

### Initializer Protection Issues

If a contract allows re-initialization:

1. **Check the `init` function** — it must check for the `"init"` storage key
   before proceeding:
   ```rust
   if env.storage().persistent().has(&symbol_short!("init")) {
       return Err(ContractError::Unauthorized);
   }
   env.storage().persistent().set(&symbol_short!("init"), &true);
   ```
2. **Use the `upgradeability` crate** — import `upgradeability::initializer_guard`
   for a standardized, tested guard:
   ```rust
   use upgradeability;
   
   pub fn init(env: Env, ...) {
       upgradeability::initializer_guard(&env);
       // ... rest of init
   }
   ```
3. **Run integration tests** to verify:
   ```bash
   cargo test -p integration-tests -- initializer_protection --test-threads=1
   ```

## Gas Estimation

Typical costs on testnet:
- Contract deployment: ~1000 stroops
- Function invocation: ~100-500 stroops
- Storage operations: Variable

## Security Checklist

Before deploying to any network:

- [ ] All contracts use initializer protection (`"init"` storage key guard)
- [ ] `cargo test -p upgradeability` passes (7 tests)
- [ ] `cargo test -p integration-tests -- initializer_protection` passes
- [ ] Double-init is verified blocked on deployed contracts
- [ ] Governance roles are correctly assigned
- [ ] Multi-sig signers are configured
- [ ] Treasury governance initialized: `sensitiveRequired ≥ required`, `1 ≤ timelockDelay ≤ 7 days`
- [ ] Treasury test suite passes: `npx hardhat test test/MultisigTreasury.test.js`

## Further Resources

- [Soroban Documentation](https://developers.stellar.org/soroban)
- [Stellar CLI Reference](https://developers.stellar.org/cli)
- [Testnet Faucet](https://friendbot.stellar.org/)
- [UPGRADEABILITY.md](./UPGRADEABILITY.md) — Detailed upgradeability design
