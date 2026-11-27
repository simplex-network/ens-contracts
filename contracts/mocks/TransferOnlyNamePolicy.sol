//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

contract TransferOnlyNamePolicy {
    address public immutable registrar;

    constructor(address registrar_) {
        registrar = registrar_;
    }

    function consumeTransfer(
        uint256,
        address,
        address,
        uint256,
        string calldata
    ) external pure {}
}
