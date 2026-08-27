//SPDX-License-Identifier: MIT
pragma solidity >=0.8.17 <0.9.0;

import "./IPriceOracle.sol";

/// @dev A price oracle that can also quote in its own accounting unit, before
///      conversion to ETH. `IPriceOracle.price` returns wei, which moves with the
///      ETH price and is therefore useless as a spending limit. `priceUSD`
///      returns the same quote in attoUSD, which is what the price list is
///      actually configured in.
interface IPriceOracleUSD is IPriceOracle {
    /// @return The price to register or renew `name`, in attoUSD.
    function priceUSD(
        string calldata name,
        uint256 expires,
        uint256 duration
    ) external view returns (Price memory);
}
