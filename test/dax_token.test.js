import { expect } from "chai";
import hre from "hardhat";

describe("DAX_Token Contract Tests", function () {
  let daxToken;
  let deployer;
  let holder;
  let recipient;

  const TOTAL_SUPPLY = hre.ethers.parseEther("2000000000"); // 2 Billion DAX

  beforeEach(async function () {
    [deployer, holder, recipient] = await hre.ethers.getSigners();
    const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
    daxToken = await DAX_Token.deploy(holder.address);
    await daxToken.waitForDeployment();
  });

  it("mints exactly 2,000,000,000 DAX to the initialHolder", async function () {
    const balance = await daxToken.balanceOf(holder.address);
    const totalSupply = await daxToken.totalSupply();
    const cap = await daxToken.TOTAL_SUPPLY_CAP();

    expect(balance).to.equal(TOTAL_SUPPLY);
    expect(totalSupply).to.equal(TOTAL_SUPPLY);
    expect(cap).to.equal(TOTAL_SUPPLY);
  });

  it("reverts if initialHolder is address(0)", async function () {
    const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
    await expect(
      DAX_Token.deploy(hre.ethers.ZeroAddress)
    ).to.be.revertedWith("DAX_Token: Invalid initial holder");
  });

  it("has correct ERC20 name, symbol, and 18 decimals", async function () {
    expect(await daxToken.name()).to.equal("DAX Token");
    expect(await daxToken.symbol()).to.equal("DAX");
    expect(await daxToken.decimals()).to.equal(18n);
  });

  it("supports deflationary burn() reducing total supply", async function () {
    const burnAmount = hre.ethers.parseEther("1000");
    await daxToken.connect(holder).burn(burnAmount);

    const newBalance = await daxToken.balanceOf(holder.address);
    const newSupply = await daxToken.totalSupply();

    expect(newBalance).to.equal(TOTAL_SUPPLY - burnAmount);
    expect(newSupply).to.equal(TOTAL_SUPPLY - burnAmount);
  });

  it("supports burnFrom() with approved allowance", async function () {
    const burnAmount = hre.ethers.parseEther("500");
    await daxToken.connect(holder).approve(deployer.address, burnAmount);
    await daxToken.connect(deployer).burnFrom(holder.address, burnAmount);

    const newSupply = await daxToken.totalSupply();
    expect(newSupply).to.equal(TOTAL_SUPPLY - burnAmount);
  });

  it("supports standard ERC20 transfers", async function () {
    const sendAmount = hre.ethers.parseEther("250");
    await daxToken.connect(holder).transfer(recipient.address, sendAmount);

    expect(await daxToken.balanceOf(recipient.address)).to.equal(sendAmount);
    expect(await daxToken.balanceOf(holder.address)).to.equal(TOTAL_SUPPLY - sendAmount);
  });
});
