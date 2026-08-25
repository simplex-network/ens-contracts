import hre from 'hardhat'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, node, registration } from './fixtures/namesV2.js'

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
  await f.controller.write.setRegistrarCredits([registrar.address, 3n], {
    account: guardian,
  })
  const reg = registration('acceptme', alice.address, {
    resolver: f.resolver.address,
  })
  await f.controller.write.commit(
    [await f.controller.read.makeCommitment([reg])],
    { account: registrar },
  )
  await f.controller.write.registerWithCredit([reg], { account: registrar })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

describe('topUpEditCredits', () => {
  it('adds to a name and spends one registrar credit', async () => {
    const { controller, resolver } = await load()
    expect(await resolver.read.editCredits([node('acceptme')])).toBe(10n)

    await controller.write.topUpEditCredits([node('acceptme'), 10n], {
      account: registrar,
    })

    expect(await resolver.read.editCredits([node('acceptme')])).toBe(20n)
    expect(await controller.read.registrarCredits([registrar.address])).toBe(1n)
  })

  it('is additive across calls', async () => {
    const { controller, resolver } = await load()
    await controller.write.topUpEditCredits([node('acceptme'), 10n], {
      account: registrar,
    })
    await controller.write.topUpEditCredits([node('acceptme'), 5n], {
      account: registrar,
    })
    expect(await resolver.read.editCredits([node('acceptme')])).toBe(25n)
  })

  it('rejects an uncredited caller', async () => {
    const { controller } = await load()
    await expect(
      controller.write.topUpEditCredits([node('acceptme'), 10n], {
        account: alice,
      }),
    ).toBeRevertedWithCustomError('NoRegistrarCredits')
  })

  it('reverts when no default resolver is configured', async () => {
    const { controller } = await load()
    const { zeroAddress } = await import('viem')
    await controller.write.setDefaultResolver([zeroAddress], { account: owner })
    await expect(
      controller.write.topUpEditCredits([node('acceptme'), 10n], {
        account: registrar,
      }),
    ).toBeRevertedWithCustomError('NoDefaultResolver')
  })

  it('works on a name the caller never registered — the recipient buys their own', async () => {
    const { controller, resolver } = await load()
    await controller.write.topUpEditCredits([node('acceptme'), 7n], {
      account: registrar,
    })
    expect(await resolver.read.editCredits([node('acceptme')])).toBe(17n)
  })
})
