pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SocialBondFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60;
    bool public paused;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Bond {
        euint32 encryptedAmount;
        euint32 encryptedMaturity;
    }
    mapping(uint256 => Bond) public bonds; // bondId => Bond
    uint256 public totalBonds;

    struct Batch {
        uint256 totalEncryptedAmount;
        uint256 bondCount;
        bool finalized;
    }
    mapping(uint256 => Batch) public batches;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event BondSubmitted(address indexed provider, uint256 indexed bondId, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalAmount, uint256 bondCount);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchNotOpen();
    error BatchAlreadyOpen();
    error InvalidBatch();
    error InvalidCooldown();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert BatchAlreadyOpen();
        currentBatchId++;
        batchOpen = true;
        batches[currentBatchId].totalEncryptedAmount = 0; // Initialize
        batches[currentBatchId].bondCount = 0;
        batches[currentBatchId].finalized = false;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        batches[currentBatchId].finalized = true;
        emit BatchClosed(currentBatchId);
    }

    function submitBond(
        euint32 encryptedAmount,
        euint32 encryptedMaturity
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        _initIfNeeded(encryptedAmount);
        _initIfNeeded(encryptedMaturity);

        totalBonds++;
        uint256 bondId = totalBonds;
        bonds[bondId] = Bond(encryptedAmount, encryptedMaturity);

        batches[currentBatchId].totalEncryptedAmount = FHE.add(
            batches[currentBatchId].totalEncryptedAmount,
            encryptedAmount
        );
        batches[currentBatchId].bondCount++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit BondSubmitted(msg.sender, bondId, currentBatchId);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused checkDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].finalized) {
            revert InvalidBatch();
        }

        euint32 encryptedTotalAmount = batches[batchId].totalEncryptedAmount;
        euint32 encryptedBondCount = FHE.asEuint32(batches[batchId].bondCount);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(encryptedTotalAmount);
        cts[1] = FHE.toBytes32(encryptedBondCount);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }
        // Security: Replay protection ensures a decryption request is processed only once.

        uint256 batchId = decryptionContexts[requestId].batchId;
        euint32 encryptedTotalAmount = batches[batchId].totalEncryptedAmount;
        euint32 encryptedBondCount = FHE.asEuint32(batches[batchId].bondCount);

        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = FHE.toBytes32(encryptedTotalAmount);
        currentCts[1] = FHE.toBytes32(encryptedBondCount);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        // Security: State hash verification ensures the contract state relevant to the decryption
        // (i.e., the ciphertexts) has not changed since the decryption was requested.
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // Security: Proof verification ensures the cleartexts are authentic and correctly decrypted
        // by the FHEVM network.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        (uint32 totalAmount, uint32 bondCount) = abi.decode(cleartexts, (uint32, uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalAmount, bondCount);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!FHE.isInitialized(val)) {
            FHE.asEuint32(0); // Initialize if not already
        }
    }

    function _initIfNeeded(ebool val) internal {
        if (!FHE.isInitialized(val)) {
            FHE.asEbool(false); // Initialize if not already
        }
    }
}