// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MultisigTreasury {
    event Deposit(address indexed sender, uint amount, uint balance);
    event SubmitTransaction(address indexed owner, uint indexed txIndex, address indexed to, uint value, bytes data, uint minExecuteTime);
    event ConfirmTransaction(address indexed owner, uint indexed txIndex);
    event RevokeConfirmation(address indexed owner, uint indexed txIndex);
    event ExecuteTransaction(address indexed owner, uint indexed txIndex);
    event LimitsUpdated(uint dailyLimit, uint weeklyLimit, uint threshold);
    event SensitiveRequiredUpdated(uint sensitiveRequired);
    event TimelockUpdated(uint timelockDelay);
    event EmergencyFrozen(address indexed by);
    event EmergencyUnfrozen(address indexed by);

    // Timelock bounds: risky operations are delayed by between 1 and 7 days.
    uint public constant MIN_TIMELOCK_DELAY = 1 days;
    uint public constant MAX_TIMELOCK_DELAY = 7 days;

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint public required;

    uint public dailyLimit;
    uint public weeklyLimit;
    uint public threshold;

    // Approval threshold for sensitive actions (parameter / governance changes).
    // Invariants: 0 < sensitiveRequired <= owners.length and
    // sensitiveRequired >= required.
    uint public sensitiveRequired;

    // Delay applied to risky operations at submission time.
    // Invariant: MIN_TIMELOCK_DELAY <= timelockDelay <= MAX_TIMELOCK_DELAY.
    uint public timelockDelay;

    bool public frozen;

    struct Transaction {
        address to;
        uint value;
        bytes data;
        bool executed;
        uint numConfirmations;
        uint created;
        // block.timestamp + timelockDelay at submission. Enforced only for
        // operations that are subject to the timelock (sensitive actions and
        // transfers above threshold); emergency and small transfers ignore it.
        uint minExecuteTime;
    }

    Transaction[] public transactions;
    mapping(uint => mapping(address => bool)) public isConfirmed;

    // tracking spend windows
    uint public dayWindowStart;
    uint public daySpent;
    uint public weekWindowStart;
    uint public weekSpent;

    bool private _entered;

    modifier onlyOwner() { require(isOwner[msg.sender], "not owner"); _; }
    modifier notFrozen() { require(!frozen, "frozen"); _; }
    modifier nonReentrant() {
        require(!_entered, "reentrant call");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address[] memory _owners, uint _required, uint _dailyLimit, uint _weeklyLimit, uint _threshold, uint _sensitiveRequired, uint _timelockDelay) {
        require(_owners.length > 0, "owners required");
        require(_required > 0 && _required <= _owners.length, "invalid required");
        require(_sensitiveRequired > 0 && _sensitiveRequired <= _owners.length, "invalid sensitive required");
        require(_sensitiveRequired >= _required, "sensitive required below base required");
        require(_timelockDelay >= MIN_TIMELOCK_DELAY && _timelockDelay <= MAX_TIMELOCK_DELAY, "invalid timelock delay");
        for (uint i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0), "invalid owner");
            require(!isOwner[o], "owner not unique");
            isOwner[o] = true;
            owners.push(o);
        }
        required = _required;
        dailyLimit = _dailyLimit;
        weeklyLimit = _weeklyLimit;
        threshold = _threshold;
        sensitiveRequired = _sensitiveRequired;
        timelockDelay = _timelockDelay;
        dayWindowStart = block.timestamp / 1 days;
        weekWindowStart = block.timestamp / 1 weeks;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value, address(this).balance);
    }

    function submitTransaction(address _to, uint _value, bytes calldata _data) external onlyOwner returns (uint) {
        uint minExecuteTime = block.timestamp + timelockDelay;
        transactions.push(Transaction({ to: _to, value: _value, data: _data, executed: false, numConfirmations: 0, created: block.timestamp, minExecuteTime: minExecuteTime }));
        uint txIndex = transactions.length - 1;
        emit SubmitTransaction(msg.sender, txIndex, _to, _value, _data, minExecuteTime);
        return txIndex;
    }

    function confirmTransaction(uint _txIndex) external onlyOwner {
        require(_txIndex < transactions.length, "tx does not exist");
        Transaction storage txn = transactions[_txIndex];
        require(!txn.executed, "already executed");
        require(!isConfirmed[_txIndex][msg.sender], "already confirmed");

        // Allow confirming unfreeze calls even when frozen; all other txs require unfrozen state.
        if (frozen) {
            require(_isSelfCall(txn, this.unfreezeInternal.selector), "frozen");
        }

        isConfirmed[_txIndex][msg.sender] = true;
        txn.numConfirmations += 1;
        emit ConfirmTransaction(msg.sender, _txIndex);
    }

    function revokeConfirmation(uint _txIndex) external onlyOwner notFrozen {
        require(_txIndex < transactions.length, "tx does not exist");
        Transaction storage txn = transactions[_txIndex];
        require(!txn.executed, "already executed");
        require(isConfirmed[_txIndex][msg.sender], "not confirmed");
        isConfirmed[_txIndex][msg.sender] = false;
        txn.numConfirmations -= 1;
        emit RevokeConfirmation(msg.sender, _txIndex);
    }

    function executeTransaction(uint _txIndex) external nonReentrant {
        require(_txIndex < transactions.length, "tx does not exist");
        Transaction storage txn = transactions[_txIndex];
        require(!txn.executed, "already executed");

        // Classify the operation into one of four approval tiers.
        bool isUnfreezeCall = _isSelfCall(txn, this.unfreezeInternal.selector);
        bool isLimitUpdateCall = _isSelfCall(txn, this.updateLimits.selector);
        bool isTimelockUpdateCall = _isSelfCall(txn, this.updateTimelock.selector);
        bool isSensitiveRequiredUpdateCall = _isSelfCall(txn, this.updateSensitiveRequired.selector);
        bool isEmergencyFreezeCall = _isSelfCall(txn, this.emergencyFreeze.selector);

        bool isEmergency = isEmergencyFreezeCall || isUnfreezeCall;
        bool isSensitive = isLimitUpdateCall || isTimelockUpdateCall || isSensitiveRequiredUpdateCall;

        require(!frozen || isUnfreezeCall, "frozen");

        // Sensitive actions require a higher threshold than ordinary transfers.
        if (isEmergency) {
            // Emergency operations bypass the timelock but demand unanimity.
            require(txn.numConfirmations >= owners.length, "insufficient confirmations for emergency action");
        } else if (isSensitive) {
            require(txn.numConfirmations >= sensitiveRequired, "insufficient confirmations for sensitive action");
        } else if (txn.value > threshold) {
            require(txn.numConfirmations >= required, "insufficient confirmations for large tx");
        } else {
            require(txn.numConfirmations >= 1, "requires at least one confirmation");
        }

        // Risky operations cannot execute before the timelock elapses.
        if (isSensitive || txn.value > threshold) {
            require(block.timestamp >= txn.minExecuteTime, "timelock not elapsed");
        }

        // Pre-execution state consistency validation.
        _validateStateInvariants();

        // Update windows
        uint currentDay = block.timestamp / 1 days;
        if (dayWindowStart != currentDay) {
            dayWindowStart = currentDay;
            daySpent = 0;
        }
        uint currentWeek = block.timestamp / 1 weeks;
        if (weekWindowStart != currentWeek) {
            weekWindowStart = currentWeek;
            weekSpent = 0;
        }

        // Enforce limits if set (non-zero)
        if (dailyLimit > 0) {
            require(daySpent + txn.value <= dailyLimit, "exceeds daily limit");
        }
        if (weeklyLimit > 0) {
            require(weekSpent + txn.value <= weeklyLimit, "exceeds weekly limit");
        }

        txn.executed = true;
        daySpent += txn.value;
        weekSpent += txn.value;

        (bool success, ) = txn.to.call{ value: txn.value }(txn.data);
        require(success, "tx failed");

        // Post-execution state consistency validation: confirms the external
        // call (or any reentrant attempt) did not corrupt treasury invariants.
        _validateStateInvariants();
        require(txn.executed, "execution state corrupted");

        emit ExecuteTransaction(msg.sender, _txIndex);
    }

    function updateLimits(uint _dailyLimit, uint _weeklyLimit, uint _threshold) external {
        require(msg.sender == address(this), "only self");
        dailyLimit = _dailyLimit;
        weeklyLimit = _weeklyLimit;
        threshold = _threshold;
        emit LimitsUpdated(_dailyLimit, _weeklyLimit, _threshold);
    }

    function updateSensitiveRequired(uint _sensitiveRequired) external {
        require(msg.sender == address(this), "only self");
        require(_sensitiveRequired > 0 && _sensitiveRequired <= owners.length, "invalid sensitive required");
        require(_sensitiveRequired >= required, "sensitive required below base required");
        sensitiveRequired = _sensitiveRequired;
        emit SensitiveRequiredUpdated(_sensitiveRequired);
    }

    function updateTimelock(uint _timelockDelay) external {
        require(msg.sender == address(this), "only self");
        require(_timelockDelay >= MIN_TIMELOCK_DELAY && _timelockDelay <= MAX_TIMELOCK_DELAY, "invalid timelock delay");
        timelockDelay = _timelockDelay;
        emit TimelockUpdated(_timelockDelay);
    }

    // Emergency freeze must be approved via multisig to avoid a single-owner lockout.
    function emergencyFreeze() external {
        require(msg.sender == address(this), "only self");
        frozen = true;
        emit EmergencyFrozen(msg.sender);
    }

    // Unfreeze must be performed via an on-chain multisig transaction targeting this contract:
    // submitTransaction(address(this), 0, abi.encodeWithSelector(this.unfreezeInternal.selector))
    function unfreezeInternal() external {
        require(msg.sender == address(this), "only self");
        frozen = false;
        emit EmergencyUnfrozen(address(this));
    }

    // Helpers
    function getOwners() external view returns (address[] memory) { return owners; }
    function getTransactionCount() external view returns (uint) { return transactions.length; }
    function getTransaction(uint _txIndex) external view returns (address to, uint value, bytes memory data, bool executed, uint numConfirmations, uint created, uint minExecuteTime) {
        Transaction storage t = transactions[_txIndex];
        return (t.to, t.value, t.data, t.executed, t.numConfirmations, t.created, t.minExecuteTime);
    }

    function _isSelfCall(Transaction storage txn, bytes4 selector) internal view returns (bool) {
        bytes memory callData = txn.data;
        return txn.to == address(this) && callData.length >= 4 && bytes4(callData) == selector;
    }

    // Validates that core governance and accounting invariants hold. Called
    // before execution (nothing may start from a corrupt state) and after
    // execution (the external call must not have corrupted the treasury).
    function _validateStateInvariants() internal view {
        require(required > 0 && required <= owners.length, "invalid required");
        require(sensitiveRequired > 0 && sensitiveRequired <= owners.length, "invalid sensitive required");
        require(sensitiveRequired >= required, "sensitive required below base required");
        require(timelockDelay >= MIN_TIMELOCK_DELAY && timelockDelay <= MAX_TIMELOCK_DELAY, "invalid timelock delay");
        if (dailyLimit > 0) {
            require(daySpent <= dailyLimit, "day spent exceeds daily limit");
        }
        if (weeklyLimit > 0) {
            require(weekSpent <= weeklyLimit, "week spent exceeds weekly limit");
        }
    }

    /**
     * @dev Storage gap to reserve space for future state variables when upgrading
     * via a proxy pattern. Reduces storage collision risk across upgrade versions.
     * Size: 47 slots (was 50; 3 slots consumed by sensitiveRequired, timelockDelay
     * and the reentrancy flag _entered, which were appended before this gap).
     */
    uint256[47] private __gap;
}
