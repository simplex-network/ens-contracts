import type { NetworkConnection } from 'hardhat/types/network'
import { encodeFunctionData, labelhash, namehash, zeroAddress, zeroHash } from 'viem'

import { DAY } from '../../fixtures/constants.js'

export const YEAR = 365n * DAY

/** attoUSD per second for a given yearly price in whole dollars. */
const perYear = (usd: bigint) => (usd * 10n ** 18n) / YEAR

/** The 6+ rung: $10 a year, to the nearest attoUSD per second. */
const BASE = perYear(10n)

/**
 * attoUSD per second, by label length: [1, 2, 3, 4, 5, 6+]. $10 a year at six
 * characters and above, ten times more for each character lost. Built as exact
 * multiples of the 6+ rung so the ratios hold without rounding drift; the
 * dollar figures are therefore $10 to within a part in 1e12, not to the wei.
 * The sixth entry is what splits 6+ from 5 — a five-entry array leaves them
 * priced identically.
 */
export const PRICE_CURVE = [
  BASE * 100000n,
  BASE * 10000n,
  BASE * 1000n,
  BASE * 100n,
  BASE * 10n,
  BASE,
] as const

/** The yearly price of a label of `len` characters, in attoUSD. */
export function yearPriceUSD(len: number, years = 1n) {
  const idx = len >= 6 ? 5 : len - 1
  return PRICE_CURVE[idx] * YEAR * years
}

/** What a one-year 6+ character name costs, in attoUSD. */
export const YEAR_PRICE_USD = yearPriceUSD(6)

/** attoUSD charged per edit credit in these tests: $0.10. */
export const EDIT_CREDIT_PRICE_USD = 10n ** 17n
export const TLD = 'simplex'
export const TLD_NODE = namehash(TLD)

/**
 * The full `.simplex` stack, wired as `deploy-simplex.mjs` will wire it:
 * SimplexResolver in place of PublicResolver, the SubnameRegistrar in the
 * resolver's wrapper slot, the controller proxy as both trusted controller and
 * credit granter, and no reverse registrar.
 *
 * `owner` owns the controller. `beneficiary` is the guardian key. `registrar`
 * stands in for the names service hot wallet and starts with no credits.
 */
export async function deployNamesV2(
  connection: NetworkConnection,
  accounts: {
    owner: `0x${string}`
    beneficiary: `0x${string}`
  },
) {
  const viem = connection.viem
  const ens = await viem.deployContract('ENSRegistry', [])
  const baseRegistrar = await viem.deployContract(
    'BaseRegistrarImplementation',
    [ens.address, TLD_NODE],
  )
  await ens.write.setSubnodeOwner([zeroHash, labelhash(TLD), baseRegistrar.address])

  // PublicResolver inherits ReverseClaimer, whose constructor calls the registrar
  // at addr.reverse. It must exist before the resolver is deployed, even though
  // this deployment passes address(0) for trustedReverseRegistrar and never uses it.
  const reverseRegistrar = await viem.deployContract('ReverseRegistrar', [
    ens.address,
  ])
  await ens.write.setSubnodeOwner([zeroHash, labelhash('reverse'), accounts.owner])
  await ens.write.setSubnodeOwner([
    namehash('reverse'),
    labelhash('addr'),
    reverseRegistrar.address,
  ])

  // The real `.simplex` curve, in attoUSD per second: $1/yr at 5+ characters,
  // $32 at 4, $128 at 3. With the feed pinned to 1e8 below, 1 attoUSD is 1 wei,
  // so a one-year 6-character name costs ~0.9993 ETH in these tests.
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
      zeroAddress,
      zeroAddress,
      ens.address,
      {
        tldNode: TLD_NODE,
        tldSuffix: `.${TLD}`,
        minCharLength: 6,
        smpxNft: zeroAddress,
        nftGateEnabled: false,
      },
      accounts.owner,
    ],
  })
  const proxy = await viem.deployContract('SimplexControllerProxy', [
    implementation.address,
    initData,
  ])
  const controller = await viem.getContractAt('SimplexController', proxy.address)

  const subnameRegistrar = await viem.deployContract('SubnameRegistrar', [
    ens.address,
    baseRegistrar.address,
  ])
  const resolver = await viem.deployContract('SimplexResolver', [
    ens.address,
    subnameRegistrar.address, // wrapper slot: subname authorisation routes here
    controller.address, // trustedETHController
    zeroAddress, // no reverse registrar
    controller.address, // may grant edit credits
  ])
  await subnameRegistrar.write.setResolver([resolver.address])

  await baseRegistrar.write.addController([controller.address])
  await baseRegistrar.write.setSubnameHook([subnameRegistrar.address])
  await controller.write.setDefaultResolver([resolver.address], {
    account: accounts.owner,
  })
  await controller.write.setBeneficiary([accounts.beneficiary], {
    account: accounts.owner,
  })
  await controller.write.setEditCreditPrice([EDIT_CREDIT_PRICE_USD], {
    account: accounts.owner,
  })

  return {
    ens,
    baseRegistrar,
    controller,
    implementation,
    resolver,
    subnameRegistrar,
    priceOracle,
    dummyOracle,
    reverseRegistrar,
  }
}

/** A registration struct with the defaults every test here wants. */
export function registration(
  label: string,
  owner: `0x${string}`,
  overrides: Partial<{
    duration: bigint
    resolver: `0x${string}`
    data: `0x${string}`[]
  }> = {},
) {
  return {
    label,
    owner,
    duration: overrides.duration ?? YEAR,
    secret: zeroHash,
    resolver: overrides.resolver ?? zeroAddress,
    data: overrides.data ?? [],
    reverseRecord: 0,
    referrer: zeroHash,
  } as const
}

export function node(label: string) {
  return namehash(`${label}.${TLD}`)
}

/** EIP-712 type definitions for every signed intent in the names-v2 stack. */
export const eip712Types = {
  SetText: [
    { name: 'node', type: 'bytes32' },
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  ClearRecords: [
    { name: 'node', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  ApproveAll: [
    { name: 'owner', type: 'address' },
    { name: 'operator', type: 'address' },
    { name: 'approved', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  CreateSubname: [
    { name: 'parentNode', type: 'bytes32' },
    { name: 'label', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TransferName: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  DeleteSubname: [
    { name: 'parentNode', type: 'bytes32' },
    { name: 'label', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const FAR_FUTURE = 4102444800n

/** Sign one of the intents above against `verifyingContract`. */
export async function signIntent(
  publicClient: any,
  client: any,
  domainName:
    | 'SimplexResolver'
    | 'SimplexENSRegistry'
    | 'SimplexSubnames'
    | 'SimplexNames',
  verifyingContract: `0x${string}`,
  primaryType: keyof typeof eip712Types,
  message: Record<string, unknown>,
) {
  const chainId = await publicClient.getChainId()
  return client.signTypedData({
    account: client.account,
    domain: { name: domainName, version: '1', chainId, verifyingContract },
    types: eip712Types,
    primaryType,
    message,
  })
}

/** Enough allowance that a test never has to think about it: $1000. */
export const AMPLE_ALLOWANCE = 1000n * 10n ** 18n
