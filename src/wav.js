// WAV-fil, 16 bitar PCM, en kanal
'use strict';

function wav(samples, rate) {
    const n = samples.length;
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0, 'ascii');
    b.writeUInt32LE(36 + n * 2, 4);
    b.write('WAVE', 8, 'ascii');
    b.write('fmt ', 12, 'ascii');
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);          // PCM
    b.writeUInt16LE(1, 22);          // mono
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 2, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36, 'ascii');
    b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(samples[i], 44 + i * 2);
    return b;
}

// Läser en WAV-fil från wav() (för testerna och verktygen)
function readWav(buf) {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('inte WAV');
    const rate = buf.readUInt32LE(24);
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
        if (id === 'data') {
            const n = Math.floor(Math.min(len, buf.length - off - 8) / 2);
            const s = new Int16Array(n);
            for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(off + 8 + i * 2);
            return { rate, samples: s };
        }
        off += 8 + len + (len & 1);
    }
    throw new Error('ingen data i WAV-filen');
}

module.exports = { wav, readWav };
