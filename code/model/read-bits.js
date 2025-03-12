'use strict'

// This tool can be used to analyze the bitstream of a CD audio track and extract the sectors from it.

// It needs a text file as input, which only contains the characters '0' and '1', representing
// the pits and grooves of the CD. For example, the sync pattern of a CD frame would be
// represented as either 1111111111100000000000111 or 0000000000011111111111000. The text file
// could be generated from another tool. The tool also provides a conversion function from a CSV
// file from a logic analyzer, and to the expected text file format.

// By default, the tool will output a PNG file with the bitstream, aligning the frames in rows, and
// coloring the bits according to their type. The tool can also output various levels of logging
// information, and the decoded sectors in a 2448-byte format, with subchannel information, or a
// 2352-byte format, without the subchannels. If the sectors are detected to be data, the tool
// will also descramble it.

// When used to convert a CSV file from a logic analyzer, it is expected to have the following format:
// - Column 1: Time in seconds
// - Column 2: Clock signal from the XPCLK pin of the DSP
// - Column 3: Data signal from the ASYO pin of the DSP

async function main() {
  const { program } = require('commander')

  program.version('1.0.0')

  program
    .option('-f, --verboseFrameLog', 'verbose frame log')
    .option('-s, --verboseSectorLog', 'verbose sector log')
    .option('-e, --verboseSectorLogError', 'verbose sector log errors')
    .option('-d, --dumpSectorData', 'dump sector data')
    .option('-o, --output <file>', 'output sectors in 2448-bytes format')
    .option('-c, --cooked <file>', 'output sectors in 2352-bytes format')

  let inputFile
  let outputFile
  let cookedFile
  let cmd
  program
    .command('parseCSV <input> <output>')
    .description('input file is a csv, dump converted file to output')
    .action((input, output) => {
      inputFile = input
      outputFile = output
      cmd = 'parseCSV'
    })

  program
    .command('analyze <input>')
    .description('input file is a text bitstream')
    .action(input => {
      inputFile = input
      cmd = 'analyze'
    })

  program.parse(process.argv)
  const options = program.opts()

  const verboseFrameLog = options.verboseFrameLog
  const verboseSectorLog = options.verboseSectorLog
  const verboseSectorLogError = options.verboseSectorLogError
  const dumpSectorData = options.dumpSectorData

  console.log('================================')

  const EFMlib = require('./efm')
  const { scrambleLUT } = require('./scrambler')

  // The EFM symbols from the EFM library are tuned to be used in an encoder, and are not
  // suitable for decoding. The following code will create a reverse lookup table for the
  // EFM symbols, so they can be used to decode the bitstream.
  const EFM = {}
  for (const [k, v] of Object.entries(EFMlib.symbols)) {
    let s = ''
    let m = 1
    for (let i = 0; i < 14; i++) {
      if ((v & m) === 0) {
        s += '0'
      } else {
        s += '1'
      }
      m <<= 1
    }
    if (k === 'S0') {
      EFM[s] = 'S0'
    } else if (k === 'S1') {
      EFM[s] = 'S1'
    } else {
      EFM[s] = parseInt(k)
    }
  }

  const fs = require('fs')
  const parse = require('csv-parse')
  const png = require('pngjs').PNG
  const hexer = require('hexer')

  const lerp = (x, y, a) => x * (1 - a) + y * a
  const clamp = (a, min = 0, max = 1) => Math.min(max, Math.max(min, a))
  const invlerp = (x, y, a) => clamp((a - x) / (y - x))
  const range = (x1, y1, x2, y2, a) => lerp(x2, y2, invlerp(x1, y1, a))

  function tohex(d) {
    let s = (+d).toString(16)
    if (s.length < 2) {
      s = '0' + s
    }
    return s
  }

  // The code to process a sample file from the logic analyzer.
  function readSampleFile(filename, output) {
    console.log('Reading and parsing csv')
    const records = []
    fs.createReadStream(filename)
      .pipe(parse())
      .on('data', row => {
        records.push(row)
      })
      .on('end', () => {
        console.log('Got ' + records.length + ' records')

        console.log('Parsing...')
        const bits = []

        // The input CSV file will have a lot of repeated clock signals, and
        // we simply want to get the data bits when the clock signal changes.
        let previousClock = parseInt(records[2][1].trim())

        for (let i = 3; i < records.length; i++) {
          const clock = parseInt(records[i][1].trim())
          if (clock === previousClock) continue
          if (clock === 0) bits.push(records[i][2].trim())
          previousClock = clock
        }

        console.log('Done. Got ' + bits.length + ' bits')

        fs.writeFileSync(output, bits.join(''))
      })
  }

  if (cmd === 'parseCSV') {
    readSampleFile(inputFile, outputFile)
    // If we just converted the file, don't do anything further.
    return 0
  }

  if (options.output) {
    outputFile = fs.createWriteStream(options.output, { encoding: null })
  }

  if (options.cooked) {
    cookedFile = fs.createWriteStream(options.cooked, { encoding: null })
  }

  // The code to read the bitstream from a file will try to locate the first frame
  // sync pattern, and will discard the bits before it. This will make the rest of
  // the code more simple.
  function readBitsFile(filename) {
    const bitstream = fs.readFileSync(filename)
    let p1 = bitstream.indexOf('1111111111100000000000111')
    let p2 = bitstream.indexOf('0000000000011111111111000')
    if (p1 === -1) {
      p1 = bitstream.length
    }
    if (p2 === -1) {
      p2 = bitstream.length
    }
    const p = Math.min(p1, p2)
    return bitstream.slice(p)
  }

  const bits = readBitsFile(inputFile)
  const frameCount = Math.floor(bits.length / 588)

  // Each frame has 33 symbols, and this is how they're laid out in the frame.
  // This gives an idea of the general swizzling of the bytes at a line level.
  const colormap = {
    0: [255, 204, 255], // subchannel byte
    1: [204, 255, 255], // AUDIO byte (MSB) LEFT
    2: [204, 204, 255], // AUDIO byte (LSB) LEFT
    3: [204, 255, 255], // AUDIO byte (MSB) LEFT
    4: [204, 204, 255], // AUDIO byte (LSB) LEFT
    5: [204, 255, 255], // AUDIO byte (MSB) LEFT
    6: [204, 204, 255], // AUDIO byte (LSB) LEFT
    7: [153, 255, 204], // AUDIO byte (MSB) RIGHT
    8: [153, 204, 204], // AUDIO byte (LSB) RIGHT
    9: [153, 255, 204], // AUDIO byte (MSB) RIGHT
    10: [153, 204, 204], // AUDIO byte (LSB) RIGHT
    11: [153, 255, 204], // AUDIO byte (MSB) RIGHT
    12: [153, 204, 204], // AUDIO byte (LSB) RIGHT
    13: [204, 255, 204], // error correction (C2 a.k.a. Q)
    14: [204, 255, 204], // error correction (C2 a.k.a. Q)
    15: [204, 255, 204], // error correction (C2 a.k.a. Q)
    16: [204, 255, 204], // error correction (C2 a.k.a. Q)
    17: [204, 255, 255], // AUDIO byte (MSB) LEFT
    18: [204, 204, 255], // AUDIO byte (LSB) LEFT
    19: [204, 255, 255], // AUDIO byte (MSB) LEFT
    20: [204, 204, 255], // AUDIO byte (LSB) LEFT
    21: [204, 255, 255], // AUDIO byte (MSB) LEFT
    22: [204, 204, 255], // AUDIO byte (LSB) LEFT
    23: [153, 255, 204], // AUDIO byte (MSB) RIGHT
    24: [153, 204, 204], // AUDIO byte (LSB) RIGHT
    25: [153, 255, 204], // AUDIO byte (MSB) RIGHT
    26: [153, 204, 204], // AUDIO byte (LSB) RIGHT
    27: [153, 255, 204], // AUDIO byte (MSB) RIGHT
    28: [153, 204, 204], // AUDIO byte (LSB) RIGHT
    29: [255, 255, 204], // error correction (C1 a.k.a. P)
    30: [255, 255, 204], // error correction (C1 a.k.a. P)
    31: [255, 255, 204], // error correction (C1 a.k.a. P)
    32: [255, 255, 204] // error correction (C1 a.k.a. P)
  }

  const outPNG = new png({
    width: 588,
    height: frameCount
  })

  let previous = -1
  const frames = []

  // We're going to organize the input bitstream into frames, and color the bits
  // according to their type. Since the EFM encoding ensures a lot of 0s, we're
  // going to color the 0s as the color of the channel, and the 1s as black.
  // From this point forward, we assume that the bitstream is correctly aligned
  // to the frame sync pattern, and that we have exactly 588 bits per frame. If
  // the DSP did its job properly, the recovered clock signal should be quite
  // perfect, and the bitstream should be correctly aligned.
  for (let y = 0; y < frameCount; y++) {
    let frame = ''
    for (let x = 0; x < 588; x++) {
      const b = bits[x + y * 588]
      const v = b === '0'.charCodeAt(0) ? 0 : 1

      // This essentially decodes the NRZ-I encoding. If the bit is the same as the
      // previous bit, we output a 0, otherwise we output a 1, as the NRZ-I encoding
      // only looks at the transitions between the pits and grooves.
      const o = v === previous ? 0 : 1
      previous = v
      frame += o.toString()

      let c = [255, 255, 255]

      if (x < 24) {
        c = [255, 204, 204]
      } else if ((x - 24) % 17 < 3) {
        c = [204, 204, 204]
      } else {
        c = colormap[Math.floor((x - 24) / 17)]
      }

      outPNG.data[4 * (x + y * 588) + 0] = o === 0 ? c[0] : 0
      outPNG.data[4 * (x + y * 588) + 1] = o === 0 ? c[1] : 0
      outPNG.data[4 * (x + y * 588) + 2] = o === 0 ? c[2] : 0
      outPNG.data[4 * (x + y * 588) + 3] = 255
    }
    frames.push(frame)
  }

  fs.writeFileSync('out.png', png.sync.write(outPNG))

  const normalFrameSync = '100000000001000000000010'

  // The "frameCutter" function will mangle the input frame data, and will return
  // the requested amount of bits. We use this to chop the frame into pieces.
  function frameCutter(frame, amount) {
    if (typeof amount === 'string') amount = amount.length
    const result = frame.data.substring(0, amount)
    frame.data = frame.data.substring(amount)
    return result
  }

  function getEFM(frame) {
    const slice = frameCutter(frame, 14)
    const byte = EFM[slice]
    if (byte === undefined) return -1
    return byte
  }

  function EFMToString(b) {
    if (b === -1) {
      return 'xx'
    } else if (typeof b === 'string') {
      return b
    } else {
      return b.toString(16).padStart(2, '0')
    }
  }

  function mergeBitStatus(merge) {
    if (Array.isArray(merge)) {
      return merge.reduce((c, m) => {
        if (!c) return false
        return (m.match(/1/g) ?? []).length <= 1
      }, true)
        ? 'OK'
        : 'Invalid'
    } else {
      const bits = merge.match(/1/g) ?? []
      return bits <= 1 ? 'OK' : 'Invalid'
    }
  }

  const sectors = []

  function createSector() {
    return {
      frameCount: 0,
      gotS0: false,
      gotS1: false,
      subchannel: [],
      data: [],
      c1: [],
      c2: []
    }
  }

  console.log('Parsing frames')

  let currentSector = createSector()

  const frameLog = verboseFrameLog ? console.log : x => x

  // First, we process every 588-bits frame, and extract the subchannel, the data, and the error correction bytes.
  // We will also do some basic checks to see if the frame sync is correct, and if the merge bits are correct.
  for (let frameCounter = 0; frameCounter < frames.length; frameCounter++) {
    const frame = { data: frames[frameCounter] }
    const merges = []

    frameLog()
    frameLog('******** Analyzing frame ' + frameCounter + ' ********')
    // First, we chop off the first 24 bits, hoping they are the frame sync.
    const frameSync = frameCutter(frame, normalFrameSync)
    if (frameSync === normalFrameSync) {
      frameLog('Frame Sync: OK')
    } else {
      frameLog('Frame Sync incorrect: ' + frameSync)
    }
    // Next, the merge bits after the frame sync.
    merges.push(frameCutter(frame, 3))

    // Then, we get the subchannel symbol.
    const subchannel = getEFM(frame)
    frameLog('Subchannel byte: ' + EFMToString(subchannel))
    // And the merge bits after the subchannel.
    merges.push(frameCutter(frame, 3))

    // We create a new sector when we find the S0 sync byte in the subchannel.
    if (subchannel === 'S0') {
      sectors.push(currentSector)
      currentSector = createSector()
      currentSector.gotS0 = true
      currentSector.frameCount = 1
    } else if (++currentSector.frameCount === 2 && subchannel === 'S1') {
      currentSector.gotS1 = true
    } else {
      // We have 12 subchannel bytes per sector. There's no need to store
      // S0 and S1, we only flag them.
      currentSector.subchannel.push(subchannel)
    }

    const data = []
    const c1 = []
    const c2 = []

    // At this point, we can grab the 12-4-12-4 data pattern.
    // First 12 bytes are normal data.
    for (let i = 0; i < 12; i++) {
      data.push(getEFM(frame))
      merges.push(frameCutter(frame, 3))
    }

    // Next 4 bytes are C2 error correction, inverted.
    for (let i = 0; i < 4; i++) {
      let v = getEFM(frame)
      if (typeof v === 'number' && v >= 0) v = v ^ 0xff
      c2.push(v)
      merges.push(frameCutter(frame, 3))
    }

    // Next 12 bytes are normal data again.
    for (let i = 0; i < 12; i++) {
      data.push(getEFM(frame))
      merges.push(frameCutter(frame, 3))
    }

    // Last 4 bytes are C1 error correction, inverted.
    for (let i = 0; i < 4; i++) {
      let v = getEFM(frame)
      if (typeof v === 'number' && v >= 0) v = v ^ 0xff
      c1.push(v)
      merges.push(frameCutter(frame, 3))
    }

    data.forEach(v => currentSector.data.push(v))
    c1.forEach(v => currentSector.c1.push(v))
    c2.forEach(v => currentSector.c2.push(v))

    frameLog('Data : ' + data.map(EFMToString).join(''))
    frameLog('C1   : ' + c1.map(EFMToString).join(''))
    frameLog('C2   : ' + c2.map(EFMToString).join(''))
    frameLog('Merge bits : ' + merges.join(' ') + ' ' + mergeBitStatus(merges))
  }

  frames.length = 0

  // It's highly unlikely the first sector is valid, because the capture probably started in the middle of it.
  // So just discard it unconditionally.
  sectors.shift()

  console.log()
  console.log('================================')

  console.log('Got ' + sectors.length + ' sectors')
  console.log(
    'Got ' +
    sectors.reduce((c, s) => {
      if (s.gotS0 && s.gotS1 && s.frameCount === 98) c++
      return c
    }, 0) +
    ' valid sectors'
  )

  // Due to the delayed lines, we need at least 2 sectors worth of data to be able to
  // decode it properly. If we don't have that, we can't do anything.
  if (sectors.length >= 2) {
    console.log('Parsing ' + (sectors.length - 2) + ' sectors')
  }

  const sectorLog = verboseSectorLog ? console.log : x => x
  const sectorLogError = verboseSectorLogError ? console.log : x => x

  const poly = require('jqr-poly')
  const gf = require('jqr-gf')

  for (let i = 2; i < sectors.length; i++) {
    sectorLog()
    sectorLog('******** Analyzing sector ' + (i - 1) + ' ********')

    // We start analyzing a sector by looking over its subchannel information. This
    // means we are transposing the data first.
    let isDigital = false
    let validSubchannel = true
    const subbits = [[], [], [], [], [], [], [], []]
    for (let s = 0; s < 96; s++) {
      const sb = sectors[i - 1].subchannel[s]
      if (typeof sb === 'string' || sb < 0) {
        validSubchannel = false
        break
      }
      let mask = 0x80
      for (let b = 0; b < 8; b++) {
        subbits[b][s] = (sb & mask) === 0 ? 0 : 1
        mask >>= 1
      }
    }
    if (!validSubchannel) {
      sectorLog('Invalid subchannel bytes')
    } else {
      sectorLog('Subchannels: ')
      const names = ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W']
      for (let s = 0; s < 8; s++) {
        sectorLog(' - ' + names[s] + ': ' + subbits[s].join(''))
      }

      // We're only going to analyze the P and Q channels. The others may have
      // meaning for CD-Text, and other extensions, but this is way beyond the
      // scope of this tool.
      const P = subbits[0].reduce((c, b) => c + b, 0)
      if (P === 96) {
        sectorLog('P channel indicates gap')
      } else if (P === 0) {
        sectorLog('P channel indicates inside track')
      } else {
        sectorLog('Invalid P channel')
      }

      sectorLog('Decoding Q channel')
      const Q = subbits[1]
      // Decoding Q is a bit more involved, as its fields have different
      // meaning depending on the prefix bits, hence the length of the
      // following code. It's not complex code, just catering for all
      // the cases for the Q channel according to the spec.

      // control bits
      if (Q[0] === 0 && Q[1] === 0) {
        if (Q[3] === 0) {
          sectorLog(' . 2 audio channels without pre-emphasis')
        } else {
          sectorLog(' . 2 audio channels with pre-emphasis 50/15 us')
        }
      }
      if (Q[0] === 0) {
        if (Q[2] === 0) {
          sectorLog(' . copy prohibited')
        } else {
          sectorLog(' . copy permitted')
        }
      }
      if (Q[0] === 0 && Q[1] === 1 && Q[3] === 0) {
        sectorLog(' . digital data')
        isDigital = true
      }
      if (Q[0] === 1) {
        sectorLog(' . broadcasting use')
      }

      // address bits
      const adr = (Q[4] << 3) | (Q[5] << 2) | (Q[6] << 1) | (Q[7] << 0)
      let crc = 0
      let mask = 0x8000
      for (let i = 80; i < 96; i++) {
        if (Q[i] === 1) crc |= mask
        mask >>= 1
      }
      sectorLog(' . ADR: ' + adr)

      // Not in the mood for generating the memoization for the CRC-16, and
      // this only checks a few bits, so going for the academic implementation.
      // Polynomial is x^16 + x^12 + x^5 + 1
      const poly = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      const check = Q.map(x => x)
      for (let i = 0; i < Q.length - poly.length + 1; i++) {
        if (check[i] === 1) {
          for (let j = 0; j < poly.length; j++) {
            check[i + j] ^= poly[j]
          }
        }
      }

      const count = check.reduce((c, v) => c + v, 0)
      const dataQ = Q.slice(8, 80)
      sectorLog(
        ' . CRC: ' +
        crc.toString(16).padStart(4, '0') +
        ' - ' +
        (count === 16 ? 'valid' : 'invalid')
      )
      sectorLog('Decoding Data-Q')
      switch (adr) {
        case 0: {
          sectorLog(
            ' . Mode 0: ' +
            (dataQ.reduce((c, v) => c + v, 0) === 0 ? 'Valid' : 'Invalid')
          )
          break
        }
        case 1: {
          // mode 1 is the most common type, and is required to occupy at least 90% of the contents
          const bcd = []
          for (let j = 0; j < 9; j++) {
            let v = 0
            let mask = 0x80
            for (let i = 0; i < 8; i++) {
              if (dataQ[j * 8 + i] === 1) v |= mask
              mask >>= 1
            }
            bcd.push(v.toString(16).padStart(2, '0'))
          }
          const TNO = bcd[0]
          switch (TNO) {
            case 0x00: {
              sectorLog(
                ' . Mode 1, LeadIn, POINT:' +
                bcd[1] +
                ' MIN:' +
                bcd[2] +
                ' SEC:' +
                bcd[3] +
                ' FRAME:' +
                bcd[4] +
                ' ZERO:' +
                bcd[5] +
                ' P-MIN:' +
                bcd[6] +
                ' P-SEC:' +
                bcd[7] +
                ' P-FRAME:' +
                bcd[8]
              )
              break
            }
            default: {
              sectorLog(
                ' . Mode 1, ' +
                (TNO === 0xaa ? ' LeadOut,' : 'TNO:' + TNO) +
                ' X:' +
                bcd[1] +
                ' MIN:' +
                bcd[2] +
                ' SEC:' +
                bcd[3] +
                ' FRAME:' +
                bcd[4] +
                ' ZERO:' +
                bcd[5] +
                ' A-MIN:' +
                bcd[6] +
                ' A-SEC:' +
                bcd[7] +
                ' A-FRAME:' +
                bcd[8]
              )
              break
            }
          }
          break
        }
        case 2: {
          // if mode 2 is used, it needs to occupy at least 1% of the contents
          const bcd = []
          for (let j = 0; j < 18; j++) {
            let v = 0
            let mask = 0x08
            for (let i = 0; i < 4; i++) {
              if (dataQ[j * 4 + i] === 1) v |= mask
              mask >>= 1
            }
            bcd.push(v.toString(16))
          }
          sectorLog(
            ' . Mode 2, UPC: ' +
            bcd.slice(0, 13).join('') +
            ' A-FRAME: ' +
            bcd.slice(16, 18).join('')
          )
          break
        }
        case 3: {
          // if mode 3 is used, it needs to occupy at least 1% of the contents
          const bcd = []
          for (let j = 0; j < 18; j++) {
            let v = 0
            let mask = 0x08
            for (let i = 0; i < 4; i++) {
              if (dataQ[j * 4 + i] === 1) v |= mask
              mask >>= 1
            }
            bcd.push(v.toString(16))
          }
          const l = []
          for (let j = 0; j < 5; j++) {
            let v = 0
            let mask = 0x20
            for (let i = 0; i < 6; i++) {
              if (dataQ[j * 6 + i] === 1) v |= mask
              mask >>= 1
            }
            l.push(v)
          }
          const abc = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
          sectorLog(
            ' . Mode 3, ISRC: ' +
            l.map(v => abc[v]).join('') +
            bcd.slice(8, 15).join('') +
            ' A-FRAME: ' +
            bcd.slice(16, 18).join('')
          )
          break
        }
        default: {
          const bcd = []
          for (let j = 0; j < 18; j++) {
            let v = 0
            let mask = 0x08
            for (let i = 0; i < 4; i++) {
              if (dataQ[j * 4 + i] === 1) v |= mask
              mask >>= 1
            }
            bcd.push(v.toString(16))
          }
          sectorLog(' . Mode ' + adr + ', unknown format: ' + bcd.join(''))
          break
        }
      }
    }
    // This was all for the Q channel according to the spec.

    // Allocate the sector buffer here, since it'll be used in the rest of
    // the scope, but it's only going to be used near the end.
    const sectordata = Buffer.alloc(2352)

    // This helper function is a read-write accessor for the delayed bytes.
    // Given a delay value, a row, and a column, it will return the value of the
    // byte at that position, or set it if a value is provided. It's a bit of a
    // virtual array accessor, considering the data as an infinite number of rows
    // for 32 columns, hopping around the data, c1, and c2 fields.
    const delayedByte = (delay, row, column, value) => {
      let sectorNumber = i
      while (row < delay) {
        sectorNumber--
        delay -= 98
      }
      row -= delay

      if (column < 12) {
        const idx = 24 * row + column
        if (value !== undefined) sectors[sectorNumber].data[idx] = value
        return sectors[sectorNumber].data[idx]
      } else if (column < 16) {
        const idx = 4 * row + column - 12
        if (value !== undefined) sectors[sectorNumber].c2[idx] = value
        return sectors[sectorNumber].c2[idx]
      } else if (column < 28) {
        const idx = 24 * row + column - 4
        if (value !== undefined) sectors[sectorNumber].data[idx] = value
        return sectors[sectorNumber].data[idx]
      } else {
        const idx = 4 * row + column - 28
        if (value !== undefined) sectors[sectorNumber].c1[idx] = value
        return sectors[sectorNumber].c1[idx]
      }
    }

    for (let r = 0; r < 98; r++) {
      // We start with processing C1, gathering all of the data for it, and
      // checking for errors. Note this will naturally cover C2 as part of
      // the processing, and the fact it's also delayed itself means that
      // the whole of the data covered by the ECC of a single frame is a
      // weird criss cross pattern trough the data. More importantly, the
      // coverage of a data line may happen in the future or in the past
      // for a given ECC line, which means that when correcting errors,
      // the order of operations is extremely important. This whole tool
      // would need to be reworked to do this properly to account for
      // this time-traveling aspect of the data.
      {
        const syndromes = []
        const coeffs = []
        const erasures = []
        const erratas = []
        let gotError = false
        for (let b = 0; b < 32; b++) {
          // The delay for C1 is luckily simple: it's either 0 or 1, depending
          // on the column's parity.
          const v = delayedByte(b % 2, r, b)
          if (v < 0) {
            coeffs[b] = 0
            erasures.push(gf.exp(31 - b))
            erratas.push(b)
          } else {
            coeffs[b] = v
          }
        }
        // Fairly certain the jqf.poly library is buggy, and that sometimes,
        // it will result in the wrong evaluation. I've somewhat narrowed it
        // down to when one of the recovery bytes have 0s in them, and I
        // think the library is taking the wrong shortcut as a result, but
        // I'm not exactly in the mood for fishing for this. This means this
        // may rarely yield false negatives. Same with the C2 calculation
        // below.
        const polynomial = poly.create(coeffs, gf)
        let e = 1
        for (let s = 0; s < 4; s++) {
          const syndrome = polynomial.evaluate(e)
          if (syndrome !== 0) gotError = true
          syndromes.push(syndrome)
          e *= 2
        }
        if (gotError) {
          sectorLogError(
            'C1 sector: ' + i + ', row: ' + r + ', syndromes: ' + syndromes
          )
          sectorLogError('C1 corrupted data: ' + coeffs)
          const hcoeffs = []
          for (let i = 0; i < coeffs.length; i++) {
            hcoeffs[i] = tohex(coeffs[i])
          }
          sectorLogError('C1 corrupted data: ' + hcoeffs)
          const originalSyndromes = [...syndromes]
          erasures.forEach(e => {
            for (let s = 0; s < syndromes.length - 1; s++) {
              syndromes[s] = gf.mul(syndromes[s], e) ^ syndromes[s + 1]
            }
          })
          sectorLogError('C1 Forney syndromes: ' + syndromes)
          let locator = poly.create([1], gf)
          let old = poly.create([1], gf)
          for (let K = 0; K < 4 - erasures.length; K++) {
            let delta = syndromes[K]
            for (let l = 0; l < locator.getDegree(); l++) {
              const c = locator.getCoefficient(locator.getDegree() - l)
              const s = syndromes[K - l - 1]
              const m = gf.mul(c, s)
              delta = gf.add(delta, m)
            }
            old = old.multiplyByMonomial(1, 1)
            if (delta !== 0) {
              if (old.getDegree() > locator.getDegree()) {
                const t = old.multiplyScalar(delta)
                old = locator.multiplyScalar(gf.inv(delta))
                locator = t
              }
              locator = locator.add(old.multiplyScalar(delta))
            }
          }
          // TODO: Apply error correction here. At this point, the math becomes horrendous,
          // and I don't have the patience to do it. Furthermore, the jqr-gf library is
          // buggy, and it fails to perform the math for it properly. Plus, see the comment
          // at the top of this loop about time travel. At least we can see the errors.
          sectorLogError('C1 Locator: ' + locator.getCoefficients())
          let e = 1
          for (let p = 31; p >= 0; p--) {
            const r = locator.evaluate(e)
            if (r === 0) erratas.push(p)
            e *= 2
          }
          sectorLogError('C1 Erratas: ' + erratas)
        }
      }

      // Next we process C2, which is more complex, as its delayed lines are
      // not so simple. The `delayed` array below hardcodes the pattern of
      // the delayed lines. This is otherwise the same sort of processing as
      // the above, so this is technically copy/pasted. I avoided factorizing
      // this however for clarity.
      {
        const syndromes = []
        const coeffs = []
        const erasures = []
        const erratas = []
        let gotError = false
        const delayed = [
          107, 104, 99, 96, 91, 88, 83, 80, 75, 72, 67, 64, 59, 56, 51, 48, 43,
          40, 35, 32, 27, 24, 19, 16, 11, 8, 3, 0
        ]
        for (let b = 0; b < 28; b++) {
          const v = delayedByte(delayed[b], r, b)
          if (v < 0) {
            coeffs[b] = 0
            erasures.push(gf.exp(31 - b))
            erratas.push(b)
          } else {
            coeffs[b] = v
          }
        }
        const polynomial = poly.create(coeffs, gf)
        let e = 1
        for (let s = 0; s < 4; s++) {
          const syndrome = polynomial.evaluate(e)
          if (syndrome !== 0) gotError = true
          syndromes.push(syndrome)
          e *= 2
        }
        if (gotError) {
          sectorLogError(
            'C2 sector: ' + i + ', row: ' + r + ', syndromes: ' + syndromes
          )
          sectorLogError('C2 corrupted data: ' + coeffs)
          const hcoeffs = []
          for (let i = 0; i < coeffs.length; i++) {
            hcoeffs[i] = tohex(coeffs[i])
          }
          sectorLogError('C2 corrupted data: ' + hcoeffs)
          const originalSyndromes = [...syndromes]
          erasures.forEach(e => {
            for (let s = 0; s < syndromes.length - 1; s++) {
              syndromes[s] = gf.mul(syndromes[s], e) ^ syndromes[s + 1]
            }
          })
          sectorLogError('C2 Forney syndromes: ' + syndromes)
          let locator = poly.create([1], gf)
          let old = poly.create([1], gf)
          for (let K = 0; K < 4 - erasures.length; K++) {
            let delta = syndromes[K]
            for (let l = 0; l < locator.getDegree(); l++) {
              const c = locator.getCoefficient(locator.getDegree() - l)
              const s = syndromes[K - l - 1]
              const m = gf.mul(c, s)
              delta = gf.add(delta, m)
            }
            old = old.multiplyByMonomial(1, 1)
            if (delta !== 0) {
              if (old.getDegree() > locator.getDegree()) {
                const t = old.multiplyScalar(delta)
                old = locator.multiplyScalar(gf.inv(delta))
                locator = t
              }
              locator = locator.add(old.multiplyScalar(delta))
            }
          }
          // TODO: correct errors. See the comment in C1's algorithm.
          sectorLogError('C2 Locator: ' + locator.getCoefficients())
          let e = 1
          for (let p = 31; p >= 0; p--) {
            const r = locator.evaluate(e)
            if (r === 0) erratas.push(p)
            e *= 2
          }
          sectorLogError('C2 Erratas: ' + erratas)
        }
      }

      // Now that C1 and C2 are finished processing, we can now gather the
      // data for the sector.

      // This is a swizzling pattern for the data, but not the only valid one.
      // This one was chosen because it is straddling the buffer the least, but
      // dumping bitstreams from different discs manufactured by different means
      // will definitely yield different patterns. This is a row-column swizzling
      // pattern, and that's the meaning of each entry in the array.
      const delayeddata = [
        [3, 1], [0, 0], [27, 7], [24, 6], [65, 17], [62, 16], [89, 23], [86, 22],
        [11, 3], [8, 2], [35, 9], [32, 8], [73, 19], [70, 18], [97, 25], [94, 24],
        [19, 5], [16, 4], [43, 11], [40, 10], [81, 21], [78, 20], [105, 27], [102, 26]
      ]

      for (let d = 0; d < 24; d++) {
        // This "106" here can also vary depending on the disc. Here it's just max
        // row-delay + 1, but I've seen some wildly different values from one disc
        // to another.
        const delay = 106 - delayeddata[d][0]
        const column = delayeddata[d][1]
        const delayed = delayedByte(delay, r, column)
        const offset = r * 24 + d
        sectordata[offset] = delayed
      }
    }

    // We're almost done.
    if (dumpSectorData) {
      console.log('Swizzled sector:')
      console.log(hexer(Buffer.from(sectors[i].data), { group: 1, cols: 24 }))
      console.log('Re-ordered sector:')
      console.log(hexer(sectordata, { group: 1, cols: 24 }))
    }

    let descrambled = false
    if (isDigital) {
      // If we got the hint that this sector may be data, look for the sync pattern,
      // and de-scramble the payload.
      const sync = sectordata.indexOf(Uint8Array.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]))
      if (sync !== -1) {
        descrambled = true
        sectorLog('Digital data sync pattern found at offset ' + sync + ' (0x' + tohex(sync) + ')')
        for (let i = 12; i < 2352; i++) {
          // This may look weird, but remember that there's no proper synchronization between
          // subchannel and data, so the actual data may start virtually anywhere in the sector.
          // However, the PRNG for the scrambling is always starting at the beginning of the
          // data payload, which is always at offset 12. Hence the weird modulo.
          sectordata[(i + sync) % 2352] ^= scrambleLUT[i - 12]
        }
      } else {
        sectorLog('Digital data bit set, but no sync pattern found')
      }
    }

    // All done, flush everything and move on to the next sector.
    if (dumpSectorData && descrambled) {
      console.log('Decoded sector:')
      console.log(hexer(sectordata, { group: 1, cols: 24 }))
    }

    if (outputFile) {
      outputFile.write(Buffer.alloc(2352, sectordata, null))
      for (let s = 0; s < 96; s++) {
        const b = sectors[i - 1].subchannel[s]
        outputFile.write(Buffer.alloc(1, [b], null))
      }
    }

    if (cookedFile) {
      cookedFile.write(Buffer.alloc(2352, sectordata, null))
    }
  }

  if (outputFile) {
    outputFile.end()
  }

  if (cookedFile) {
    cookedFile.end()
  }
}

main()
  .then(ret => process.exit)
  .catch(err => {
    throw err
  })
