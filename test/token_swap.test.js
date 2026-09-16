import { expect } from "chai";
import hre from "hardhat";

describe("DAX_Token & DAX_Swap Protocol Suite", function () {
  let daxToken, daxSwap, mockUsdt, mockUsdc, mockWbtc;
  let deployer, ledger, alice, bob;

  const TOTAL_CAP = hre.ethers.parseEther("2000000000"); // 2,000,000,000 DAX
  const INITIAL_SWAP_RESERVE = hre.ethers.parseEther("10000000"); // 10,000,000 DAX for swap gate
  const ETH_RATE = hre.ethers.parseEther("25000"); // 1 ETH = 25,000 DAX ($2,500 ETH at $0.10/DAX)
  const USDT_RATE = hre.ethers.parseEther("10"); // 1 USDT = 10 DAX ($0.10/DAX)
  const USDC_RATE = hre.ethers.parseEther("10"); // 1 USDC = 10 DAX ($0.10/DAX)
  const WBTC_RATE = hre.ethers.parseEther("650000"); // 1 WBTC = 650,000 DAX ($65,000 WBTC at $0.10/DAX)

  beforeEach(async function () {
    [deployer, ledger, alice, bob] = await hre.ethers.getSigners();

    // 1. Deploy DAX_Token with full 100M supply to deployer
    const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
    daxToken = await DAX_Token.deploy(deployer.address);
    await daxToken.waitForDeployment();

    // 2. Deploy DAX_Swap bound to deployed ledger
    const DAX_Swap = await hre.ethers.getContractFactory("DAX_Swap");
    daxSwap = await DAX_Swap.deploy(
      await daxToken.getAddress(),
      ledger.address,
      ETH_RATE
    );
    await daxSwap.waitForDeployment();

    // 3. Deploy Mock USDT (6 decimals), USDC (6 decimals), WBTC (8 decimals)
    const MockToken = await hre.ethers.getContractFactory("MockToken");
    mockUsdt = await MockToken.deploy("Tether USD", "USDT", hre.ethers.parseUnits("1000000", 6));
    await mockUsdt.waitForDeployment();

    mockUsdc = await MockToken.deploy("USD Coin", "USDC", hre.ethers.parseUnits("1000000", 6));
    await mockUsdc.waitForDeployment();

    mockWbtc = await MockToken.deploy("Wrapped BTC", "WBTC", hre.ethers.parseUnits("10000", 8));
    await mockWbtc.waitForDeployment();

    // Configure token rates in Swap gate (ledger is the authorized caller)
    await daxSwap.connect(ledger).setTokenRate(await mockUsdt.getAddress(), 6, USDT_RATE);
    await daxSwap.connect(ledger).setTokenRate(await mockUsdc.getAddress(), 6, USDC_RATE);
    await daxSwap.connect(ledger).setTokenRate(await mockWbtc.getAddress(), 8, WBTC_RATE);

    // 4. Fund Swap contract with DAX liquidity
    await daxToken.transfer(await daxSwap.getAddress(), INITIAL_SWAP_RESERVE);

    // 5. Fund Alice with test tokens
    await mockUsdt.mint(alice.address, hre.ethers.parseUnits("1000", 6));
    await mockUsdc.mint(alice.address, hre.ethers.parseUnits("1000", 6));
    await mockWbtc.mint(alice.address, hre.ethers.parseUnits("2", 8));
  });

  describe("DAX_Token Specification", function () {
    it("Should have exact total supply of 2,000,000,000 DAX", async function () {
      expect(await daxToken.totalSupply()).to.equal(TOTAL_CAP);
      expect(await daxToken.name()).to.equal("DAX Token");
      expect(await daxToken.symbol()).to.equal("DAX");
      expect(await daxToken.decimals()).to.equal(18);
    });

    it("Should prevent deployment with zero initialHolder address", async function () {
      const DAX_Token = await hre.ethers.getContractFactory("DAX_Token");
      await expect(
        DAX_Token.deploy(hre.ethers.ZeroAddress)
      ).to.be.revertedWith("DAX_Token: Invalid initial holder");
    });
  });

  describe("DAX_Swap: Digital Asset Swapping & Ledger Invariant", function () {
    it("Should swap native ETH to DAX and forward 100% of ETH to deployed ledger", async function () {
      const ethAmount = hre.ethers.parseEther("1.0"); // 1 ETH
      const expectedDax = hre.ethers.parseEther("25000"); // 25,000 DAX

      const initialLedgerBalance = await hre.ethers.provider.getBalance(ledger.address);
      const initialAliceDax = await daxToken.balanceOf(alice.address);

      // Alice swaps 1 ETH
      const tx = await daxSwap.connect(alice).swapEthForDax(expectedDax, { value: ethAmount });
      await expect(tx)
        .to.emit(daxSwap, "TokensSwapped")
        .withArgs(alice.address, hre.ethers.ZeroAddress, ethAmount, expectedDax, ledger.address);

      // INVARIANT: Deployed ledger received 100% of the ETH
      const finalLedgerBalance = await hre.ethers.provider.getBalance(ledger.address);
      expect(finalLedgerBalance - initialLedgerBalance).to.equal(ethAmount);

      // INVARIANT: Alice received exact expected DAX
      const finalAliceDax = await daxToken.balanceOf(alice.address);
      expect(finalAliceDax - initialAliceDax).to.equal(expectedDax);
    });

    it("Should swap ERC-20 (USDT) to DAX and forward 100% of USDT to deployed ledger", async function () {
      const usdtAmount = hre.ethers.parseUnits("100", 6); // 100 USDT
      const expectedDax = hre.ethers.parseEther("1000"); // 100 * 10 = 1,000 DAX

      // Alice approves DAX_Swap for USDT
      await mockUsdt.connect(alice).approve(await daxSwap.getAddress(), usdtAmount);

      const initialLedgerUsdt = await mockUsdt.balanceOf(ledger.address);
      const initialAliceDax = await daxToken.balanceOf(alice.address);

      // Alice swaps USDT
      const tx = await daxSwap.connect(alice).swapTokenForDax(
        await mockUsdt.getAddress(),
        usdtAmount,
        expectedDax
      );
      await expect(tx)
        .to.emit(daxSwap, "TokensSwapped")
        .withArgs(alice.address, await mockUsdt.getAddress(), usdtAmount, expectedDax, ledger.address);

      // INVARIANT: Deployed ledger received 100% of the swapped USDT
      const finalLedgerUsdt = await mockUsdt.balanceOf(ledger.address);
      expect(finalLedgerUsdt - initialLedgerUsdt).to.equal(usdtAmount);

      // INVARIANT: Alice received exact expected DAX
      const finalAliceDax = await daxToken.balanceOf(alice.address);
      expect(finalAliceDax - initialAliceDax).to.equal(expectedDax);
    });

    it("Should swap ERC-20 (USDC) to DAX and forward 100% of USDC to deployed ledger", async function () {
      const usdcAmount = hre.ethers.parseUnits("250", 6); // 250 USDC
      const expectedDax = hre.ethers.parseEther("2500"); // 250 * 10 = 2,500 DAX

      await mockUsdc.connect(alice).approve(await daxSwap.getAddress(), usdcAmount);

      const initialLedgerUsdc = await mockUsdc.balanceOf(ledger.address);
      const initialAliceDax = await daxToken.balanceOf(alice.address);

      await daxSwap.connect(alice).swapTokenForDax(
        await mockUsdc.getAddress(),
        usdcAmount,
        expectedDax
      );

      // INVARIANT: Deployed ledger received 100% of the swapped USDC
      const finalLedgerUsdc = await mockUsdc.balanceOf(ledger.address);
      expect(finalLedgerUsdc - initialLedgerUsdc).to.equal(usdcAmount);

      // INVARIANT: Alice received exact expected DAX
      const finalAliceDax = await daxToken.balanceOf(alice.address);
      expect(finalAliceDax - initialAliceDax).to.equal(expectedDax);
    });

    it("Should swap ERC-20 (WBTC) to DAX and forward 100% of WBTC to deployed ledger", async function () {
      const wbtcAmount = hre.ethers.parseUnits("0.5", 8); // 0.5 WBTC (8 decimals)
      const expectedDax = hre.ethers.parseEther("325000"); // 0.5 * 650,000 = 325,000 DAX

      await mockWbtc.connect(alice).approve(await daxSwap.getAddress(), wbtcAmount);

      const initialLedgerWbtc = await mockWbtc.balanceOf(ledger.address);
      const initialAliceDax = await daxToken.balanceOf(alice.address);

      await daxSwap.connect(alice).swapTokenForDax(
        await mockWbtc.getAddress(),
        wbtcAmount,
        expectedDax
      );

      // INVARIANT: Deployed ledger received 100% of the swapped WBTC
      const finalLedgerWbtc = await mockWbtc.balanceOf(ledger.address);
      expect(finalLedgerWbtc - initialLedgerWbtc).to.equal(wbtcAmount);

      // INVARIANT: Alice received exact expected DAX
      const finalAliceDax = await daxToken.balanceOf(alice.address);
      expect(finalAliceDax - initialAliceDax).to.equal(expectedDax);
    });

    it("Should provide accurate quotes via getQuote for ETH, USDT, USDC, and WBTC", async function () {
      const ethQuote = await daxSwap.getQuote(hre.ethers.ZeroAddress, hre.ethers.parseEther("2"));
      expect(ethQuote).to.equal(hre.ethers.parseEther("50000")); // 2 * 25,000

      const usdtQuote = await daxSwap.getQuote(await mockUsdt.getAddress(), hre.ethers.parseUnits("50", 6));
      expect(usdtQuote).to.equal(hre.ethers.parseEther("500")); // 50 * 10

      const usdcQuote = await daxSwap.getQuote(await mockUsdc.getAddress(), hre.ethers.parseUnits("75", 6));
      expect(usdcQuote).to.equal(hre.ethers.parseEther("750")); // 75 * 10

      const wbtcQuote = await daxSwap.getQuote(await mockWbtc.getAddress(), hre.ethers.parseUnits("0.1", 8));
      expect(wbtcQuote).to.equal(hre.ethers.parseEther("65000")); // 0.1 * 650,000
    });

    it("Should revert if minDaxOut exceeds calculated output (slippage protection)", async function () {
      const ethAmount = hre.ethers.parseEther("1.0");
      const unrealisticDax = hre.ethers.parseEther("30000");

      await expect(
        daxSwap.connect(alice).swapEthForDax(unrealisticDax, { value: ethAmount })
      ).to.be.revertedWith("DAX_Swap: Slippage limit exceeded");
    });

    it("Should revert if non-ledger caller attempts to update rates or withdraw liquidity", async function () {
      await expect(
        daxSwap.connect(bob).setEthRate(hre.ethers.parseEther("30000"))
      ).to.be.revertedWith("DAX_Swap: Only deployed ledger authorized");

      await expect(
        daxSwap.connect(bob).withdrawDaxLiquidity(hre.ethers.parseEther("1000"))
      ).to.be.revertedWith("DAX_Swap: Only deployed ledger authorized");
    });

    it("Should allow deployed ledger to withdraw DAX liquidity back", async function () {
      const withdrawAmount = hre.ethers.parseEther("500000");
      await daxSwap.connect(ledger).withdrawDaxLiquidity(withdrawAmount);
      expect(await daxToken.balanceOf(ledger.address)).to.equal(withdrawAmount);
    });

    describe("Reverse Swaps (DAX -> Digital Assets) & Protocol Exit Spread", function () {
      beforeEach(async function () {
        // Fund swap contract with ETH and token reserves to support redemptions
        await ledger.sendTransaction({
          to: await daxSwap.getAddress(),
          value: hre.ethers.parseEther("10.0"), // 10 ETH reserve
        });

        await mockUsdt.mint(await daxSwap.getAddress(), hre.ethers.parseUnits("50000", 6));
        await mockUsdc.mint(await daxSwap.getAddress(), hre.ethers.parseUnits("50000", 6));
        await mockWbtc.mint(await daxSwap.getAddress(), hre.ethers.parseUnits("5", 8));

        // Fund Alice with DAX for testing redemptions
        await daxToken.transfer(alice.address, hre.ethers.parseEther("1000000"));
        await daxToken.connect(alice).approve(await daxSwap.getAddress(), hre.ethers.MaxUint256);
      });

      it("Should swap DAX to ETH with 2.5% exit spread sent to ledger", async function () {
        const daxIn = hre.ethers.parseEther("25000"); // 25,000 DAX (Gross 1 ETH at 25,000 rate)
        const grossEth = hre.ethers.parseEther("1.0");
        const spreadEth = (grossEth * 250n) / 10000n; // 0.025 ETH (2.5%)
        const netEth = grossEth - spreadEth; // 0.975 ETH

        const initialAliceEth = await hre.ethers.provider.getBalance(alice.address);
        const initialLedgerEth = await hre.ethers.provider.getBalance(ledger.address);

        const tx = await daxSwap.connect(alice).swapDaxForEth(daxIn, netEth);
        const receipt = await tx.wait();
        const gasCost = receipt.gasUsed * receipt.gasPrice;

        const finalAliceEth = await hre.ethers.provider.getBalance(alice.address);
        const finalLedgerEth = await hre.ethers.provider.getBalance(ledger.address);

        // Alice receives netEth minus gas
        expect(finalAliceEth - initialAliceEth + gasCost).to.equal(netEth);

        // Ledger receives exact spreadEth
        expect(finalLedgerEth - initialLedgerEth).to.equal(spreadEth);
      });

      it("Should swap DAX to USDT with 2.5% exit spread sent to ledger", async function () {
        const daxIn = hre.ethers.parseEther("1000"); // 1,000 DAX (Gross 100 USDT at 10 rate)
        const grossUsdt = hre.ethers.parseUnits("100", 6);
        const spreadUsdt = (grossUsdt * 250n) / 10000n; // 2.5 USDT
        const netUsdt = grossUsdt - spreadUsdt; // 97.5 USDT

        const initialAliceUsdt = await mockUsdt.balanceOf(alice.address);
        const initialLedgerUsdt = await mockUsdt.balanceOf(ledger.address);

        await daxSwap.connect(alice).swapDaxForToken(await mockUsdt.getAddress(), daxIn, netUsdt);

        const finalAliceUsdt = await mockUsdt.balanceOf(alice.address);
        const finalLedgerUsdt = await mockUsdt.balanceOf(ledger.address);

        expect(finalAliceUsdt - initialAliceUsdt).to.equal(netUsdt);
        expect(finalLedgerUsdt - initialLedgerUsdt).to.equal(spreadUsdt);
      });

      it("Should swap DAX to USDC with 2.5% exit spread sent to ledger", async function () {
        const daxIn = hre.ethers.parseEther("2500"); // 2,500 DAX (Gross 250 USDC at 10 rate)
        const grossUsdc = hre.ethers.parseUnits("250", 6);
        const spreadUsdc = (grossUsdc * 250n) / 10000n; // 6.25 USDC
        const netUsdc = grossUsdc - spreadUsdc; // 243.75 USDC

        const initialAliceUsdc = await mockUsdc.balanceOf(alice.address);
        const initialLedgerUsdc = await mockUsdc.balanceOf(ledger.address);

        await daxSwap.connect(alice).swapDaxForToken(await mockUsdc.getAddress(), daxIn, netUsdc);

        const finalAliceUsdc = await mockUsdc.balanceOf(alice.address);
        const finalLedgerUsdc = await mockUsdc.balanceOf(ledger.address);

        expect(finalAliceUsdc - initialAliceUsdc).to.equal(netUsdc);
        expect(finalLedgerUsdc - initialLedgerUsdc).to.equal(spreadUsdc);
      });

      it("Should swap DAX to WBTC with 2.5% exit spread sent to ledger", async function () {
        const daxIn = hre.ethers.parseEther("650000"); // 650,000 DAX (Gross 1 WBTC at 650,000 rate)
        const grossWbtc = hre.ethers.parseUnits("1.0", 8);
        const spreadWbtc = (grossWbtc * 250n) / 10000n; // 0.025 WBTC
        const netWbtc = grossWbtc - spreadWbtc; // 0.975 WBTC

        const initialAliceWbtc = await mockWbtc.balanceOf(alice.address);
        const initialLedgerWbtc = await mockWbtc.balanceOf(ledger.address);

        await daxSwap.connect(alice).swapDaxForToken(await mockWbtc.getAddress(), daxIn, netWbtc);

        const finalAliceWbtc = await mockWbtc.balanceOf(alice.address);
        const finalLedgerWbtc = await mockWbtc.balanceOf(ledger.address);

        expect(finalAliceWbtc - initialAliceWbtc).to.equal(netWbtc);
        expect(finalLedgerWbtc - initialLedgerWbtc).to.equal(spreadWbtc);
      });

      it("Should provide accurate quotes via getReverseQuote for all assets", async function () {
        // ETH
        const [netEth, spreadEth] = await daxSwap.getReverseQuote(
          hre.ethers.ZeroAddress,
          hre.ethers.parseEther("25000")
        );
        expect(netEth).to.equal(hre.ethers.parseEther("0.975"));
        expect(spreadEth).to.equal(hre.ethers.parseEther("0.025"));

        // USDT
        const [netUsdt, spreadUsdt] = await daxSwap.getReverseQuote(
          await mockUsdt.getAddress(),
          hre.ethers.parseEther("1000")
        );
        expect(netUsdt).to.equal(hre.ethers.parseUnits("97.5", 6));
        expect(spreadUsdt).to.equal(hre.ethers.parseUnits("2.5", 6));

        // USDC
        const [netUsdc, spreadUsdc] = await daxSwap.getReverseQuote(
          await mockUsdc.getAddress(),
          hre.ethers.parseEther("2500")
        );
        expect(netUsdc).to.equal(hre.ethers.parseUnits("243.75", 6));
        expect(spreadUsdc).to.equal(hre.ethers.parseUnits("6.25", 6));

        // WBTC
        const [netWbtc, spreadWbtc] = await daxSwap.getReverseQuote(
          await mockWbtc.getAddress(),
          hre.ethers.parseEther("650000")
        );
        expect(netWbtc).to.equal(hre.ethers.parseUnits("0.975", 8));
        expect(spreadWbtc).to.equal(hre.ethers.parseUnits("0.025", 8));
      });

      it("Should allow ledger to update exit spread and enforce 10% maximum cap", async function () {
        // Ledger sets to 3% (300 bps)
        await daxSwap.connect(ledger).setExitSpreadBps(300);
        expect(await daxSwap.exitSpreadBps()).to.equal(300);

        // Setting > 1000 bps (10%) reverts
        await expect(
          daxSwap.connect(ledger).setExitSpreadBps(1001)
        ).to.be.revertedWith("DAX_Swap: Spread cannot exceed 10%");

        // Non-ledger caller reverts
        await expect(
          daxSwap.connect(bob).setExitSpreadBps(100)
        ).to.be.revertedWith("DAX_Swap: Only deployed ledger authorized");
      });
    });
  });
});
