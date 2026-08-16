import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip, buildArchiveEntryName } from '../src/zip.js';

test('createZip packs STORE entries with valid directory footer', () => {
  const zip = createZip([
    { name: 'a.md', data: 'alpha' },
    { name: 'b.md', data: 'beta' },
  ]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[8], 0x00); // compression method low byte
  assert.equal(zip[9], 0x00); // compression method high byte (STORE)

  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdOffset = zip.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 10, true), 2);
});

test('buildArchiveEntryName appends short id suffix on filename collision', () => {
  const used = new Set();
  const first = buildArchiveEntryName(
    { id: '11111111-2222-3333-4444-555555555555', title: 'Meeting notes', archived_at: '2026-08-16T12:00:00.000Z' },
    used
  );
  const second = buildArchiveEntryName(
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Meeting notes', archived_at: '2026-08-16T12:00:00.000Z' },
    used
  );
  assert.equal(first, '2026-08-16T12-00-00Z-Meeting notes.md');
  assert.equal(second, '2026-08-16T12-00-00Z-Meeting notes-aaaaaaaa.md');
});
