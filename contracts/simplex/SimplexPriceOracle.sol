//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {IPriceOracle} from "../ethregistrar/IPriceOracle.sol";
import {IPriceOracleUSD} from "../ethregistrar/IPriceOracleUSD.sol";
import {AggregatorInterface} from "../ethregistrar/StablePriceOracle.sol";
import {StringUtils} from "../utils/StringUtils.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice USD-denominated rent, configurable by call rather than fixed at
///         construction. `StablePriceOracle` hard-wires six `immutable` prices at
///         lengths 1..6, so every price change means a fresh oracle plus
///         `SimplexController.setPriceOracle`. Here the curve is a base price per
///         year plus a sparse list of rungs at arbitrary lengths, and the
///         Chainlink feed and the Dutch-auction parameters are settable too, so
///         the oracle never has to be redeployed to change what a name costs.
///
///         A rung `(maxLength, priceUSDPerYear)` means "names of at most
///         `maxLength` characters cost this". Every length between two rungs
///         inherits the rung above it and every length above the tallest rung
///         pays the base price, so a curve with rungs at 13 and 32 needs no
///         enumeration of the lengths in between. The setter enforces that no
///         length is ever cheaper than a longer one.
///
///         The premium is ENS's exponential Dutch auction, copied from
///         `ExponentialPremiumPriceOracle` so that vendored file stays untouched;
///         only the entry point differs, reading its parameters from storage
///         rather than from `immutable`s.
contract SimplexPriceOracle is IPriceOracleUSD, Ownable2Step {
    using StringUtils for *;

    /// @notice "Names of at most `maxLength` characters cost `priceUSDPerYear`."
    struct Rung {
        uint256 maxLength;
        uint256 priceUSDPerYear;
    }

    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @dev Ceiling on where a rung may sit. Bounds `setPrices` at 64 storage
    ///      writes; every longer name pays the base price, which is the floor.
    uint256 public constant MAX_RUNG_LENGTH = 64;

    /// @dev Must equal `BaseRegistrarImplementation.GRACE_PERIOD`: the auction
    ///      opens exactly when the name becomes registrable.
    uint256 private constant GRACE_PERIOD = 90 days;

    AggregatorInterface public usdOracle;

    /// @dev attoUSD per year for every length above `topRung`.
    uint256 public basePriceUSDPerYear;
    /// @dev The tallest configured rung. Zero means the base price applies to
    ///      every length.
    uint256 public topRung;
    /// @dev The rung list, expanded. Authoritative for lengths 1..`topRung`.
    mapping(uint256 => uint256) public priceUSDPerYearByLength;

    uint256 public startPremium;
    uint256 public totalDays;
    uint256 public endValue;

    event PricesChanged(uint256 basePriceUSDPerYear, Rung[] rungs);
    event UsdOracleChanged(address indexed usdOracle);
    event PremiumChanged(uint256 startPremium, uint256 totalDays);

    /// @dev The feed reported zero or a negative price. Zero would panic on the
    ///      division below; negative would wrap the cast to ~2**256 and floor
    ///      every quote to zero, handing out free names. Both fail loudly instead.
    error InvalidPriceFeed(int256 answer);
    error ZeroAddress();
    error RungLengthOutOfRange(uint256 maxLength);
    error RungLengthsNotAscending(uint256 index);
    error RungPricesNotDescending(uint256 index);
    error BasePriceExceedsLowestRung(uint256 basePrice, uint256 lowestRungPrice);

    constructor(
        AggregatorInterface _usdOracle,
        uint256 _basePriceUSDPerYear,
        Rung[] memory _rungs,
        uint256 _startPremium,
        uint256 _totalDays
    ) {
        _setUsdOracle(_usdOracle);
        _setPrices(_basePriceUSDPerYear, _rungs);
        _setPremium(_startPremium, _totalDays);
    }

    /// @notice Replace the whole curve: the base price and the rung list, in one
    ///         call. Split setters would be unusable, because raising the base
    ///         above the current lowest rung is only reachable if both move
    ///         together.
    /// @param newBasePriceUSDPerYear attoUSD per year for lengths above the
    ///        tallest rung.
    /// @param rungs Ascending by `maxLength`, non-increasing in price, each
    ///        `maxLength` in 1..`MAX_RUNG_LENGTH`. May be empty.
    function setPrices(
        uint256 newBasePriceUSDPerYear,
        Rung[] calldata rungs
    ) external onlyOwner {
        _setPrices(newBasePriceUSDPerYear, rungs);
    }

    /// @notice Point the oracle at a different ETH/USD feed. `StablePriceOracle`
    ///         holds this `immutable`, which is why a retired feed forces a
    ///         redeploy there.
    function setUsdOracle(AggregatorInterface newOracle) external onlyOwner {
        _setUsdOracle(newOracle);
    }

    /// @notice Retune the Dutch auction. `newTotalDays == 0` makes `endValue`
    ///         equal `startPremium`, which yields a zero premium at every elapsed
    ///         time: that is how the auction is switched off.
    function setPremium(
        uint256 newStartPremium,
        uint256 newTotalDays
    ) external onlyOwner {
        _setPremium(newStartPremium, newTotalDays);
    }

    function price(
        string calldata name,
        uint256 expires,
        uint256 duration
    ) external view override returns (IPriceOracle.Price memory) {
        IPriceOracle.Price memory usd = _priceUSD(name, expires, duration);
        uint256 ethPrice = _ethPrice();
        return
            IPriceOracle.Price({
                base: (usd.base * 1e8) / ethPrice,
                premium: (usd.premium * 1e8) / ethPrice
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

    /// @dev Returns the premium price at current time elapsed
    /// @param _startPremium starting price
    /// @param elapsed time past since expiry
    function decayedPremium(
        uint256 _startPremium,
        uint256 elapsed
    ) public pure returns (uint256) {
        uint256 daysPast = (elapsed * PRECISION) / 1 days;
        uint256 intDays = daysPast / PRECISION;
        uint256 premium = _startPremium >> intDays;
        uint256 partDay = (daysPast - intDays * PRECISION);
        uint256 fraction = (partDay * (2 ** 16)) / PRECISION;
        uint256 totalPremium = addFractionalPremium(fraction, premium);
        return totalPremium;
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
        Rung[] memory rungs
    ) internal {
        uint256 previousLength;
        uint256 previousPrice = type(uint256).max;

        for (uint256 i; i < rungs.length; ++i) {
            Rung memory rung = rungs[i];
            if (rung.maxLength == 0 || rung.maxLength > MAX_RUNG_LENGTH)
                revert RungLengthOutOfRange(rung.maxLength);
            if (rung.maxLength <= previousLength)
                revert RungLengthsNotAscending(i);
            if (rung.priceUSDPerYear > previousPrice)
                revert RungPricesNotDescending(i);

            for (
                uint256 len = previousLength + 1;
                len <= rung.maxLength;
                ++len
            ) {
                priceUSDPerYearByLength[len] = rung.priceUSDPerYear;
            }
            previousLength = rung.maxLength;
            previousPrice = rung.priceUSDPerYear;
        }

        if (rungs.length != 0 && newBasePriceUSDPerYear > previousPrice)
            revert BasePriceExceedsLowestRung(
                newBasePriceUSDPerYear,
                previousPrice
            );

        basePriceUSDPerYear = newBasePriceUSDPerYear;
        // Entries above the new `topRung` are left as they are. The lookup gates
        // on `topRung`, so they are unreadable, and the next `setPrices`
        // overwrites 1..`topRung` unconditionally. Clearing them would cost gas
        // and buy nothing.
        topRung = previousLength;

        emit PricesChanged(newBasePriceUSDPerYear, rungs);
    }

    function _setUsdOracle(AggregatorInterface newOracle) internal {
        if (address(newOracle) == address(0)) revert ZeroAddress();
        int256 answer = newOracle.latestAnswer();
        if (answer <= 0) revert InvalidPriceFeed(answer);
        usdOracle = newOracle;
        emit UsdOracleChanged(address(newOracle));
    }

    function _setPremium(
        uint256 newStartPremium,
        uint256 newTotalDays
    ) internal {
        startPremium = newStartPremium;
        endValue = newStartPremium >> newTotalDays;
        totalDays = newTotalDays;
        emit PremiumChanged(newStartPremium, newTotalDays);
    }

    function _priceUSD(
        string calldata name,
        uint256 expires,
        uint256 duration
    ) internal view returns (IPriceOracle.Price memory) {
        uint256 len = name.strlen();
        // The empty label is unregistrable (`valid()` requires
        // `strlen >= minCharLength`, and `minCharLength` is never zero), but
        // `rentPrice("")` is a public view the app can reach and index 0 of the
        // map is never written. Quote it as the shortest name rather than free.
        if (len == 0) len = 1;

        uint256 perYear = len > topRung
            ? basePriceUSDPerYear
            : priceUSDPerYearByLength[len];

        return
            IPriceOracle.Price({
                base: (perYear * duration) / SECONDS_PER_YEAR,
                premium: _premium(expires)
            });
    }

    /// @dev Returns the pricing premium in attoUSD. Reads no storage while the
    ///      name is inside its grace period, which is every registration of a
    ///      name that has not lapsed.
    function _premium(uint256 expires) internal view returns (uint256) {
        uint256 auctionStart = expires + GRACE_PERIOD;
        if (auctionStart > block.timestamp) {
            return 0;
        }
        uint256 decayed = decayedPremium(
            startPremium,
            block.timestamp - auctionStart
        );
        uint256 floor = endValue;
        if (decayed >= floor) {
            return decayed - floor;
        }
        return 0;
    }

    function _ethPrice() internal view returns (uint256) {
        int256 answer = usdOracle.latestAnswer();
        if (answer <= 0) revert InvalidPriceFeed(answer);
        return uint256(answer);
    }

    uint256 constant PRECISION = 1e18;
    uint256 constant bit1 = 999989423469314432; // 0.5 ^ 1/65536 * (10 ** 18)
    uint256 constant bit2 = 999978847050491904; // 0.5 ^ 2/65536 * (10 ** 18)
    uint256 constant bit3 = 999957694548431104;
    uint256 constant bit4 = 999915390886613504;
    uint256 constant bit5 = 999830788931929088;
    uint256 constant bit6 = 999661606496243712;
    uint256 constant bit7 = 999323327502650752;
    uint256 constant bit8 = 998647112890970240;
    uint256 constant bit9 = 997296056085470080;
    uint256 constant bit10 = 994599423483633152;
    uint256 constant bit11 = 989228013193975424;
    uint256 constant bit12 = 978572062087700096;
    uint256 constant bit13 = 957603280698573696;
    uint256 constant bit14 = 917004043204671232;
    uint256 constant bit15 = 840896415253714560;
    uint256 constant bit16 = 707106781186547584;

    function addFractionalPremium(
        uint256 fraction,
        uint256 premium
    ) internal pure returns (uint256) {
        if (fraction & (1 << 0) != 0) {
            premium = (premium * bit1) / PRECISION;
        }
        if (fraction & (1 << 1) != 0) {
            premium = (premium * bit2) / PRECISION;
        }
        if (fraction & (1 << 2) != 0) {
            premium = (premium * bit3) / PRECISION;
        }
        if (fraction & (1 << 3) != 0) {
            premium = (premium * bit4) / PRECISION;
        }
        if (fraction & (1 << 4) != 0) {
            premium = (premium * bit5) / PRECISION;
        }
        if (fraction & (1 << 5) != 0) {
            premium = (premium * bit6) / PRECISION;
        }
        if (fraction & (1 << 6) != 0) {
            premium = (premium * bit7) / PRECISION;
        }
        if (fraction & (1 << 7) != 0) {
            premium = (premium * bit8) / PRECISION;
        }
        if (fraction & (1 << 8) != 0) {
            premium = (premium * bit9) / PRECISION;
        }
        if (fraction & (1 << 9) != 0) {
            premium = (premium * bit10) / PRECISION;
        }
        if (fraction & (1 << 10) != 0) {
            premium = (premium * bit11) / PRECISION;
        }
        if (fraction & (1 << 11) != 0) {
            premium = (premium * bit12) / PRECISION;
        }
        if (fraction & (1 << 12) != 0) {
            premium = (premium * bit13) / PRECISION;
        }
        if (fraction & (1 << 13) != 0) {
            premium = (premium * bit14) / PRECISION;
        }
        if (fraction & (1 << 14) != 0) {
            premium = (premium * bit15) / PRECISION;
        }
        if (fraction & (1 << 15) != 0) {
            premium = (premium * bit16) / PRECISION;
        }
        return premium;
    }
}
