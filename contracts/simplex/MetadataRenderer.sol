//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IMetadataRenderer} from "../ethregistrar/IMetadataRenderer.sol";

/// @notice Fully on-chain ERC-721 metadata for SimpleX names. The BaseRegistrar
///         holds a pointer to this contract and delegates tokenURI here, passing
///         the stored plaintext label. Renders a self-contained data: URI
///         (JSON + SVG), so no server or IPFS is required. The SVG design is a
///         byte-for-byte port of the reference renderer in the parent SNRC repo
///         (`scripts/nft-preview/gen.mjs`); keep the two in sync.
///
///         Layout heuristic (char-count based, so it works on-chain without
///         glyph metrics): the name (label + suffix) is laid out on 1-3 lines,
///         font size = floor(450 / (charsPerLine * 1.05)) capped per line count,
///         where 1.05 is the worst-case bold glyph advance ('m'); this keeps a
///         ~5% side margin even for an all-'m' 63-char label, and guarantees the
///         full name is shown. Wrapping is balanced and UTF-8-codepoint-safe.
contract MetadataRenderer is IMetadataRenderer {
    using Strings for uint256;

    /// @dev TLD suffix including the leading dot, eg ".testing".
    string public suffix;

    // Official SimpleX brand mark (dark-theme variant, 34x35 viewBox): P1 solid
    // white, P2 filled with the brand cyan->blue gradient.
    string private constant P1 =
        "M3.02958 8.60922L8.622 14.2013L14.3705 8.45375L17.1669 11.2498L11.4183 16.9972L17.0114 22.5895L14.1373 25.4633L8.54422 19.871L2.79636 25.6187L0 22.8227L5.74794 17.075L0.155484 11.483L3.02958 8.60922Z";
    string private constant P2 =
        "M14.0923 25.5156L16.944 22.6642L16.9429 22.6634L22.6467 16.9612L17.0513 11.3675L17.0523 11.367L14.2548 8.56979L8.65972 2.97535L11.5114 0.123963L17.1061 5.71849L22.8099 0.015625L25.6074 2.81285L19.9035 8.51562L25.4984 14.1099L31.2025 8.40729L34 11.2045L28.2958 16.907L33.8917 22.5017L31.0399 25.3531L25.4442 19.7584L19.7409 25.4611L25.3365 31.0559L22.4848 33.9073L16.8892 28.3124L11.1864 34.0156L8.38885 31.2184L14.0923 25.5156Z";
    string private constant DESC =
        "A SimpleX name. Resolves to SimpleX contact and channel links.";

    constructor(string memory _suffix) {
        suffix = _suffix;
    }

    /// @inheritdoc IMetadataRenderer
    function tokenURI(
        uint256,
        string calldata label
    ) external view returns (string memory) {
        string memory name = string.concat(label, suffix);
        string memory svg = _svg(name);
        string memory json = string.concat(
            '{"name":"',
            _jsonEscape(name),
            '","description":"',
            DESC,
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );
        return
            string.concat(
                "data:application/json;base64,",
                Base64.encode(bytes(json))
            );
    }

    function _svg(string memory name) internal pure returns (string memory) {
        (uint256 size, uint256 lines) = _layout(bytes(name).length);
        string memory defs = string.concat(
            "<defs>",
            // background: CSS linear-gradient(30deg) black (bottom-left) -> warm
            // white (top-right); userSpaceOnUse endpoints = the 30deg magic-corner
            // line on a 500x500 box (L = 500*sin30 + 500*cos30 = 683.01, centred).
            '<linearGradient id="g" x1="79.25" y1="545.75" x2="420.75" y2="-45.75" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#000000"/><stop offset="52%" stop-color="#131D49"/><stop offset="65%" stop-color="#3F5598"/><stop offset="85%" stop-color="#C3FAFF"/><stop offset="90%" stop-color="#FFF6E0"/></linearGradient>',
            // brand logo gradient (P2): cyan -> blue, official userSpaceOnUse coords
            '<linearGradient id="lg" x1="12.8381" y1="-0.678252" x2="9.54355" y2="31.4493" gradientUnits="userSpaceOnUse"><stop stop-color="#01F1FF"/><stop offset="1" stop-color="#0197FF"/></linearGradient>',
            // name gradient: linear-gradient(90deg, #019bfe, #64fdff)
            '<linearGradient id="tg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#019bfe"/><stop offset="100%" stop-color="#64fdff"/></linearGradient>',
            "</defs>"
        );
        string memory logo = string.concat(
            '<g transform="translate(36,36) scale(1.95)"><path fill-rule="evenodd" clip-rule="evenodd" d="',
            P1,
            '" fill="#ffffff"/><path fill-rule="evenodd" clip-rule="evenodd" d="',
            P2,
            '" fill="url(#lg)"/></g>'
        );
        return
            string.concat(
                '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">',
                defs,
                '<rect width="500" height="500" fill="url(#g)"/>',
                logo,
                '<text font-family="sans-serif" font-size="',
                size.toString(),
                '" font-weight="bold" fill="url(#tg)" text-anchor="middle">',
                _tspans(bytes(name), size, lines),
                "</text></svg>"
            );
    }

    /// @dev Choose the fewest lines (1-3) whose font size clears a per-line-count
    ///      floor; size = floor(450 / (charsPerLine * 1.05)), capped per line count.
    function _layout(
        uint256 len
    ) internal pure returns (uint256 size, uint256 lines) {
        uint256[3] memory maxF = [uint256(44), 30, 24];
        uint256[3] memory floorF = [uint256(22), 16, 14];
        for (uint256 l = 1; l <= 3; l++) {
            uint256 perLine = (len + l - 1) / l; // ceil
            uint256 s = perLine == 0 ? maxF[l - 1] : (450 * 100) / (perLine * 105);
            if (s > maxF[l - 1]) s = maxF[l - 1];
            if (s >= floorF[l - 1] || l == 3) {
                if (s < 14) s = 14; // MIN
                return (s, l);
            }
        }
    }

    /// @dev Lay the name out as balanced, UTF-8-safe `<tspan>` lines, vertically
    ///      centred. Each line's text is XML-escaped.
    function _tspans(
        bytes memory nb,
        uint256 size,
        uint256 lines
    ) internal pure returns (string memory out) {
        uint256 lineH = (size * 120 + 50) / 100; // round(size * 1.2)
        uint256 blockH = lines * lineH;
        // round(252 - blockH/2 + 0.74*size)
        int256 fb = (int256(252) *
            100 -
            int256(blockH) *
            50 +
            int256(size) *
            74 +
            50) / 100;
        uint256 per = (nb.length + lines - 1) / lines; // ceil bytes per line
        uint256 pos;
        for (uint256 i = 0; i < lines && pos < nb.length; i++) {
            uint256 end = pos + per;
            if (end > nb.length) end = nb.length;
            // don't split a multibyte UTF-8 sequence (continuation byte 10xxxxxx)
            while (end < nb.length && (uint8(nb[end]) & 0xC0) == 0x80) end++;
            uint256 y = uint256(fb + int256(i * lineH));
            out = string.concat(
                out,
                '<tspan x="250" y="',
                y.toString(),
                '">',
                _xmlEscape(string(_slice(nb, pos, end))),
                "</tspan>"
            );
            pos = end;
        }
    }

    function _slice(
        bytes memory b,
        uint256 start,
        uint256 end
    ) internal pure returns (bytes memory r) {
        r = new bytes(end - start);
        for (uint256 i; i < r.length; i++) r[i] = b[start + i];
    }

    /// @dev Escapes a string for inclusion in a JSON string literal: backslash
    ///      and double-quote are escaped; control bytes are replaced with space.
    function _jsonEscape(
        string memory s
    ) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 2);
        uint256 j;
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\") {
                out[j++] = "\\";
                out[j++] = c;
            } else if (uint8(c) < 0x20) {
                out[j++] = " ";
            } else {
                out[j++] = c;
            }
        }
        assembly {
            mstore(out, j)
        }
        return string(out);
    }

    /// @dev Escapes a string for inclusion in XML/SVG text content.
    function _xmlEscape(
        string memory s
    ) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 6);
        uint256 j;
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == "&") j = _append(out, j, "&amp;");
            else if (c == "<") j = _append(out, j, "&lt;");
            else if (c == ">") j = _append(out, j, "&gt;");
            else if (c == '"') j = _append(out, j, "&quot;");
            else if (c == "'") j = _append(out, j, "&apos;");
            else out[j++] = c;
        }
        assembly {
            mstore(out, j)
        }
        return string(out);
    }

    function _append(
        bytes memory out,
        uint256 j,
        bytes memory frag
    ) private pure returns (uint256) {
        for (uint256 k; k < frag.length; k++) out[j++] = frag[k];
        return j;
    }
}
