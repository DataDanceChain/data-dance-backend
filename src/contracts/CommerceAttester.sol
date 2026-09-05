// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CommerceAttester
/// @notice Public proof that a DataDance marketplace licence receipt hash exists.
/// Off-chain ledger keeps the JSON (schema datadance.commerce.licence.v1).
/// On-chain data is only the SHA-256 content hash plus this event — no dataset
/// bytes, emails, phones, or contributor wallet ids.
contract CommerceAttester {
    event Attested(bytes32 indexed hash, address indexed sender);

    function attest(bytes32 hash) external {
        emit Attested(hash, msg.sender);
    }
}
