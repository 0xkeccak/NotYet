// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * PeriodVault — one treasury contract that gates spending by TIME, not by wallets.
 *
 * The owner deposits once and commits a schedule: for each period i it stores the EVM
 * address of a spend key `k_i`, a budget, a [start,end] window, and a per-transaction
 * ceiling. The spend keys are timelock-encrypted (tlock/drand) off-chain, so period i's
 * key does not exist in usable form before its round — the agent literally cannot produce
 * a valid withdraw signature early. The contract enforces the rest:
 *
 *   • window   — a key is useless before start_i AND after end_i (not just "not yet")
 *   • identity — ecrecover of the withdrawal signature must equal the committed k_i
 *   • budget   — spent_i + amt <= budget_i, tracked on-chain and visible on HashScan
 *   • HITL     — any single withdrawal above perTxMax_i additionally requires the owner's
 *                Ledger key (approver) to sign — the explicit-approval boundary
 *
 * No per-period accounts, no key server. The policy is the contract; anyone can read it.
 */
contract PeriodVault {
    struct Period {
        address signer;    // address(k_i) — the timelocked per-period spend key
        uint256 budget;    // total spendable this period (weibar)
        uint256 spent;     // consumed so far (also doubles as the per-period nonce)
        uint64  start;     // unix seconds — window opens
        uint64  end;       // unix seconds — window closes
        uint256 perTxMax;  // single-withdrawal ceiling; above it, approver must co-sign
        bool    exists;
    }

    address public owner;     // deployer; deposits + commits + reclaims after expiry
    address public agent;     // fixed recipient of every withdrawal (kept near-zero at rest)
    address public approver;  // owner's Ledger EVM key — the human-in-the-loop co-signer
    mapping(uint256 => Period) public periods;

    event PeriodCommitted(uint256 indexed i, address signer, uint256 budget, uint64 start, uint64 end, uint256 perTxMax);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(uint256 indexed i, uint256 amt, uint256 spent, bool escalated);
    event Reclaimed(uint256 indexed i, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _agent, address _approver) payable {
        require(_agent != address(0) && _approver != address(0), "zero addr");
        owner = msg.sender;
        agent = _agent;
        approver = _approver;
    }

    /// Commit one period's policy. Callable once per index, owner only.
    function commitPeriod(
        uint256 i,
        address signer,
        uint256 budget,
        uint64 start,
        uint64 end,
        uint256 perTxMax
    ) external onlyOwner {
        require(!periods[i].exists, "exists");
        require(signer != address(0), "zero signer");
        require(end > start, "bad window");
        require(budget > 0, "zero budget");
        periods[i] = Period(signer, budget, 0, start, end, perTxMax, true);
        emit PeriodCommitted(i, signer, budget, start, end, perTxMax);
    }

    /// Fund the vault. Anyone may top it up; `receive` handles bare transfers too.
    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// The message a signer must sign to authorize a withdrawal. Bound to this contract,
    /// this chain, the period, the amount, the current `spent` (nonce), and a role tag —
    /// so a signature cannot be replayed across contracts, chains, periods, amounts,
    /// sequential withdrawals, or between the agent and approver roles.
    function digest(uint256 i, uint256 amt, uint256 spent, string memory tag) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encodePacked(address(this), block.chainid, i, amt, spent, tag));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// Withdraw `amt` for period `i`. Requires the (unlocked) period key's signature; if
    /// `amt` exceeds perTxMax_i, additionally requires the approver (Ledger) signature.
    function withdraw(
        uint256 i,
        uint256 amt,
        uint8 av, bytes32 ar, bytes32 asig,
        uint8 ov, bytes32 or_, bytes32 osig
    ) external {
        Period storage p = periods[i];
        require(p.exists, "no period");
        require(block.timestamp >= p.start && block.timestamp <= p.end, "outside window");
        require(amt > 0 && p.spent + amt <= p.budget, "budget");

        require(ecrecover(digest(i, amt, p.spent, "agent"), av, ar, asig) == p.signer, "bad agent sig");

        bool escalated = amt > p.perTxMax;
        if (escalated) {
            require(ecrecover(digest(i, amt, p.spent, "approve"), ov, or_, osig) == approver, "needs device approval");
        }

        p.spent += amt;
        (bool ok, ) = payable(agent).call{value: amt}("");
        require(ok, "xfer failed");
        emit Withdrawn(i, amt, p.spent, escalated);
    }

    /// Owner reclaims the UNSPENT remainder of a period — but only AFTER its window ends.
    /// This gives the owner their money back without ever letting them pull a live period
    /// forward: before end_i they cannot touch it, exactly like the agent.
    function reclaim(uint256 i) external onlyOwner {
        Period storage p = periods[i];
        require(p.exists, "no period");
        require(block.timestamp > p.end, "not expired");
        uint256 remaining = p.budget - p.spent;
        require(remaining > 0, "nothing left");
        p.spent = p.budget; // consume so it cannot be reclaimed twice
        (bool ok, ) = payable(owner).call{value: remaining}("");
        require(ok, "reclaim failed");
        emit Reclaimed(i, remaining);
    }
}
