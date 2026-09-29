// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

library PayUnlockTypes {
    enum ProductStatus { Nonexistent, Active, Disabled, Canceled }
    enum State { Nonexistent, Paid, DeliveryReserved, Fulfilled, AwaitingSeller, AwaitingBuyer, InArbitration, Confirmed, PaidOut, Refunded }
    struct Receiving { bytes32 nonce; bytes32 publicKey; }
    struct ProductTerms {
        address token;
        uint256 price;
        bool hasEventEnd;
        uint64 eventEnd;
        bool hasReviewOverride;
        uint64 reviewOverride;
        uint32 commitmentWindow;
    }
    struct Terms {
        address token;
        uint256 price;
        bool hasEventEnd;
        uint64 eventEnd;
        uint64 reviewWindow;
        uint64 responseWindow;
        uint32 commitmentWindow;
    }
    struct Product { ProductStatus status; ProductTerms terms; Receiving receiving; uint256 orderCount; }
    struct Order {
        State state;
        address buyer;
        address seller;
        bytes32 productKey;
        bytes32 requestId;
        Receiving buyerReceiving;
        Receiving sellerReceiving;
        Terms terms;
        bytes32 deliveryHash;
        uint64 publicationDeadline;
        uint64 reviewDeadline;
        uint64 responseDeadline;
        uint256 turn;
    }
    // Deployment, order, sender, turn, kind and profile come from authoritative
    // contract state. Reference envelopes are SDK v3 raw bytes (65 bytes each).
    struct Reference {
        uint32 serviceId;
        uint64 preparedAt;
        bytes32 creator;
        bytes buyerEnvelope;
        bytes sellerEnvelope;
        bytes32 contentHash;
    }
    struct Arbitrator { bool active; bytes32 publicKey; uint64 keyVersion; uint256 fee; }
    struct Assignment {
        address wallet;
        bytes32 publicKey;
        uint64 keyVersion;
        uint64 revision;
        uint256 fee;
        address requester;
        bool handoverRecorded;
    }
    struct Evidence { Reference contentRef; bytes arbitratorEnvelope; }
}
