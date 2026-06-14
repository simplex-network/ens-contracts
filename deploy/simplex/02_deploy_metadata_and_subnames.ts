import { artifacts, deployScript } from '@rocketh'

export default deployScript(
  async ({ deploy, get, execute: write, namedAccounts, network }) => {
    const { deployer, owner } = namedAccounts

    const registry = get<(typeof artifacts.ENSRegistry)['abi']>('ENSRegistry')
    const registrar = get<
      (typeof artifacts.BaseRegistrarImplementation)['abi']
    >('BaseRegistrarImplementation')

    const tld = process.env.SIMPLEX_TLD || 'testing'

    // On-chain NFT metadata renderer (swappable). tokenURI on the registrar
    // delegates here, passing the stored label, so the NFT title is the name.
    const renderer = await deploy('MetadataRenderer', {
      account: deployer,
      artifact: artifacts.MetadataRenderer,
      args: [`.${tld}`],
    })

    // Subname creation + on-chain index (immutable). Users grant
    // registry.setApprovalForAll(subnameRegistrar, true) before their first
    // subname; createSubname forces the subname owner to the parent owner.
    await deploy('SubnameRegistrar', {
      account: deployer,
      artifact: artifacts.SubnameRegistrar,
      args: [registry.address],
    })

    if (!renderer.newlyDeployed) return
    if (network.name === 'mainnet' && !network.tags?.tenderly) return

    console.log(`  - Pointing BaseRegistrar.tokenURI at MetadataRenderer`)
    await write(registrar, {
      functionName: 'setMetadataRenderer',
      args: [renderer.address],
      account: owner,
    })
  },
  {
    id: 'SimplexMetadataAndSubnames v1.0.0',
    tags: ['category:simplex', 'MetadataRenderer', 'SubnameRegistrar'],
    dependencies: ['ENSRegistry', 'BaseRegistrarImplementation', 'SimplexController'],
  },
)
