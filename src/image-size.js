/** Width/height from a PNG, JPEG, GIF, or WebP buffer. No dependencies. */

export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return pngSize(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return gifSize(buf);
  if (buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return webpSize(buf);
  return null;
}

export function imageSizeFromDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:image/')) return null;
  const i = url.indexOf('base64,');
  if (i < 0) return null;
  try {
    return imageSize(Buffer.from(url.slice(i + 7), 'base64'));
  } catch {
    return null;
  }
}

function pngSize(buf) {
  // signature (8) + length (4) + 'IHDR' (4) + width/height
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  const version = buf.toString('ascii', 3, 6);
  if (version !== '87a' && version !== '89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) return null;
  return { width, height };
}

function jpegSize(buf) {
  let offset = 2;
  while (offset + 8 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset++;
      marker = buf[offset + 1];
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
    if (marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; }
    const size = buf.readUInt16BE(offset + 2);
    if (size < 2) return null;
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 8 >= buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    offset += 2 + size;
  }
  return null;
}

function webpSize(buf) {
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (type === 'VP8X' && data + 10 <= buf.length) {
      const width = 1 + buf[data + 4] + (buf[data + 5] << 8) + (buf[data + 6] << 16);
      const height = 1 + buf[data + 7] + (buf[data + 8] << 8) + (buf[data + 9] << 16);
      if (!width || !height) return null;
      return { width, height };
    }
    if (type === 'VP8 ' && data + 10 <= buf.length) {
      // lossy: 3-byte frame tag, then 0x9d 0x01 0x2a, then 14-bit width/height
      const start = buf[data + 3] === 0x9d && buf[data + 4] === 0x01 && buf[data + 5] === 0x2a ? data + 6
        : buf[data] === 0x9d && buf[data + 1] === 0x01 && buf[data + 2] === 0x2a ? data + 3
        : -1;
      if (start < 0 || start + 4 > buf.length) return null;
      const width = buf.readUInt16LE(start) & 0x3fff;
      const height = buf.readUInt16LE(start + 2) & 0x3fff;
      if (!width || !height) return null;
      return { width, height };
    }
    if (type === 'VP8L' && data + 5 <= buf.length) {
      if (buf[data] !== 0x2f) return null;
      const bits = buf[data + 1] | (buf[data + 2] << 8) | (buf[data + 3] << 16) | (buf[data + 4] << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    offset = data + size + (size % 2); // chunks are padded to even length
  }
  return null;
}
