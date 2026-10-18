import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers/render.mjs';

const random = uuids => load('utils/secure-random.ts', { expo: { uuid: { v4: () => uuids.shift() } } });

test('random bytes skip the fixed version and variant bits of each native v4 UUID', async () => {
 const uuids = ['00010203-0405-4607-8809-0a0b0c0d0e0f', '10111213-1415-4617-b819-1a1b1c1d1e1f', '20212223-2425-4627-a829-2a2b2c2d2e2f'];
 const bytes = await random(uuids).getRandomBytesAsync(32);
 const expected = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x07, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x17, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  0x20, 0x21, 0x22, 0x23];
 assert.deepEqual([...bytes], expected);
 assert.equal(uuids.length, 0, '32 bytes need three UUIDs (14 random bytes each)');
});

test('ids are lowercase v4 UUIDs and a non-v4 native value is refused', async () => {
 assert.equal(random(['ABCDEF01-2345-4678-9ABC-DEF012345678']).randomUUID(), 'abcdef01-2345-4678-9abc-def012345678');
 assert.throws(() => random(['00000000-0000-1000-8000-000000000000']).randomUUID(), /unavailable/);
 await assert.rejects(random([undefined]).getRandomBytesAsync(1));
});
