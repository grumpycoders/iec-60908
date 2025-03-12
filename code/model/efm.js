'use strict'

const { Transform } = require('stream')
const util = require('util')

/* The EFM encoder is a Stream Transform class that takes arrays of symbols as an input, and outputs bytes one
   at a time. The symbols can be bytes, or the values S0, S1, and ERASURE. The output bytes represent
   the bitstream in Little Endian. The encoder will automatically emit sync pattern every 33 input symbols,
   as well as merge bits. It is important to properly end the encoder once all input symbols have been given
   as input, in order to make sure the last bits are flushed out. The symbols S0 and S1 ought to only be used
   for the subchannel's first two symbols. The ERASURE symbol typically shouldn't be used in a normal stream,
   but can be useful for testing the Reed Solomon correction mechanism. There are technically a few other
   potential candidates for the erasure 14-bits pattern, we just picked one which seemed distant enough from
   the other valid EFM symbols. */

// The normal input symbols are between 0 and 255, so these values won't collide.
const S0 = -1
const S1 = -2
const ERASURE = -3

// The Eight-to-Fourteen Modulation values for all symbols between 0 and 255.
const lut = [
  0x0112, 0x0021, 0x0109, 0x0111, 0x0022, 0x0220, 0x0108, 0x0024, 0x0092, 0x0081, 0x0089, 0x0091, 0x0082, 0x0080,
  0x0088, 0x0084, 0x0101, 0x0041, 0x0049, 0x0104, 0x0042, 0x0040, 0x0048, 0x0044, 0x0212, 0x0201, 0x0209, 0x0211,
  0x0202, 0x0210, 0x0208, 0x0204, 0x0100, 0x0421, 0x0110, 0x0124, 0x0422, 0x0420, 0x0102, 0x0424, 0x0492, 0x0481,
  0x0489, 0x0491, 0x0482, 0x0480, 0x0488, 0x0484, 0x0020, 0x0441, 0x0449, 0x0221, 0x0442, 0x0440, 0x0448, 0x0444,
  0x0412, 0x0401, 0x0409, 0x0411, 0x0402, 0x0410, 0x0408, 0x0404, 0x0912, 0x0921, 0x0909, 0x0911, 0x0922, 0x0900,
  0x0908, 0x0924, 0x0892, 0x0881, 0x0889, 0x0891, 0x0882, 0x0880, 0x0888, 0x0884, 0x0901, 0x0841, 0x0849, 0x0904,
  0x0842, 0x0840, 0x0848, 0x0844, 0x0812, 0x0801, 0x0809, 0x0811, 0x0802, 0x0810, 0x0808, 0x0804, 0x1112, 0x1121,
  0x1109, 0x1111, 0x1122, 0x1100, 0x0902, 0x1124, 0x1092, 0x1081, 0x1089, 0x1091, 0x1082, 0x1080, 0x1088, 0x1084,
  0x1101, 0x1041, 0x1049, 0x1104, 0x1042, 0x1040, 0x1048, 0x1044, 0x1012, 0x0490, 0x1009, 0x1011, 0x1002, 0x1010,
  0x1008, 0x1004, 0x2112, 0x2121, 0x2109, 0x2111, 0x2122, 0x2100, 0x2108, 0x2124, 0x2092, 0x2081, 0x2089, 0x2091,
  0x2082, 0x2080, 0x2088, 0x2084, 0x2101, 0x2041, 0x2049, 0x2104, 0x2042, 0x2040, 0x2048, 0x2044, 0x2012, 0x0241,
  0x2009, 0x2011, 0x0242, 0x2010, 0x2008, 0x0244, 0x2110, 0x2421, 0x0222, 0x2120, 0x2422, 0x2420, 0x2102, 0x2424,
  0x2492, 0x2481, 0x2489, 0x2491, 0x2482, 0x2480, 0x2488, 0x2484, 0x0120, 0x2441, 0x2449, 0x0224, 0x2442, 0x2440,
  0x2448, 0x2444, 0x2412, 0x2401, 0x2409, 0x2411, 0x2402, 0x2410, 0x2408, 0x2404, 0x0122, 0x2221, 0x0249, 0x0910,
  0x2222, 0x2220, 0x0248, 0x2224, 0x2090, 0x2021, 0x0890, 0x0090, 0x2022, 0x2020, 0x0240, 0x2024, 0x0920, 0x2241,
  0x2249, 0x0121, 0x2242, 0x2240, 0x2248, 0x2244, 0x2212, 0x2201, 0x2209, 0x2211, 0x2202, 0x2210, 0x2208, 0x2204,
  0x1022, 0x1020, 0x1221, 0x1024, 0x1222, 0x1220, 0x1102, 0x1224, 0x1021, 0x0821, 0x2490, 0x1090, 0x0822, 0x0820,
  0x1108, 0x0824, 0x1120, 0x1241, 0x1249, 0x1110, 0x1242, 0x1240, 0x1248, 0x1244, 0x1212, 0x1201, 0x1209, 0x1211,
  0x1202, 0x1210, 0x1208, 0x1204
]

// The Eight-to-Fourteen Modulation values for the non-byte symbols we handle.
const S0_symbol = 0x2004
const S1_symbol = 0x1200
const ERASURE_symbol = 0b10001000000000

/* The way to use the class is through the Transform API. None of the methods in the class are to be called
   directly: they will be called by the node.js code directly. */

class Encoder extends Transform {
  constructor() {
    super({ objectMode: true })
    this.lastbit = 0
    this.lastfew = 0
    this.mask = 1
    this.byte = 0
    this.column = 0
  }

  _putbit(bit) {
    // Do the NRZ-I flip flop, and remember the last two bits for the merge bit algorithm.
    this.lastfew <<= 1
    if (bit !== 0) {
      this.lastbit ^= 1
      this.lastfew |= 1
    }
    if (this.lastbit) {
      this.byte |= this.mask
    }
    this.mask <<= 1
    // Flush a byte if we have 8 bits.
    if (this.mask === 0x100) {
      this.push(this.byte)
      this.mask = 1
      this.byte = 0
    }
    this.lastfew &= 3
  }

  // There are various possible strategies to come up with merge bits. This one
  // is the most eager possible, in order to systematically introduce a transition
  // into the bitstream, to keep the clock recovery circuit happy. Since we remember
  // the last two bits we had, we only need the next two bits to decide what to do.
  _putmerge(next) {
    const val = (this.lastfew << 2) | (next & 3)
    if ((val & 5) === 0) {
      this._putbit(0)
      this._putbit(1)
      this._putbit(0)
    } else if (val === 1) {
      this._putbit(1)
      this._putbit(0)
      this._putbit(0)
    } else if (val === 4) {
      this._putbit(0)
      this._putbit(0)
      this._putbit(1)
    } else {
      this._putbit(0)
      this._putbit(0)
      this._putbit(0)
    }
  }

  // Helper to output the 24-bits sync pattern.
  _putsync() {
    this._putbit(1)
    for (let i = 0; i < 10; i++) {
      this._putbit(0)
    }
    this._putbit(1)
    for (let i = 0; i < 10; i++) {
      this._putbit(0)
    }
    this._putbit(1)
    this._putbit(0)
  }

  // Helper to output a 14-bits EFM symbol.
  _putsymbol(symbol) {
    // We keep track of the column, and emit a sync pattern every 33 symbols.
    if (this.column++ === 0) {
      this._putsync()
    }
    this._putmerge(symbol)
    let mask = 1
    for (let i = 0; i < 14; i++) {
      this._putbit(symbol & mask)
      mask <<= 1
    }
    // If we are at the end of a frame, we need to emit merge bits.
    // Technically, since the next frame will start with a sync pattern,
    // we know it'll start with the bits pattern 10, so we can
    // pre-emptively emit the merge bits for that.
    if (this.column === 33) {
      this.column = 0
      this._putmerge(1)
    }
  }

  // The general _transform method, called by the nodejs Transform API.
  _transform(data, encoding, callback) {
    if (Array.isArray(data) || Buffer.isBuffer(data) || util.types.isUint8Array(data)) {
      for (const b of data) {
        if ((b >= 0) && (b < 256)) {
          this._putsymbol(lut[b])
        } else if (b === S0) {
          this._putsymbol(S0_symbol)
        } else if (b === S1) {
          this._putsymbol(S1_symbol)
        } else if (b === ERASURE) {
          this._putsymbol(ERASURE_symbol)
        } else {
          return callback(new Error('Improper input symbol'))
        }
      }
      callback()
    } else {
      callback(new Error('Improper input type'))
    }
  }

  // Ensure the last bits are flushed out, and reset the encoder.
  _flush(callback) {
    if (this.mask !== 1) {
      this.push(this.byte)
    }
    this.lastbit = 0
    this.lastfew = 0
    this.mask = 1
    this.byte = 0
    this.column = 0
    callback()
  }
}

exports.Encoder = Encoder
exports.S0 = S0
exports.S1 = S1
exports.ERASURE = ERASURE
exports.symbols = { ...lut, S0: S0_symbol, S1: S1_symbol }
