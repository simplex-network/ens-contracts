import hre from 'hardhat'
import { labelhash, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, registration, YEAR } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient, registrarClient, aliceClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account

async function fixture() {
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

async function sponsoredRegister(controller: any, reg: any, account = registrar) {
  await controller.write.commit([await controller.read.makeCommitment([reg])], {
    account,
  })
  return controller.write.registerWithCredit([reg], { account })
}

describe('registrar credits', () => {
  it('a credited registrar registers with zero value and the balance decrements', async () => {
    const { controller, baseRegistrar } = await load()
    await controller.write.setRegistrarCredits([registrar.address, 3n], {
      account: guardian,
    })

    await sponsoredRegister(controller, registration('alicename', alice.address))

    expect(await controller.read.registrarCredits([registrar.address])).toBe(2n)
    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('alicename'))])
      ).toLowerCase(),
    ).toBe(alice.address.toLowerCase())
  })

  it('rejects a registrar with no credits', async () => {
    const { controller } = await load()
    const reg = registration('nocredits', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: registrar },
    )
    await expect(
      controller.write.registerWithCredit([reg], { account: registrar }),
    ).toBeRevertedWithCustomError('NoRegistrarCredits')
  })

  it('renewWithCredit spends a credit and extends the name', async () => {
    const { controller, baseRegistrar } = await load()
    await controller.write.setRegistrarCredits([registrar.address, 2n], {
      account: guardian,
    })
    await sponsoredRegister(controller, registration('renewable', alice.address))

    const tokenId = BigInt(labelhash('renewable'))
    const before = await baseRegistrar.read.nameExpires([tokenId])

    await controller.write.renewWithCredit(['renewable', YEAR, zeroHash], {
      account: registrar,
    })

    expect(await baseRegistrar.read.nameExpires([tokenId])).toBe(before + YEAR)
    expect(await controller.read.registrarCredits([registrar.address])).toBe(0n)
  })

  it('rejects renewWithCredit from an uncredited caller', async () => {
    const { controller } = await load()
    await controller.write.setRegistrarCredits([registrar.address, 1n], {
      account: guardian,
    })
    await sponsoredRegister(controller, registration('renewgate', alice.address))
    await expect(
      controller.write.renewWithCredit(['renewgate', YEAR, zeroHash], {
        account: alice,
      }),
    ).toBeRevertedWithCustomError('NoRegistrarCredits')
  })

  it('the guardian can zero an allowance in one transaction', async () => {
    const { controller } = await load()
    await controller.write.setRegistrarCredits([registrar.address, 1000n], {
      account: guardian,
    })
    await controller.write.setRegistrarCredits([registrar.address, 0n], {
      account: guardian,
    })
    expect(await controller.read.registrarCredits([registrar.address])).toBe(0n)
  })

  it('only the beneficiary may set credits — not the owner, not anyone else', async () => {
    const { controller } = await load()
    await expect(
      controller.write.setRegistrarCredits([registrar.address, 1n], {
        account: owner,
      }),
    ).toBeRevertedWithCustomError('NotBeneficiary')
    await expect(
      controller.write.setRegistrarCredits([registrar.address, 1n], {
        account: alice,
      }),
    ).toBeRevertedWithCustomError('NotBeneficiary')
  })

  it('the payable path still works and still refunds the overpayment', async () => {
    const { controller } = await load()
    await controller.write.setPublicSalesOpen([true], { account: owner })

    const reg = registration('payforit', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: alice },
    )
    const before = await publicClient.getBalance({ address: alice.address })
    const hash = await controller.write.register([reg], {
      account: alice,
      value: 10n ** 15n,
    })
    const receipt = await publicClient.getTransactionReceipt({ hash })
    const after = await publicClient.getBalance({ address: alice.address })
    // price is zero in this fixture, so everything but gas comes back
    expect(before - after).toBe(receipt.gasUsed * receipt.effectiveGasPrice)
  })

  it('a credited registration attaches no value to the controller', async () => {
    const { controller } = await load()
    await controller.write.setRegistrarCredits([registrar.address, 1n], {
      account: guardian,
    })
    await sponsoredRegister(controller, registration('freeofeth', alice.address))
    expect(
      await publicClient.getBalance({ address: controller.address }),
    ).toBe(0n)
  })
})
