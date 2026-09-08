//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {IPriceOracle} from "../ethregistrar/IPriceOracle.sol";
import {IPriceOracleUSD} from "../ethregistrar/IPriceOracleUSD.sol";
import {AggregatorInterface} from "../ethregistrar/StablePriceOracle.sol";
import {StringUtils} from "../utils/StringUtils.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice USD-denominated rent the owner can change by call. In
///         `StablePriceOracle` the prices are `immutable`, so every change means
///         a new oracle and a `SimplexController.setPriceOracle`.
///
///         Lapsed names carry no premium: once the grace period is over a name
///         costs the same as any other.
contract SimplexPriceOracle is IPriceOracleUSD, Ownable2Step {
    using StringUtils for *;

    struct LabelPrice {
        uint256 labelLength;
        uint256 priceUSDPerYear;
    }

    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @dev Bounds how much `setPrices` can be made to write.
    uint256 public constant MAX_LABEL_LENGTH = 64;

    AggregatorInterface public usdOracle;
    /// @dev `AggregatorInterface` has no `decimals()`, so a feed's scale cannot
    ///      be read and has to be stated. A wrong one misprices every name
    ///      without reverting.
    uint256 public usdOracleScale;

    /// @dev attoUSD per year, for every length without an exception.
    uint256 public basePriceUSDPerYear;
    /// @dev Zero means no exception, so a zero price is refused.
    mapping(uint256 => uint256) public priceByLabelLength;
    /// @dev The mapping's keys: a mapping cannot be read back or cleared
    ///      without them.
    uint256[] public pricedLabelLengths;

    event PricesChanged(uint256 basePriceUSDPerYear, LabelPrice[] prices);
    event UsdOracleChanged(address indexed usdOracle, uint8 decimals);

    /// @dev Zero would divide by zero; negative would wrap the cast and quote
    ///      every name as free.
    error InvalidPriceFeed(int256 answer);
    error ZeroAddress();
    error InvalidFeedDecimals(uint8 decimals);
    error LabelLengthOutOfRange(uint256 labelLength);
    error DuplicateLabelLength(uint256 labelLength);
    error ZeroExceptionPrice(uint256 labelLength);

    constructor(
        AggregatorInterface _usdOracle,
        uint8 _usdOracleDecimals,
        uint256 _basePriceUSDPerYear,
        LabelPrice[] memory _prices
    ) {
        _setUsdOracle(_usdOracle, _usdOracleDecimals);
        _setPrices(_basePriceUSDPerYear, _prices);
    }

    /// @notice Replaces the whole curve: exceptions not listed again are gone.
    ///         Order does not matter and the list may be empty.
    function setPrices(
        uint256 newBasePriceUSDPerYear,
        LabelPrice[] calldata newPrices
    ) external onlyOwner {
        _setPrices(newBasePriceUSDPerYear, newPrices);
    }

    /// @param decimals The new feed's scale, which cannot be read from it.
    function setUsdOracle(
        AggregatorInterface newOracle,
        uint8 decimals
    ) external onlyOwner {
        _setUsdOracle(newOracle, decimals);
    }

    /// @notice attoUSD per year for a label of this length.
    function priceUSDPerYear(
        uint256 labelLength
    ) public view returns (uint256) {
        uint256 exception = priceByLabelLength[labelLength];
        return exception == 0 ? basePriceUSDPerYear : exception;
    }

    /// @notice The whole curve, in the shape `setPrices` takes.
    function prices()
        external
        view
        returns (uint256 base, LabelPrice[] memory exceptions)
    {
        uint256 n = pricedLabelLengths.length;
        exceptions = new LabelPrice[](n);
        for (uint256 i; i < n; ++i) {
            uint256 labelLength = pricedLabelLengths[i];
            exceptions[i] = LabelPrice({
                labelLength: labelLength,
                priceUSDPerYear: priceByLabelLength[labelLength]
            });
        }
        base = basePriceUSDPerYear;
    }

    function price(
        string calldata label,
        uint256 expires,
        uint256 duration
    ) external view override returns (IPriceOracle.Price memory) {
        IPriceOracle.Price memory usd = _priceUSD(label, expires, duration);
        uint256 ethPrice = _ethPrice();
        uint256 scale = usdOracleScale;
        return
            IPriceOracle.Price({
                base: (usd.base * scale) / ethPrice,
                premium: (usd.premium * scale) / ethPrice
            });
    }

    /// @inheritdoc IPriceOracleUSD
    function priceUSD(
        string calldata label,
        uint256 expires,
        uint256 duration
    ) external view override returns (IPriceOracle.Price memory) {
        return _priceUSD(label, expires, duration);
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view virtual returns (bool) {
        return
            interfaceID == type(IERC165).interfaceId ||
            interfaceID == type(IPriceOracle).interfaceId ||
            interfaceID == type(IPriceOracleUSD).interfaceId;
    }

    function _setPrices(
        uint256 newBasePriceUSDPerYear,
        LabelPrice[] memory newPrices
    ) internal {
        uint256 previous = pricedLabelLengths.length;
        for (uint256 i; i < previous; ++i) {
            delete priceByLabelLength[pricedLabelLengths[i]];
        }
        delete pricedLabelLengths;

        for (uint256 i; i < newPrices.length; ++i) {
            uint256 labelLength = newPrices[i].labelLength;
            uint256 perYear = newPrices[i].priceUSDPerYear;
            if (labelLength == 0 || labelLength > MAX_LABEL_LENGTH)
                revert LabelLengthOutOfRange(labelLength);
            if (perYear == 0) revert ZeroExceptionPrice(labelLength);
            if (priceByLabelLength[labelLength] != 0)
                revert DuplicateLabelLength(labelLength);

            priceByLabelLength[labelLength] = perYear;
            pricedLabelLengths.push(labelLength);
        }

        basePriceUSDPerYear = newBasePriceUSDPerYear;

        emit PricesChanged(newBasePriceUSDPerYear, newPrices);
    }

    function _setUsdOracle(
        AggregatorInterface newOracle,
        uint8 decimals
    ) internal {
        if (address(newOracle) == address(0)) revert ZeroAddress();
        if (decimals == 0 || decimals > 36) revert InvalidFeedDecimals(decimals);
        int256 answer = newOracle.latestAnswer();
        if (answer <= 0) revert InvalidPriceFeed(answer);
        usdOracle = newOracle;
        usdOracleScale = 10 ** uint256(decimals);

        emit UsdOracleChanged(address(newOracle), decimals);
    }

    function _priceUSD(
        string calldata label,
        uint256,
        uint256 duration
    ) internal view returns (IPriceOracle.Price memory) {
        return
            IPriceOracle.Price({
                base: (priceUSDPerYear(label.strlen()) * duration) /
                    SECONDS_PER_YEAR,
                premium: 0
            });
    }

    function _ethPrice() internal view returns (uint256) {
        int256 answer = usdOracle.latestAnswer();
        if (answer <= 0) revert InvalidPriceFeed(answer);
        return uint256(answer);
    }
}
