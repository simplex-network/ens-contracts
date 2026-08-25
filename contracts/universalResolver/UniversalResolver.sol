// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {AbstractUniversalResolver, IGatewayProvider} from "./AbstractUniversalResolver.sol";
import {RegistryUtils, ENS} from "./RegistryUtils.sol";

contract UniversalResolver is AbstractUniversalResolver {
    ENS public immutable registry;

    /// @param owner Retained for constructor-ABI compatibility with upstream and
    ///        with the deployment scripts. SNRC dropped `ReverseClaimer` — it
    ///        claimed a reverse node for `owner`, and this deployment runs no
    ///        reverse registrar, so the claim had nothing to call.
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
