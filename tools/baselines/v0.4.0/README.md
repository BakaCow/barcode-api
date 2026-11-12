# Historical readers for damage-test reproduction

These snapshots are the active readers from version 0.4.0 before this damage-testing change. They are benchmark inputs, not active app assets. Their known wrong readings are deliberately preserved so the before/after measurements can be reproduced.

The browser snapshot uses the same bundled ZXing JavaScript/WASM as the current worker. The API snapshot uses the pinned native dependencies. Custom engine decoding code is project code with the attributed Code 128 lookup table; retain [the attribution](../../../web/engine/THIRD-PARTY.txt) and [Apache license](../../../web/vendor/ZXING-CPP-LICENSE.txt).

See [DAMAGE-TESTING.md](../../../DAMAGE-TESTING.md) for the test corpus and commands. Earlier files retain their original bytes; source hashes in reports identify exactly what was tested.
