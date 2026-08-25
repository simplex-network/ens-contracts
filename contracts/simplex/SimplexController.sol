//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {BaseRegistrarImplementation} from "../ethregistrar/BaseRegistrarImplementation.sol";
import {StringUtils} from "../utils/StringUtils.sol";
import {Resolver} from "../resolvers/Resolver.sol";
import {ENS} from "../registry/ENS.sol";
import {IReverseRegistrar} from "../reverseRegistrar/IReverseRegistrar.sol";
import {IDefaultReverseRegistrar} from "../reverseRegistrar/IDefaultReverseRegistrar.sol";
import {IETHRegistrarController, IPriceOracle} from "../ethregistrar/IETHRegistrarController.sol";
import {IPriceOracleUSD} from "../ethregistrar/IPriceOracleUSD.sol";

/// @dev The subset of SimplexResolver the controller calls. Declared here so the
///      controller does not import the resolver and pull in PublicResolver.
interface IEditCredits {
    function grantEditCredits(bytes32 node, uint256 amount) external;
}

/// @dev Fork of ETHRegistrarController with additional access controls:
///      - Minimum name length gate (admin can lower monotonically)
///      - Reserved names (admin-managed blocklist)
///      - NFT gate (optional, for .testing TLD)
///
///      Deployed behind an ERC1967 proxy (UUPS). The implementation has
///      its initializers disabled in the constructor; storage lives in
///      the proxy and is preserved across upgrades.
contract SimplexController is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    IETHRegistrarController,
    ERC165
{
    using StringUtils for *;

    uint8 constant REVERSE_RECORD_ETHEREUM_BIT = 1;
    uint8 constant REVERSE_RECORD_DEFAULT_BIT = 2;
    uint256 public constant MIN_REGISTRATION_DURATION = 28 days;
    /// @dev Relayed record writes granted per year of registration or renewal.
    uint256 public constant EDIT_CREDITS_PER_YEAR = 10;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint64 private constant MAX_EXPIRY = type(uint64).max;

    // Manual reentrancy guard (see `_reentrancyStatus` + `nonReentrant`).
    // Implemented by hand rather than inheriting ReentrancyGuardUpgradeable so
    // the guard's state appends to the reserved `__gap` instead of inserting a
    // new base contract's storage ahead of existing variables — see
    // docs/upgrades.md (this contract is already deployed behind a UUPS proxy).
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // Was immutable in the non-upgradeable version. Converted to plain
    // storage so values survive a UUPS upgrade rather than being baked
    // into each implementation's bytecode.
    ENS public ens;
    BaseRegistrarImplementation base;
    uint256 public minCommitmentAge;
    uint256 public maxCommitmentAge;
    IReverseRegistrar public reverseRegistrar;
    IDefaultReverseRegistrar public defaultReverseRegistrar;
    IPriceOracleUSD public prices;
    bytes32 public tldNode;
    string public tldSuffix;

    mapping(bytes32 => uint256) public commitments;

    // --- Simplex additions ---
    uint8 public minCharLength;
    mapping(bytes32 => bool) public reservedNames;
    IERC721 public smpxNft;
    bool public nftGateEnabled;
    // Was `priceOracleFrozen`. `freezePriceOracle` is gone: the Chainlink feed is
    // immutable inside the oracle, so a frozen oracle whose feed is retired would
    // break registration and renewal permanently. The slot is kept so the layout
    // does not shift.
    bool private _unusedPriceOracleFrozen;

    error CommitmentNotFound(bytes32 commitment);
    error CommitmentTooNew(bytes32 commitment, uint256 minimumCommitmentTimestamp, uint256 currentTimestamp);
    error CommitmentTooOld(bytes32 commitment, uint256 maximumCommitmentTimestamp, uint256 currentTimestamp);
    error NameNotAvailable(string name);
    error DurationTooShort(uint256 duration);
    error ResolverRequiredWhenDataSupplied();
    error ResolverRequiredForReverseRecord();
    error UnexpiredCommitmentExists(bytes32 commitment);
    error InsufficientValue();
    error TransferFailed();
    error NameNotReserved(string name);
    struct SimplexConfig {
        bytes32 tldNode;
        string tldSuffix;
        uint8 minCharLength;
        IERC721 smpxNft;
        bool nftGateEnabled;
    }

    error MaxCommitmentAgeTooLow();
    error MaxCommitmentAgeTooHigh();
    error NameTooShort(string name, uint8 minLength);
    error NameReserved(string name);
    error NftRequired();
    error MinCharLengthCanOnlyDecrease();
    error NftGateCanOnlyBeDisabled();
    error ZeroAddress();
    error NotBeneficiary();
    error NotOwnerOrBeneficiary();
    error BeneficiaryAlreadySet();
    error InsufficientAllowance(uint256 required, uint256 available);
    error AlreadyFrozen();
    error Frozen();
    error PublicSalesClosed();
    error NoDefaultResolver();

    event NameRegistered(
        string label,
        bytes32 indexed labelhash,
        address indexed owner,
        uint256 baseCost,
        uint256 premium,
        uint256 expires,
        bytes32 referrer
    );

    event NameRenewed(
        string label,
        bytes32 indexed labelhash,
        uint256 cost,
        uint256 expires,
        bytes32 referrer
    );

    event MinCharLengthChanged(uint8 newMinCharLength);
    event ReservedNameAdded(string name);
    event ReservedNameRemoved(string name);
    event NftGateDisabled();
    event PriceOracleChanged(IPriceOracleUSD indexed newOracle);
    event BeneficiaryChanged(address indexed beneficiary);
    event RegistrarAllowanceSet(address indexed registrar, uint256 allowanceUSD);
    event RegistrarAllowanceSpent(
        address indexed registrar,
        uint256 spentUSD,
        uint256 remainingUSD
    );
    event EditCreditPriceChanged(uint256 priceUSD);
    event DefaultResolverChanged(address indexed resolver);
    event PublicSalesOpenChanged(bool open);
    event ContractFrozen();
    event EditCreditsToppedUp(bytes32 indexed node, uint256 amount);

    error ReentrantCall();

    /// @dev Manual `nonReentrant`. A freshly-zero `_reentrancyStatus` (the case
    ///      for the already-deployed instance, whose `initialize` does not
    ///      re-run on upgrade) reads as not-entered, so the guard is correct
    ///      without a reinitializer; `initialize` seeds it to `_NOT_ENTERED`
    ///      for fresh deploys to get the cheaper steady-state cost.
    /// @dev The guardian key. Permanent once set: the owner cannot take it back.
    modifier onlyBeneficiary() {
        if (msg.sender != beneficiary) revert NotBeneficiary();
        _;
    }

    /// @dev Restrictive actions are held by the owner and the guardian both, so
    ///      they can be taken immediately rather than waiting on the owner's
    ///      timelock. See docs/plans/names-v2-launch-to-freeze-plan.md.
    modifier onlyOwnerOrBeneficiary() {
        if (msg.sender != owner() && msg.sender != beneficiary)
            revert NotOwnerOrBeneficiary();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert ReentrantCall();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        BaseRegistrarImplementation _base,
        IPriceOracleUSD _prices,
        uint256 _minCommitmentAge,
        uint256 _maxCommitmentAge,
        IReverseRegistrar _reverseRegistrar,
        IDefaultReverseRegistrar _defaultReverseRegistrar,
        ENS _ens,
        SimplexConfig memory _config,
        address _owner
    ) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _reentrancyStatus = _NOT_ENTERED;

        if (_maxCommitmentAge <= _minCommitmentAge) revert MaxCommitmentAgeTooLow();
        // Sanity cap on how long a commitment may sit before it expires.
        // The previous form compared duration to block.timestamp (~1.7e9),
        // which never triggered for any plausible deploy value.
        if (_maxCommitmentAge > 30 days) revert MaxCommitmentAgeTooHigh();

        ens = _ens;
        base = _base;
        prices = _prices;
        minCommitmentAge = _minCommitmentAge;
        maxCommitmentAge = _maxCommitmentAge;
        reverseRegistrar = _reverseRegistrar;
        defaultReverseRegistrar = _defaultReverseRegistrar;
        tldNode = _config.tldNode;
        tldSuffix = _config.tldSuffix;
        minCharLength = _config.minCharLength;
        smpxNft = _config.smpxNft;
        nftGateEnabled = _config.nftGateEnabled;

        if (_owner != msg.sender) {
            _transferOwnership(_owner);
        }
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {
        if (frozen) revert Frozen();
    }

    /// @notice Recover ERC20 tokens sent to this contract by mistake.
    function recoverFunds(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        IERC20(_token).transfer(_to, _amount);
    }

    // --- names v2: governance ---

    /// @notice Set the guardian key. Callable by the owner while unset, and by the
    ///         beneficiary itself afterwards, so the owner cannot take it back.
    function setBeneficiary(address newBeneficiary) external {
        if (newBeneficiary == address(0)) revert ZeroAddress();
        if (beneficiary == address(0)) {
            if (msg.sender != owner()) revert NotBeneficiary();
        } else if (msg.sender != beneficiary) {
            revert NotBeneficiary();
        }
        beneficiary = newBeneficiary;
        emit BeneficiaryChanged(newBeneficiary);
    }

    /// @notice Replace a registrar's spending limit, in attoUSD. Set, not add:
    ///         zeroing it is the kill switch for a compromised registrar and must
    ///         take one transaction.
    function setRegistrarAllowance(
        address registrar,
        uint256 allowanceUSD
    ) external onlyBeneficiary {
        registrarAllowance[registrar] = allowanceUSD;
        emit RegistrarAllowanceSet(registrar, allowanceUSD);
    }

    /// @notice Price of one edit credit against a registrar's allowance, attoUSD.
    function setEditCreditPrice(uint256 priceUSD) external onlyOwner {
        editCreditPriceUSD = priceUSD;
        emit EditCreditPriceChanged(priceUSD);
    }

    /// @notice The resolver new registrations point at. Only registrations against
    ///         this resolver are granted edit credits.
    function setDefaultResolver(address resolver) external onlyOwner {
        defaultResolver = resolver;
        emit DefaultResolverChanged(resolver);
    }

    /// @notice Open or close the payable registration path. Two-way until `freeze`,
    ///         so it is also the pause switch. Held by the guardian as well as the
    ///         owner because an exploit in the payable path accrues harm per block.
    function setPublicSalesOpen(bool open) external onlyOwnerOrBeneficiary {
        if (frozen) revert Frozen();
        publicSalesOpen = open;
        emit PublicSalesOpenChanged(open);
    }

    /// @notice One-way. Makes the implementation permanent and locks the sales
    ///         switch in its current position. Everything else the owner can do
    ///         survives, including `setPriceOracle` and the reserved-name setters.
    function freeze() external onlyOwner {
        if (frozen) revert AlreadyFrozen();
        frozen = true;
        emit ContractFrozen();
    }

    // --- Simplex admin functions ---

    function setMinCharLength(uint8 newMinCharLength) external onlyOwner {
        if (newMinCharLength >= minCharLength) revert MinCharLengthCanOnlyDecrease();
        minCharLength = newMinCharLength;
        emit MinCharLengthChanged(newMinCharLength);
    }

    /// @notice Reserve any number of names in a single transaction. Pass a
    ///         single-element array to reserve one. Each addition emits a
    ///         `ReservedNameAdded` event so indexers see them individually.
    function addReservedNames(
        string[] calldata names
    ) external onlyOwnerOrBeneficiary {
        for (uint256 i = 0; i < names.length; ++i) {
            reservedNames[keccak256(bytes(names[i]))] = true;
            emit ReservedNameAdded(names[i]);
        }
    }

    /// @notice Symmetric bulk-remove. Pass a single-element array to remove
    ///         one. Each removal emits a `ReservedNameRemoved` event.
    function removeReservedNames(string[] calldata names) external onlyOwner {
        for (uint256 i = 0; i < names.length; ++i) {
            delete reservedNames[keccak256(bytes(names[i]))];
            emit ReservedNameRemoved(names[i]);
        }
    }

    /// @notice Hand a reserved name to its brand. Sets the default resolver on
    ///         the node and grants edit credits, so the name resolves immediately
    ///         and the brand's later record edits can be relayed — a brand never
    ///         has to hold ETH. `setSubnodeOwner` alone sets an owner but not a
    ///         resolver, so without this the name would not resolve at all.
    function registerReserved(
        string calldata label,
        address owner,
        uint256 duration
    ) external onlyOwner {
        bytes32 labelhash = keccak256(bytes(label));
        if (!reservedNames[labelhash]) revert NameNotReserved(label);
        if (duration < MIN_REGISTRATION_DURATION) revert DurationTooShort(duration);

        address resolver = defaultResolver;
        if (resolver == address(0)) {
            base.registerWithLabel(label, owner, duration);
            return;
        }

        base.registerWithLabel(label, address(this), duration);
        bytes32 namehash = keccak256(abi.encodePacked(tldNode, labelhash));
        ens.setRecord(namehash, owner, resolver, 0);
        base.transferFrom(address(this), owner, uint256(labelhash));
        _grantEditCredits(namehash, resolver, duration);
    }

    function disableNftGate() external onlyOwner {
        if (!nftGateEnabled) revert NftGateCanOnlyBeDisabled();
        nftGateEnabled = false;
        emit NftGateDisabled();
    }

    /// @notice Swap the active price oracle. Survives `freeze`, and must: the
    ///         Chainlink feed is immutable inside the oracle, so a retired feed
    ///         would otherwise end registration and renewal permanently.
    function setPriceOracle(IPriceOracleUSD newOracle) external onlyOwner {
        if (address(newOracle) == address(0)) revert ZeroAddress();
        prices = newOracle;
        emit PriceOracleChanged(newOracle);
    }

    // --- ENS controller functions (unchanged logic, added gates) ---

    function rentPrice(
        string calldata label,
        uint256 duration
    ) public view override returns (IPriceOracle.Price memory price) {
        bytes32 labelhash = keccak256(bytes(label));
        price = _rentPrice(label, labelhash, duration);
    }

    function valid(string calldata label) public view returns (bool) {
        return label.strlen() >= minCharLength;
    }

    function available(
        string calldata label
    ) public view override returns (bool) {
        bytes32 labelhash = keccak256(bytes(label));
        return _available(label, labelhash);
    }

    function makeCommitment(
        Registration calldata registration
    ) public pure override returns (bytes32 commitment) {
        if (registration.data.length > 0 && registration.resolver == address(0))
            revert ResolverRequiredWhenDataSupplied();

        if (registration.reverseRecord != 0 && registration.resolver == address(0))
            revert ResolverRequiredForReverseRecord();

        if (registration.duration < MIN_REGISTRATION_DURATION)
            revert DurationTooShort(registration.duration);

        return keccak256(abi.encode(registration));
    }

    function commit(bytes32 commitment) public override nonReentrant {
        if (commitments[commitment] + maxCommitmentAge >= block.timestamp) {
            revert UnexpiredCommitmentExists(commitment);
        }
        commitments[commitment] = block.timestamp;
    }

    /// @param checkNft Skipped on the credited path, where `msg.sender` is the
    ///        registrar rather than the buyer.
    function _checkSimplexGates(
        string calldata label,
        bool checkNft
    ) internal view {
        if (label.strlen() < minCharLength)
            revert NameTooShort(label, minCharLength);
        if (reservedNames[keccak256(bytes(label))])
            revert NameReserved(label);
        if (checkNft && nftGateEnabled && smpxNft.balanceOf(msg.sender) == 0)
            revert NftRequired();
    }

    /// @dev Deduct `amountUSD` from the caller's spending limit. The beneficiary
    ///      can zero that limit in one transaction, which is the kill switch for a
    ///      compromised registrar.
    function _spendAllowance(uint256 amountUSD) private {
        uint256 available = registrarAllowance[msg.sender];
        if (amountUSD > available)
            revert InsufficientAllowance(amountUSD, available);
        uint256 remaining;
        unchecked {
            remaining = available - amountUSD;
        }
        registrarAllowance[msg.sender] = remaining;
        emit RegistrarAllowanceSpent(msg.sender, amountUSD, remaining);
    }

    /// @dev The list price of `label` for `duration`, in attoUSD.
    function _rentPriceUSD(
        string calldata label,
        bytes32 labelhash,
        uint256 duration
    ) private view returns (uint256) {
        IPriceOracle.Price memory p = prices.priceUSD(
            label,
            base.nameExpires(uint256(labelhash)),
            duration
        );
        return p.base + p.premium;
    }

    /// @dev Grant relayed-write allowance for `node`, but only when the name
    ///      actually uses the default resolver — credits live in the resolver, so
    ///      granting them anywhere else would be a no-op the user could not spend.
    function _grantEditCredits(
        bytes32 node,
        address resolverInUse,
        uint256 duration
    ) private {
        address target = defaultResolver;
        if (target == address(0) || resolverInUse != target) return;
        uint256 yearsBought = duration / SECONDS_PER_YEAR;
        if (yearsBought == 0) yearsBought = 1;
        IEditCredits(target).grantEditCredits(
            node,
            EDIT_CREDITS_PER_YEAR * yearsBought
        );
    }

    /// @notice Buy relayed-write allowance for an existing name. Spends one
    ///         registrar credit, so the same allowance and the same kill switch
    ///         cover it.
    function topUpEditCredits(
        bytes32 node,
        uint256 amount
    ) external nonReentrant {
        _spendAllowance(amount * editCreditPriceUSD);
        address target = defaultResolver;
        if (target == address(0)) revert NoDefaultResolver();
        IEditCredits(target).grantEditCredits(node, amount);
        emit EditCreditsToppedUp(node, amount);
    }

    /// @notice Register and pay. Gated by the public sales switch; the credited
    ///         and reserved paths are not.
    function register(
        Registration calldata registration
    ) public payable override nonReentrant {
        if (!publicSalesOpen) revert PublicSalesClosed();
        _checkSimplexGates(registration.label, true);

        bytes32 labelhash = keccak256(bytes(registration.label));
        IPriceOracle.Price memory price = _rentPrice(
            registration.label,
            labelhash,
            registration.duration
        );
        uint256 totalPrice = price.base + price.premium;
        if (msg.value < totalPrice) revert InsufficientValue();

        _registerCore(registration, labelhash, price);

        if (msg.value > totalPrice) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - totalPrice}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Register with no value attached, spending one registrar credit.
    ///         The fee would have gone to the controller and been withdrawn back
    ///         to the same treasury, so it is removed rather than performed.
    function registerWithCredit(
        Registration calldata registration
    ) external nonReentrant {
        _checkSimplexGates(registration.label, false);

        bytes32 labelhash = keccak256(bytes(registration.label));
        _spendAllowance(
            _rentPriceUSD(registration.label, labelhash, registration.duration)
        );
        IPriceOracle.Price memory price = _rentPrice(
            registration.label,
            labelhash,
            registration.duration
        );

        _registerCore(registration, labelhash, price);
    }

    /// @dev Everything both registration paths share: availability, the
    ///      commit/reveal window, the mint, records, and the edit-credit grant.
    function _registerCore(
        Registration calldata registration,
        bytes32 labelhash,
        IPriceOracle.Price memory price
    ) private returns (uint256 expires) {
        if (!_available(registration.label, labelhash))
            revert NameNotAvailable(registration.label);

        bytes32 commitment = makeCommitment(registration);
        uint256 commitmentTimestamp = commitments[commitment];

        if (commitmentTimestamp + minCommitmentAge > block.timestamp)
            revert CommitmentTooNew(
                commitment,
                commitmentTimestamp + minCommitmentAge,
                block.timestamp
            );

        if (commitmentTimestamp + maxCommitmentAge <= block.timestamp) {
            if (commitmentTimestamp == 0) revert CommitmentNotFound(commitment);
            revert CommitmentTooOld(
                commitment,
                commitmentTimestamp + maxCommitmentAge,
                block.timestamp
            );
        }

        delete (commitments[commitment]);

        bytes32 namehash = keccak256(abi.encodePacked(tldNode, labelhash));

        if (registration.resolver == address(0)) {
            expires = base.registerWithLabel(
                registration.label,
                registration.owner,
                registration.duration
            );
        } else {
            expires = base.registerWithLabel(
                registration.label,
                address(this),
                registration.duration
            );

            ens.setRecord(
                namehash,
                registration.owner,
                registration.resolver,
                0
            );
            if (registration.data.length > 0)
                Resolver(registration.resolver).multicallWithNodeCheck(
                    namehash,
                    registration.data
                );

            base.transferFrom(
                address(this),
                registration.owner,
                uint256(labelhash)
            );

            if (registration.reverseRecord & REVERSE_RECORD_ETHEREUM_BIT != 0)
                reverseRegistrar.setNameForAddr(
                    msg.sender,
                    msg.sender,
                    registration.resolver,
                    string.concat(registration.label, tldSuffix)
                );
            if (registration.reverseRecord & REVERSE_RECORD_DEFAULT_BIT != 0)
                defaultReverseRegistrar.setNameForAddr(
                    msg.sender,
                    string.concat(registration.label, tldSuffix)
                );
        }

        _grantEditCredits(
            namehash,
            registration.resolver,
            registration.duration
        );

        emit NameRegistered(
            registration.label,
            labelhash,
            registration.owner,
            price.base,
            price.premium,
            expires,
            registration.referrer
        );
    }

    function renew(
        string calldata label,
        uint256 duration,
        bytes32 referrer
    ) external payable override nonReentrant {
        bytes32 labelhash = keccak256(bytes(label));

        IPriceOracle.Price memory price = _rentPrice(label, labelhash, duration);
        if (msg.value < price.base) revert InsufficientValue();

        _renewCore(label, labelhash, duration, price.base, referrer);

        if (msg.value > price.base) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - price.base}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Renew with no value attached, spending one registrar credit.
    function renewWithCredit(
        string calldata label,
        uint256 duration,
        bytes32 referrer
    ) external nonReentrant {
        bytes32 labelhash = keccak256(bytes(label));
        uint256 costUSD = _rentPriceUSD(label, labelhash, duration);
        _spendAllowance(costUSD);
        IPriceOracle.Price memory price = _rentPrice(label, labelhash, duration);
        _renewCore(label, labelhash, duration, price.base, referrer);
    }

    function _renewCore(
        string calldata label,
        bytes32 labelhash,
        uint256 duration,
        uint256 cost,
        bytes32 referrer
    ) private returns (uint256 expires) {
        expires = base.renew(uint256(labelhash), duration);

        bytes32 namehash = keccak256(abi.encodePacked(tldNode, labelhash));
        _grantEditCredits(namehash, ens.resolver(namehash), duration);

        emit NameRenewed(label, labelhash, cost, expires, referrer);
    }

    /// @notice Pays the beneficiary, never `owner()`, so revenue is independent of
    ///         the admin key. Permissionless to call.
    function withdraw() public nonReentrant {
        address payee = beneficiary;
        if (payee == address(0)) revert ZeroAddress();
        (bool ok, ) = payable(payee).call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view override returns (bool) {
        return
            interfaceID == type(IETHRegistrarController).interfaceId ||
            super.supportsInterface(interfaceID);
    }

    /* Internal functions */

    function _rentPrice(
        string calldata label,
        bytes32 labelhash,
        uint256 duration
    ) internal view returns (IPriceOracle.Price memory price) {
        price = prices.price(
            label,
            base.nameExpires(uint256(labelhash)),
            duration
        );
    }

    function _available(
        string calldata label,
        bytes32 labelhash
    ) internal view returns (bool) {
        return valid(label) && base.available(uint256(labelhash));
    }

    /// @dev Reserved storage to allow new state variables in upgrades
    ///      without colliding with child contracts. Use indices from the
    ///      front of the array; the size shrinks as state variables are
    ///      added in future versions.
    // Decremented from 50 to 49 when `priceOracleFrozen` was added in the
    // setPriceOracle / freezePriceOracle change. Decrement further whenever
    // new state variables land here.
    // 49 -> 48 when `_reentrancyStatus` was added (reentrancy guard).
    uint256 private _reentrancyStatus;

    // --- names v2: governance and credits. 48 -> 45. ---
    // Slot 1: beneficiary + frozen pack together.
    /// @dev Guardian key: registrar credits, the sales switch, and `withdraw`'s payee.
    address public beneficiary;
    /// @dev One-way. Blocks upgrades and the sales switch; nothing else.
    bool public frozen;
    /// @dev Spending limit per registrar, in attoUSD. A sponsored registration or
    ///      renewal deducts the name's own list price; a top-up deducts
    ///      `editCreditPriceUSD` per credit. Denominated in the unit the price
    ///      list is configured in, so it does not move with the ETH price.
    mapping(address => uint256) public registrarAllowance;
    // Slot 3: defaultResolver + publicSalesOpen pack together.
    /// @dev The resolver new registrations point at, and the only one granted edit credits.
    address public defaultResolver;
    /// @dev Gates the payable path only. Credited and reserved registrations ignore it.
    bool public publicSalesOpen;
    /// @dev What one edit credit costs against a registrar's allowance, attoUSD.
    ///      Zero makes top-ups free, which is a deliberate configuration and not a
    ///      default worth relying on.
    uint256 public editCreditPriceUSD;

    uint256[44] private __gap;
}
