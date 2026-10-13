import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sha256} from '../lanflux/static/vendor/noble-hashes/sha2.js';
import {bytesToHex} from '../lanflux/static/vendor/noble-hashes/utils.js';

test('SHA-256 standard known answers, including empty and multi-block input', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc','ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq','248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ];
  for (const [text,expected] of vectors) assert.equal(bytesToHex(sha256(new TextEncoder().encode(text))),expected);
  const hash = sha256.create();
  const block = new TextEncoder().encode('a'.repeat(1000));
  for (let i=0;i<1000;i++) hash.update(block);
  assert.equal(bytesToHex(hash.digest()),'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('Incremental hashing matches independent Node crypto across padding and slice boundaries', () => {
  for (const length of [0,1,55,56,63,64,65,127,128,129,4096,65537,1024*1024]) {
    const bytes = Uint8Array.from({length},(_,i) => (i*37+11)%256);
    const expected = createHash('sha256').update(bytes).digest('hex');
    for (const chunkSize of [1,63,64,65,4096,256*1024]) {
      const hash = sha256.create();
      for (let i=0;i<bytes.length;i+=chunkSize) hash.update(bytes.subarray(i,i+chunkSize));
      assert.equal(bytesToHex(hash.digest()),expected,`length=${length}, chunks=${chunkSize}`);
    }
  }
});

test('Vendored source matches its recorded checksums and retains the MIT copyright notice', async () => {
  const base = new URL('../lanflux/static/vendor/noble-hashes/',import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
  assert.equal(manifest.version,'2.4.0');
  for (const [filename,digest] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(new URL(filename,base))).digest('hex'),digest);
  const license = await readFile(new URL('LICENSE',base),'utf8');
  assert.match(license,/MIT/);
  assert.match(license,/Paul Miller/);
});
