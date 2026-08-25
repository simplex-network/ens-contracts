import hre from 'hardhat'
import { encodeFunctionData, labelhash, namehash, zeroAddress, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import { PRICE_CURVE, YEAR, yearPriceUSD } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const [ownerClient, guardianClient, registrarClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account

const TLD = 'simplex'
const ALLOWANCE = 1000n * 10n ** 18n

/**
 * A reverse record answers "which name does this address go by". Upstream sets
 * it for `msg.sender`, which is right when the caller is the buyer. On the
 * sponsored path the caller is the registrar's shared hot wallet, so it has to
 * be set for the buyer instead.
 *
 * Unlike the shared fixture, this one wires real reverse registrars — that is
 * the configuration the behaviour is observable in.
 */
async function fixture() {
  const viem = connection.viem
  const ens = await viem.deployContract('ENSRegistry', [])
  const baseRegistrar = await viem.deployContract(
    'BaseRegistrarImplementation',
    [ens.address, namehash(TLD)],
  )
  await ens.write.setSubnodeOwner([zeroHash, labelhash(TLD), baseRegistrar.address])

  const reverseRegistrar = await viem.deployContract('ReverseRegistrar', [
    ens.address,
  ])
  const defaultReverseRegistrar = await viem.deployContract(
    'DefaultReverseRegistrar',
    [],
  )
  await ens.write.setSubnodeOwner([zeroHash, labelhash('reverse'), owner.address])
  await ens.write.setSubnodeOwner([
    namehash('reverse'),
    labelhash('addr'),
    reverseRegistrar.address,
  ])

  const dummyOracle = await viem.deployContract('DummyOracle', [100000000n])
  const priceOracle = await viem.deployContract('StablePriceOracle', [
    dummyOracle.address,
    PRICE_CURVE,
  ])

  const implementation = await viem.deployContract('SimplexController', [])
  const initData = encodeFunctionData({
    abi: implementation.abi,
    functionName: 'initialize',
    args: [
      baseRegistrar.address,
      priceOracle.address,
      0n,
      86400n,
      reverseRegistrar.address,
      defaultReverseRegistrar.address,
      ens.address,
      {
        tldNode: namehash(TLD),
        tldSuffix: `.${TLD}`,
        minCharLength: 6,
        smpxNft: zeroAddress,
        nftGateEnabled: false,
      },
      owner.address,
    ],
  })
  const proxy = await viem.deployContract('SimplexControllerProxy', [
    implementation.address,
    initData,
  ])
  const controller = await viem.getContractAt('SimplexController', proxy.address)

  const resolver = await viem.deployContract('PublicResolver', [
    ens.address,
    zeroAddress,
    controller.address,
    reverseRegistrar.address,
  ])
  await reverseRegistrar.write.setDefaultResolver([resolver.address])

  await baseRegistrar.write.addController([controller.address])
  await reverseRegistrar.write.setController([controller.address, true])
  await defaultReverseRegistrar.write.setController([controller.address, true])
  await controller.write.setBeneficiary([guardian.address], { account: owner })
  await controller.write.setPublicSalesOpen([true], { account: owner })
  await controller.write.setRegistrarAllowance([registrar.address, ALLOWANCE], {
    account: guardian,
  })

  return {
    ens,
    baseRegistrar,
    controller,
    resolver,
    reverseRegistrar,
    defaultReverseRegistrar,
  }
}
const load = () => connection.networkHelpers.loadFixture(fixture)

function reg(label: string, buyer: `0x${string}`, resolver: `0x${string}`, bits: number) {
  return {
    label,
    owner: buyer,
    duration: YEAR,
    secret: zeroHash,
    resolver,
    data: [] as `0x${string}`[],
    reverseRecord: bits,
    referrer: zeroHash,
  }
}

const reverseNameOf = async (resolver: any, addr: `0x${string}`) =>
  resolver.read.name([namehash(`${addr.slice(2).toLowerCase()}.addr.reverse`)])

describe('reverse record on the sponsored path', () => {
  it('names the buyer, not the registrar that paid the gas', async () => {
    const { controller, resolver } = await load()
    const r = reg('boughtforme', alice.address, resolver.address, 1)
    await controller.write.commit([await controller.read.makeCommitment([r])], {
      account: registrar,
    })
    await controller.write.registerWithCredit([r], { account: registrar })

    expect(await reverseNameOf(resolver, alice.address)).toBe(
      'boughtforme.simplex',
    )
    // the shared hot wallet is untouched — the bug was that it took the record
    expect(await reverseNameOf(resolver, registrar.address)).toBe('')
  })

  it('a second sponsored registration does not overwrite the first buyer', async () => {
    const { controller, resolver } = await load()
    for (const [label, buyer] of [
      ['firstbuyer', alice.address],
      ['secondbuyer', bob.address],
    ] as const) {
      const r = reg(label, buyer, resolver.address, 1)
      await controller.write.commit(
        [await controller.read.makeCommitment([r])],
        { account: registrar },
      )
      await controller.write.registerWithCredit([r], { account: registrar })
    }
    expect(await reverseNameOf(resolver, alice.address)).toBe(
      'firstbuyer.simplex',
    )
    expect(await reverseNameOf(resolver, bob.address)).toBe(
      'secondbuyer.simplex',
    )
    expect(await reverseNameOf(resolver, registrar.address)).toBe('')
  })

  it('the buyer owns their reverse node, so they can change it later', async () => {
    const { controller, resolver, ens } = await load()
    const r = reg('ownsreverse', alice.address, resolver.address, 1)
    await controller.write.commit([await controller.read.makeCommitment([r])], {
      account: registrar,
    })
    await controller.write.registerWithCredit([r], { account: registrar })

    const node = namehash(
      `${alice.address.slice(2).toLowerCase()}.addr.reverse`,
    )
    expect((await ens.read.owner([node])).toLowerCase()).toBe(
      alice.address.toLowerCase(),
    )
  })

  it('the default reverse registrar names the buyer too', async () => {
    const { controller, resolver, defaultReverseRegistrar } = await load()
    const r = reg('defaultrev', alice.address, resolver.address, 2)
    await controller.write.commit([await controller.read.makeCommitment([r])], {
      account: registrar,
    })
    await controller.write.registerWithCredit([r], { account: registrar })

    expect(await defaultReverseRegistrar.read.nameForAddr([alice.address])).toBe(
      'defaultrev.simplex',
    )
    expect(
      await defaultReverseRegistrar.read.nameForAddr([registrar.address]),
    ).toBe('')
  })

  it('both bits at once, still the buyer', async () => {
    const { controller, resolver, defaultReverseRegistrar } = await load()
    const r = reg('bothbits', alice.address, resolver.address, 3)
    await controller.write.commit([await controller.read.makeCommitment([r])], {
      account: registrar,
    })
    await controller.write.registerWithCredit([r], { account: registrar })

    expect(await reverseNameOf(resolver, alice.address)).toBe('bothbits.simplex')
    expect(await defaultReverseRegistrar.read.nameForAddr([alice.address])).toBe(
      'bothbits.simplex',
    )
  })

  it('paying for someone else names the payer, and writes nothing to the recipient', async () => {
    const { controller, resolver, ens, baseRegistrar } = await load()
    // alice pays; bob receives the name; the reverse bit is set
    const r = reg('paidforbob', bob.address, resolver.address, 1)
    await controller.write.commit([await controller.read.makeCommitment([r])], {
      account: alice,
    })
    await controller.write.register([r], {
      account: alice,
      value: 2n * yearPriceUSD(10),
    })

    // the name itself is unambiguously bob's
    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('paidforbob'))])
      ).toLowerCase(),
    ).toBe(bob.address.toLowerCase())
    expect(
      (await ens.read.owner([namehash('paidforbob.simplex')])).toLowerCase(),
    ).toBe(bob.address.toLowerCase())

    // upstream semantics: the reverse record follows the payer, who asked for it
    expect(await reverseNameOf(resolver, alice.address)).toBe(
      'paidforbob.simplex',
    )
    // and nothing was written into bob's namespace without his consent
    expect(await reverseNameOf(resolver, bob.address)).toBe('')

    // the payer's claim is inert to any correct client: reverse records are
    // self-asserted (`ReverseRegistrar.setName` takes an arbitrary string), so
    // they mean nothing until forward-verified — and the forward record here
    // does not point back at alice
    expect(BigInt(await resolver.read.addr([namehash('paidforbob.simplex')]))).toBe(
      0n,
    )
  })

  it('the payable path keeps upstream semantics: the payer is named', async () => {
    const { controller, resolver } = await load()
    const r = reg('paidforit', alice.address, resolver.address, 1)
    await controller.write.commit([await controller.read.makeCommitment([r])], {
      account: alice,
    })
    await controller.write.register([r], {
      account: alice,
      value: 2n * yearPriceUSD(9),
    })
    expect(await reverseNameOf(resolver, alice.address)).toBe('paidforit.simplex')
  })
})
