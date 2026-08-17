const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 86400;
const TWO_DAYS = 2 * DAY;
const THREE_DAYS = 3 * DAY;
const EIGHT_DAYS = 8 * DAY;

describe("MultisigTreasury", function () {
  let owner0, owner1, owner2, recipient;
  let treasury;

  async function advanceTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function nextIndex() {
    return (await treasury.getTransactionCount()) - 1n;
  }

  async function submitTx(from, to, value, data = "0x") {
    await treasury.connect(from).submitTransaction(to, value, data);
    return nextIndex();
  }

  async function confirmBy(idx, ...signers) {
    for (const signer of signers) {
      await treasury.connect(signer).confirmTransaction(idx);
    }
  }

  async function deployTreasury(overrides = {}) {
    const owners = [owner0.address, owner1.address, owner2.address];
    const Multisig = await ethers.getContractFactory("MultisigTreasury");
    const inst = await Multisig.deploy(
      overrides.owners || owners,
      overrides.required !== undefined ? overrides.required : 2,
      overrides.dailyLimit !== undefined ? overrides.dailyLimit : ethers.parseEther("5"),
      overrides.weeklyLimit !== undefined ? overrides.weeklyLimit : ethers.parseEther("10"),
      overrides.threshold !== undefined ? overrides.threshold : ethers.parseEther("2"),
      overrides.sensitiveRequired !== undefined ? overrides.sensitiveRequired : 3,
      overrides.timelockDelay !== undefined ? overrides.timelockDelay : TWO_DAYS
    );
    await inst.waitForDeployment();
    return inst;
  }

  beforeEach(async () => {
    [owner0, owner1, owner2, recipient] = await ethers.getSigners();
    treasury = await deployTreasury();

    // Fund contract
    await owner0.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("5") });
  });

  it("executes a small single-confirm transaction immediately", async () => {
    const value = ethers.parseEther("0.5");
    const idx = await submitTx(owner0, recipient.address, value);
    await confirmBy(idx, owner0);
    const before = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(idx);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(value);
    // Post-execution accounting remains consistent.
    expect(await treasury.daySpent()).to.equal(value);
    expect(await treasury.weekSpent()).to.equal(value);
  });

  it("requires multisig and a timelock for large transactions above threshold", async () => {
    const value = ethers.parseEther("3"); // threshold is 2 ETH
    const idx = await submitTx(owner0, recipient.address, value);
    await confirmBy(idx, owner0);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "insufficient confirmations for large tx"
    );

    await confirmBy(idx, owner1);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "timelock not elapsed"
    );

    const txn = await treasury.getTransaction(idx);
    expect(txn.minExecuteTime).to.be.gt(0n);

    await advanceTime(TWO_DAYS);
    const before = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(idx);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(value);
  });

  it("requires the higher sensitive threshold and a timelock for parameter changes", async () => {
    const newDailyLimit = ethers.parseEther("2");
    const newWeeklyLimit = ethers.parseEther("12");
    const newThreshold = ethers.parseEther("3");
    const data = treasury.interface.encodeFunctionData("updateLimits", [
      newDailyLimit,
      newWeeklyLimit,
      newThreshold,
    ]);

    await expect(
      treasury.connect(owner0).updateLimits(newDailyLimit, newWeeklyLimit, newThreshold)
    ).to.be.revertedWith("only self");

    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1);
    // required (2) is insufficient for a sensitive action (sensitiveRequired = 3).
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "insufficient confirmations for sensitive action"
    );

    await confirmBy(idx, owner2);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx);

    expect(await treasury.dailyLimit()).to.equal(newDailyLimit);
    expect(await treasury.weeklyLimit()).to.equal(newWeeklyLimit);
    expect(await treasury.threshold()).to.equal(newThreshold);
  });

  it("requires unanimous approval and bypasses the timelock for emergency freeze", async () => {
    const data = treasury.interface.encodeFunctionData("emergencyFreeze");
    await expect(treasury.connect(owner0).emergencyFreeze()).to.be.revertedWith("only self");

    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "insufficient confirmations for emergency action"
    );

    // The third (unanimous) confirmation executes immediately — no timelock.
    await confirmBy(idx, owner2);
    await treasury.connect(owner0).executeTransaction(idx);
    expect(await treasury.frozen()).to.equal(true);

    // While frozen, ordinary transactions cannot even be confirmed.
    const paymentIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
    await expect(treasury.connect(owner0).confirmTransaction(paymentIdx)).to.be.revertedWith(
      "frozen"
    );
  });

  it("unfreezes unanimously, bypasses the timelock, and accepts confirmations while frozen", async () => {
    const paymentIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
    await confirmBy(paymentIdx, owner0);

    const freezeData = treasury.interface.encodeFunctionData("emergencyFreeze");
    const freezeIdx = await submitTx(owner0, await treasury.getAddress(), 0n, freezeData);
    await confirmBy(freezeIdx, owner0, owner1, owner2);
    await treasury.connect(owner0).executeTransaction(freezeIdx);
    expect(await treasury.frozen()).to.equal(true);

    // A non-unfreeze transaction cannot be confirmed while frozen.
    const blockedIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
    await expect(treasury.connect(owner0).confirmTransaction(blockedIdx)).to.be.revertedWith(
      "frozen"
    );

    // Unfreeze: confirmable even while frozen, executes immediately once unanimous.
    const unfreezeData = treasury.interface.encodeFunctionData("unfreezeInternal");
    const unfreezeIdx = await submitTx(owner0, await treasury.getAddress(), 0n, unfreezeData);
    await confirmBy(unfreezeIdx, owner0, owner1); // confirmed while frozen
    await confirmBy(unfreezeIdx, owner2); // still frozen
    await treasury.connect(owner0).executeTransaction(unfreezeIdx);
    expect(await treasury.frozen()).to.equal(false);

    // The previously queued payment now executes.
    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(paymentIdx);
    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientAfter - recipientBefore).to.equal(ethers.parseEther("0.1"));
  });

  it("rejects invalid governance configuration at deployment", async () => {
    const owners = [owner0.address, owner1.address, owner2.address];
    const Multisig = await ethers.getContractFactory("MultisigTreasury");
    const base = [owners, 2, ethers.parseEther("5"), ethers.parseEther("10"), ethers.parseEther("2")];

    // sensitiveRequired out of range
    await expect(Multisig.deploy(...base, 4, TWO_DAYS)).to.be.revertedWith("invalid sensitive required");
    await expect(Multisig.deploy(...base, 0, TWO_DAYS)).to.be.revertedWith("invalid sensitive required");
    // sensitiveRequired below the base required
    await expect(Multisig.deploy(...base, 1, TWO_DAYS)).to.be.revertedWith("sensitive required below base required");
    // timelock outside the 1-7 day range
    await expect(Multisig.deploy(...base, 3, 0)).to.be.revertedWith("invalid timelock delay");
    await expect(Multisig.deploy(...base, 3, EIGHT_DAYS)).to.be.revertedWith("invalid timelock delay");
  });

  it("updates the timelock through the sensitive-action flow", async () => {
    const data = treasury.interface.encodeFunctionData("updateTimelock", [THREE_DAYS]);
    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1, owner2);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx);
    expect(await treasury.timelockDelay()).to.equal(THREE_DAYS);

    // New proposals inherit the updated delay.
    const data2 = treasury.interface.encodeFunctionData("updateTimelock", [TWO_DAYS]);
    const idx2 = await submitTx(owner0, await treasury.getAddress(), 0n, data2);
    await confirmBy(idx2, owner0, owner1, owner2);
    await expect(treasury.connect(owner0).executeTransaction(idx2)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(THREE_DAYS);
    await treasury.connect(owner0).executeTransaction(idx2);
    expect(await treasury.timelockDelay()).to.equal(TWO_DAYS);
  });

  it("enforces sensitive threshold variations after governance updates", async () => {
    const data = treasury.interface.encodeFunctionData("updateSensitiveRequired", [2]);
    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1, owner2);
    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx);
    expect(await treasury.sensitiveRequired()).to.equal(2n);

    // A sensitive action now needs only 2 confirmations (still timelocked).
    const data2 = treasury.interface.encodeFunctionData("updateLimits", [
      ethers.parseEther("1"),
      ethers.parseEther("11"),
      ethers.parseEther("4"),
    ]);
    const idx2 = await submitTx(owner0, await treasury.getAddress(), 0n, data2);
    await confirmBy(idx2, owner0, owner1);
    await expect(treasury.connect(owner0).executeTransaction(idx2)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx2);
    expect(await treasury.dailyLimit()).to.equal(ethers.parseEther("1"));
  });

  it("rejects out-of-range governance updates at execution", async () => {
    // updateSensitiveRequired below the base required fails inside the self-call.
    const data = treasury.interface.encodeFunctionData("updateSensitiveRequired", [1]);
    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1, owner2);
    await advanceTime(TWO_DAYS);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith("tx failed");
    expect(await treasury.sensitiveRequired()).to.equal(3n);

    // updateTimelock beyond 7 days fails inside the self-call.
    const data2 = treasury.interface.encodeFunctionData("updateTimelock", [EIGHT_DAYS]);
    const idx2 = await submitTx(owner0, await treasury.getAddress(), 0n, data2);
    await confirmBy(idx2, owner0, owner1, owner2);
    await advanceTime(TWO_DAYS);
    await expect(treasury.connect(owner0).executeTransaction(idx2)).to.be.revertedWith("tx failed");
    expect(await treasury.timelockDelay()).to.equal(TWO_DAYS);
  });

  it("tracks concurrent proposals with independent confirmation state", async () => {
    const small = ethers.parseEther("0.5");
    const large = ethers.parseEther("3");

    const smallIdxA = await submitTx(owner0, recipient.address, small);
    const smallIdxB = await submitTx(owner1, recipient.address, small);
    const largeIdx = await submitTx(owner2, recipient.address, large);

    await confirmBy(smallIdxA, owner0);
    await confirmBy(largeIdx, owner0);
    await confirmBy(largeIdx, owner1);

    // Confirmations are tracked per proposal.
    expect((await treasury.getTransaction(smallIdxA)).numConfirmations).to.equal(1n);
    expect((await treasury.getTransaction(smallIdxB)).numConfirmations).to.equal(0n);
    expect((await treasury.getTransaction(largeIdx)).numConfirmations).to.equal(2n);

    // Executing one proposal leaves the others untouched.
    const before = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(smallIdxA);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(small);
    expect((await treasury.getTransaction(smallIdxB)).executed).to.equal(false);
    expect((await treasury.getTransaction(largeIdx)).executed).to.equal(false);

    // An unconfirmed proposal cannot execute.
    await expect(treasury.connect(owner1).executeTransaction(smallIdxB)).to.be.revertedWith(
      "requires at least one confirmation"
    );

    // The large proposal still respects its timelock.
    await expect(treasury.connect(owner2).executeTransaction(largeIdx)).to.be.revertedWith(
      "timelock not elapsed"
    );
    await advanceTime(TWO_DAYS);
    await treasury.connect(owner2).executeTransaction(largeIdx);
    expect((await treasury.getTransaction(largeIdx)).executed).to.equal(true);
  });

  it("allows revoking a confirmation before execution", async () => {
    const idx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
    await confirmBy(idx, owner0);
    expect((await treasury.getTransaction(idx)).numConfirmations).to.equal(1n);

    await treasury.connect(owner0).revokeConfirmation(idx);
    expect((await treasury.getTransaction(idx)).numConfirmations).to.equal(0n);

    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "requires at least one confirmation"
    );
  });

  it("blocks reentrant execution attempts", async () => {
    const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
    const attacker = await Attacker.deploy();
    await attacker.waitForDeployment();
    const attackerAddress = await attacker.getAddress();

    // Payable proposal to the attacker triggers receive() during execution.
    const attackIdx = await submitTx(owner0, attackerAddress, 0n, "0x");
    await confirmBy(attackIdx, owner0);

    // Fully-approved second proposal the attacker tries to execute reentrantly.
    const value = ethers.parseEther("1");
    const targetIdx = await submitTx(owner0, recipient.address, value);
    await confirmBy(targetIdx, owner0);

    await attacker.arm(await treasury.getAddress(), Number(targetIdx));

    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(attackIdx);
    const recipientAfter = await ethers.provider.getBalance(recipient.address);

    expect(await attacker.reentered()).to.equal(true);
    expect(await attacker.reentrantCallSucceeded()).to.equal(false);
    expect(recipientAfter - recipientBefore).to.equal(0n);

    const txn = await treasury.getTransaction(targetIdx);
    expect(txn.executed).to.equal(false);
  });

  it("exposes the hardened governance storage layout with reserved gap slots", async () => {
    expect(await treasury.required()).to.equal(2n);
    expect(await treasury.dailyLimit()).to.equal(ethers.parseEther("5"));
    expect(await treasury.weeklyLimit()).to.equal(ethers.parseEther("10"));
    expect(await treasury.threshold()).to.equal(ethers.parseEther("2"));
    expect(await treasury.sensitiveRequired()).to.equal(3n);
    expect(await treasury.timelockDelay()).to.equal(2n * 86400n);
    expect(await treasury.MIN_TIMELOCK_DELAY()).to.equal(1n * 86400n);
    expect(await treasury.MAX_TIMELOCK_DELAY()).to.equal(7n * 86400n);
    expect(await treasury.frozen()).to.equal(false);
    const owners = await treasury.getOwners();
    expect(owners.length).to.equal(3);
  });
});
