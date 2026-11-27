//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

interface IClaimUnderTerms {
    function approve(address to, uint256 tokenId) external;

    function claimUnderTerms(
        address from,
        uint256 tokenId,
        uint256 offer,
        bytes32 acceptedTermsHash
    ) external;
}

contract ReentrantClaimer {
    IClaimUnderTerms public immutable registrar;

    constructor(IClaimUnderTerms registrar_) {
        registrar = registrar_;
    }

    function offer(address to, uint256 tokenId) external {
        registrar.approve(to, tokenId);
    }

    function claim(
        address from,
        uint256 tokenId,
        uint256 offerNumber,
        bytes32 termsHash
    ) external {
        registrar.claimUnderTerms(from, tokenId, offerNumber, termsHash);
    }

    function onERC721Received(
        address,
        address from,
        uint256 tokenId,
        bytes calldata
    ) external returns (bytes4) {
        registrar.claimUnderTerms(from, tokenId, 0, bytes32(0));
        return this.onERC721Received.selector;
    }

    fallback() external {
        registrar.claimUnderTerms(address(0), 0, 0, bytes32(0));
    }
}
