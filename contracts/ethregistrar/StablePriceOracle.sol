//SPDX-License-Identifier: MIT
pragma solidity ~0.8.17;

import "./IPriceOracle.sol";
import "./IPriceOracleUSD.sol";
import "../utils/StringUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface AggregatorInterface {
    function latestAnswer() external view returns (int256);
}

// StablePriceOracle sets a price in USD, based on an oracle.
contract StablePriceOracle is IPriceOracleUSD {
    using StringUtils for *;

    // Rent in base price units by length
    uint256 public immutable price1Letter;
    uint256 public immutable price2Letter;
    uint256 public immutable price3Letter;
    uint256 public immutable price4Letter;
    uint256 public immutable price5Letter;
    /// @dev SNRC: `price5Letter` applied to every name of five characters or
    ///      more, so a six-character name could never be priced apart from a
    ///      five-character one. Supplying a sixth entry splits them; a
    ///      five-entry array keeps the previous behaviour exactly.
    uint256 public immutable price6Letter;

    // Oracle address
    AggregatorInterface public immutable usdOracle;

    event RentPriceChanged(uint256[] prices);

    /// @dev The feed reported zero or a negative price. Zero would panic on the
    ///      division below; negative would wrap the cast to ~2**256 and floor
    ///      every quote to zero, handing out free names. Both fail loudly instead.
    error InvalidPriceFeed(int256 answer);

    constructor(AggregatorInterface _usdOracle, uint256[] memory _rentPrices) {
        usdOracle = _usdOracle;
        price1Letter = _rentPrices[0];
        price2Letter = _rentPrices[1];
        price3Letter = _rentPrices[2];
        price4Letter = _rentPrices[3];
        price5Letter = _rentPrices[4];
        price6Letter = _rentPrices.length > 5 ? _rentPrices[5] : _rentPrices[4];
    }

    function price(
        string calldata name,
        uint256 expires,
        uint256 duration
    ) external view override returns (IPriceOracle.Price memory) {
        IPriceOracle.Price memory usd = _priceUSD(name, expires, duration);
        return
            IPriceOracle.Price({
                base: attoUSDToWei(usd.base),
                premium: attoUSDToWei(usd.premium)
            });
    }

    /// @inheritdoc IPriceOracleUSD
    function priceUSD(
        string calldata name,
        uint256 expires,
        uint256 duration
    ) external view override returns (IPriceOracle.Price memory) {
        return _priceUSD(name, expires, duration);
    }

    function _priceUSD(
        string calldata name,
        uint256 expires,
        uint256 duration
    ) internal view returns (IPriceOracle.Price memory) {
        uint256 len = name.strlen();
        uint256 basePrice;

        if (len >= 6) {
            basePrice = price6Letter * duration;
        } else if (len == 5) {
            basePrice = price5Letter * duration;
        } else if (len == 4) {
            basePrice = price4Letter * duration;
        } else if (len == 3) {
            basePrice = price3Letter * duration;
        } else if (len == 2) {
            basePrice = price2Letter * duration;
        } else {
            basePrice = price1Letter * duration;
        }

        return
            IPriceOracle.Price({
                base: basePrice,
                premium: _premium(name, expires, duration)
            });
    }

    /// @dev Returns the pricing premium in wei.
    function premium(
        string calldata name,
        uint256 expires,
        uint256 duration
    ) external view returns (uint256) {
        return attoUSDToWei(_premium(name, expires, duration));
    }

    /// @dev Returns the pricing premium in internal base units.
    function _premium(
        string memory name,
        uint256 expires,
        uint256 duration
    ) internal view virtual returns (uint256) {
        return 0;
    }

    function attoUSDToWei(uint256 amount) internal view returns (uint256) {
        return (amount * 1e8) / _ethPrice();
    }

    function weiToAttoUSD(uint256 amount) internal view returns (uint256) {
        return (amount * _ethPrice()) / 1e8;
    }

    function _ethPrice() internal view returns (uint256) {
        int256 answer = usdOracle.latestAnswer();
        if (answer <= 0) revert InvalidPriceFeed(answer);
        return uint256(answer);
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view virtual returns (bool) {
        return
            interfaceID == type(IERC165).interfaceId ||
            interfaceID == type(IPriceOracle).interfaceId ||
            interfaceID == type(IPriceOracleUSD).interfaceId;
    }
}
