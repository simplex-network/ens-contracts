import hre from 'hardhat'
import { labelhash } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, Reason } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const [ownerClient, guardianClient] = await connection.viem.getWalletClients()
const publicClient = await connection.viem.getPublicClient()
const owner = ownerClient.account
const guardian = guardianClient.account

async function fixture() {
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

/**
 * A reservation carries why it exists. The reason lives in the same mapping as
 * the fact, so the two cannot disagree: `Reason.None` is both "no reason" and
 * "not reserved", which is what makes `delete` keep working unchanged.
 *
 * The wording a user reads is client-side, per ens-contracts#29 — nothing here
 * asserts on English.
 */
describe('reservation reasons', () => {
  it('stores the reason it was given', async () => {
    const { controller } = await load()
    await controller.write.addReservedNames([['brandheld'], Reason.Trademark], {
      account: owner,
    })
    await expect(
      controller.read.reservedNames([labelhash('brandheld')]),
    ).resolves.toBe(Reason.Trademark)
  })

  it('holds a name against every reason, not just the first', async () => {
    const { controller } = await load()
    const cases = [
      ['tm', Reason.Trademark],
      ['ours', Reason.Internal],
      ['civic', Reason.Community],
    ] as const
    for (const [label, reason] of cases) {
      await controller.write.addReservedNames([[label], reason], {
        account: owner,
      })
      await expect(
        controller.read.reservedNames([labelhash(label)]),
      ).resolves.toBe(reason)
      // every reason reserves — availability must not depend on which one
      await expect(controller.read.available([label])).resolves.toBe(false)
    }
  })

  it('refuses Reason.None, which would silently unreserve', async () => {
    const { controller } = await load()
    await expect(
      controller.write.addReservedNames([['nothingness'], Reason.None], {
        account: owner,
      }),
    ).rejects.toThrow()
    await expect(
      controller.read.reservedNames([labelhash('nothingness')]),
    ).resolves.toBe(Reason.None)
  })

  it('reclassifies without unreserving, so no gap opens', async () => {
    const { controller } = await load()
    await controller.write.addReservedNames([['reclassify'], Reason.Internal], {
      account: owner,
    })
    await controller.write.setReservationReason(
      [['reclassify'], Reason.Community],
      { account: owner },
    )
    await expect(
      controller.read.reservedNames([labelhash('reclassify')]),
    ).resolves.toBe(Reason.Community)
    // the point of the function: it never passed through unreserved
    await expect(controller.read.available(['reclassify'])).resolves.toBe(false)
  })

  it('will not reclassify a name that is not reserved', async () => {
    const { controller } = await load()
    await expect(
      controller.write.setReservationReason([['never'], Reason.Trademark], {
        account: owner,
      }),
    ).rejects.toThrow()
  })

  it('removing clears the reason back to None', async () => {
    const { controller } = await load()
    await controller.write.addReservedNames([['temporary'], Reason.Community], {
      account: owner,
    })
    await controller.write.removeReservedNames([['temporary']], {
      account: owner,
    })
    await expect(
      controller.read.reservedNames([labelhash('temporary')]),
    ).resolves.toBe(Reason.None)
    await expect(controller.read.available(['temporary'])).resolves.toBe(true)
  })

  it('carries the reason in the event indexers read', async () => {
    const { controller } = await load()
    const hash = await controller.write.addReservedNames(
      [['indexed'], Reason.Community],
      { account: owner },
    )
    await publicClient.waitForTransactionReceipt({ hash })
    const logs = await controller.getEvents.ReservedNameAdded()
    expect(logs.at(-1)?.args).toMatchObject({
      name: 'indexed',
      reason: Reason.Community,
    })
  })
})
