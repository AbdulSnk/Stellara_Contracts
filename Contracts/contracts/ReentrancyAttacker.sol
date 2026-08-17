// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Test-only helper: when the treasury sends a value-carrying (or empty) call to
// this contract, receive() attempts to re-enter treasury.executeTransaction()
// for another pending proposal. Used by MultisigTreasury.test.js to prove that
// the treasury's nonReentrant guard blocks reentrant execution.
contract ReentrancyAttacker {
    address public treasury;
    uint public targetTx;
    bool public shouldReenter;
    bool public reentered;
    bool public reentrantCallSucceeded;

    function arm(address _treasury, uint _targetTx) external {
        treasury = _treasury;
        targetTx = _targetTx;
        shouldReenter = true;
        reentered = false;
        reentrantCallSucceeded = false;
    }

    receive() external payable {
        if (shouldReenter && !reentered) {
            reentered = true;
            (bool ok, ) = treasury.call(abi.encodeWithSignature("executeTransaction(uint256)", targetTx));
            reentrantCallSucceeded = ok;
        }
    }
}
