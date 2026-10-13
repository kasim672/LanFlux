import {readFile,copyFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const source = resolve('node_modules/@noble/hashes');
const destination = resolve('lanflux/static/vendor/noble-hashes');
const version = JSON.parse(await readFile(resolve(source,'package.json'),'utf8')).version;
if (version !== '2.4.0') throw new Error('Review the vendor version and license before updating the pinned hashing implementation.');
await mkdir(destination,{recursive:true});
const files = ['sha2.js','_md.js','_u64.js','utils.js','LICENSE'];
const checksums = {};
for (const name of files) {
  await copyFile(resolve(source,name),resolve(destination,name));
  checksums[name] = createHash('sha256').update(await readFile(resolve(destination,name))).digest('hex');
}
await writeFile(resolve(destination,'manifest.json'),JSON.stringify({package:'@noble/hashes',version,files:checksums},null,2)+'\n');
console.log(`Copied the pinned MIT-licensed hashing modules (${version}).`);
