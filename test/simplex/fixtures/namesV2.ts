import type { NetworkConnection } from 'hardhat/types/network'
import { encodeFunctionData, labelhash, namehash, zeroAddress, zeroHash } from 'viem'

import { DAY } from '../../fixtures/constants.js'

export const YEAR = 365n * DAY
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

  const dummyOracle = await viem.deployContract('DummyOracle', [100000000n])
  const priceOracle = await viem.deployContract('StablePriceOracle', [
    dummyOracle.address,
    [0n, 0n, 0n, 0n, 0n],
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
  domainName: 'SimplexResolver' | 'SimplexENSRegistry' | 'SimplexSubnames',
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
