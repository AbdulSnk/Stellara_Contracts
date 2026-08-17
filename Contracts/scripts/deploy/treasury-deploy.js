// Hardhat deployment script for MultisigTreasury.
//
// Usage (from Contracts/):
//   TREASURY_OWNERS="0x111...,0x222...,0x333..." \
//   TREASURY_REQUIRED=2 \
//   TREASURY_SENSITIVE_REQUIRED=3 \
//   TREASURY_TIMELOCK_DAYS=2 \
//   npx hardhat run scripts/deploy/treasury-deploy.js --network <network>
//
// Configuration environment variables:
//   TREASURY_OWNERS             Comma-separated owner addresses (default: deployer)
//   TREASURY_REQUIRED           Confirmations for transfers above threshold (default: 2)
//   TREASURY_SENSITIVE_REQUIRED Confirmations for sensitive actions (default: owners.length)
//   TREASURY_TIMELOCK_DAYS      Timelock in days, 1-7 (default: 2)
//   TREASURY_THRESHOLD_ETH      Large-transfer threshold in ETH (default: 2)
//   TREASURY_DAILY_LIMIT_ETH    Daily spending limit in ETH (default: 5)
//   TREASURY_WEEKLY_LIMIT_ETH   Weekly spending limit in ETH (default: 10)
//
// Amounts are validated against the contract's governance invariants:
//   0 < REQUIRED <= owners.length
//   REQUIRED <= SENSITIVE_REQUIRED <= owners.length
//   1 <= TIMELOCK_DAYS <= 7

const hre = require("hardhat");

const SECONDS_PER_DAY = 86400;

function parseOwners(deployerAddress) {
  const raw = (process.env.TREASURY_OWNERS || deployerAddress).split(",");
  const owners = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  if (owners.length === 0) {
    throw new Error("TREASURY_OWNERS must contain at least one address");
  }
  return owners;
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const owners = parseOwners(deployerAddress);
  const required = Number(process.env.TREASURY_REQUIRED || "2");
  const sensitiveRequired = Number(
    process.env.TREASURY_SENSITIVE_REQUIRED || String(owners.length)
  );
  const timelockDays = Number(process.env.TREASURY_TIMELOCK_DAYS || "2");
  const dailyLimitEth = process.env.TREASURY_DAILY_LIMIT_ETH || "5";
  const weeklyLimitEth = process.env.TREASURY_WEEKLY_LIMIT_ETH || "10";
  const thresholdEth = process.env.TREASURY_THRESHOLD_ETH || "2";

  // Mirror the constructor's governance invariant checks so misconfiguration
  // fails fast with a clear message before any gas is spent.
  if (required <= 0 || required > owners.length) {
    throw new Error(`TREASURY_REQUIRED (${required}) must be within 1..${owners.length}`);
  }
  if (sensitiveRequired <= 0 || sensitiveRequired > owners.length) {
    throw new Error(
      `TREASURY_SENSITIVE_REQUIRED (${sensitiveRequired}) must be within 1..${owners.length}`
    );
  }
  if (sensitiveRequired < required) {
    throw new Error(
      `TREASURY_SENSITIVE_REQUIRED (${sensitiveRequired}) must be >= TREASURY_REQUIRED (${required})`
    );
  }
  if (timelockDays < 1 || timelockDays > 7) {
    throw new Error(`TREASURY_TIMELOCK_DAYS (${timelockDays}) must be between 1 and 7`);
  }

  console.log("Deploying MultisigTreasury with governance configuration:");
  console.log(`  Owners:               ${owners.join(", ")}`);
  console.log(`  Required (large txs): ${required}-of-${owners.length}`);
  console.log(`  Sensitive required:   ${sensitiveRequired}-of-${owners.length}`);
  console.log(`  Timelock delay:       ${timelockDays} day(s)`);
  console.log(`  Daily limit:          ${dailyLimitEth} ETH`);
  console.log(`  Weekly limit:         ${weeklyLimitEth} ETH`);
  console.log(`  Large-tx threshold:   ${thresholdEth} ETH`);

  const MultisigTreasury = await ethers.getContractFactory("MultisigTreasury");
  const treasury = await MultisigTreasury.deploy(
    owners,
    required,
    ethers.parseEther(dailyLimitEth),
    ethers.parseEther(weeklyLimitEth),
    ethers.parseEther(thresholdEth),
    sensitiveRequired,
    timelockDays * SECONDS_PER_DAY
  );
  await treasury.waitForDeployment();

  const address = await treasury.getAddress();
  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`MultisigTreasury deployed to: ${address}`);
  console.log(`Deployed by:                  ${deployerAddress}`);
  console.log(`Network:                      ${hre.network.name}`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Governance initialization complete. Next steps:");
  console.log(`  1. Fund the treasury:  cast send ${address} --value 100ether`);
  console.log("  2. Record the address in DEPLOYMENT.md and Frontend config.");
  console.log("  3. See docs/GOVERNANCE_GUIDE.md for propose/confirm/execute runbook.");

  return address;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
