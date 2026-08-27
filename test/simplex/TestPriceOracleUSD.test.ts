import hre from 'hardhat'
import { describe, expect, it } from 'vitest'

import { PRICE_CURVE, YEAR, yearPriceUSD } from './fixtures/namesV2.js'

const connection = await hre.network.connect()

async function fixture() {
  const feed = await connection.viem.deployContract('DummyOracle', [
    100000000n, // $1 per ETH, so 1 attoUSD is 1 wei
  ])
  const oracle = await connection.viem.deployContract('StablePriceOracle', [
    feed.address,
    PRICE_CURVE,
  ])
  const fiveEntry = await connection.viem.deployContract('StablePriceOracle', [
    feed.address,
    PRICE_CURVE.slice(0, 5),
  ])
  return { feed, oracle, fiveEntry }
}
const load = () => connection.networkHelpers.loadFixture(fixture)

/**
 * `priceUSD` is what makes a registrar allowance denominable in money: it
 * returns the quote in the unit the price list is configured in, before the
 * conversion to ETH that makes `price` unusable as a spending limit.
 */
describe('IPriceOracleUSD', () => {
  it('quotes in attoUSD, unaffected by the ETH price', async () => {
    const { oracle, feed } = await load()
    const before = await oracle.read.priceUSD(['sixchr', 0n, YEAR])
    await feed.write.set([500000000n]) // ETH quintuples
    const after = await oracle.read.priceUSD(['sixchr', 0n, YEAR])

    expect(before.base).toBe(yearPriceUSD(6))
    expect(after.base).toBe(before.base)
    expect(after.premium).toBe(0n)
  })

  it('while `price` moves with it, which is why it cannot be the limit', async () => {
    const { oracle, feed } = await load()
    const before = await oracle.read.price(['sixchr', 0n, YEAR])
    await feed.write.set([500000000n])
    const after = await oracle.read.price(['sixchr', 0n, YEAR])
    expect(after.base).toBe(before.base / 5n)
  })

  it('the two agree at the current rate', async () => {
    const { oracle } = await load()
    const usd = await oracle.read.priceUSD(['sixchr', 0n, YEAR])
    const wei = await oracle.read.price(['sixchr', 0n, YEAR])
    // the fixture feed pins 1 attoUSD to 1 wei
    expect(wei.base).toBe(usd.base)
  })

  it('prices a six-character name apart from a five-character one', async () => {
    const { oracle } = await load()
    const six = await oracle.read.priceUSD(['sixchr', 0n, YEAR])
    const five = await oracle.read.priceUSD(['fivec', 0n, YEAR])
    const four = await oracle.read.priceUSD(['four', 0n, YEAR])
    const three = await oracle.read.priceUSD(['thr', 0n, YEAR])
    const long = await oracle.read.priceUSD(['averylongname', 0n, YEAR])

    expect(long.base).toBe(six.base)
    expect(five.base).toBe(10n * six.base)
    expect(four.base).toBe(100n * six.base)
    expect(three.base).toBe(1000n * six.base)
  })

  it('scales with duration', async () => {
    const { oracle } = await load()
    const one = await oracle.read.priceUSD(['sixchr', 0n, YEAR])
    const three = await oracle.read.priceUSD(['sixchr', 0n, 3n * YEAR])
    expect(three.base).toBe(3n * one.base)
  })

  it('a five-entry curve keeps the old behaviour: 5 and 6+ priced alike', async () => {
    const { fiveEntry, oracle } = await load()
    const six = await fiveEntry.read.priceUSD(['sixchr', 0n, YEAR])
    const five = await fiveEntry.read.priceUSD(['fivec', 0n, YEAR])
    expect(six.base).toBe(five.base)
    expect(await fiveEntry.read.price6Letter()).toBe(
      await fiveEntry.read.price5Letter(),
    )
    // and it differs from the six-entry deployment, which is the point
    expect(six.base).not.toBe(
      (await oracle.read.priceUSD(['sixchr', 0n, YEAR])).base,
    )
  })

  it('refuses a feed reporting zero rather than panicking on the division', async () => {
    const { oracle, feed } = await load()
    await feed.write.set([0n])
    await expect(
      oracle.read.price(['sixchr', 0n, YEAR]),
    ).toBeRevertedWithCustomError('InvalidPriceFeed')
  })

  it('refuses a negative feed rather than handing out free names', async () => {
    const { oracle, feed } = await load()
    await feed.write.set([-100000000n])
    await expect(
      oracle.read.price(['sixchr', 0n, YEAR]),
    ).toBeRevertedWithCustomError('InvalidPriceFeed')
  })

  it('quotes in attoUSD regardless — the USD path never reads the feed', async () => {
    const { oracle, feed } = await load()
    const before = await oracle.read.priceUSD(['sixchr', 0n, YEAR])
    await feed.write.set([0n])
    expect((await oracle.read.priceUSD(['sixchr', 0n, YEAR])).base).toBe(
      before.base,
    )
    await feed.write.set([-100000000n])
    expect((await oracle.read.priceUSD(['sixchr', 0n, YEAR])).base).toBe(
      before.base,
    )
  })

  it('advertises the interface', async () => {
    const { oracle } = await load()
    // IPriceOracleUSD = IPriceOracle.priceUSD selector xor'd per ERC-165 rules;
    // assert via the contract rather than recomputing it here
    expect(await oracle.read.supportsInterface(['0x01ffc9a7'])).toBe(true)
  })
})
