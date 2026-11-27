import hre from 'hardhat'
import {
  getAddress,
  keccak256,
  labelhash,
  parseEventLogs,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  COMMUNITY_TERMS,
  deployNamesV2,
  GENERAL_TERMS,
  MIN_REGISTRATION,
  node,
  registration,
  signRegistration,
  termsLink,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const GRACE_PERIOD = 90n * DAY

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const testClient = await connection.viem.getTestClient()
const [
  ownerClient,
  guardianClient,
  registrarClient,
  aliceClient,
  bobClient,
  carolClient,
] = await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account
const carol = carolClient.account
type Account = typeof alice

const KINDS = [
  {
    title: 'general terms',
    label: 'plainname',
    terms: GENERAL_TERMS,
    other: COMMUNITY_TERMS,
    commit: 'commitUnderGeneralTerms',
    acceptForClaim: 'acceptGeneralTermsForClaim',
    setTerms: 'setGeneralTerms',
    accepted: 'GeneralTermsAccepted',
  },
  {
    title: 'community terms',
    label: 'community',
    terms: COMMUNITY_TERMS,
    other: GENERAL_TERMS,
    commit: 'commitUnderCommunityTerms',
    acceptForClaim: 'acceptCommunityTermsForClaim',
    setTerms: 'setCommunityTerms',
    accepted: 'CommunityTermsAccepted',
  },
] as const
type Kind = (typeof KINDS)[number]
const [GENERAL, COMMUNITY] = KINDS

const id = (label: string) => BigInt(labelhash(label))

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  await f.controller.write.setPublicSalesOpen([true], { account: owner })
  await f.namePolicy.write.addCommunityNames([[COMMUNITY.label]], {
    account: guardian,
  })
  for (const k of KINDS) {
    const reg = registration(k.label, alice.address)
    const namePolicy: any = f.namePolicy
    await namePolicy.write[k.commit](
      [await f.controller.read.makeCommitment([reg]), k.terms],
      { account: alice },
    )
    await f.controller.write.register([reg], {
      account: alice,
      value: 2n * YEAR_PRICE_USD,
    })
  }
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)
type Fixture = Awaited<ReturnType<typeof fixture>>

async function offerToBob(f: Fixture, label: string) {
  await f.baseRegistrar.write.approve([bob.address, id(label)], {
    account: alice,
  })
  return f.baseRegistrar.read.offers([id(label)])
}

const claim = (
  f: Fixture,
  label: string,
  {
    from = alice.address,
    offer,
    terms,
    account = bob,
  }: {
    from?: `0x${string}`
    offer: bigint
    terms: `0x${string}`
    account?: Account
  },
) =>
  f.baseRegistrar.write.claimUnderTerms([from, id(label), offer, terms], {
    account,
  })

const logsOf = async (hash: `0x${string}`) =>
  (await publicClient.waitForTransactionReceipt({ hash })).logs.map(
    ({ address, topics, data }) => ({ address, topics, data }),
  )

const acceptances = async (f: Fixture, k: Kind, hash: `0x${string}`) =>
  parseEventLogs({
    abi: f.namePolicy.abi,
    eventName: k.accepted,
    logs: (await publicClient.waitForTransactionReceipt({ hash })).logs,
  }).map(({ args }) => [args.name, args.holder, args.termsHash])

const stateAfterClaim = (f: Fixture, label: string, offer: bigint) =>
  Promise.all([
    f.baseRegistrar.read.ownerOf([id(label)]),
    f.baseRegistrar.read.getApproved([id(label)]),
    f.baseRegistrar.read.offers([id(label)]),
    f.baseRegistrar.read.balanceOf([alice.address]),
    f.baseRegistrar.read.balanceOf([bob.address]),
    f.baseRegistrar.read.nonces([bob.address]),
    f.ens.read.owner([node(label)]),
    f.namePolicy.read.acceptedClaimTerms([
      id(label),
      alice.address,
      bob.address,
      offer,
    ]),
    f.namePolicy.read.nonces([bob.address]),
  ])

describe('claimUnderTerms', () => {
  for (const k of KINDS) {
    describe(k.title, () => {
      it('one transaction of the recipient leaves the state and the events of the acceptance and the claim', async () => {
        const twoStep = await load()
        const offer = await offerToBob(twoStep, k.label)
        const namePolicy: any = twoStep.namePolicy
        const accept = await namePolicy.write[k.acceptForClaim](
          [id(k.label), alice.address, offer, k.terms],
          { account: bob },
        )
        const take = await twoStep.baseRegistrar.write.transferFrom(
          [alice.address, bob.address, id(k.label)],
          { account: bob },
        )
        const twoStepLogs = [...(await logsOf(accept)), ...(await logsOf(take))]
        const twoStepState = await stateAfterClaim(twoStep, k.label, offer)

        const oneStep = await load()
        expect(await offerToBob(oneStep, k.label)).toBe(offer)
        const claimed = await claim(oneStep, k.label, { offer, terms: k.terms })

        expect(await logsOf(claimed)).toEqual(twoStepLogs)
        expect(await stateAfterClaim(oneStep, k.label, offer)).toEqual(
          twoStepState,
        )
        expect(await acceptances(oneStep, k, claimed)).toEqual([
          [k.label, getAddress(bob.address), k.terms],
        ])
        expect(await oneStep.baseRegistrar.read.ownerOf([id(k.label)])).toBe(
          getAddress(bob.address),
        )
        expect(await oneStep.ens.read.owner([node(k.label)])).toBe(
          getAddress(bob.address),
        )
      })

      it('reverts TermsNotAccepted for the other terms, for none and for terms replaced since the offer, and the name stays', async () => {
        const f = await load()
        const offer = await offerToBob(f, k.label)
        for (const terms of [k.other, zeroHash]) {
          await expect(
            claim(f, k.label, { offer, terms }),
          ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
        }
        const next = termsLink('next.md', '4')
        const namePolicy: any = f.namePolicy
        await namePolicy.write[k.setTerms]([next], { account: owner })
        await expect(
          claim(f, k.label, { offer, terms: k.terms }),
        ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
        expect(await f.baseRegistrar.read.ownerOf([id(k.label)])).toBe(
          getAddress(alice.address),
        )
        await claim(f, k.label, { offer, terms: keccak256(toHex(next)) })
        expect(await f.baseRegistrar.read.ownerOf([id(k.label)])).toBe(
          getAddress(bob.address),
        )
      })
    })
  }

  it('a name removed from the community names between the offer and the claim is claimed under the general terms', async () => {
    const f = await load()
    const offer = await offerToBob(f, COMMUNITY.label)
    await f.namePolicy.write.removeCommunityNames([[COMMUNITY.label]], {
      account: owner,
    })
    await expect(
      claim(f, COMMUNITY.label, { offer, terms: COMMUNITY_TERMS }),
    ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
    const claimed = await claim(f, COMMUNITY.label, {
      offer,
      terms: GENERAL_TERMS,
    })
    expect(await acceptances(f, GENERAL, claimed)).toEqual([
      [COMMUNITY.label, getAddress(bob.address), GENERAL_TERMS],
    ])
  })

  it('only the approved recipient of the open offer claims', async () => {
    const f = await load()
    const label = GENERAL.label
    const terms = GENERAL_TERMS
    await expect(
      claim(f, label, { offer: 0n, terms }),
    ).toBeRevertedWithCustomError('NotOffered')

    await f.baseRegistrar.write.setApprovalForAll([bob.address, true], {
      account: alice,
    })
    await expect(
      claim(f, label, { offer: 0n, terms }),
    ).toBeRevertedWithCustomError('NotOffered')

    await f.baseRegistrar.write.approve([carol.address, id(label)], {
      account: alice,
    })
    const toCarol = await f.baseRegistrar.read.offers([id(label)])
    for (const account of [bob, alice]) {
      await expect(
        claim(f, label, { offer: toCarol, terms, account }),
      ).toBeRevertedWithCustomError('NotOffered')
    }

    const first = await offerToBob(f, label)
    await f.baseRegistrar.write.approve([zeroAddress, id(label)], {
      account: alice,
    })
    await expect(
      claim(f, label, { offer: first, terms }),
    ).toBeRevertedWithCustomError('NotOffered')

    const second = await offerToBob(f, label)
    await expect(
      claim(f, label, { offer: first, terms }),
    ).toBeRevertedWithCustomError('NotOffered')
    await claim(f, label, { offer: second, terms })
    expect(await f.baseRegistrar.read.ownerOf([id(label)])).toBe(
      getAddress(bob.address),
    )
  })

  it('an offer replaced in the same block before the claim is not claimed', async () => {
    const f = await load()
    const label = GENERAL.label
    const offer = await offerToBob(f, label)
    const higherTip = { maxPriorityFeePerGas: 2_000_000_000n }
    await testClient.setAutomine(false)
    try {
      const withdrawn = await f.baseRegistrar.write.approve(
        [zeroAddress, id(label)],
        { account: alice, ...higherTip },
      )
      const offeredAgain = await f.baseRegistrar.write.approve(
        [bob.address, id(label)],
        { account: alice, ...higherTip },
      )
      const claimed = await f.baseRegistrar.write.claimUnderTerms(
        [alice.address, id(label), offer, GENERAL_TERMS],
        { account: bob, gas: 1_000_000n, maxPriorityFeePerGas: 1n },
      )
      await testClient.mine({ blocks: 1 })
      const [withdrawal, reoffer, claimReceipt] = await Promise.all(
        [withdrawn, offeredAgain, claimed].map((hash) =>
          publicClient.getTransactionReceipt({ hash }),
        ),
      )
      expect(
        [withdrawal, reoffer, claimReceipt].map(
          ({ blockNumber, transactionIndex, status }) => [
            blockNumber,
            transactionIndex,
            status,
          ],
        ),
      ).toEqual([
        [withdrawal.blockNumber, 0, 'success'],
        [withdrawal.blockNumber, 1, 'success'],
        [withdrawal.blockNumber, 2, 'reverted'],
      ])
    } finally {
      await testClient.setAutomine(true)
    }
    expect(await f.baseRegistrar.read.ownerOf([id(label)])).toBe(
      getAddress(alice.address),
    )
    await expect(
      claim(f, label, { offer, terms: GENERAL_TERMS }),
    ).toBeRevertedWithCustomError('NotOffered')
    await claim(f, label, {
      offer: await f.baseRegistrar.read.offers([id(label)]),
      terms: GENERAL_TERMS,
    })
  })

  it('a claim naming another holder reverts NotNameOwner, and only the registrar records claim terms', async () => {
    const f = await load()
    const label = GENERAL.label
    const offer = await offerToBob(f, label)
    await expect(
      claim(f, label, { from: carol.address, offer, terms: GENERAL_TERMS }),
    ).toBeRevertedWithCustomError('NotNameOwner')
    for (const account of [alice, bob]) {
      await expect(
        f.namePolicy.write.recordClaimTerms(
          [id(label), alice.address, offer, GENERAL_TERMS, bob.address],
          { account },
        ),
      ).toBeRevertedWithCustomError('NotRegistrar')
    }
  })

  it('a lapsed name in its grace period, and a name registered again, are not claimed', async () => {
    const f = await load()
    const label = GENERAL.label
    const offer = await offerToBob(f, label)
    await connection.networkHelpers.time.increase(MIN_REGISTRATION + 1n)
    await expect(
      claim(f, label, { offer, terms: GENERAL_TERMS }),
    ).toBeRevertedWithoutReason()

    await connection.networkHelpers.time.increase(GRACE_PERIOD)
    const reg = registration(label, carol.address)
    await commitUnderGeneralTerms(connection, f.controller, reg, {
      account: carol,
    })
    await f.controller.write.register([reg], {
      account: carol,
      value: 2n * YEAR_PRICE_USD,
    })
    await expect(
      claim(f, label, { offer, terms: GENERAL_TERMS }),
    ).toBeRevertedWithCustomError('NotNameOwner')
    await expect(
      claim(f, label, { from: carol.address, offer, terms: GENERAL_TERMS }),
    ).toBeRevertedWithCustomError('NotOffered')
  })

  it('a name in its dispute period is claimed in one transaction', async () => {
    const f = await load()
    const label = 'disputedname'
    const reg = registration(label, alice.address)
    await commitUnderGeneralTerms(connection, f.controller, reg, {
      account: alice,
    })
    await f.sponsor.write.registerWithCredit(
      await signRegistration(connection, f.sponsor, reg),
      { account: registrar },
    )
    const until = await f.baseRegistrar.read.disputeUntil([id(label)])
    const offer = await offerToBob(f, label)
    const claimed = await claim(f, label, { offer, terms: GENERAL_TERMS })
    const { blockNumber } = await publicClient.waitForTransactionReceipt({
      hash: claimed,
    })
    expect(
      (await publicClient.getBlock({ blockNumber })).timestamp,
    ).toBeLessThan(until)
    expect(await f.baseRegistrar.read.ownerOf([id(label)])).toBe(
      getAddress(bob.address),
    )
    expect(await f.baseRegistrar.read.disputeUntil([id(label)])).toBe(until)
  })

  it('the claim calls no code of the holder or the recipient', async () => {
    const f = await load()
    const label = GENERAL.label
    const holder = await connection.viem.deployContract('ReentrantClaimer', [
      f.baseRegistrar.address,
    ])
    await f.baseRegistrar.write.approve([holder.address, id(label)], {
      account: alice,
    })
    await holder.write.claim(
      [
        alice.address,
        id(label),
        await f.baseRegistrar.read.offers([id(label)]),
        GENERAL_TERMS,
      ],
      { account: carol },
    )
    expect(await f.baseRegistrar.read.ownerOf([id(label)])).toBe(
      getAddress(holder.address),
    )

    await holder.write.offer([bob.address, id(label)], { account: carol })
    await claim(f, label, {
      from: holder.address,
      offer: await f.baseRegistrar.read.offers([id(label)]),
      terms: GENERAL_TERMS,
    })
    expect(await f.baseRegistrar.read.ownerOf([id(label)])).toBe(
      getAddress(bob.address),
    )
  })

  it("with the registrar's policy pointer at the policy implementation the claim reverts NotProxy, and at a policy without recordClaimTerms or at zero it reverts while transferFrom moves the name", async () => {
    const f = await load()
    const label = GENERAL.label
    const offer = await offerToBob(f, label)
    await f.baseRegistrar.write.setNamePolicy(
      [f.namePolicyImplementation.address],
      { account: owner },
    )
    await expect(
      claim(f, label, { offer, terms: GENERAL_TERMS }),
    ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'NotProxy')

    const transferOnly = await connection.viem.deployContract(
      'TransferOnlyNamePolicy',
      [f.baseRegistrar.address],
    )
    for (const pointer of [transferOnly.address, zeroAddress]) {
      await f.baseRegistrar.write.setNamePolicy([pointer], { account: owner })
      await expect(
        claim(f, label, { offer, terms: GENERAL_TERMS }),
      ).toBeRevertedWithoutReason()
    }
    await f.baseRegistrar.write.setNamePolicy([transferOnly.address], {
      account: owner,
    })
    await f.baseRegistrar.write.transferFrom(
      [alice.address, bob.address, id(label)],
      { account: bob },
    )
    expect(await f.baseRegistrar.read.ownerOf([id(label)])).toBe(
      getAddress(bob.address),
    )
  })

  it('gas of the one-step claim against the acceptance and the claim', async () => {
    const gasUsed = async (hash: Promise<`0x${string}`>) =>
      (await publicClient.waitForTransactionReceipt({ hash: await hash }))
        .gasUsed
    const rows: Record<string, Record<string, number>> = {}
    for (const k of KINDS) {
      const twoStep = await load()
      const offer = await offerToBob(twoStep, k.label)
      const namePolicy: any = twoStep.namePolicy
      const accept = await gasUsed(
        namePolicy.write[k.acceptForClaim](
          [id(k.label), alice.address, offer, k.terms],
          { account: bob },
        ),
      )
      const transferFrom = await gasUsed(
        twoStep.baseRegistrar.write.transferFrom(
          [alice.address, bob.address, id(k.label)],
          { account: bob },
        ),
      )
      const oneStep = await load()
      await offerToBob(oneStep, k.label)
      const claimUnderTerms = await gasUsed(
        claim(oneStep, k.label, { offer, terms: k.terms }),
      )
      rows[k.title] = {
        [k.acceptForClaim]: Number(accept),
        transferFrom: Number(transferFrom),
        twoTransactions: Number(accept + transferFrom),
        claimUnderTerms: Number(claimUnderTerms),
        saved: Number(accept + transferFrom - claimUnderTerms),
      }
      expect(claimUnderTerms).toBeLessThan(accept + transferFrom)
    }
    console.table(rows)
  })
})
