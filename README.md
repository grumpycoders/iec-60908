## What?
The iec-60908 standard (also known as the Red Book) describes how
[optical discs](https://en.wikipedia.org/wiki/Optical_disc) known
as [Compact discs](https://en.wikipedia.org/wiki/Compact_disc) work.
The information in this document is very abstract, and represents a
very real challenge to anyone trying to make heads or tails of how
the data is organized on the disc, and even less how to generate
said data stream.

This repository is a collection of research notes and tools, aiming
at grounding the mathematics behind all this into actionable code
and knowledge. [Disc rot](https://en.wikipedia.org/wiki/Disc_rot)
is a very real issue, and threatens preservation of our culture and
knowledge, and having better tools to not only read, but recreate
the information from such medium is a step forward in archival
efforts.

This documentation doesn't really go much into upper level details such
as the format of data sectors, format of subchannels, or filesystem
information, the format of the table of contents, or the way the
audio data is stored, as these are fully and often properly
documented in other places. Only relevant portions will be mentioned.

## Pits and grooves
The surface of a compact disc is covered in microscopic holes, which
form a series of pits and grooves, also known as pits and lands.
While this is well know, and the internet has lots of research showing
the surface of a compact disc through a microscope, the way this
actually translates to data isn't that well documented.

### NRZ-I encoding
The pits and grooves represent an [NRZ-I](https://en.wikipedia.org/wiki/Non-return-to-zero#Non-return-to-zero_inverted)
encoded bitstream. In layman's terms, it means that a binary '1' is
encoded by the presence of a transition from a pit to a groove, or
from a groove to a pit, whereas a binary '0' is encoded by the
absence of transition. This is important because the real bitstream
to consider while looking at the surface of a disc is the decoded
NRZ-I one. The rest of this document will mostly focus on the
bitstream after being decoded from the NRZ-I representation.

### General bitstream
The bitstream extracted from the NRZ-I decoder reading the pits and
grooves isn't exactly random. The arrangement of bits follow some
rules governed by the EFM encoding. We will be discussing the
EFM encoding a bit later, but the important aspects for this part of
the discussion are:
 - The data is organized in what's called "frames".
 - A frame is exactly 588 bits of EFM-encoded data.
 - A sector is exactly 98 frames.
 - The EFM encoding mandates the following properties:
   - Any 1 has to be followed by at least 2 zeroes.
   - Any 1 has to be followed by at most 10 zeroes.

Doing some math on this yields the following important property:
 - At 1x speed, an audio sector lasts for 1/75th of a second.
 - At 588 bits per frame, 98 frames per sector, this gives us:
   - $`588 * 98 * 75 = 4321800`$ bits per second.

This means that the bitstream read from the disc when it's playing
at 1x speed can be seen as a 4.3218Mhz data stream. Any other
reading speed above that would simply be a multiple of the base
4.3218Mhz clock rate.

### Initial data capture
Capturing the raw bitstream with a logic analyzer hooked on the
amplifier circuit of a CD player while it is reading an audio
disc yields the following result when sampling at exactly
4.3218Mhz:

![A wavy pattern of bits, with obvious repetitions.](images/cropped-skewed-bitstream.png)

A fuller version of the above can be obtained [here](images/skewed-bitstream.png).
Each 1 is represented as a black pixel, and each 0 is represented
as a white pixel. While this is a 2D picture, it represents the input
data which is really just a bitstream. By arranging them in groups
of 588 bits, we can better see the arrangement of the data frame by
frame.

Several things to note there:
 - Some data patterns emerge. We will talk more about them a bit later.
 - There is only a bitstream, and no clock channel.
 - The data captured at exactly 4.3218Mhz is "wavy". This is caused
by the physical aspect of the drive, which has a motor running off a
PWM, using an internal feedback loop.
 - This also means that each line isn't perfectly one frame, but only
an approximation thereof.
 - The DSP responsible for decoding the bistream will be the one:
   - Creating an actual clock rate to decode the input properly.
   - Managing the PWM of the motor, in order to provide an acceptable
general bitrate.
   - Buffer the decoded data so that the output rate is within
acceptable tolerances, while speeding up or slowing down the motor
accordingly.

### Clock recovery
As mentioned above, there is no clock channel, so we need to do something
to reconstitute the bitstream clock.

Due to the nature of the EFM bitstream, with not a lot of 1s separated
by a lot of 0s, at distances between 2 and 10, it is technically possible
to write a [clock recovery](https://en.wikipedia.org/wiki/Clock_recovery)
algorithm to reconstitute an appropriate clock rate.

However, this is already something that the DSP of a CD player
has to do when decoding a bitstream. It turns out that the DSP of a
[PlayStation console](https://en.wikipedia.org/wiki/PlayStation_(console))
has debugging pins with the raw NRZ-I encoded bistream, and the recovered
clock, named "ASYO" and "XPLCK" respectively:

![A picture of a PS1 motherboard, with the debug pads for the pins ASYO and XPLCK marked.](images/dsp-pinout.png)

Capturing these two signals, and processing the data to decode the bitstream
according to the recovered clock from the DSP yields a much better picture:

![A straight pattern of bits, with obvious repetitions.](images/cropped-bitstream.png)

A fuller version of the above can be obtained [here](images/bitstream.png).

## Data interpretation
Once we have the bitstream from the pits and gooves as described above,
we can start interpreting the data according to the documentation.

The EFM encoder maps 258 symbols into a fourteen bits structure, which
follows the constrains explained above regarding the amount of 0s
between 1s. 256 of these symbols directly map to bytes, and two of these
symbols are used to indicate submarkers. These two symbols are called
S0 and S1, and we'll talk about them a bit later. The word "EFM" means
"Eight-to-Fourteen Modulation".

### Composition of a frame
Each 588 bits frame begins with a very specific 24-bits sync pattern,
which can not collide with any of the 258 EFM symbols, while still
respecting the 0s-to-1s bitstream ratio. This sync pattern is
100000000001000000000010, and is very visible in the various captures
from above. In the [straightened capture](images/cropped-bitstream.png),
this is the vertical clear lines on the right of the picture.

Each frame contains 33 symbols which, when properly formed, are one of
the 258 defined EFM symbols. Each symbol is 11 bits long. And finally,
each symbol as well as the 24-bits sync pattern is separated from each
other using 3 "merge bits".

This math goes back to what was explained before: 24 bits of sync pattern,
33 symbols of 14 bits, 34 merge bits which are 3 bits long, means we have
$`24 + 33 * 14 + 34 * 3 = 588`$ bits per frame.

The point of the merge bits is to properly support the 0-to-1 balance
imposed by the specification. Since some EFM symbols end or begin with 1s,
without the merge bits, they may violate the minimum distance between
two 1s. This means constructing a merge bit sequence involves knowing
the last 2 bits, and the next 2 bits of the bitstream. As a result,
it is a lot more practical to write merge bits before writing a symbol
to the bitstream, instead of after, since it's easier to remember what
the last two bits were, instead of trying to oracle what the next two
bits will be. This will be discussed in more details later.

If we align the frames starting from the sync pattern, and colorize each
EFM symbol with a different color, we can obtain the following picture:

![A colorized bitstream from the pits and grooves.](images/colorized.png)

On this picture, the 24-bits sync pattern is aligned completely to the
left, the merge bits columns are in gray, and all of the 33 EFM symbols
are presented with different colors, depending of their meaning, which
we will discuss now.

### Subchannel
The first EFM symbol of a frame is for the subchannel. The subchannel is
a piece of data which is often misunderstood, and needs some special 
detailing to properly clarify what is going on here.

When reading subchannel information from a high level perspective, aka
by talking to a CD-Rom drive using the ATAPI protocol, subchannel
information will come in the form of a maximum of 96 bytes per burst.

The subchannel is composed of 8 columns, named P to W. The full meaning
of all these columns is documented in the
[Red Book](https://github.com/suvozy/CD-Copy-protect), and aren't totally
useful for the purpose of this documentation. We can summarize the
information by saying the following:
 - P is either 96 bits of 0s, or 96 bits of 1s,
and give rough information about where in the disc we are, in terms of
being in lead-in, lead-out, or pre-gaps.
 - Q is some side-channel metadata, usually indicating what is the
current location of roughly the data this subchannel is.

Since subchannels are 96 bytes long, the top 2 subchannels symbols are
special symbols, called S0 and S1, which indicate the beginning of a
subchannel 96-bytes stream.

Aside from these two special EFM symbols every 98 frames, every other
symbol found in the bitstream, when well-formed, will be one out of
256 values, directly mapping to bytes.

One important piece of information from this is the subchannel stream
is treated as a side channel for the purpose of data transfer end-to-end.
What this means is that the S0/S1 symbols only indicate the beginning
of a subchannel stream, and has no relationship with the actual data
in the frame.

### Data
As explained just above, the remaining 32 symbols in a frame are always
bytes, and can now be referred to as such.

These 32 bytes are organized as such:
 - 12 bytes of payload data.
 - 4 bytes of error correcting code, called C2.
 - 12 bytes of payload data.
 - 4 bytes of error correcting code, called C1.

However, and this is really the complex part of the whole CIRC encoder
here, the data isn't stored linearly. This is going to be very difficult
to explain properly, but also, it doesn't necessarily represent a huge
deal implementation-wise.

Basically, the stream of frames can be seen as 32 columns with an
infinite number of lines. When starting to read a frame from the first
column, the reader needs to read in the past buffer following an
upward zig-zag pattern.

In other words, while one frame is organized in the form of 12-4-12-4
bytes, they are in relation to each other not linearly in the frames
stream, but following this zig-zag pattern.

Worse: the C1 and C2 error correction code are correcting values for
bytes that are from a _different_ zig-zag pattern. Gathering the list
of bytes for C1 and C2 isn't the same mechanism as gathering the list
of bytes for the actual payload in a given frame, and the correction of
bytes throughout the buffer by the DSP using C1 and C2 is done
asynchronously from the processing of the data itself.

When stored into a frame, C1 and C2 are inverted, meaning they are
xored with 0xff. Note that C1 is computed with C2's data _before_ the
inversion. As the ECC of a message full of zeroes is zero, this means
that the C1 and C2 error correcting codes are also zero when the data
itself is zero. In other words, a fully silent section of frames will
have all of its data bytes set to zero, and all of its C1 and C2 bytes
set to 0xff.

Finally, there is no sector delimitation. This is a very important
part of the whole specification. The data is an infinite stream of bytes,
which is played back at the rate of 176400 bytes per second at 1x
speed. The presence of a subchannel which sometimes indicates MSF
positions through the Q column doesn't actually delimitate anything. The
zig-zag delayed pattern as described above may begin at any point from
the original stream, and isn't a fixed value from one burner to another.

This is very relevant when processing data sectors. The first 16 bytes
of a data sector are as follow:
 - 12 bytes of a "sync" pattern, looking like this:
`00 ff ff ff ff ff ff ff ff ff ff 00`
 - 3 bytes of MSF position.
 - 1 byte of sector mode.

This 16 bytes header serves two purposes for the DSP:
 - Locate the beginning of a data sector.
 - Knowing the exact address of said sector, as the subchannel information
is unreliable at best.

Audio sectors having strictly no such information, it is impossible and
pointless to try to deterministically split them into sectors.

A few ways one can verify this:
 - Using different CD-R writers to write the same audio stream, and
read it back using the dumping method above. The measured drift will
be different from one master disc to another. Worse: the drift may
even happen _per column_, meaning the start of a sector may effectively
be in column 2, or column 16, or column 20, depending on the strategy
used by the CD-R writer.
 - The presence of a data track before the audio tracks can be used to
re-align the audio sectors, as the data sectors have their own sync
pattern. For discs that have been written in DAO mode, the audio data
will be written immediately after the data track, and the drift will
then be exactly the same throughout the whole disc.
 - Some audio discs available in retail have been badly mastered, and
contain [RIFF](https://en.wikipedia.org/wiki/Resource_Interchange_File_Format)
headers from their original [.wav](https://en.wikipedia.org/wiki/WAV)
files. Said headers can be sometimes seen in known dumps as being in
the middle of a so-called "audio sector", even after it was appearing
after a data track, instead of being at exactly offset 0 or 150 sectors.
 - However, all of the discs manufactured by the same company, using the
same mastering devices, will have the same drift between the subchannel
sync symbols and the actual data, so care must be taken to select discs
from different manufacturers to verify this.

### Reed-Solomon
The C1 and C2 codes in the data stream are Reed-Solomon error correcting
codes. C2 is a (28,24) code, covering 12 bytes of data, for 4 bytes of
recovery bytes, while C1 is a (32,28) code, covering 16 bytes of data,
for 4 bytes of recovery bytes. See the
[Reed–Solomon codes for coders](https://en.wikiversity.org/wiki/Reed%E2%80%93Solomon_codes_for_coders)
wikiversity page for more information about error correcting codes,
Galois fields, and Reed Solomon.

Several important details:
 - C1 covers C2. This means that a DSP will correct errors in a specific
order to make sense, and correcting C1 first may very well silence C2
problems. But either can theorically be done in any order to correct
data, and one or the other showing up in the DSP diagnostics doesn't
really have any indication in the gravity of the problems.
 - C1 and C2 do not cover the same data bytes, as they do not have the
same delayed patterns to gather their data. As such, they will help cover
different shapes of scratches on the disc.
 - C2 has its correcting bytes in the middle of the data it's covering.
This means the typical barrel-shifter Reed Solomon encoder will not
work, as it will place the correcting data at the end. So while encoding
C1 can be done using either typical method for Reed-Solomon, C2 needs
to use a matrix multiplication to be calculated. The reasoning for C2
to be in the middle of the data line is to be more equidistant from C1
in terms of data frequency, to better cover scratches and holes.
 - When locating and correcting errors, Reed Solomon no longer has
concepts of which bytes are from the initial message, and which are
from the error correcting code. This means that, despite being in a
different location in the frame, the C1 and C2 codes are decoded and
corrected using the same exact algorithm.
 - Theoretically, Reed Solomon can correct only 2 bytes when 4 recovery
bytes have been used, but since the EFM decoder can also detect invalid
sequences of bits, this is an added information sent to the Reed Solomon
decoder known as "erasures", and can end up correcting more bytes as
a result.
