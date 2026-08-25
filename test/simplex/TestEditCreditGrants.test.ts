import hre from 'hardhat'
import { labelhash, zeroAddress, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, node, registration, YEAR } from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const connection = await hre.network.connect()
const [ownerClient, guardianClient, registrarClient, aliceClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.controller.write.setRegistrarCredits([registrar.address, 100n], {
    account: guardian,
  })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

async function sponsoredRegister(controller: any, reg: any) {
  await controller.write.commit([await controller.read.makeCommitment([reg])], {
    account: registrar,
  })
  return controller.write.registerWithCredit([reg], { account: registrar })
}

describe('edit credit grants', () => {
  it('grants 10 per year at registration against the default resolver', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(
      controller,
      registration('twoyears', alice.address, {
        duration: 2n * YEAR,
        resolver: resolver.address,
      }),
    )
    expect(await resolver.read.editCredits([node('twoyears')])).toBe(20n)
  })

  it('grants nothing when the registration uses another resolver', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(
      controller,
      registration('noresolver', alice.address, { resolver: zeroAddress }),
    )
    expect(await resolver.read.editCredits([node('noresolver')])).toBe(0n)
  })

  it('rounds down, with a floor of one year', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(
      controller,
      registration('shortish', alice.address, {
        duration: 364n * DAY,
        resolver: resolver.address,
      }),
    )
    expect(await resolver.read.editCredits([node('shortish')])).toBe(10n)

    await sponsoredRegister(
      controller,
      registration('longish', alice.address, {
        duration: 366n * DAY,
        resolver: resolver.address,
      }),
    )
    expect(await resolver.read.editCredits([node('longish')])).toBe(10n)

    await sponsoredRegister(
      controller,
      registration('minimal', alice.address, {
        duration: 28n * DAY,
        resolver: resolver.address,
      }),
    )
    expect(await resolver.read.editCredits([node('minimal')])).toBe(10n)
  })

  it('adds on renewal rather than replacing', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(
      controller,
      registration('renewme', alice.address, { resolver: resolver.address }),
    )
    expect(await resolver.read.editCredits([node('renewme')])).toBe(10n)

    await controller.write.renewWithCredit(['renewme', 3n * YEAR, zeroHash], {
      account: registrar,
    })
    expect(await resolver.read.editCredits([node('renewme')])).toBe(40n)
  })

  it('a renewal by an unrelated address is a gift, never a reduction', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(
      controller,
      registration('hostile', alice.address, {
        duration: 5n * YEAR,
        resolver: resolver.address,
      }),
    )
    expect(await resolver.read.editCredits([node('hostile')])).toBe(50n)

    // anyone may renew anyone's name, for the minimum term
    await controller.write.setPublicSalesOpen([true], { account: owner })
    await controller.write.renew(['hostile', 28n * DAY, zeroHash], {
      account: alice,
      value: 0n,
    })
    expect(await resolver.read.editCredits([node('hostile')])).toBe(60n)
  })

  it('registerReserved sets the resolver and grants credits, so a brand needs no ETH', async () => {
    const { controller, resolver, ens, baseRegistrar } = await load()
    await controller.write.addReservedNames([['brandname']], { account: owner })
    await controller.write.registerReserved(
      ['brandname', alice.address, YEAR],
      { account: owner },
    )

    expect((await ens.read.resolver([node('brandname')])).toLowerCase()).toBe(
      resolver.address.toLowerCase(),
    )
    expect((await ens.read.owner([node('brandname')])).toLowerCase()).toBe(
      alice.address.toLowerCase(),
    )
    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('brandname'))])
      ).toLowerCase(),
    ).toBe(alice.address.toLowerCase())
    expect(await resolver.read.editCredits([node('brandname')])).toBe(10n)
  })
})
