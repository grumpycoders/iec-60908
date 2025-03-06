'use strict'

// The jqr-* packages are buggy, but good enough for what we do here.
// Error correction will not work properly with them.
const poly = require('jqr-poly')
const gf = require('jqr-gf')

// The division will try to call sub from the field, but it's not defined.
// Luckily, it's easy to remedy to this problem.
gf.sub = gf.add

/* This code provides four Reed Solomon encoders. One very generic, that will output
   parity bytes that belong at at the end of the input stream, for any number of
   input bytes, and any number of parity bytes. The second one showcases how to do
   Reed-Solomon using a barrel-shifter, for a hardcoded 4 parity bytes. The third and
   fourth will be a matrix multiplication encoder, tuned specifically for C1 and C2.
 */

// Generated using the genMatrices.py script
const c1s = [
  0xf9, 0xcd, 0x43, 0x94, 0x8e, 0xfc, 0x0b, 0xba, 0xb4, 0xda, 0x83, 0xcb, 0xc5, 0xc7, 0x28, 0x0b,
  0x05, 0xca, 0x07, 0xa1, 0x9b, 0x29, 0x29, 0x9f, 0x99, 0x88, 0x50, 0x8a, 0x84, 0x6a, 0x93, 0x95,
  0x8f, 0x77, 0x97, 0xfa, 0xf4, 0xee, 0x11, 0x6b, 0x65, 0xc1, 0xf5, 0x52, 0x4c, 0x67, 0xfd, 0x6c,
  0x66, 0x7b, 0xd0, 0xa1, 0x9b, 0xf2, 0x42, 0xd1, 0xcb, 0x53, 0xe4, 0x6e, 0x68, 0xb2, 0x74, 0x40,
  0x3a, 0x1e, 0xa2, 0x9e, 0x98, 0xd6, 0xf4, 0xb3, 0xad, 0x94, 0x0d, 0x65, 0x5f, 0x8a, 0xab, 0x5e,
  0x58, 0x70, 0xd5, 0x31, 0x2b, 0x9a, 0xec, 0x8c, 0x86, 0x9d, 0x47, 0xd3, 0xcd, 0x60, 0xb1, 0x95,
  0x8f, 0x31, 0xfd, 0x89, 0x83, 0xc6, 0xa2, 0xa9, 0xa3, 0xbd, 0x3b, 0x51, 0x4b, 0xf9, 0x4e, 0x06,
]
const c2s = [
  0x3a, 0x1e, 0xa2, 0x9e, 0x98, 0xd6, 0xf4, 0xb3, 0xad, 0x94, 0x0d, 0x65, 0x5f, 0x8a, 0xab, 0x5e,
  0x58, 0x70, 0xd5, 0x31, 0x2b, 0x9a, 0xec, 0x8c, 0x86, 0x9d, 0x47, 0xd3, 0xcd, 0x60, 0xb1, 0x95,
  0x8f, 0x31, 0xfd, 0x89, 0x83, 0xc6, 0xa2, 0xa9, 0xa3, 0xbd, 0x3b, 0x51, 0x4b, 0xf9, 0x4e, 0x06,
  0xf9, 0x45, 0xf3, 0x48, 0x42, 0x2f, 0xb4, 0x9d, 0x97, 0x93, 0xba, 0x7a, 0x74, 0xeb, 0x22, 0x83,
  0x7d, 0x9c, 0x4e, 0xbe, 0xb8, 0x2f, 0x88, 0x74, 0x6e, 0xd1, 0x82, 0x16, 0x10, 0xb7, 0x55, 0x40,
  0x3a, 0x8a, 0x6c, 0x44, 0x3e, 0xe8, 0x73, 0x8f, 0x89, 0xcd, 0xb2, 0x77, 0x71, 0x78, 0xf6, 0x16
]

/* Generic Reed Solomon creates a generator polynomial based on the number of parity bytes. Meaning
   we can cache it after generating it, and save cycles every time we want to encode another ECC. */

const cachedGenerators = []

function getGenerator(nsyms) {
  const cached = cachedGenerators[nsyms]
  if (cached !== undefined) {
    return cached
  }

  let g = poly.create([1], gf)

  for (let i = 0; i < nsyms; i++) {
    const m = poly.create([1, gf.exp(i)], gf)
    g = g.multiply(m)
  }
  cachedGenerators[nsyms] = g
  return g
}

/* The generic encoder simply generates a polynomial out of the message to encode, and divide it
   by the generator polynomial. The reminder of the division makes the parity bytes to append
   to the message. The math behind this is described here:
   https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction#Simple_encoding_procedure:_The_message_as_a_sequence_of_coefficients
   However, note that the polynomial functions in jqr-poly are fairly buggy, and can produce
   incorrect errors on some degenerated syndromes. There are other encoders below which will
   produce correct results.
   */
exports.encode = function (msg, nsyms) {
  const g = getGenerator(nsyms)
  const polyMsg = poly.create(msg.concat(new Array(nsyms).fill(0)), gf)
  const r = polyMsg.divide(g)
  const ret = r[1].getCoefficients()
  return ret.concat(new Array(nsyms - ret.length).fill(0))
}

/* This is a generic Reed Solomon encoder, for exactly 4 recovery bytes, and using a barrel shifter.
   The math is essentially the same as the generic encoder, just specialized for 4 bytes. The
   polynomial after expansion for 4 parity bytes is x⁴ + 15·x³ + 54·x² + 120·x + 64. This means
   that each round of the barrel shifter will calculate the following:
     parity[x] += msg[i] * coeffs[x]
   Now, since we know the coefficients (15, 54, 120, 64), we can simply precompute the log values
   for them, to simplify the multiplication. The log values are:
       log(15)  = 0x4b
       log(54)  = 0xf9
       log(120) = 0x4e
       log(64)  = 0x06
   */
exports.encode_4 = function (msg) {
  const ret = new Array(4).fill(0)
  for (let i = 0; i < msg.length; i++) {
    const c = gf.add(msg[i], ret[0])
    ret[0] = ret[1]
    ret[1] = ret[2]
    ret[2] = ret[3]
    ret[3] = 0
    if (c === 0) continue
    const lc = gf.log(c)
    // The modulo here is only to avoid overflow, as technically the input
    // value to exp should be in the range of 0-255. But if the exponant
    // table is precomputed with 512 values, then this is not needed.
    // This comment applies to the rest of the code as well.
    ret[0] = gf.add(ret[0], gf.exp((lc + 0x4b) % 255))
    ret[1] = gf.add(ret[1], gf.exp((lc + 0xf9) % 255))
    ret[2] = gf.add(ret[2], gf.exp((lc + 0x4e) % 255))
    ret[3] = gf.add(ret[3], gf.exp((lc + 0x06) % 255))
  }
  return ret
}

// This is a systematic encoding matrix algorithm to compute C1, the same as with C2 below, simply
// with a different matrix, according to a (32,28) encoder, with the parity bytes at the end. See
// the encoder.js code to have a better understanding about why this may be beneficial to use.
exports.encodeC1 = function (msg) {
  if (msg.length !== 28) {
    throw Error('Invalid message length for C1')
  }
  const ret = new Array(4).fill(0)
  for (let i = 0; i < 28; i++) {
    const c = msg[i]
    if (c === 0) continue
    const lc = gf.log(c)
    ret[0] = gf.add(ret[0], gf.exp((lc + c1s[i * 4 + 0]) % 255))
    ret[1] = gf.add(ret[1], gf.exp((lc + c1s[i * 4 + 1]) % 255))
    ret[2] = gf.add(ret[2], gf.exp((lc + c1s[i * 4 + 2]) % 255))
    ret[3] = gf.add(ret[3], gf.exp((lc + c1s[i * 4 + 3]) % 255))
  }
  return ret
}

/* The specific encoder for the L1-C2 ECC cannot use the division, as it'll only work when the
   parity bytes are located at the end. Instead we need to create a skewed systematic encoding
   matrix, with the coefficients located in the middle instead of the end. The math for this
   is roughly described here, with the difference that the coefficients are located in the middle:
   https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction#Systematic_encoding_procedure:_The_message_as_an_initial_sequence_of_values
   */
exports.encodeC2 = function (msg) {
  if (msg.length !== 24) {
    throw Error('Invalid message length for C2')
  }
  const ret = new Array(4).fill(0)
  for (let i = 0; i < 24; i++) {
    const c = msg[i]
    if (c === 0) continue
    const lc = gf.log(c)
    ret[0] = gf.add(ret[0], gf.exp((lc + c2s[i * 4 + 0]) % 255))
    ret[1] = gf.add(ret[1], gf.exp((lc + c2s[i * 4 + 1]) % 255))
    ret[2] = gf.add(ret[2], gf.exp((lc + c2s[i * 4 + 2]) % 255))
    ret[3] = gf.add(ret[3], gf.exp((lc + c2s[i * 4 + 3]) % 255))
  }
  return ret
}
