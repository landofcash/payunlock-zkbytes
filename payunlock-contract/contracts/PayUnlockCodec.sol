// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {PayUnlockTypes as T} from "./PayUnlockTypes.sol";

/// @dev Exact canonical JSON counterpart of the Phase 2 client protocol.
library PayUnlockCodec {
    using Strings for uint256;
    uint256 internal constant RETENTION = 365 days;
    string internal constant PROFILE = "zkbytes-wallet-eip191-hkdfsha256-ed25519-x25519-hpke-v1";
    error InvalidReference();

    function addr(address value) internal pure returns (string memory) { return Strings.toHexString(uint160(value), 20); }
    function hex32(bytes32 value) internal pure returns (string memory) { return Strings.toHexString(uint256(value), 32); }
    function b64(bytes32 value) internal pure returns (string memory) { return Base64.encode(abi.encodePacked(value)); }
    function quoted(uint256 value) internal pure returns (string memory) { return string.concat('"', value.toString(), '"'); }

    function recipient(address account, T.Receiving memory identity) internal view returns (string memory) {
        return string.concat('{"context":{"account":"', addr(account), '","deployment":', deployment(),
            ',"nonce":"', hex32(identity.nonce), '","version":1},"publicKey":"', b64(identity.publicKey), '"}');
    }
    function deployment() internal view returns (string memory) {
        return string.concat('{"chainId":', block.chainid.toString(), ',"contract":"', addr(address(this)), '"}');
    }
    function orderJSON(uint256 id, T.Order memory o) internal view returns (string memory) {
        string memory terms = string.concat('{"eventEnd":', o.terms.hasEventEnd ? quoted(o.terms.eventEnd) : 'null',
            ',"price":', quoted(o.terms.price), ',"responseWindow":', quoted(o.terms.responseWindow),
            ',"reviewWindow":', quoted(o.terms.reviewWindow), ',"token":"', addr(o.terms.token), '","version":1}');
        return string.concat('{"buyer":', recipient(o.buyer, o.buyerReceiving), ',"deployment":', deployment(),
            ',"orderId":', quoted(id), ',"seller":', recipient(o.seller, o.sellerReceiving), ',"terms":', terms, '}');
    }
    function creator(bytes32 key) internal pure returns (string memory) {
        return string.concat('{"publicKey":"', b64(key), '","signatureScheme":"zkbytes-ed25519-v1"}');
    }
    function validate(T.Reference memory r) public view {
        if (r.serviceId == 0 || r.creator == 0 || r.contentHash == 0 ||
            r.preparedAt > block.timestamp || uint256(r.preparedAt) + RETENTION <= block.timestamp) revert InvalidReference();
        envelope(r.buyerEnvelope); envelope(r.sellerEnvelope);
    }
    function envelope(bytes memory value) public pure {
        if (value.length != 65 || value[0] != 0x03) revert InvalidReference();
    }
    function recordHash(uint256 id, bytes memory encodedOrder, T.Reference memory r, address sender, uint256 turn, bool message) public view returns (bytes32) {
        T.Order memory o = abi.decode(encodedOrder, (T.Order));
        validate(r);
        string memory first = string.concat('{"buyerEnvelope":"', Base64.encode(r.buyerEnvelope), '","contentHash":"', hex32(r.contentHash),
            '","creator":', creator(r.creator), ',"expiresAt":"', timestamp(uint256(r.preparedAt) + RETENTION, false), '","kind":"', message ? 'message' : 'delivery', '","order":', orderJSON(id, o));
        string memory last = string.concat(',"preparedAt":"', timestamp(r.preparedAt, true), '","profile":"', PROFILE,
            '","sellerEnvelope":"', Base64.encode(r.sellerEnvelope), '","sender":"', addr(sender), '","serviceId":', uint256(r.serviceId).toString(), ',"turn":', quoted(turn), ',"version":2}');
        return keccak256(bytes(string.concat('payunlock-record-v2\n', first, last)));
    }
    function evidenceHash(uint256 id, bytes memory encodedOrder, T.Assignment memory a, T.Evidence memory e) public view returns (bytes32) {
        T.Order memory o = abi.decode(encodedOrder, (T.Order));
        validate(e.contentRef); envelope(e.arbitratorEnvelope);
        string memory assignment = string.concat('{"caseId":', quoted(id), ',"keyVersion":', quoted(a.keyVersion), ',"publicKey":"', b64(a.publicKey),
            '","revision":', quoted(a.revision), ',"wallet":"', addr(a.wallet), '"}');
        string memory first = string.concat('{"assignment":', assignment, ',"creator":', creator(e.contentRef.creator), ',"envelopes":["',
            Base64.encode(e.contentRef.buyerEnvelope), '","', Base64.encode(e.contentRef.sellerEnvelope), '","', Base64.encode(e.arbitratorEnvelope),
            '"],"evidenceHash":"', hex32(e.contentRef.contentHash), '","expiresAt":"', timestamp(uint256(e.contentRef.preparedAt) + RETENTION, false), '"');
        return keccak256(bytes(string.concat('payunlock-evidence-record-v2\n', first, ',"order":', orderJSON(id, o),
            ',"preparedAt":"', timestamp(e.contentRef.preparedAt, true), '","profile":"', PROFILE, '","serviceId":', uint256(e.contentRef.serviceId).toString(), ',"version":2}')));
    }
    function requestHash(uint256 id, bytes memory encodedOrder, T.Assignment memory a, uint256 index, address participant, uint64 advisoryDate, T.Evidence memory request) public view returns (bytes32) {
        bytes32 referenceHash = evidenceHash(id, encodedOrder, a, request);
        return keccak256(abi.encode(keccak256("payunlock-request-record-v2"), block.chainid, address(this), id, index, a.revision, a.wallet, a.keyVersion, participant, advisoryDate, referenceHash));
    }
    // Gregorian civil date conversion; bounded to the four-digit ISO years used by v1.
    function timestamp(uint256 value, bool millis) internal pure returns (string memory) {
        if (value > 253402300799) revert InvalidReference();
        uint256 z = value / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 year = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        if (month <= 2) ++year;
        return string.concat(year.toString(), '-', two(month), '-', two(day), 'T', two(value / 3600 % 24), ':', two(value / 60 % 60), ':', two(value % 60), millis ? '.000Z' : 'Z');
    }
    function two(uint256 n) private pure returns (string memory) { return n < 10 ? string.concat('0', n.toString()) : n.toString(); }
}
