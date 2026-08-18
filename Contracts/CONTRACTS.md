# Stellara Smart Contracts - Detailed Documentation

## Contract Architecture

All contracts follow Soroban best practices and are optimized for the Testnet environment.

### Design Patterns

1. **Contract Initialization**: All contracts require explicit initialization before use
2. **Authentication**: Functions requiring authorization use `require_auth()` for security
3. **Data Storage**: Persistent state stored in contract instance storage
4. **Error Handling**: Using Symbol-based error codes for gas efficiency
5. **Fee Handling**: Standardized fee collection via `FeeManager`
6. **Cross-Contract Safety**: Atomic multi-contract operations via `safe_call`

## Cross-Contract Call Safety

The system implements a `CrossCall` module (`shared/src/safe_call.rs`) to ensure atomicity and proper error propagation when contracts call each other.

### Guarantees
1.  **Atomicity**: If a downstream contract call fails (panics or returns error), the upstream contract catches the error and propagates it, causing the entire transaction (including any prior state changes like fee payments) to roll back.
2.  **Defensive Checks**: The `safe_invoke` wrapper abstracts `env.try_invoke_contract`, ensuring that all cross-contract calls are handled safely.

### Usage
Use `shared::safe_call::safe_invoke` instead of raw `env.invoke_contract` when you need to handle potential failures gracefully or ensure explicit error codes are returned.

```rust
match safe_invoke(&env, &contract_id, &func_name, args) {
    Ok(val) => { /* success */ },
    Err(code) => { /* handle error or propagate */ }
}
```

## Fee Handling

All contracts implementing fee collection use the `FeeManager` from the shared library.

### Fee Collection Process
1. **Check Balance**: The contract verifies the payer has sufficient balance of the fee token.
2. **Collect Fee**: The fee is transferred from the payer to the designated fee recipient.
3. **Execute Operation**: If fee collection succeeds, the contract operation proceeds.

### Error Codes
- `InsufficientBalance` (1001): The payer does not have enough funds to cover the fee.
- `InvalidAmount` (1002): The fee amount is invalid (negative).

## Trading Contract

### Purpose
Enables decentralized exchange of cryptocurrency pairs with trade history tracking.

### State Variables
- `stats`: TradeStats - Global trading statistics
- `trades`: Vec<Trade> - Complete trade history

### Key Structs

```rust
pub struct Trade {
    pub id: u64,
    pub trader: Address,
    pub pair: Symbol,          // e.g., "USDT" 
    pub amount: i128,          // Amount being traded
    pub price: i128,           // Price per unit
    pub timestamp: u64,        // Ledger timestamp
    pub is_buy: bool,          // Buy vs Sell order
}

pub struct TradeStats {
    pub total_trades: u64,
    pub total_volume: i128,
    pub last_trade_id: u64,
}

## Staking Rewards Contract

### Purpose
Allows users to stake tokens in different pools to earn rewards from protocol revenue.

### Pools
- **30 Days**: 5.00% APY
- **60 Days**: 10.00% APY
- **90 Days**: 15.00% APY

### Features
- **Early Withdrawal Penalty**: 10% deduction from principal if withdrawn before the lockup period ends.
- **Auto-compounding**: Users can re-stake their earned rewards into their principal.
- **Reward Claiming**: Separate function to withdraw rewards without affecting the stake.

### Key Structs

```rust
pub struct UserStake {
    pub amount: i128,              // Staked amount
    pub pool_id: u32,             // 0=30d, 1=60d, 2=90d
    pub start_timestamp: u64,      // Initial staking time
    pub last_claim_timestamp: u64, // Last time rewards were claimed
}

pub struct PoolConfig {
    pub lockup_seconds: u64,
    pub apy_bps: u32,              // APY in basis points (100 = 1%)
}
```

## Verifiable Credentials Contract (Soroban)

### Purpose
W3C-style verifiable credential issuance, verification, revocation, and reissuance with governance-controlled lifecycle.

### State Transitions

All state transitions are enforced by the contract and emit dedicated events:

```
  ┌─────────┐      issue_credential()      ┌─────────┐
  │         │ ──────────────────────────►  │  Valid   │
  │  (new)  │                              │          │
  └─────────┘                              └────┬─────┘
                                                │
                           ┌────────────────────┼────────────┐
                           │                    │            │
                    revoke_credential()   expires     reissue_credential()
                           │                    │            │
                     ┌─────▼──────┐       ┌─────▼─────┐  ┌──▼──────────────┐
                     │  Revoked   │       │  Expired   │  │ New Valid       │
                     │ (recorded) │       │ (emitted)  │  │ (old removed)   │
                     └────────────┘       └───────────┘  └─────────────────┘
                           │                    │            │
                           └────────────────────┴────────────┘
                                reissue_credential()
```

### Key Functions

| Function | Access | Description |
|---|---|---|
| `issue_credential(...)` | Authenticated | Issue a new credential with type, claims, and optional expiration |
| `verify_credential(id)` | Public | Returns `true` if credential is valid (not revoked, not expired, valid proof) |
| `revoke_credential(...)` | Authenticated | Revoke with reason + proof; records in audit trail |
| `reissue_credential(...)` | Authenticated | Atomic reissuance: old credential revoked + new issued in one tx |
| `get_credential_status(id)` | Public | Returns `"valid"`, `"revoked"`, or `"expired"` as a Symbol |
| `get_credential_details(id)` | Public | Full credential struct with all fields |
| `get_credentials_by_subject(did)` | Public | All credential IDs for a subject |
| `get_credentials_by_issuer(did)` | Public | All credential IDs issued by an issuer |
| `get_revocation_status(id)` | Public | `Option<RevocationEntry>` with revoker, reason, date, proof |

### Error Codes

| Code | Name | When |
|---|---|---|
| 4001 | `InvalidCredential` | Expired expiration_date at issuance, or other validity failure |
| 4002 | `UnauthorizedIssuer` | Caller not authorized |
| 4003 | `CredentialNotFound` | Credential ID does not exist in storage |
| 4004 | `AlreadyRevoked` | Attempting to revoke an already-revoked credential |
| 4005 | `ExpiredCredential` | Attempting to revoke an expired credential (use reissue instead) |
| 4006 | `InvalidProof` | Empty proof value |
| 4008 | `GovernanceError` | Governance role check failed |
| 4009 | `AlreadyInitialized` | Contract already initialized (double-init protection) |
| 4010 | `StillActive` | Attempting to reissue a credential that is still active |
| 4011 | `CredentialInvalid` | Credential is not valid for the requested operation |

### Events

| Topic | Payload |
|---|---|
| `cred_iss` | `CredentialIssuedEvent { credential_id, issuer_did, subject_did, credential_type, timestamp }` |
| `cred_rev` | `CredentialRevokedEvent { credential_id, revoked_by, reason, timestamp }` |
| `cred_reis` | `CredentialReissuedEvent { old_credential_id, new_credential_id, issuer, new_subject, old_subject, timestamp }` |
| `cred_exp` | `CredentialExpiredEvent { credential_id, expired_at }` |

### Revocation Record

```rust
pub struct RevocationEntry {
    pub credential_id: Symbol,    // The revoked credential ID
    pub revoker: Symbol,          // DID of the revoker
    pub revocation_date: u64,     // Ledger timestamp of revocation
    pub reason: Symbol,           // Human-readable reason
    pub proof: Bytes,             // Cryptographic proof of revocation authority
}
```

### Issuer Expectations

1. Call `issue_credential()` with a valid proof and non-past expiration date.
2. To revoke, call `revoke_credential()` with reason and proof — the credential must be active (not already revoked or expired).
3. To reissue, call `reissue_credential()` — the old credential must be revoked or expired. Active credentials return `StillActive`.
4. Use `get_credential_status()` to check state before operations.

### Verifier Expectations

1. Call `verify_credential(id)` — returns `true` only for valid, non-revoked, non-expired credentials.
2. Use `get_credential_status(id)` for programmatic state checks (`"valid"`, `"revoked"`, `"expired"`).
3. Use `get_revocation_status(id)` to retrieve full revocation audit data when needed.
4. Always re-verify before trusting; credential state may change between checks.
