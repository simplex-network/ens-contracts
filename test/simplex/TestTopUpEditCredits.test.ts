import hre from 'hardhat'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  EDIT_CREDIT_PRICE_USD,
  node,
  registration,
} from './fixtures/namesV2.js'

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
  await f.controller.write.setRegistrarAllowance([registrar.address, AMPLE_ALLOWANCE], {
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
  it('adds to a name and deducts the configured price per credit', async () => {
    const { controller, resolver } = await load()
    expect(await resolver.read.editCredits([node('acceptme')])).toBe(10n)
    const before = await controller.read.registrarAllowance([registrar.address])

    await controller.write.topUpEditCredits([node('acceptme'), 10n], {
      account: registrar,
    })

    expect(await resolver.read.editCredits([node('acceptme')])).toBe(20n)
    expect(before - (await controller.read.registrarAllowance([registrar.address]))).toBe(
      10n * EDIT_CREDIT_PRICE_USD,
    )
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

  it('rejects a caller with no allowance', async () => {
    const { controller } = await load()
    await expect(
      controller.write.topUpEditCredits([node('acceptme'), 10n], {
        account: alice,
      }),
    ).toBeRevertedWithCustomError('InsufficientAllowance')
  })

  it('refuses when the allowance cannot cover the credits asked for', async () => {
    const { controller } = await load()
    await controller.write.setRegistrarAllowance(
      [registrar.address, EDIT_CREDIT_PRICE_USD * 2n],
      { account: guardian },
    )
    await expect(
      controller.write.topUpEditCredits([node('acceptme'), 3n], {
        account: registrar,
      }),
    ).toBeRevertedWithCustomError('InsufficientAllowance')
    await controller.write.topUpEditCredits([node('acceptme'), 2n], {
      account: registrar,
    })
  })

  it('only the owner may reprice a credit', async () => {
    const { controller } = await load()
    await expect(
      controller.write.setEditCreditPrice([1n], { account: guardian }),
    ).toBeRevertedWithString('Ownable: caller is not the owner')
    await controller.write.setEditCreditPrice([1n], { account: owner })
    expect(await controller.read.editCreditPriceUSD()).toBe(1n)
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
