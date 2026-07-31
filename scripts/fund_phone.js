import pkg from "hardhat";
const { ethers } = pkg;

async function main() {
  // Replace this with the address you copied from your phone's screen
  const phoneAddress = "0x9EBC9a11a64a7a9858478BA92435CC126B83f8dA";

  if (phoneAddress === "PASTE_YOUR_PHONE_ADDRESS_HERE") {
    console.log("ERROR: Please edit this file (contracts/scripts/fund_phone.js) and replace 'PASTE_YOUR_PHONE_ADDRESS_HERE' with your copied address!");
    return;
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Funding phone wallet (${phoneAddress}) with 100 test ETH...`);

  const tx = await deployer.sendTransaction({
    to: phoneAddress,
    value: ethers.parseEther("100.0")
  });
  await tx.wait();

  console.log(`Success! 100 test ETH has been sent to ${phoneAddress}.`);
  console.log("Go back to the DAX app on your phone and tap SYNC again to see the 100.0000 ETH balance!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
