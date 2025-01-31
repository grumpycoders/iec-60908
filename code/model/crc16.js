'use strict'

// The subchannel Q uses a very typical CRC16 CCITT checksum. So
// we just use the standard algorithm, with its polynomial of
// x^¹⁶ + x¹² + x⁵ + 1, which is 0x1021 in hex.
const crc16_lut = []
{
  const poly = 0x1021
  for (let d = 0; d < 256; d++) {
    let r = d << 8
    for (let i = 0; i < 8; i++) {
      const flip = r & 0x8000 ? poly : 0
      r <<= 1
      r ^= flip
      r &= 0xffff
    }
    crc16_lut[d] = r
  }
}

exports.crc16 = data => {
  let crc = 0
  for (const d of data) {
    crc = crc16_lut[(crc >> 8) ^ d] ^ (crc << 8)
    crc &= 0xffff
  }

  return crc ^ 0xffff
}
