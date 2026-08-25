import hre from 'hardhat'
import { keccak256, toHex } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  FAR_FUTURE,
  node,
  registration,
  signIntent,
} from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient, registrarClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account

const NODE = node('giftedto')
const KEY = 'simplex.contact'

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.controller.write.setRegistrarAllowance([registrar.address, AMPLE_ALLOWANCE], {
    account: guardian,
  })
  const reg = registration('giftedto', alice.address, {
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

const sign = (client: any, resolver: `0x${string}`, message: any) =>
  signIntent(publicClient, client, 'SimplexResolver', resolver, 'ClearRecords', message)

describe('clearRecordsWithSig', () => {
  it('pins the EIP-712 type hash', async () => {
    const { resolver } = await load()
    expect(await resolver.read.CLEAR_RECORDS_TYPEHASH()).toBe(
      keccak256(
        toHex('ClearRecords(bytes32 node,uint256 nonce,uint256 deadline)'),
      ),
    )
  })

  it('retires every record in one call, for one credit', async () => {
    const { resolver } = await load()
    // the sender leaves records behind
    await resolver.write.setText([NODE, KEY, 'sender-link'], { account: alice })
    await resolver.write.setText([NODE, 'simplex.channel', 'sender-channel'], {
      account: alice,
    })
    expect(await resolver.read.text([NODE, KEY])).toBe('sender-link')

    const before = await resolver.read.editCredits([NODE])
    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(aliceClient, resolver.address, message)
    await resolver.write.clearRecordsWithSig(
      [NODE, message.nonce, message.deadline, sig],
      { account: bobClient.account },
    )

    expect(await resolver.read.text([NODE, KEY])).toBe('')
    expect(await resolver.read.text([NODE, 'simplex.channel'])).toBe('')
    expect(await resolver.read.editCredits([NODE])).toBe(before - 1n)
    expect(await resolver.read.recordVersions([NODE])).toBe(1n)
  })

  it('costs one credit no matter how many records existed', async () => {
    const { resolver } = await load()
    for (let i = 0; i < 8; i++) {
      await resolver.write.setText([NODE, `key.${i}`, 'x'], { account: alice })
    }
    const before = await resolver.read.editCredits([NODE])
    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(aliceClient, resolver.address, message)
    await resolver.write.clearRecordsWithSig(
      [NODE, message.nonce, message.deadline, sig],
      { account: bobClient.account },
    )
    expect(await resolver.read.editCredits([NODE])).toBe(before - 1n)
  })

  it('rejects a signature from anyone but the owner', async () => {
    const { resolver } = await load()
    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(bobClient, resolver.address, message)
    await expect(
      resolver.write.clearRecordsWithSig(
        [NODE, message.nonce, message.deadline, sig],
        { account: bobClient.account },
      ),
    ).toBeRevertedWithCustomError('InvalidSignature')
  })

  it('rejects a replayed signature', async () => {
    const { resolver } = await load()
    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(aliceClient, resolver.address, message)
    await resolver.write.clearRecordsWithSig(
      [NODE, message.nonce, message.deadline, sig],
      { account: bobClient.account },
    )
    await expect(
      resolver.write.clearRecordsWithSig(
        [NODE, message.nonce, message.deadline, sig],
        { account: bobClient.account },
      ),
    ).toBeRevertedWithCustomError('InvalidNonce')
  })

  it('rejects an expired signature', async () => {
    const { resolver } = await load()
    const past = BigInt((await publicClient.getBlock()).timestamp) - 1n
    const message = { node: NODE, nonce: 0n, deadline: past }
    const sig = await sign(aliceClient, resolver.address, message)
    await expect(
      resolver.write.clearRecordsWithSig(
        [NODE, message.nonce, message.deadline, sig],
        { account: bobClient.account },
      ),
    ).toBeRevertedWithCustomError('SignatureExpired')
  })

  it('refuses at zero credits', async () => {
    const { resolver, controller } = await load()
    // spend the allowance down with setTextWithSig
    let nonce = 0n
    for (let i = 0; i < 10; i++) {
      const m = {
        node: NODE,
        key: `k${i}`,
        value: 'v',
        nonce,
        deadline: FAR_FUTURE,
      }
      const s = await signIntent(
        publicClient,
        aliceClient,
        'SimplexResolver',
        resolver.address,
        'SetText',
        m,
      )
      await resolver.write.setTextWithSig(
        [NODE, m.key, m.value, m.nonce, m.deadline, s],
        { account: bobClient.account },
      )
      nonce += 1n
    }
    expect(await resolver.read.editCredits([NODE])).toBe(0n)

    const message = { node: NODE, nonce, deadline: FAR_FUTURE }
    const sig = await sign(aliceClient, resolver.address, message)
    await expect(
      resolver.write.clearRecordsWithSig(
        [NODE, message.nonce, message.deadline, sig],
        { account: bobClient.account },
      ),
    ).toBeRevertedWithCustomError('NoEditCredits')
  })
})
