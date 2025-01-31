'use strict'

/* Quick and simple MSF encoder */
exports.from = tc => tc.f + tc.s * 75 + tc.m * 75 * 60
exports.to = lba => {
  const tc = {}
  tc.f = lba % 75
  tc.s = Math.floor(lba / 75)
  tc.m = Math.floor(tc.s / 60)
  tc.s %= 60
  return tc
}
