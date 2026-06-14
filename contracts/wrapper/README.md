# wrapper/ — interfaces only (NameWrapper removed)

SNRC is **wrapper-free** (v3). The `NameWrapper` implementation and its support
contracts (`ERC1155Fuse`, `Controllable`, `StaticMetadataService`, mocks, tests)
were removed from the source tree.

What remains here, and why:

- `INameWrapper.sol` — imported by the **verbatim** `PublicResolver`
  (`isAuthorised`). SNRC deploys the resolver with `nameWrapper = address(0)`, so
  the wrapper-auth branch is never taken, but the import must still resolve.
- `IMetadataService.sol`, `INameWrapperUpgrade.sol` — pulled in by
  `INameWrapper.sol`.

What replaced the wrapper in v3:

- **2LDs** are plain ERC-721 on `BaseRegistrarImplementation` (v3), which adds
  `ERC721Enumerable`, an on-chain `labelOf` index, and `tokenURI`.
- **NFT metadata** is rendered fully on-chain by `simplex/MetadataRenderer.sol`.
- **Subnames** are created + indexed by `simplex/SubnameRegistrar.sol`.

See `docs/architecture.md` and the `docs/uml-class-diagram.excalidraw` /
`docs/uml-deployment-diagram.excalidraw` diagrams.
