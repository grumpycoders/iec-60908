'use strict'

// This is the encoder for the bitstream format used by compact discs.
// It takes a raw, 2352-bytes per sector file as input, and outputs a
// bitstream file. The output bitstream can be in several formats:
// - efm: straight up a bitstream representing the pits and grooves
// - text: same as the above, but in a text format, with 1s and 0s
// - raw: skips the EFM encoder, and outputs bytes. This can be useful
//        for debugging, to see the 32 bytes per frame after all of the
//        Reed Solomon and swizzling, but will lack subchannel data.
//
// Subchannels are generated on the fly, which may not be desirable.
// A future version may allow to specify a subchannel file, which
// would be used instead of generating subchannel data on the fly.
// Also as a result, TOC data is not generated, and this only
// creates a single track starting from 00:00:00 or 00:02:00,
// depending on the pregap option.
//
// Last but not least, the code is meant to be as readable as possible,
// not fast. It is not optimized for speed, and should not be used in
// production. It is meant to be a reference implementation, not a
// production encoder. A production encoder should be written in C or
// C++ or Rust or any other language designed for speed, and should
// be using less readable but more performant tricks to access the
// data and encode it.
async function main() {
  const fs = require('fs')
  const { promisify } = require('util')
  const stat = promisify(fs.stat)

  const { program } = require('commander')
  const cliProgress = require('cli-progress')

  const bcd = require('./bcd')
  const crc16 = require('./crc16')
  const efm = require('./efm')
  const encoder = require('./encoder')
  const msf = require('./msf')
  const { scrambleLUT } = require('./scrambler')

  program.version('1.0.0')

  program
    .option('-i, --input <file>', 'input raw file')
    .option('-d, --digital', 'input is digital data')
    .option('-e, --efm <file>', 'output EFM bitstream file')
    .option('-p, --pregap', 'emit pregap data')
    .option('-o, --output <file>', 'output raw file')
    .option('-v, --verbose', 'activate debug mode')
    .option('-t, --text', 'use text format instead of bitstream')

  program.parse(process.argv)
  const options = program.opts()

  if (options.output && options.efm) {
    throw Error('Only one output file can be specified')
  }

  if (!options.input) {
    throw Error('At least one input file is necessary')
  }

  let input
  let inputSize
  if (options.input) {
    input = fs.createReadStream(options.input, { encoding: null })
    const istat = await stat(options.input)
    inputSize = istat.size
  }
  let outfile
  if (options.output !== undefined) {
    outfile = fs.createWriteStream(options.output, { encoding: null })
  }
  if (options.efm !== undefined) {
    const efmOut = fs.createWriteStream(options.efm)
    outfile = new efm.Encoder()
    outfile.on('data', b => {
      if (options.text) {
        for (let mask = 1; mask !== 0x100; mask <<= 1) {
          efmOut.write((b & mask) !== 0 ? '1' : '0')
        }
      } else {
        efmOut.write(Buffer.alloc(1, [b], null))
      }
    })
  }

  if (!input) {
    throw Error('Only raw input file supported at the moment')
  }

  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic)

  const enc = new encoder.Encoder(outfile)
  if (options.verbose) {
    enc.setDebug(true)
  }

  let remainder = Buffer.alloc(0, null, null)
  let counter = options.pregap ? -153 : 0
  bar.start(inputSize / 2352, 0)
  // The generic pushSector function, used to push a sector to the encoder. There is
  // a bit of an API abstraction issue, as the subchannel argument of the encoder is
  // highly tied to the kind of output stream. An EFM output stream _requires_ the
  // subchannel, while a raw output stream can _not_ have it. If this isn't respected,
  // each encoder will just be completely broken.
  const pushSector = sector => {
    // Scramble the data if we're emitting digital data.
    if (options.digital) {
      for (let i = 12; i < 2352; i++) {
        sector[i] ^= scrambleLUT[i - 12]
      }
    }
    // Raw files output don't have subchannels, so skip that.
    if (options.efm) {
      // This is the subchannel Q, which is used to store the timecode
      const subq = [0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]

      if (options.digital) {
        subq[0] |= 0x40
      }

      const tc = msf.to(counter)
      const tca = msf.to(counter + 150)
      subq[3] = bcd.to(tc.m)
      subq[4] = bcd.to(tc.s)
      subq[5] = bcd.to(tc.f)
      subq[7] = bcd.to(tca.m)
      subq[8] = bcd.to(tca.s)
      subq[9] = bcd.to(tca.f)

      const crc = crc16.crc16(subq)
      subq.push(crc >> 8)
      subq.push(crc & 0xff)
      const sub = new Array(96).fill(0)
      for (let i = 0; i < 96; i++) {
        const index = Math.floor(i / 8)
        const bit = i % 8
        const mask = 0x80 >> bit
        sub[i] = (subq[index] & mask) === 0 ? 0 : 0x40
        if (counter === 0) {
          sub[i] |= 0x80
        }
      }
      enc.queue(sector, sub)
    } else {
      enc.queue(sector)
    }
  }
  // Emit the pregap if requested. Yes, I know this looks weird, I just wasn't
  // in the mood for an additional if statement.
  for (let p = 0; p < (options.pregap ? 153 : 0); p++) {
    const sector = Buffer.alloc(2352).fill(0)
    sector[1] = sector[2] = sector[3] = sector[4] = sector[5] = 0xff
    sector[6] = sector[7] = sector[8] = sector[9] = sector[10] = 0xff
    const tc = msf.to(counter++ + 150)
    sector[12] = bcd.to(tc.m)
    sector[13] = bcd.to(tc.s)
    sector[14] = bcd.to(tc.f)
    pushSector(sector)
  }
  // This is the actual loop that reads the input file and pushes the sectors.
  // We only push single, full sectors to the encoder, so we need to
  // keep track of the remainder, which is the leftover data from the
  // previous chunk.
  for await (const chunk of input) {
    let fullChunk = Buffer.concat([remainder, chunk])
    while (fullChunk.length >= 2352) {
      const sector = fullChunk.slice(0, 2352)
      fullChunk = fullChunk.slice(2352)
      pushSector(sector)
      bar.update(++counter)
    }
    remainder = fullChunk
  }

  if (outfile) {
    outfile.end()
  }
  bar.stop()
  console.log('Done')
}

main()
  .then(ret => process.exit)
  .catch(err => { throw (err) })
