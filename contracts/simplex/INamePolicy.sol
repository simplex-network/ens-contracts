//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

interface INamePolicy {
    function consumeRegistration(
        string calldata label,
        bytes32 labelhash,
        bytes32 commitment,
        address owner
    ) external;

    function isReserved(bytes32 labelhash) external view returns (bool);

    function communityNames(bytes32 labelhash) external view returns (bool);

    function acceptTermsForClaim(
        uint256 tokenId,
        address from,
        uint256 offer,
        bytes32 acceptedTermsHash,
        address recipient
    ) external;

    function consumeTransfer(
        uint256 tokenId,
        address from,
        address to,
        uint256 offer,
        string calldata label
    ) external;

    function consumeRenewal(
        string calldata label,
        bytes32 labelhash,
        uint256 duration,
        address holder
    ) external;
}

interface INamePolicyBinding {
    function controller() external view returns (address);

    function registrar() external view returns (address);
}
