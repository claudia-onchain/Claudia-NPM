// Cheap, dependency-free media sniffing: mime type, image dimensions, audio/video duration.
// Anything we can't read quickly is simply left out.

export interface Sniffed {
  mime?: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "application/octet-stream": "bin",
};

export function extFor(mime: string): string {
  return EXT[mime.split(";")[0]!.trim().toLowerCase()] ?? "bin";
}

export function mimeFromPath(p: string): string | undefined {
  const ext = p.split("?")[0]!.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  };
  return ext ? map[ext] : undefined;
}

const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) + b[o + 1]!;
const u32le = (b: Uint8Array, o: number) => b[o]! + (b[o + 1]! << 8) + (b[o + 2]! << 16) + ((b[o + 3]! << 24) >>> 0);
const u16le = (b: Uint8Array, o: number) => b[o]! + (b[o + 1]! << 8);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function sniff(b: Uint8Array): Sniffed {
  if (b.length < 12) return {};
  // PNG
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: "image/jpeg", ...jpegSize(b) };
  // GIF
  if (ascii(b, 0, 3) === "GIF") return { mime: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
  // RIFF: WebP / WAV
  if (ascii(b, 0, 4) === "RIFF") {
    const kind = ascii(b, 8, 4);
    if (kind === "WEBP") return { mime: "image/webp", ...webpSize(b) };
    if (kind === "WAVE") return { mime: "audio/wav", ...wavDuration(b) };
  }
  // ISO BMFF (mp4 / mov / m4a)
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    const mime = brand === "qt  " ? "video/quicktime" : brand.startsWith("M4A") ? "audio/mp4" : "video/mp4";
    return { mime, ...mp4Info(b) };
  }
  // WebM / Matroska
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: "video/webm" };
  if (ascii(b, 0, 4) === "OggS") return { mime: "audio/ogg" };
  if (ascii(b, 0, 4) === "fLaC") return { mime: "audio/flac" };
  // MP3 (ID3 tag or frame sync)
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return { mime: "audio/mpeg", ...mp3Duration(b) };
  return {};
}

function jpegSize(b: Uint8Array): Sniffed {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const m = b[o + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      o += 2;
      continue;
    }
    o += 2 + u16be(b, o + 2);
  }
  return {};
}

function webpSize(b: Uint8Array): Sniffed {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === "VP8L") {
    const n = u32le(b, 21);
    return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
  }
  return {};
}

function wavDuration(b: Uint8Array): Sniffed {
  let o = 12;
  let byteRate = 0;
  while (o + 8 <= b.length) {
    const id = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    if (id === "fmt ") byteRate = u32le(b, o + 16);
    if (id === "data" && byteRate) return { durationSec: round(Math.min(size, b.length - o - 8) / byteRate) };
    o += 8 + size + (size % 2);
  }
  return {};
}

/** Walks moov → mvhd (duration) and the first video tkhd (width/height). */
function mp4Info(b: Uint8Array): Sniffed {
  const out: Sniffed = {};
  const walk = (start: number, end: number, depth: number) => {
    let o = start;
    while (o + 8 <= end && depth < 6) {
      let size = u32be(b, o);
      const type = ascii(b, o + 4, 4);
      let header = 8;
      if (size === 1) {
        size = u32be(b, o + 8) * 2 ** 32 + u32be(b, o + 12);
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header) return;
      const boxEnd = Math.min(o + size, end);
      if (type === "moov" || type === "trak") walk(o + header, boxEnd, depth + 1);
      else if (type === "mvhd" && out.durationSec === undefined) {
        const v = b[o + header]!;
        const p = o + header + 4;
        if (v === 1) {
          const ts = u32be(b, p + 16);
          const dur = u32be(b, p + 20) * 2 ** 32 + u32be(b, p + 24);
          if (ts) out.durationSec = round(dur / ts);
        } else {
          const ts = u32be(b, p + 8);
          const dur = u32be(b, p + 12);
          if (ts) out.durationSec = round(dur / ts);
        }
      } else if (type === "tkhd" && out.width === undefined) {
        const w = u32be(b, boxEnd - 8) / 65536;
        const h = u32be(b, boxEnd - 4) / 65536;
        if (w > 0 && h > 0) {
          out.width = Math.round(w);
          out.height = Math.round(h);
        }
      }
      o += size;
    }
  };
  walk(0, b.length, 0);
  return out;
}

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** Rough duration for constant-bitrate MPEG-1 Layer III (what TTS APIs return). */
function mp3Duration(b: Uint8Array): Sniffed {
  let o = 0;
  if (ascii(b, 0, 3) === "ID3") o = 10 + ((b[6]! << 21) | (b[7]! << 14) | (b[8]! << 7) | b[9]!);
  for (; o + 4 < b.length && o < 64 * 1024; o++) {
    if (b[o] === 0xff && (b[o + 1]! & 0xfe) === 0xfa) {
      const kbps = MP3_BITRATES[b[o + 2]! >> 4];
      if (kbps) return { durationSec: round(((b.length - o) * 8) / (kbps * 1000)) };
    }
  }
  return {};
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Wraps raw 16-bit little-endian PCM (what Gemini TTS returns) in a WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true);
  v.setUint16(32, (channels * bitsPerSample) / 8, true);
  v.setUint16(34, bitsPerSample, true);
  w(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
