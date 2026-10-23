import hre from 'hardhat'
import {
  getAddress,
  keccak256,
  labelhash,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  deployNamesV2,
  MIN_REGISTRATION,
  node,
  Reason,
  registration,
  YEAR,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const GRACE_PERIOD = 90n * DAY
const TERMS = keccak256(toHex('bona fide community terms v1'))
const KEY = 'simplex.contact'

const connection = await hre.network.connect()
const [ownerClient, guardianClient, , aliceClient, brandClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const alice = aliceClient.account
const brand = brandClient.account

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.controller.write.setPublicSalesOpen([true], { account: owner })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)
type Fixture = Awaited<ReturnType<typeof fixture>>

const implementationBoundTo = (
  controller: `0x${string}`,
  registrar: `0x${string}`,
) =>
  connection.viem.deployContract('SimplexNamePolicy', [controller, registrar])

const policyWithNoReservations = ({ namePolicyImplementation }: Fixture) =>
  connection.viem.deployContract('SimplexNamePolicyProxy', [
    namePolicyImplementation.address,
    '0x',
  ])

async function registerForAlice(
  { controller }: Fixture,
  reg: ReturnType<typeof registration>,
) {
  await controller.write.commit([await controller.read.makeCommitment([reg])], {
    account: alice,
  })
  await controller.write.register([reg], {
    account: alice,
    value: 2n * YEAR_PRICE_USD,
  })
}

async function lapseWithRecord(f: Fixture, label: string) {
  await registerForAlice(
    f,
    registration(label, alice.address, { resolver: f.resolver.address }),
  )
  await f.resolver.write.setText([node(label), KEY, 'https://smp/alice'], {
    account: alice,
  })
  await connection.networkHelpers.time.increase(
    MIN_REGISTRATION + GRACE_PERIOD + 1n,
  )
}

describe('name policy', () => {
  describe('upgrades', () => {
    it('only the controller owner upgrades the policy', async () => {
      const { controller, baseRegistrar, namePolicy } = await load()
      const next = await implementationBoundTo(
        controller.address,
        baseRegistrar.address,
      )
      await expect(
        namePolicy.write.upgradeTo([next.address], { account: guardian }),
      ).toBeRevertedWithCustomError('NotOwner')
      await expect(
        namePolicy.write.upgradeTo([next.address], { account: owner }),
      )
        .toEmitEvent('Upgraded')
        .withArgs({ implementation: getAddress(next.address) })
    })

    it('an upgrade reverts once the controller is frozen', async () => {
      const { controller, baseRegistrar, namePolicy } = await load()
      const next = await implementationBoundTo(
        controller.address,
        baseRegistrar.address,
      )
      await controller.write.freeze({ account: owner })
      await expect(
        namePolicy.write.upgradeTo([next.address], { account: owner }),
      ).toBeRevertedWithCustomError('Frozen')
    })

    it('an upgrade reverts for an implementation bound to another controller or registrar', async () => {
      const { controller, baseRegistrar, namePolicy } = await load()
      for (const next of [
        await implementationBoundTo(alice.address, baseRegistrar.address),
        await implementationBoundTo(controller.address, alice.address),
      ]) {
        await expect(
          namePolicy.write.upgradeTo([next.address], { account: owner }),
        ).toBeRevertedWithCustomError('ImplementationMismatch')
      }
    })

    it('an upgrade preserves the reserved and bona fide lists, the terms and the acceptances', async () => {
      const { controller, baseRegistrar, namePolicy } = await load()
      await namePolicy.write.addReservedNames(
        [['reservedname'], Reason.Trademark],
        { account: owner },
      )
      await namePolicy.write.setTerms([TERMS, 'ipfs://terms'], {
        account: owner,
      })
      await namePolicy.write.addBonaFideNames([['community']], {
        account: owner,
      })
      const commitment = await controller.read.makeCommitment([
        registration('community', alice.address),
      ])
      await namePolicy.write.commitUnderBonaFideCommunityTerms(
        [commitment, TERMS],
        { account: alice },
      )

      const next = await implementationBoundTo(
        controller.address,
        baseRegistrar.address,
      )
      await namePolicy.write.upgradeTo([next.address], { account: owner })

      expect(
        await namePolicy.read.reservedNames([labelhash('reservedname')]),
      ).toBe(Reason.Trademark)
      expect(
        await namePolicy.read.bonaFideNames([labelhash('community')]),
      ).toBe(true)
      expect(await namePolicy.read.termsHash()).toBe(TERMS)
      expect(
        await namePolicy.read.acceptedTerms([commitment, alice.address]),
      ).toBe(TERMS)
    })
  })

  describe('registerReserved', () => {
    it('registers to the owner with the current default resolver, after clearing the records on a former one', async () => {
      const f = await load()
      await lapseWithRecord(f, 'brandname')
      await f.namePolicy.write.addReservedNames(
        [['brandname'], Reason.Trademark],
        { account: owner },
      )
      const current = await connection.viem.deployContract('SimplexResolver', [
        f.ens.address,
        f.subnameRegistrar.address,
        f.controller.address,
        zeroAddress,
      ])
      await f.controller.write.setDefaultResolver([current.address], {
        account: owner,
      })

      await f.namePolicy.write.registerReserved(
        ['brandname', brand.address, MIN_REGISTRATION],
        { account: owner },
      )

      expect(
        await f.baseRegistrar.read.ownerOf([BigInt(labelhash('brandname'))]),
      ).toBe(getAddress(brand.address))
      expect(await f.ens.read.owner([node('brandname')])).toBe(
        getAddress(brand.address),
      )
      expect(await f.ens.read.resolver([node('brandname')])).toBe(
        getAddress(current.address),
      )
      expect(await f.resolver.read.text([node('brandname'), KEY])).toBe('')
    })

    it('with no default resolver, registers to the owner after clearing the records on a former one, and leaves the registry resolver unchanged', async () => {
      const f = await load()
      await lapseWithRecord(f, 'barename')
      await f.namePolicy.write.addReservedNames(
        [['barename'], Reason.Trademark],
        { account: owner },
      )
      await f.controller.write.setDefaultResolver([zeroAddress], {
        account: owner,
      })

      await f.namePolicy.write.registerReserved(
        ['barename', brand.address, MIN_REGISTRATION],
        { account: owner },
      )

      expect(
        await f.baseRegistrar.read.ownerOf([BigInt(labelhash('barename'))]),
      ).toBe(getAddress(brand.address))
      expect(await f.ens.read.owner([node('barename')])).toBe(
        getAddress(brand.address),
      )
      expect(await f.ens.read.resolver([node('barename')])).toBe(
        getAddress(f.resolver.address),
      )
      expect(await f.resolver.read.text([node('barename'), KEY])).toBe('')
    })

    it('reverts once the policy is removed as a registrar controller', async () => {
      const { baseRegistrar, namePolicy } = await load()
      expect(await baseRegistrar.read.controllers([namePolicy.address])).toBe(
        true,
      )
      await namePolicy.write.addReservedNames(
        [['brandname'], Reason.Trademark],
        { account: owner },
      )
      await baseRegistrar.write.removeController([namePolicy.address])
      await expect(
        namePolicy.write.registerReserved(
          ['brandname', brand.address, MIN_REGISTRATION],
          { account: owner },
        ),
      ).toBeRevertedWithoutReason()
    })
  })

  describe('the controller', () => {
    it('available() reads the reserved list of the current policy', async () => {
      const f = await load()
      await f.namePolicy.write.addReservedNames(
        [['freename'], Reason.Trademark],
        { account: owner },
      )
      expect(await f.controller.read.available(['freename'])).toBe(false)

      const other = await policyWithNoReservations(f)
      await f.controller.write.setNamePolicy([other.address], {
        account: owner,
      })
      expect(await f.controller.read.available(['freename'])).toBe(true)
    })

    it('renewal reads the reserved list of the current policy', async () => {
      const f = await load()
      await registerForAlice(f, registration('heldname', alice.address))
      await f.namePolicy.write.addReservedNames(
        [['heldname'], Reason.Trademark],
        { account: owner },
      )
      const renew = () =>
        f.controller.write.renew(['heldname', YEAR, zeroHash], {
          account: alice,
          value: YEAR_PRICE_USD,
        })
      await expect(renew()).toBeRevertedWithCustomError('NameReserved')

      const other = await policyWithNoReservations(f)
      await f.controller.write.setNamePolicy([other.address], {
        account: owner,
      })
      await renew()
    })

    it('setNamePolicy reverts for zero and for a policy bound to another controller', async () => {
      const { controller, baseRegistrar, namePolicy } = await load()
      await expect(
        controller.write.setNamePolicy([zeroAddress], { account: owner }),
      ).toBeRevertedWithCustomError('ZeroAddress')
      const boundElsewhere = await implementationBoundTo(
        alice.address,
        baseRegistrar.address,
      )
      await expect(
        controller.write.setNamePolicy([boundElsewhere.address], {
          account: owner,
        }),
      ).toBeRevertedWithCustomError('NamePolicyMismatch')
      expect(await controller.read.namePolicy()).toBe(
        getAddress(namePolicy.address),
      )
    })
  })
})
