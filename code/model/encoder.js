'use strict'

const RingBuffer = require('ringbufferjs')
const efm = require('./efm')
const rs = require('./rs')

/* Throughout the code, we will be referring to "lines" and "columns". One can see the
   input stream as an infinite number of lines, spread over 24 columns. The encoder
   will add a total of 8 columns using 2 Reed-Solomon ECCs. The mapping between input
   column:line to the output column:line is a complex swizzle pattern, but it'd be even
   more complicated to visualize it in a 1-dimensional manner instead of a 2-dimensional
   one, hence this code using columns and lines as a sort of [X, Y] indexer.
   */

/* This code is extremely convoluted, mostly because of the specifications in the redbook,
   but also because we want to emit a straight bitstream while keeping as little state
   as possible, and be as real-time as possible, to match what one would get from a
   hardware encoder. This means that we compute the ECC bytes as we go, and we need to
   keep a buffer of past data to compute the ECC bytes. This is done using a few ring
   buffers, to check for past and future data as we grab the data for C1 and C2. This
   also means we are computing the C1 and C2 more times than necessary, but this is
   necessary to keep the state small. Otherwise, we would need even more state to
   compute the C1 and C2 bytes, which would delay the output much more. A streamed
   encoder, for example in the context of a CD-R writer, can keep as much state as
   it wants, but here we want to be able to restart the encoder as quickly as possible.
   This also means that, aside from the S0/S1 subchannel sync pattern, the encoder is
   extremely systematic for a given 588 bits output frame.
   */

// Debugging helper.
function tohex(d) {
  let s = (+d).toString(16)
  if (s.length < 2) {
    s = '0' + s
  }
  return s
}

/* When reading into the past and future buffers, things are heavily scrambled and
   swizzled. It's easier to handle the back lookups using tables for the various
   shuffles. These were hand crafted based off the redbook information, as well
   as experimentation and manual tweaks. It's important to realize that the L2-to-L1
   encoding isn't standardized, and so there's no unique way to do it, as long as
   it's within certain parameters. As a result, the offsets of the L2 data within
   the L1 frames can and will be shifted around from one disc to another, depending
   on the burner that encoded the input L2 stream. In other words, even if you have
   a perfect dump of a given disc, there's very little chance that burning it will
   produce the same L1 bitstream as the original, causing various sorts of subtle
   delayed differences from the original.

   If one organizes the data in 98 lines of 24 columns, then the lookup makes some
   amount of sense using these tables. See the read-bits.js file for some more
   enlightenment on the data layout.
   */
const swizzledColumn = [
  5, 4, 13, 12, 21, 20, 7, 6,
  15, 14, 23, 22, 9, 8, 17, 16,
  1, 0, 11, 10, 19, 18, 3, 2
]
const delayedLine = [
  106, 103, 98, 95, 90, 87, 82, 79, 74, 71, 66, 63,
  44, 41, 36, 33, 29, 26, 20, 17, 12, 9, 5, 2
]
// Of COURSE C2 isn't the same delays as the data. That'd be too easy.
const delayedC2Data = [
  107, 104, 99, 96, 91, 88, 83, 80, 75, 72, 67, 64,
  43, 40, 35, 32, 27, 24, 19, 16, 11, 8, 3, 0
]
const delayedC2Locs = [59, 56, 51, 48]
// We need to delay data a tiny bit for the digital data sync pattern. This ensures
// the DSP doesn't miss the sync pattern, and that the data is properly aligned.
// Otherwise, data sectors will be delayed much further. This is the smallest
// delay that works.
const delayedOffset = 2

/* This class will write bytes to the passed writer as sectors are pushed to it. The
   writer may be the EFM encoder Transform, or a simple file. */
class Encoder {
  constructor(writer) {
    this.writer = writer
    // The sectors queue is 3 sectors deep, because we need to compute the ECC bytes
    // for the current sector, as well as the next two sectors, at worst. The last
    // sector will be barely used by the encoder, but such is life. A real hardware
    // encoder might want to use 4 sectors worth of ring buffer, in order to start
    // gathering the next sector from storage while the current three are being processed.
    this.sectorsQueue = new RingBuffer(3)
    // Due to the various delays, we don't need much past subchannel data, so we
    // only keep two frames worth of subchannel data.
    this.subChannelQueue = new RingBuffer(2)
    // This is the past data buffer, which is used to compute the ECC bytes. All
    // of the buffers above are for the "future" data, while this one is for the past
    // data which we have already processed. This is 59 lines deep, and needs to
    // contain 28 symbols per line.
    this.pastData = new RingBuffer(59)
    // In other words: the sectors queue ought to be 4 * 2352 = 9408 bytes,
    // the subchannel queue ought to be 2 * 96 = 192 bytes, and the past data
    // queue ought to be 59 * 28 = 1652 symbols.

    this.counter = 0
    this.debug = false
    /* Adding silence as past data. This could also be the ERASURE symbol. If we
       need to restart the encoder quickly after a seek for instance, right now
       we must feed 3 sectors worth of input data in order to ensure all the data
       is safely encoded, as the DSP has to de-swizzle them. If we were to
       immediately emit data from the get-go with silence as the prefix, then
       the swizzled data will be incorrect as the ECCs will go over them. If
       instead we emit erasures, and change the ECC encoder to emit erasures when
       encountering an erasure as input, then this may force the DSP to discard
       properly the data. All of this hasn't been tested yet.
       */
    for (let s = 0; s < 59; s++) {
      const b = []
      for (let c = 0; c < 28; c++) {
        // "Silence" means that C2 is 0xff, as it's an inverted value. So one
        // silent row with audio + C2 has the following shape:
        //   00 [ ... 12 bytes ... ] 00 ff ff ff ff 00 [ ... 12 bytes ... ] 00
        b[c] = ((c < 12) || (c > 15)) ? 0 : 0xff
      }
      this.pastData.enq(b)
    }
  }

  setDebug(debug) {
    this.debug = debug
  }

  /* The subChannel array is mandatory if the writer is the EFM stream transform,
     and cannot be present if it's a simple file. Sectors won't be written out until
     enough data has been gathered to do so. What this means is that data is always
     delayed, sometimes by quite a bit. But also, the ECC bytes will also cover past
     data, up to 59 data lines, or about half a sector. The encoder will fill past
     sector data with audio silence for the purpose of the ECC encoder, but if that's
     undesirable, it'd be recommended to discard at least the first 59 lines that come
     out of the encoder, which means 59*32=1888 bytes when using a raw file as an
     output file, or 4337 bytes when using the EFM encoder. A full sector out would
     amount to 3136 bytes using a raw output file, or 7203 bytes when using the EFM
     encoder.
     */
  queue(sector, subChannel) {
    if (Buffer.isBuffer(sector)) {
      sector = [...sector]
    }
    this.sectorsQueue.enq(sector)
    this.subChannelQueue.enq(subChannel)
    if (this.sectorsQueue.size() < 3) {
      return
    }
    subChannel = this.subChannelQueue.peek()
    /* We gather the sector data for three sectors worth of future data. Ideally, we
       should just be able to use the ring buffer directly, but the library doesn't
       support that.
       */
    const sectors = [].concat(...this.sectorsQueue.peekN(3))
    // While this loop goes over 98 lines of input sector data, the general encoding
    // algorithm in there doesn't really care about which line it's at.
    for (let i = 0; i < 98; i++) {
      if (Array.isArray(subChannel)) {
        const f = i === 0 ? efm.S0 : (i === 1 ? efm.S1 : subChannel[i - 2])
        if (this.writer) {
          this.writer.write([f])
        }
      }

      /* Getting data line. P1 is the first 12 bytes part of the data line we're going to
         emit, and P2 is the second set of 12 bytes. The final data will be P1, C2, P2, C1.
         */
      const p1 = []
      const p2 = []
      /* All of our data is in the future, so grab data from there */
      for (let c = 0; c < 12; c++) {
        const lin = delayedLine[c] + i - delayedOffset
        const col = swizzledColumn[c]
        const v = sectors[lin * 24 + col]
        p1.push(v)
      }
      for (let c = 12; c < 24; c++) {
        const lin = delayedLine[c] + i - delayedOffset
        const col = swizzledColumn[c]
        const v = sectors[lin * 24 + col]
        p2.push(v)
      }

      /* The rest of this code will compute the C1 and C2 bytes, which is very convoluted.
         We need C2 exactly 6 times, and C1 exactly 2 times. The first time we compute C2
         with 4 different delays, for the 4 bytes of C2. This means grabbing data from
         all over the place, as we're adding delays on top of delays. Then, since C1
         computes itself over C2, and since C1 has a delay of either 0 or 1, depending
         on the parity of the column, we compute C2 an additional 2 times, for the
         two columns of C2 that C1 will use that have a delay of 1. Then, we compute C1
         twice, once with a delay of 1, and once with a delay of 0. */

      /* Note that rs.js provides three methods to compute Reed-Solomon. The C1/C2 variants
         are using matrix multiplications with static vectors for each column of Reed-Solomon.
         This means that each entry in the output vector becomes completely independant,
         unlike the barrel shifter method in the "4" variant which requires knowing all the
         columns at all times, but doesn't need static vectors to function. While we are
         computing C2 and C1 a great number of times, we only care about one or two output
         columns at a time. This means that the Reed-Solomon computation can be sped up by
         further specializing the C1 and C2 variants into only computing the relevant
         output columns in the final vector. */

      /* The ECC for both C1 and C2 look a bit in the past, so grab them. This should
         really be a direct lookup inside of a normal ring buffer, but this isn't how
         the ring buffer library works. Ideally, all of the accesses to the ring buffer
         should just be direct instead.
         */
      const past = [].concat(...this.pastData.peekN(59))
      /* Current C2 data */
      const c2v = []
      for (let n = 0; n < 4; n++) {
        const v1 = []
        /* The first 12 bytes of C2 are in the past, because the delay for
           the data it protects is greater than the delay for itself. */
        for (let c = 0; c < 12; c++) {
          const dd = delayedC2Data[c]
          const dl = delayedC2Locs[n]
          const d = dd - dl
          const lin = 59 - d
          v1.push(past[lin * 28 + c])
        }
        const v2 = []
        /* The next 12 bytes of C2 are in the future, because the delay for
           the data it protects is less than the delay for itself. */
        for (let c = 12; c < 24; c++) {
          const dd = delayedC2Data[c]
          const dl = delayedC2Locs[n]
          const d = dl - dd
          const lin = delayedLine[c] + i + d - delayedOffset
          const col = swizzledColumn[c]
          v2.push(sectors[lin * 24 + col])
        }
        // This is all the data we need to compute C2.
        const v = [].concat(v1, v2)
        const c2 = rs.encodeC2(v)
        if (this.debug) {
          const hcoeffs = []
          for (let i = 0; i < v.length; i++) {
            hcoeffs[i] = tohex(v[i])
          }
          const hc2 = []
          for (let i = 0; i < c2.length; i++) {
            hc2[i] = tohex(c2[i] ^ 0xff)
          }
          console.log('s' + (this.counter + '').padStart(2, '0') + 'f' + (i + '').padStart(2, '0') + ': computing C2[' + n + '] over: ' + hcoeffs + ' and got ' + hc2)
        }
        // The C2 data is inverted, so we need to XOR it with 0xff for the storage.
        c2v.push(c2[n] ^ 0xff)
      }

      const c2f = []
      /* Future C2 data for C1 */
      /* We need to compute C2 two more times because C1 will look into the future
         for C2 data itself. The swizzle looks simple (0, 1, 0, 1, 0, 1, ...) but
         this makes for some very interesting math at this point... The delay for
         grabbing C2 will be 0, 1, 0, 1, while C1 itself will be stored with the
         same 0, 1, 0, 1 delay. This means that when the C1 delay is 1, and the
         C2 delay is 0, we're looking in the future. So we need to compute future
         C2 bytes 0 and 2, which will be stored in slots 0 and 1 of c2f. This
         means the algorithm for the data gathering below is very similar to the
         one we just did, just with an additional delay of 1.
         */
      for (let n = 0; n < 2; n++) {
        const v1 = []
        for (let c = 0; c < 12; c++) {
          const dd = delayedC2Data[c]
          const dl = delayedC2Locs[n * 2] + 1
          const d = dd - dl
          const lin = 59 - d
          v1.push(past[lin * 28 + c])
        }
        const v2 = []
        for (let c = 12; c < 24; c++) {
          const dd = delayedC2Data[c]
          const dl = delayedC2Locs[n * 2] + 1
          const d = dl - dd
          const lin = delayedLine[c] + i + d - delayedOffset
          const col = swizzledColumn[c]
          v2.push(sectors[lin * 24 + col])
        }
        const v = [].concat(v1, v2)
        const c2 = rs.encodeC2(v)
        if (this.debug) {
          const hcoeffs = []
          for (let i = 0; i < v.length; i++) {
            hcoeffs[i] = tohex(v[i])
          }
          const hc2 = []
          for (let i = 0; i < c2.length; i++) {
            hc2[i] = tohex(c2[i] ^ 0xff)
          }
          console.log('s' + (this.counter + '').padStart(2, '0') + 'f' + (i + '').padStart(2, '0') + ': computing C2f[' + n + '] over: ' + hcoeffs + ' and got ' + hc2)
        }
        // The future-C2 isn't for actual data line output, so we don't need to
        // actually invert it, only to re-invert it right after in the C1 computation.
        c2f.push(c2[n * 2])
      }

      const c1v = new Array(4).fill(0)
      /* Our last step is to compute C1 twice. Its delay is simple, but since
         it grabs C2 data, we need to be careful about constructing its vectors.
         The first time we compute C1 will be with a delay of 1, because this is
         the simple case: we will always take future data in this case. */
      {
        const v = []
        for (let c = 0; c < 24; c++) {
          // C1 is computed over C2, in the middle of the data. So push an extra
          // four bytes worth of data to the vector we need to encode.
          if (c === 12) {
            /* The case where we compute with a delay of 1 means we're looking at
               future C2 on even bytes, and current C2 on odd bytes. Also, the
               computation is done _before_ the inversion, so we need to
               re-invert the data coming from the data line we're emitting.
               */
            v.push(c2f[0])
            v.push(c2v[1] ^ 0xff)
            v.push(c2f[1])
            v.push(c2v[3] ^ 0xff)
          }
          const dd = c % 2
          const dl = 1
          const d = dl - dd
          const lin = delayedLine[c] + i + d - delayedOffset
          const col = swizzledColumn[c]
          v.push(sectors[lin * 24 + col])
        }
        const c1 = rs.encodeC1(v)
        if (this.debug) {
          const hcoeffs = []
          for (let i = 0; i < v.length; i++) {
            hcoeffs[i] = tohex(v[i])
          }
          const hc1 = []
          for (let i = 0; i < c1.length; i++) {
            hc1[i] = tohex(c1[i] ^ 0xff)
          }
          console.log('s' + (this.counter + '').padStart(2, '0') + 'f' + (i + '').padStart(2, '0') + ': computing C1[1,3] over: ' + hcoeffs + ' and got ' + hc1)
        }
        c1v[1] = c1[1] ^ 0xff
        c1v[3] = c1[3] ^ 0xff
      }

      /* The second time we compute C1 will be with a delay of 0, for slots 0 and 2 of the ECC
         bytes. The straddling is a bit more complex because it either looks at the current line,
         or the past one.
         */
      {
        const v = []
        for (let c = 0; c < 24; c++) {
          if (c === 12) {
            /* The case where we compute with a delay of 0 means we're looking at
               current C2 on even bytes, and past C2 on odd bytes. */
            v.push(c2v[0] ^ 0xff)
            v.push(past[58 * 28 + 13] ^ 0xff)
            v.push(c2v[2] ^ 0xff)
            v.push(past[58 * 28 + 15] ^ 0xff)
          }
          const dd = c % 2
          const dl = 0
          const d = dd - dl
          if (dd === 0) {
            const lin = delayedLine[c] + i + d - delayedOffset
            const col = swizzledColumn[c]
            v.push(sectors[lin * 24 + col])
          } else {
            const lin = 58
            v.push(past[lin * 28 + c + ((c >= 12) ? 4 : 0)])
          }
        }
        const c1 = rs.encodeC1(v)
        if (this.debug) {
          const hcoeffs = []
          for (let i = 0; i < v.length; i++) {
            hcoeffs[i] = tohex(v[i])
          }
          const hc1 = []
          for (let i = 0; i < c1.length; i++) {
            hc1[i] = tohex(c1[i] ^ 0xff)
          }
          console.log('s' + (this.counter + '').padStart(2, '0') + 'f' + (i + '').padStart(2, '0') + ': computing C1[0,2] over: ' + hcoeffs + ' and got ' + hc1)
        }
        c1v[0] = c1[0] ^ 0xff
        c1v[2] = c1[2] ^ 0xff
      }

      // We're done computing the data for this line, so we can now emit it.
      // Again: this algorithm is very convoluted to compute C1/C2, but it
      // is to avoid having to write C1/C2 in way longer and bigger buffers.
      const d = [].concat(p1, c2v, p2, c1v)
      if (this.writer) {
        this.writer.write(Uint8Array.from(d))
      }

      if (this.debug) {
        const hd = []
        for (let i = 0; i < d.length; i++) {
          hd[i] = tohex(d[i])
        }
        console.log('s' + (this.counter + '').padStart(2, '0') + 'f' + (i + '').padStart(2, '0') + ': final data: ' + hd)
      }

      // We also need to keep track of what we just emited.
      this.pastData.enq([].concat(p1, c2v, p2))
    }
    this.counter++
  }
}

exports.Encoder = Encoder
