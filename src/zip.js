const encoder = new TextEncoder();
const CRC_TABLE = makeCrcTable();

export function createZip(entries) {
  const files = normalizeEntries(entries);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const { time, date } = toDosTimeDate(file.lastModified);
    const crc = crc32(file.data);

    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 filename
    localView.setUint16(8, 0, true); // STORE (no compression)
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, file.nameBytes.length, true);
    localView.setUint16(28, 0, true);

    chunks.push(localHeader, file.nameBytes, file.data);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, file.nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.push(centralHeader, file.nameBytes);

    offset += localHeader.length + file.nameBytes.length + file.data.length;
  }

  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  for (const part of central) chunks.push(part);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  chunks.push(end);

  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

export function buildArchiveEntryName(row, usedNames) {
  const stamp = formatArchiveStamp(row && (row.archived_at || row.updated_at));
  const baseTitle = sanitizeFileStem((row && row.title) || '');
  const plain = `${stamp}-${baseTitle}.md`;
  if (!usedNames.has(plain)) {
    usedNames.add(plain);
    return plain;
  }
  const suffix = String(row && row.id ? row.id : crypto.randomUUID()).slice(0, 8);
  const unique = `${stamp}-${baseTitle}-${suffix}.md`;
  usedNames.add(unique);
  return unique;
}

export function sanitizeFileStem(value) {
  const trimmed = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed) return 'untitled';
  const max = 70;
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function formatArchiveStamp(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return 'undated';
  const safe = raw.replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
  return safe.length > 32 ? safe.slice(0, 32) : safe;
}

function normalizeEntries(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry.name !== 'string') continue;
    const nameBytes = encoder.encode(entry.name);
    if (nameBytes.length === 0) continue;
    out.push({
      nameBytes,
      data: toBytes(entry.data),
      lastModified: entry.lastModified,
    });
  }
  return out;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return encoder.encode(String(data || ''));
}

function toDosTimeDate(value) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  const year = d.getUTCFullYear();
  const safeYear = Number.isFinite(year) ? Math.min(2107, Math.max(1980, year)) : 1980;
  const month = Number.isFinite(d.getUTCMonth()) ? d.getUTCMonth() + 1 : 1;
  const day = Number.isFinite(d.getUTCDate()) ? d.getUTCDate() : 1;
  const hours = Number.isFinite(d.getUTCHours()) ? d.getUTCHours() : 0;
  const minutes = Number.isFinite(d.getUTCMinutes()) ? d.getUTCMinutes() : 0;
  const seconds = Number.isFinite(d.getUTCSeconds()) ? d.getUTCSeconds() : 0;

  const time = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | ((Math.floor(seconds / 2)) & 0x1f);
  const date = (((safeYear - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { time, date };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}
