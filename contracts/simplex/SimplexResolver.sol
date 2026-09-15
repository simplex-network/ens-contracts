//SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import {PublicResolver, INameWrapper} from "../resolvers/PublicResolver.sol";
import {ENS} from "../registry/ENS.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title SimplexResolver
/// @notice PublicResolver plus a sponsored path: the name's owner signs a
///         record change and a relayer submits it, so a user never needs ETH.
///
/// Authority comes from the signature and nothing else. A one-shot EIP-712
/// intent, bound to the node and consumed by a per-signer nonce, is what makes
/// a relayed write safe; the relayer chooses only whether to pay the gas.
/// Metering how much relaying a name may consume is the relayer's business and
/// is done off-chain: it is the only caller of these functions, so an on-chain
/// budget could only stop a transaction it had already decided to pay for.
contract SimplexResolver is PublicResolver {
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant _EIP712_NAME = keccak256("SimplexResolver");
    bytes32 private constant _EIP712_VERSION = keccak256("1");
    bytes32 public constant SET_TEXT_TYPEHASH =
        keccak256(
            "SetText(bytes32 node,string key,string value,uint256 nonce,uint256 deadline)"
        );
    bytes32 public constant CLEAR_RECORDS_TYPEHASH =
        keccak256("ClearRecords(bytes32 node,uint256 nonce,uint256 deadline)");

    /// @dev One counter per signer. Shared across every node they own, so
    ///      intents from one owner are consumed strictly in order.
    mapping(address => uint256) public nonces;

    error SignatureExpired();
    error InvalidNonce();
    error InvalidSignature();
    error NotSubnameRegistrar();
    error NodeNotOwnedByRegistrar();

    constructor(
        ENS _ens,
        INameWrapper wrapperAddress,
        address _trustedETHController,
        address _trustedReverseRegistrar
    )
        PublicResolver(
            _ens,
            wrapperAddress,
            _trustedETHController,
            _trustedReverseRegistrar
        )
    {}

    /// @notice Retire every record on a subname, callable only by the subname
    ///         registrar and only for a node the registrar itself owns in the
    ///         registry.
    /// @dev A subname node is reused verbatim when its label is re-created, and
    ///      `SubnameRegistrar._clear` cannot reach this through `authorised`:
    ///      that path resolves the owner to the 2LD holder, never the registrar.
    ///      Without this, deleting or purging a subname would leave its records
    ///      in place, and re-creating the label under a new 2LD owner would
    ///      resurface the previous owner's SimpleX address under a name the new
    ///      owner now controls. The registrar clears on delete and on purge, so
    ///      a revived label always starts empty.
    ///
    ///      The scope is deliberately narrow: one function, no writes, and only
    ///      nodes whose registry owner is the caller — which for this deployment
    ///      is exactly the set of subnames the registrar created. It is not a
    ///      second `trustedETHController`; that slot can write any record on any
    ///      node.
    function clearSubnameRecords(bytes32 node) external {
        if (msg.sender != address(nameWrapper)) revert NotSubnameRegistrar();
        if (ens.owner(node) != msg.sender) revert NodeNotOwnedByRegistrar();
        recordVersions[node]++;
        emit VersionChanged(node, recordVersions[node]);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    _EIP712_NAME,
                    _EIP712_VERSION,
                    block.chainid,
                    address(this)
                )
            );
    }

    /// @notice Write a text record on behalf of the name's owner. Authority
    ///         comes from the signature, not the caller.
    function setTextWithSig(
        bytes32 node,
        string calldata key,
        string calldata value,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _consumeIntent(
            node,
            keccak256(
                abi.encode(
                    SET_TEXT_TYPEHASH,
                    node,
                    keccak256(bytes(key)),
                    keccak256(bytes(value)),
                    nonce,
                    deadline
                )
            ),
            nonce,
            deadline,
            sig
        );
        versionable_texts[recordVersions[node]][node][key] = value;
        emit TextChanged(node, key, key, value);
    }

    /// @notice Retire every record on `node` in one constant-gas write, on behalf
    ///         of its owner. What a gifted name inherited from its sender is
    ///         cleared in a single call rather than one call per stale key.
    function clearRecordsWithSig(
        bytes32 node,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external {
        _consumeIntent(
            node,
            keccak256(
                abi.encode(CLEAR_RECORDS_TYPEHASH, node, nonce, deadline)
            ),
            nonce,
            deadline,
            sig
        );
        uint64 version = recordVersions[node] + 1;
        recordVersions[node] = version;
        emit VersionChanged(node, version);
    }

    /// @dev The address whose signature authorises `node`. Mirrors
    ///      `PublicResolver.isAuthorised`: a subname's registry owner is the
    ///      SubnameRegistrar, and its effective owner is the 2LD holder behind it.
    function relayedSigner(bytes32 node) public view returns (address owner) {
        owner = ens.owner(node);
        if (owner == address(nameWrapper))
            owner = nameWrapper.ownerOf(uint256(node));
    }

    /// @dev Verify a signed intent, then spend the nonce.
    function _consumeIntent(
        bytes32 node,
        bytes32 structHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) internal {
        if (block.timestamp > deadline) revert SignatureExpired();
        address owner = relayedSigner(node);
        if (nonce != nonces[owner]) revert InvalidNonce();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash)
        );
        if (!SignatureChecker.isValidSignatureNow(owner, digest, sig))
            revert InvalidSignature();
        unchecked {
            nonces[owner] = nonce + 1;
        }
    }
}
