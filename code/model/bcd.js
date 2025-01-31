'use strict'

/* Quick and simple BCD encoder / decoder. */
exports.from = bcd => ((bcd & 0xf0) >> 4) * 10 + (bcd & 0x0f)
exports.to = num => (((num / 10) | 0) << 4) | (num % 10)
