import hre from 'hardhat'
import { keccak256, toHex } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, FAR_FUTURE, signIntent } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient, , aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const alice = aliceClient.account
const bob = bobClient.account

async function fixture() {
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const sign = (client: any, ens: `0x${string}`, message: any) =>
  signIntent(publicClient, client, 'SimplexENSRegistry', ens, 'ApproveAll', message)

describe('ENSRegistry.setApprovalForAllWithSig', () => {
  it('pins the EIP-712 type hash', async () => {
    const { ens } = await load()
    expect(await ens.read.APPROVE_ALL_TYPEHASH()).toBe(
      keccak256(
        toHex(
          'ApproveAll(address owner,address operator,bool approved,uint256 nonce,uint256 deadline)',
        ),
      ),
    )
  })

  it('a relayer lands the owner signed approval, and the result matches the transaction form', async () => {
    const { ens, subnameRegistrar } = await load()
    expect(
      await ens.read.isApprovedForAll([
        alice.address,
        subnameRegistrar.address,
      ]),
    ).toBe(false)

    const message = {
      owner: alice.address,
      operator: subnameRegistrar.address,
      approved: true,
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await sign(aliceClient, ens.address, message)
    // bob pays the gas; alice never sends a transaction
    await ens.write.setApprovalForAllWithSig(
      [
        message.owner,
        message.operator,
        message.approved,
        message.nonce,
        message.deadline,
        sig,
      ],
      { account: bob },
    )

    expect(
      await ens.read.isApprovedForAll([
        alice.address,
        subnameRegistrar.address,
      ]),
    ).toBe(true)

    // identical to what setApprovalForAll writes
    await ens.write.setApprovalForAll([subnameRegistrar.address, true], {
      account: bob,
    })
    expect(
      await ens.read.isApprovedForAll([bob.address, subnameRegistrar.address]),
    ).toBe(true)
  })

  it('revokes when signed with approved = false', async () => {
    const { ens, subnameRegistrar } = await load()
    for (const [approved, nonce] of [
      [true, 0n],
      [false, 1n],
    ] as const) {
      const message = {
        owner: alice.address,
        operator: subnameRegistrar.address,
        approved,
        nonce,
        deadline: FAR_FUTURE,
      }
      const sig = await sign(aliceClient, ens.address, message)
      await ens.write.setApprovalForAllWithSig(
        [
          message.owner,
          message.operator,
          message.approved,
          message.nonce,
          message.deadline,
          sig,
        ],
        { account: bob },
      )
    }
    expect(
      await ens.read.isApprovedForAll([
        alice.address,
        subnameRegistrar.address,
      ]),
    ).toBe(false)
    expect(await ens.read.nonces([alice.address])).toBe(2n)
  })

  it('rejects a signature from anyone but the stated owner', async () => {
    const { ens, subnameRegistrar } = await load()
    const message = {
      owner: alice.address,
      operator: subnameRegistrar.address,
      approved: true,
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await sign(bobClient, ens.address, message)
    await expect(
      ens.write.setApprovalForAllWithSig(
        [
          message.owner,
          message.operator,
          message.approved,
          message.nonce,
          message.deadline,
          sig,
        ],
        { account: bob },
      ),
    ).toBeRevertedWithCustomError('InvalidSignature')
  })

  it('rejects a relayer swapping in a different operator', async () => {
    const { ens, subnameRegistrar } = await load()
    const message = {
      owner: alice.address,
      operator: subnameRegistrar.address,
      approved: true,
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await sign(aliceClient, ens.address, message)
    await expect(
      ens.write.setApprovalForAllWithSig(
        [message.owner, bob.address, true, message.nonce, message.deadline, sig],
        { account: bob },
      ),
    ).toBeRevertedWithCustomError('InvalidSignature')
  })

  it('rejects a replayed signature', async () => {
    const { ens, subnameRegistrar } = await load()
    const message = {
      owner: alice.address,
      operator: subnameRegistrar.address,
      approved: true,
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await sign(aliceClient, ens.address, message)
    const args = [
      message.owner,
      message.operator,
      message.approved,
      message.nonce,
      message.deadline,
      sig,
    ] as const
    await ens.write.setApprovalForAllWithSig(args, { account: bob })
    await expect(
      ens.write.setApprovalForAllWithSig(args, { account: bob }),
    ).toBeRevertedWithCustomError('InvalidNonce')
  })

  it('rejects an expired signature', async () => {
    const { ens, subnameRegistrar } = await load()
    const past = BigInt((await publicClient.getBlock()).timestamp) - 1n
    const message = {
      owner: alice.address,
      operator: subnameRegistrar.address,
      approved: true,
      nonce: 0n,
      deadline: past,
    }
    const sig = await sign(aliceClient, ens.address, message)
    await expect(
      ens.write.setApprovalForAllWithSig(
        [
          message.owner,
          message.operator,
          message.approved,
          message.nonce,
          message.deadline,
          sig,
        ],
        { account: bob },
      ),
    ).toBeRevertedWithCustomError('SignatureExpired')
  })
})
