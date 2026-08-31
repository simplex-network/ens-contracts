import hre from 'hardhat'
import { toFunctionSelector, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  registration,
  YEAR,
  yearPriceUSD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient, registrarClient, aliceClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account

const USD = 10n ** 18n
const GRACE_PERIOD = 90n * DAY
/** ENS's mainnet auction: $100,000,000 decaying to nothing over 21 days. */
const START_PREMIUM = 100000000n * USD
const TOTAL_DAYS = 21n

const rung = (maxLength: bigint, priceUSDPerYear: bigint) => ({
  maxLength,
  priceUSDPerYear,
})

/** Base $1/yr with rungs at 13 and 32, the gapped curve from the plan. */
const GAPPED = [rung(13n, 4n * USD), rung(32n, 2n * USD)]
/** The `.simplex` launch curve: $1 at 6+, $8 at 5, $32 at 4, $128 at 3. */
const LAUNCH = [rung(3n, 128n * USD), rung(4n, 32n * USD), rung(5n, 8n * USD)]

const label = (len: number) => 'a'.repeat(len)

async function fixture() {
  // 1e8 pins 1 attoUSD to 1 wei, so `price` and `priceUSD` are comparable.
  const feed = await connection.viem.deployContract('DummyOracle', [100000000n])
  const oracle = await connection.viem.deployContract('SimplexPriceOracle', [
    feed.address,
    USD,
    GAPPED,
    0n,
    0n,
  ])
  return { feed, oracle }
}
const load = () => connection.networkHelpers.loadFixture(fixture)

/** The premium alone, evaluated `elapsed` seconds into the auction. */
async function premiumAt(oracle: any, elapsed: bigint) {
  const { timestamp } = await publicClient.getBlock()
  const expires = timestamp - GRACE_PERIOD - elapsed
  return (await oracle.read.priceUSD(['name', expires, YEAR])).premium
}

describe('SimplexPriceOracle', () => {
  describe('band lookup and gaps', () => {
    it('inherits the rung above through a gap, and falls to base past the top', async () => {
      const { oracle } = await load()
      const at = async (len: number) =>
        (await oracle.read.priceUSD([label(len), 0n, YEAR])).base

      // rung 13 covers everything up to 13, with no entry for 1..12
      expect(await at(1)).toBe(4n * USD)
      expect(await at(12)).toBe(4n * USD)
      expect(await at(13)).toBe(4n * USD)
      // rung 32 covers 14..32
      expect(await at(14)).toBe(2n * USD)
      expect(await at(31)).toBe(2n * USD)
      expect(await at(32)).toBe(2n * USD)
      // above the tallest rung, the base price
      expect(await at(33)).toBe(1n * USD)
      expect(await at(100)).toBe(1n * USD)
    })

    it('reproduces the launch curve exactly', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([USD, LAUNCH], { account: owner })
      const at = async (len: number) =>
        (await oracle.read.priceUSD([label(len), 0n, YEAR])).base

      expect(await at(3)).toBe(128n * USD)
      expect(await at(4)).toBe(32n * USD)
      expect(await at(5)).toBe(8n * USD)
      expect(await at(6)).toBe(1n * USD)
      expect(await at(30)).toBe(1n * USD)
      // shorter than the shortest rung, so it inherits it rather than the base
      expect(await at(1)).toBe(128n * USD)
    })

    it('quotes the empty label as the shortest name, not as free', async () => {
      const { oracle } = await load()
      expect((await oracle.read.priceUSD(['', 0n, YEAR])).base).toBe(4n * USD)
    })

    it('counts codepoints, not bytes', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([USD, LAUNCH], { account: owner })
      // three emoji are twelve bytes but three characters
      expect((await oracle.read.priceUSD(['🚀🚀🚀', 0n, YEAR])).base).toBe(
        128n * USD,
      )
    })

    it('a free TLD is an empty curve with a zero base', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([0n, []], { account: owner })
      expect(await oracle.read.topRung()).toBe(0n)
      for (const len of [1, 5, 20, 64]) {
        expect((await oracle.read.priceUSD([label(len), 0n, YEAR])).base).toBe(
          0n,
        )
      }
    })

    it('a shrunk curve does not read the entries left above the new top', async () => {
      const { oracle } = await load()
      expect(await oracle.read.topRung()).toBe(32n)
      expect((await oracle.read.priceUSD([label(20), 0n, YEAR])).base).toBe(
        2n * USD,
      )
      // 20 still holds 2e18 in the map, but topRung now gates it out
      await oracle.write.setPrices([USD, [rung(5n, 8n * USD)]], {
        account: owner,
      })
      expect(await oracle.read.topRung()).toBe(5n)
      expect((await oracle.read.priceUSD([label(20), 0n, YEAR])).base).toBe(
        1n * USD,
      )
    })
  })

  describe('curve validation', () => {
    const rejects = async (
      oracle: any,
      base: bigint,
      rungs: ReturnType<typeof rung>[],
      error: string,
    ) =>
      expect(
        oracle.write.setPrices([base, rungs], { account: owner }),
      ).toBeRevertedWithCustomError(error)

    it('rejects a rung at length zero', async () => {
      const { oracle } = await load()
      await rejects(oracle, USD, [rung(0n, 4n * USD)], 'RungLengthOutOfRange')
    })

    it('rejects a rung above MAX_RUNG_LENGTH', async () => {
      const { oracle } = await load()
      expect(await oracle.read.MAX_RUNG_LENGTH()).toBe(64n)
      await rejects(oracle, USD, [rung(65n, 4n * USD)], 'RungLengthOutOfRange')
    })

    it('rejects lengths that do not strictly ascend', async () => {
      const { oracle } = await load()
      await rejects(
        oracle,
        USD,
        [rung(5n, 8n * USD), rung(3n, 4n * USD)],
        'RungLengthsNotAscending',
      )
      // a duplicate is not ascending either
      await rejects(
        oracle,
        USD,
        [rung(5n, 8n * USD), rung(5n, 4n * USD)],
        'RungLengthsNotAscending',
      )
    })

    it('rejects a price that rises as the length grows', async () => {
      const { oracle } = await load()
      await rejects(
        oracle,
        USD,
        [rung(3n, 8n * USD), rung(4n, 32n * USD)],
        'RungPricesNotDescending',
      )
    })

    it('rejects a base above the lowest rung', async () => {
      const { oracle } = await load()
      await rejects(
        oracle,
        9n * USD,
        [rung(5n, 8n * USD)],
        'BasePriceExceedsLowestRung',
      )
      // equal is allowed: it just flattens the curve
      await oracle.write.setPrices([8n * USD, [rung(5n, 8n * USD)]], {
        account: owner,
      })
      expect((await oracle.read.priceUSD([label(9), 0n, YEAR])).base).toBe(
        8n * USD,
      )
    })

    it('accepts a flat curve, since monotonicity is not strict', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([USD, [rung(3n, USD), rung(5n, USD)]], {
        account: owner,
      })
      expect((await oracle.read.priceUSD([label(3), 0n, YEAR])).base).toBe(USD)
      expect((await oracle.read.priceUSD([label(9), 0n, YEAR])).base).toBe(USD)
    })
  })

  describe('duration', () => {
    it('scales exactly with whole years', async () => {
      const { oracle } = await load()
      const one = (await oracle.read.priceUSD([label(40), 0n, YEAR])).base
      const three = (await oracle.read.priceUSD([label(40), 0n, 3n * YEAR]))
        .base
      expect(one).toBe(USD)
      expect(three).toBe(3n * one)
    })

    it('prorates a partial year', async () => {
      const { oracle } = await load()
      const month = 28n * DAY
      expect((await oracle.read.priceUSD([label(40), 0n, month])).base).toBe(
        (USD * month) / YEAR,
      )
    })
  })

  describe('the USD and ETH quotes', () => {
    it('quotes in attoUSD, unaffected by the ETH price', async () => {
      const { oracle, feed } = await load()
      const before = await oracle.read.priceUSD([label(40), 0n, YEAR])
      await feed.write.set([500000000n]) // ETH quintuples
      const after = await oracle.read.priceUSD([label(40), 0n, YEAR])
      expect(after.base).toBe(before.base)
    })

    it('while `price` moves inversely with it', async () => {
      const { oracle, feed } = await load()
      const before = await oracle.read.price([label(40), 0n, YEAR])
      await feed.write.set([500000000n])
      const after = await oracle.read.price([label(40), 0n, YEAR])
      expect(after.base).toBe(before.base / 5n)
    })

    it('the two agree at the pinned rate', async () => {
      const { oracle } = await load()
      const usd = await oracle.read.priceUSD([label(40), 0n, YEAR])
      const wei = await oracle.read.price([label(40), 0n, YEAR])
      expect(wei.base).toBe(usd.base)
    })
  })

  describe('the price feed', () => {
    it('refuses the zero address', async () => {
      const { oracle } = await load()
      await expect(
        oracle.write.setUsdOracle([zeroAddress], { account: owner }),
      ).toBeRevertedWithCustomError('ZeroAddress')
    })

    it('refuses a feed that is already dead', async () => {
      const { oracle } = await load()
      const dead = await connection.viem.deployContract('DummyOracle', [0n])
      await expect(
        oracle.write.setUsdOracle([dead.address], { account: owner }),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
      const negative = await connection.viem.deployContract('DummyOracle', [
        -100000000n,
      ])
      await expect(
        oracle.write.setUsdOracle([negative.address], { account: owner }),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
    })

    it('swaps the feed without moving the USD list price', async () => {
      const { oracle } = await load()
      const usdBefore = (await oracle.read.priceUSD([label(40), 0n, YEAR])).base
      const weiBefore = (await oracle.read.price([label(40), 0n, YEAR])).base

      const replacement = await connection.viem.deployContract('DummyOracle', [
        200000000n,
      ])
      await oracle.write.setUsdOracle([replacement.address], { account: owner })

      expect((await oracle.read.usdOracle()).toLowerCase()).toBe(
        replacement.address.toLowerCase(),
      )
      expect((await oracle.read.priceUSD([label(40), 0n, YEAR])).base).toBe(
        usdBefore,
      )
      expect((await oracle.read.price([label(40), 0n, YEAR])).base).toBe(
        weiBefore / 2n,
      )
    })

    it('a feed that dies after installation stops `price` but not `priceUSD`', async () => {
      const { oracle, feed } = await load()
      const before = (await oracle.read.priceUSD([label(40), 0n, YEAR])).base
      await feed.write.set([0n])
      await expect(
        oracle.read.price([label(40), 0n, YEAR]),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
      expect((await oracle.read.priceUSD([label(40), 0n, YEAR])).base).toBe(
        before,
      )
      await feed.write.set([-100000000n])
      await expect(
        oracle.read.price([label(40), 0n, YEAR]),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
      expect((await oracle.read.priceUSD([label(40), 0n, YEAR])).base).toBe(
        before,
      )
    })
  })

  describe('the premium', () => {
    async function premiumFixture() {
      const feed = await connection.viem.deployContract('DummyOracle', [
        100000000n,
      ])
      // Base zero on both, so `premium` is all that is being compared.
      const oracle = await connection.viem.deployContract(
        'SimplexPriceOracle',
        [feed.address, 0n, [], START_PREMIUM, TOTAL_DAYS],
      )
      const vendored = await connection.viem.deployContract(
        'ExponentialPremiumPriceOracle',
        [feed.address, [0n, 0n, 0n, 0n, 0n], START_PREMIUM, TOTAL_DAYS],
      )
      return { feed, oracle, vendored }
    }
    const loadPremium = () =>
      connection.networkHelpers.loadFixture(premiumFixture)

    it('matches the vendored oracle across the whole decay', async () => {
      const { oracle, vendored } = await loadPremium()
      const offsets = [
        0n,
        3600n,
        DAY,
        DAY + DAY / 2n,
        10n * DAY,
        21n * DAY - 864n, // 20.99 days
        21n * DAY,
        30n * DAY,
      ]
      for (const elapsed of offsets) {
        expect(await premiumAt(oracle, elapsed)).toBe(
          await premiumAt(vendored, elapsed),
        )
      }
    })

    it('starts at the full premium and reaches zero at totalDays', async () => {
      const { oracle } = await loadPremium()
      const endValue = await oracle.read.endValue()
      expect(await premiumAt(oracle, 0n)).toBe(START_PREMIUM - endValue)
      expect(await premiumAt(oracle, DAY)).toBe(START_PREMIUM / 2n - endValue)
      expect(await premiumAt(oracle, 21n * DAY)).toBe(0n)
      expect(await premiumAt(oracle, 30n * DAY)).toBe(0n)
    })

    it('charges nothing while the name is still in its grace period', async () => {
      const { oracle } = await loadPremium()
      const { timestamp } = await publicClient.getBlock()
      // expired an hour ago, so 90 days of grace remain
      const expires = timestamp - 3600n
      expect(
        (await oracle.read.priceUSD(['name', expires, YEAR])).premium,
      ).toBe(0n)
      // and nothing at all for a name that has not expired
      expect(
        (await oracle.read.priceUSD(['name', timestamp + YEAR, YEAR])).premium,
      ).toBe(0n)
    })

    it('is retuned by call', async () => {
      const { oracle } = await loadPremium()
      await oracle.write.setPremium([1000n * USD, 7n], { account: owner })
      expect(await oracle.read.startPremium()).toBe(1000n * USD)
      expect(await oracle.read.totalDays()).toBe(7n)
      expect(await oracle.read.endValue()).toBe((1000n * USD) >> 7n)
      expect(await premiumAt(oracle, 0n)).toBe(
        1000n * USD - ((1000n * USD) >> 7n),
      )
      expect(await premiumAt(oracle, 7n * DAY)).toBe(0n)
    })

    it('is switched off by a zero decay window', async () => {
      const { oracle } = await loadPremium()
      await oracle.write.setPremium([START_PREMIUM, 0n], { account: owner })
      for (const elapsed of [0n, DAY, 21n * DAY]) {
        expect(await premiumAt(oracle, elapsed)).toBe(0n)
      }
    })

    it('is a flat fee: it does not scale with duration', async () => {
      const { oracle } = await loadPremium()
      const { timestamp } = await publicClient.getBlock()
      const expires = timestamp - GRACE_PERIOD - DAY
      const one = await oracle.read.priceUSD(['name', expires, YEAR])
      const three = await oracle.read.priceUSD(['name', expires, 3n * YEAR])
      expect(three.premium).toBe(one.premium)
    })
  })

  describe('ownership', () => {
    const OWNABLE = 'Ownable: caller is not the owner'

    it('refuses every setter to a non-owner', async () => {
      const { oracle, feed } = await load()
      await expect(
        oracle.write.setPrices([USD, LAUNCH], { account: alice }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        oracle.write.setUsdOracle([feed.address], { account: alice }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        oracle.write.setPremium([USD, 21n], { account: alice }),
      ).toBeRevertedWithString(OWNABLE)
    })

    it('hands over in two steps, and the pending owner has nothing until it accepts', async () => {
      const { oracle } = await load()
      await oracle.write.transferOwnership([guardian.address], {
        account: owner,
      })
      expect((await oracle.read.pendingOwner()).toLowerCase()).toBe(
        guardian.address.toLowerCase(),
      )
      await expect(
        oracle.write.setPrices([USD, LAUNCH], { account: guardian }),
      ).toBeRevertedWithString(OWNABLE)

      await oracle.write.acceptOwnership({ account: guardian })
      expect((await oracle.read.owner()).toLowerCase()).toBe(
        guardian.address.toLowerCase(),
      )
      await oracle.write.setPrices([USD, LAUNCH], { account: guardian })
      await expect(
        oracle.write.setPrices([USD, LAUNCH], { account: owner }),
      ).toBeRevertedWithString(OWNABLE)
    })
  })

  it('advertises the price-oracle interfaces', async () => {
    const { oracle, feed } = await load()
    const ids = [
      '0x01ffc9a7', // IERC165
      toFunctionSelector('price(string,uint256,uint256)'), // IPriceOracle
      toFunctionSelector('priceUSD(string,uint256,uint256)'), // IPriceOracleUSD
    ] as const
    const vendored = await connection.viem.deployContract('StablePriceOracle', [
      feed.address,
      [0n, 0n, 0n, 0n, 0n],
    ])
    for (const id of ids) {
      expect(await oracle.read.supportsInterface([id])).toBe(true)
      // the same three the vendored oracle claims, which is what makes it a swap
      expect(await vendored.read.supportsInterface([id])).toBe(true)
    }
    expect(await oracle.read.supportsInterface(['0xdeadbeef'])).toBe(false)
  })

  describe('against the controller', () => {
    async function stackFixture() {
      const f = await deployNamesV2(connection, {
        owner: owner.address,
        beneficiary: guardian.address,
      })
      await f.controller.write.setPublicSalesOpen([true], { account: guardian })
      await f.controller.write.setRegistrarAllowance(
        [registrar.address, AMPLE_ALLOWANCE],
        { account: guardian },
      )
      return f
    }
    const loadStack = () => connection.networkHelpers.loadFixture(stackFixture)

    const register = async (controller: any, name: string, value: bigint) => {
      const reg = registration(name, alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        {
          account: alice,
        },
      )
      return controller.write.register([reg], { account: alice, value })
    }

    it('is what the fixture stack now prices with', async () => {
      const { controller, priceOracle } = await loadStack()
      expect((await controller.read.prices()).toLowerCase()).toBe(
        priceOracle.address.toLowerCase(),
      )
      expect(await controller.read.rentPrice(['sixchr', YEAR])).toHaveProperty(
        'base',
        yearPriceUSD(6),
      )
    })

    it('a curve change by call moves what the next registration pays', async () => {
      const { controller, priceOracle } = await loadStack()
      const before = (await controller.read.rentPrice(['sixchr', YEAR])).base
      await priceOracle.write.setPrices([2n * USD, LAUNCH], { account: owner })
      const after = (await controller.read.rentPrice(['sixchr', YEAR])).base
      expect(after).toBe(2n * USD)
      expect(after).not.toBe(before)

      await register(controller, 'sixchr', after)
      expect(await controller.read.available(['sixchr'])).toBe(false)
      // the fee actually charged is the new one, and the excess is refunded
      expect(
        await publicClient.getBalance({ address: controller.address }),
      ).toBe(after)
    })

    it('the sponsored path spends the new price in attoUSD', async () => {
      const { controller, priceOracle } = await loadStack()
      await priceOracle.write.setPrices([2n * USD, LAUNCH], { account: owner })
      // drop to five characters so the $8 rung is reachable at all
      await controller.write.setMinCharLength([5], { account: owner })
      const reg = registration('spons', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([reg])],
        { account: registrar },
      )
      await controller.write.registerWithCredit([reg], { account: registrar })
      expect(
        await controller.read.registrarAllowance([registrar.address]),
      ).toBe(
        AMPLE_ALLOWANCE - 8n * USD, // five characters, so the $8 rung
      )
    })
  })
})
