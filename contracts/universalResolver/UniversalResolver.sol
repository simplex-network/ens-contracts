// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {AbstractUniversalResolver, IGatewayProvider} from "./AbstractUniversalResolver.sol";
import {RegistryUtils, ENS} from "./RegistryUtils.sol";

contract UniversalResolver is AbstractUniversalResolver {
    ENS public immutable registry;

    /// @dev The first parameter is unnamed on purpose. Upstream passed it to
    ///      `ReverseClaimer`, which claimed a reverse node for it; SNRC runs no
    ///      reverse registrar, so the claim had nothing to call and the
    ///      inheritance is gone. The parameter is kept so the constructor ABI
    ///      still matches upstream and the deployment scripts.
    constructor(
        address /* owner */,
        ENS ens,
        IGatewayProvider batchGatewayProvider
    ) AbstractUniversalResolver(batchGatewayProvider) {
        registry = ens;
    }

    /// @inheritdoc AbstractUniversalResolver
    function findResolver(
        bytes memory name
    ) public view override returns (address, bytes32, uint256) {
        return RegistryUtils.findResolver(registry, name, 0);
    }
}
