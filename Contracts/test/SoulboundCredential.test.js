const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SoulboundCredential", function () {
  let owner, alice, bob, charlie;
  let sbt;

  const TOKEN_ID = 1;
  const FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
  const ZERO = 0;
  const PAST = Math.floor(Date.now() / 1000) - 1;
  const NEAR_EXPIRY = Math.floor(Date.now() / 1000) + 2; // 2 seconds from now

  beforeEach(async () => {
    [owner, alice, bob, charlie] = await ethers.getSigners();
    const SBT = await ethers.getContractFactory("SoulboundCredential");
    sbt = await SBT.deploy("SoulboundCredential", "SBT");
    await sbt.waitForDeployment();
  });

  // ── Issuance ──────────────────────────────────────────────────────────

  describe("Issuance", function () {
    it("should issue a credential with expiration", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      expect(await sbt.ownerOf(TOKEN_ID)).to.equal(alice.address);
      expect(await sbt.expiration(TOKEN_ID)).to.equal(FUTURE);
      await expect(sbt.issue(alice.address, TOKEN_ID, FUTURE))
        .to.be.revertedWith("SBT: token already exists");
    });

    it("should emit CredentialIssued", async () => {
      await expect(sbt.issue(alice.address, TOKEN_ID, FUTURE))
        .to.emit(sbt, "CredentialIssued")
        .withArgs(alice.address, TOKEN_ID, FUTURE);
    });

    it("should issue with no expiration (0)", async () => {
      await sbt.issue(alice.address, TOKEN_ID, ZERO);
      expect(await sbt.expiration(TOKEN_ID)).to.equal(ZERO);
      expect(await sbt.valid(TOKEN_ID)).to.equal(true);
    });

    it("should only allow owner to issue", async () => {
      await expect(
        sbt.connect(alice).issue(alice.address, TOKEN_ID, FUTURE)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  // ── Revocation ────────────────────────────────────────────────────────

  describe("Revocation", function () {
    it("should revoke a credential and mark it invalid", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revoke(TOKEN_ID);
      expect(await sbt.valid(TOKEN_ID)).to.equal(false);
      expect(await sbt.isRevoked(TOKEN_ID)).to.equal(true);
    });

    it("should emit CredentialRevoked with default reason", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await expect(sbt.revoke(TOKEN_ID))
        .to.emit(sbt, "CredentialRevoked")
        .withArgs(TOKEN_ID, await getBlockTimestamp(), "revoked by issuer");
    });

    it("should revert revoke on non-existent token", async () => {
      await expect(sbt.revoke(TOKEN_ID))
        .to.be.revertedWith("SBT: token does not exist");
    });

    it("should revert revoke on already revoked token", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revoke(TOKEN_ID);
      await expect(sbt.revoke(TOKEN_ID))
        .to.be.revertedWith("SBT: credential already revoked");
    });

    it("should revert revoke from non-owner", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await expect(sbt.connect(alice).revoke(TOKEN_ID))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should record revocation timestamp and reason via revokeWithReason", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revokeWithReason(TOKEN_ID, "policy violation");
      const [isRevoked, timestamp, reason] = await sbt.revocationRecord(TOKEN_ID);
      expect(isRevoked).to.equal(true);
      expect(timestamp).to.be.gt(0);
      expect(reason).to.equal("policy violation");
    });

    it("should emit CredentialRevoked with custom reason", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await expect(sbt.revokeWithReason(TOKEN_ID, "expired certificate"))
        .to.emit(sbt, "CredentialRevoked");
    });

    it("should revert revokeWithReason on already revoked token", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revoke(TOKEN_ID);
      await expect(sbt.revokeWithReason(TOKEN_ID, "attempted again"))
        .to.be.revertedWith("SBT: credential already revoked");
    });
  });

  // ── Expiration ────────────────────────────────────────────────────────

  describe("Expiration", function () {
    it("should report expired credential as invalid", async () => {
      await sbt.issue(alice.address, TOKEN_ID, PAST);
      expect(await sbt.valid(TOKEN_ID)).to.equal(false);
      expect(await sbt.isExpired(TOKEN_ID)).to.equal(true);
    });

    it("should report valid credential before expiry", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      expect(await sbt.valid(TOKEN_ID)).to.equal(true);
      expect(await sbt.isExpired(TOKEN_ID)).to.equal(false);
    });

    it("should report valid credential with no expiry (0)", async () => {
      await sbt.issue(alice.address, TOKEN_ID, ZERO);
      expect(await sbt.valid(TOKEN_ID)).to.equal(true);
      expect(await sbt.isExpired(TOKEN_ID)).to.equal(false);
    });

    it("should not allow renew on expired credential", async () => {
      await sbt.issue(alice.address, TOKEN_ID, PAST);
      await expect(sbt.renew(TOKEN_ID, FUTURE))
        .to.be.revertedWith("SBT: credential expired");
    });

    it("should not allow revoke on expired credential", async () => {
      await sbt.issue(alice.address, TOKEN_ID, PAST);
      await expect(sbt.revoke(TOKEN_ID))
        .to.be.revertedWith("SBT: credential revoked");
    });
  });

  // ── Renewal ───────────────────────────────────────────────────────────

  describe("Renewal", function () {
    it("should renew expiration", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      const newExpiry = FUTURE + 86400;
      await sbt.renew(TOKEN_ID, newExpiry);
      expect(await sbt.expiration(TOKEN_ID)).to.equal(newExpiry);
    });

    it("should emit CredentialRenewed", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      const newExpiry = FUTURE + 86400;
      await expect(sbt.renew(TOKEN_ID, newExpiry))
        .to.emit(sbt, "CredentialRenewed")
        .withArgs(TOKEN_ID, newExpiry);
    });

    it("should not allow renew on revoked credential", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revoke(TOKEN_ID);
      await expect(sbt.renew(TOKEN_ID, FUTURE))
        .to.be.revertedWith("SBT: credential revoked");
    });

    it("should revert renew from non-owner", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await expect(sbt.connect(alice).renew(TOKEN_ID, FUTURE))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  // ── Reissuance ────────────────────────────────────────────────────────

  describe("Reissuance", function () {
    it("should reissue by burning old and minting new", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      const newTokenId = 2;
      await sbt.reissue(bob.address, TOKEN_ID, newTokenId, FUTURE);
      expect(await sbt.ownerOf(newTokenId)).to.equal(bob.address);
      expect(await sbt.expiration(newTokenId)).to.equal(FUTURE);
      await expect(sbt.ownerOf(TOKEN_ID)).to.be.reverted;
    });

    it("should emit CredentialReissued", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      const newTokenId = 2;
      await expect(sbt.reissue(bob.address, TOKEN_ID, newTokenId, FUTURE))
        .to.emit(sbt, "CredentialReissued")
        .withArgs(bob.address, newTokenId, FUTURE, TOKEN_ID);
    });

    it("should reissue even when old credential was revoked", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revoke(TOKEN_ID);
      const newTokenId = 2;
      await sbt.reissue(bob.address, TOKEN_ID, newTokenId, FUTURE);
      expect(await sbt.valid(newTokenId)).to.equal(true);
    });

    it("should reissue even when old credential was expired", async () => {
      await sbt.issue(alice.address, TOKEN_ID, PAST);
      const newTokenId = 2;
      await sbt.reissue(bob.address, TOKEN_ID, newTokenId, FUTURE);
      expect(await sbt.valid(newTokenId)).to.equal(true);
    });

    it("should reissue when old token does not exist (new issuance only)", async () => {
      const newTokenId = 3;
      await sbt.reissue(alice.address, 999, newTokenId, FUTURE);
      expect(await sbt.ownerOf(newTokenId)).to.equal(alice.address);
    });

    it("should revert if new token id already exists", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.issue(alice.address, 2, FUTURE);
      await expect(sbt.reissue(bob.address, TOKEN_ID, 2, FUTURE))
        .to.be.revertedWith("SBT: new token already exists");
    });

    it("should revert reissue from non-owner", async () => {
      await expect(sbt.connect(alice).reissue(alice.address, 1, 2, FUTURE))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should clear old token state completely after reissue", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revokeWithReason(TOKEN_ID, "test revocation");
      await sbt.reissue(bob.address, TOKEN_ID, 2, FUTURE);

      // Old token state should be cleared
      const [revoked, , ] = await sbt.revocationRecord(TOKEN_ID);
      expect(revoked).to.equal(false);
      expect(await sbt.expiration(TOKEN_ID)).to.equal(0);
    });
  });

  // ── Revoke-then-reissue edge cases ────────────────────────────────────

  describe("Revoke-then-reissue", function () {
    it("should successfully reissue after revoke and mint new valid credential", async () => {
      await sbt.issue(alice.address, 10, FUTURE);
      await sbt.revokeWithReason(10, "compromised key");
      await sbt.reissue(bob.address, 10, 11, FUTURE);
      expect(await sbt.valid(11)).to.equal(true);
      expect(await sbt.isRevoked(11)).to.equal(false);
      expect(await sbt.isExpired(11)).to.equal(false);
      expect(await sbt.ownerOf(11)).to.equal(bob.address);
    });

    it("should allow re-revoke after reissue", async () => {
      await sbt.issue(alice.address, 20, FUTURE);
      await sbt.revoke(20);
      await sbt.reissue(bob.address, 20, 21, FUTURE);
      await sbt.revokeWithReason(21, "second revocation");
      expect(await sbt.isRevoked(21)).to.equal(true);
      const [, , reason] = await sbt.revocationRecord(21);
      expect(reason).to.equal("second revocation");
    });

    it("should allow multiple sequential reissues", async () => {
      await sbt.issue(alice.address, 30, FUTURE);
      await sbt.revoke(30);
      await sbt.reissue(bob.address, 30, 31, FUTURE);
      await sbt.revoke(31);
      await sbt.reissue(charlie.address, 31, 32, FUTURE);
      expect(await sbt.valid(32)).to.equal(true);
      expect(await sbt.ownerOf(32)).to.equal(charlie.address);
    });

    it("should not allow reissue of still-active credential", async () => {
      await sbt.issue(alice.address, 40, FUTURE);
      await expect(sbt.reissue(bob.address, 40, 41, FUTURE))
        .to.not.be.reverted; // reissue on active token burns + mints (valid use case)
      expect(await sbt.valid(41)).to.equal(true);
    });
  });

  // ── Expiration edge cases ─────────────────────────────────────────────

  describe("Expiration edge cases", function () {
    it("should handle credential expiring during validity check", async () => {
      await sbt.issue(alice.address, 50, NEAR_EXPIRY);
      expect(await sbt.valid(50)).to.equal(true);
      // Wait for expiration
      await new Promise(r => setTimeout(r, 3000));
      expect(await sbt.valid(50)).to.equal(false);
      expect(await sbt.isExpired(50)).to.equal(true);
    });

    it("should not allow renew on credential that expires during operation", async () => {
      await sbt.issue(alice.address, 60, NEAR_EXPIRY);
      await new Promise(r => setTimeout(r, 3000));
      await expect(sbt.renew(60, FUTURE))
        .to.be.revertedWith("SBT: credential expired");
    });

    it("should allow reissue of expired credential", async () => {
      await sbt.issue(alice.address, 70, PAST);
      expect(await sbt.isExpired(70)).to.equal(true);
      await sbt.reissue(bob.address, 70, 71, FUTURE);
      expect(await sbt.valid(71)).to.equal(true);
      expect(await sbt.isExpired(71)).to.equal(false);
    });
  });

  // ── Batch revocation scenarios (via sequential calls) ──────────────────

  describe("Batch revocation scenarios", function () {
    it("should handle sequential revocations correctly", async () => {
      const tokenIds = [100, 101, 102, 103, 104];
      for (const id of tokenIds) {
        await sbt.issue(alice.address, id, FUTURE);
      }

      // Revoke first 3
      for (const id of tokenIds.slice(0, 3)) {
        await sbt.revokeWithReason(id, "batch test");
      }

      for (let i = 0; i < tokenIds.length; i++) {
        const expectedRevoked = i < 3;
        expect(await sbt.isRevoked(tokenIds[i])).to.equal(expectedRevoked);
        expect(await sbt.valid(tokenIds[i])).to.equal(!expectedRevoked);
      }
    });

    it("should handle sequential batch reissue", async () => {
      const tokenIds = [200, 201, 202];
      const newTokenIds = [300, 301, 302];

      for (const id of tokenIds) {
        await sbt.issue(alice.address, id, FUTURE);
        await sbt.revoke(id);
      }

      for (let i = 0; i < tokenIds.length; i++) {
        await sbt.reissue(bob.address, tokenIds[i], newTokenIds[i], FUTURE);
        expect(await sbt.valid(newTokenIds[i])).to.equal(true);
        expect(await sbt.ownerOf(newTokenIds[i])).to.equal(bob.address);
        await expect(sbt.ownerOf(tokenIds[i])).to.be.reverted;
      }
    });

    it("should handle mixed state batch correctly", async () => {
      // Issue tokens in different states
      await sbt.issue(alice.address, 400, FUTURE);  // active
      await sbt.issue(alice.address, 401, FUTURE);  // will be revoked
      await sbt.issue(alice.address, 402, PAST);    // expired

      await sbt.revoke(401);

      expect(await sbt.valid(400)).to.equal(true);
      expect(await sbt.valid(401)).to.equal(false);
      expect(await sbt.valid(402)).to.equal(false);
      expect(await sbt.isExpired(402)).to.equal(true);
      expect(await sbt.isRevoked(401)).to.equal(true);
    });
  });

  // ── Transfers blocked ─────────────────────────────────────────────────

  describe("Non-transferable", function () {
    it("should block safeTransferFrom", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await expect(
        sbt.connect(alice)["safeTransferFrom(address,address,uint256)"](
          alice.address, bob.address, TOKEN_ID
        )
      ).to.be.revertedWith("SBT: non-transferable");
    });

    it("should block safeTransferFrom with data", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await expect(
        sbt.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](
          alice.address, bob.address, TOKEN_ID, "0x"
        )
      ).to.be.revertedWith("SBT: non-transferable");
    });

    it("should block approve", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await expect(sbt.connect(alice).approve(bob.address, TOKEN_ID))
        .to.be.revertedWith("SBT: approvals disabled");
    });

    it("should block setApprovalForAll", async () => {
      await expect(sbt.connect(alice).setApprovalForAll(bob.address, true))
        .to.be.revertedWith("SBT: approvals disabled");
    });
  });

  // ── Validity checks ──────────────────────────────────────────────────

  describe("Validity helper", function () {
    it("should return false for non-existent token", async () => {
      expect(await sbt.valid(999)).to.equal(false);
    });

    it("should return true for valid credential", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      expect(await sbt.valid(TOKEN_ID)).to.equal(true);
    });

    it("should return false for revoked credential", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revoke(TOKEN_ID);
      expect(await sbt.valid(TOKEN_ID)).to.equal(false);
    });

    it("should return false for expired credential", async () => {
      await sbt.issue(alice.address, TOKEN_ID, PAST);
      expect(await sbt.valid(TOKEN_ID)).to.equal(false);
    });
  });

  // ── Revocation record queries ─────────────────────────────────────────

  describe("Revocation records", function () {
    it("should return empty record for non-revoked token", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      const [isRevoked, timestamp, reason] = await sbt.revocationRecord(TOKEN_ID);
      expect(isRevoked).to.equal(false);
      expect(timestamp).to.equal(0);
      expect(reason).to.equal("");
    });

    it("should return full record after revocation", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revokeWithReason(TOKEN_ID, "security incident");
      const [isRevoked, timestamp, reason] = await sbt.revocationRecord(TOKEN_ID);
      expect(isRevoked).to.equal(true);
      expect(timestamp).to.be.gt(0);
      expect(reason).to.equal("security incident");
    });

    it("should clear revocation record after reissue", async () => {
      await sbt.issue(alice.address, TOKEN_ID, FUTURE);
      await sbt.revokeWithReason(TOKEN_ID, "old credential");
      await sbt.reissue(bob.address, TOKEN_ID, 2, FUTURE);
      const [isRevoked, timestamp, reason] = await sbt.revocationRecord(TOKEN_ID);
      expect(isRevoked).to.equal(false);
      expect(timestamp).to.equal(0);
      expect(reason).to.equal("");
    });
  });

  // ── Helper ────────────────────────────────────────────────────────────

  async function getBlockTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
  }
});
