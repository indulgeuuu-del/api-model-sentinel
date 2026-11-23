'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'),
  pkg = require('../package.json');
const files = [];
function collect(relative) {
  const entry = relative.replace(/\/$/, ''),
    target = path.join(root, entry),
    stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw Error('Refusing a symlink in distribution: ' + entry);
  if (stat.isDirectory())
    for (const name of fs.readdirSync(target).sort()) collect(entry + '/' + name);
  else {
    if (/\.(enc|dpapi|key|log|local\.json)$/.test(entry))
      throw Error('Runtime data cannot be packaged');
    files.push(entry);
  }
}
for (const entry of pkg.files) collect(entry);
const unique = [...new Set(files)].sort(),
  name = `${pkg.name}-${pkg.version}`;
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [],
  directory = [];
let offset = 0;
for (const file of unique) {
  const data = fs.readFileSync(path.join(root, file)),
    encoded = Buffer.from(name + '/' + file),
    crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x800, 6);
  head.writeUInt16LE(33, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(encoded.length, 26);
  local.push(head, encoded, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(encoded.length, 28);
  central.writeUInt32LE(offset, 42);
  directory.push(central, encoded);
  offset += head.length + encoded.length + data.length;
}
const centralBytes = Buffer.concat(directory),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(unique.length, 8);
end.writeUInt16LE(unique.length, 10);
end.writeUInt32LE(centralBytes.length, 12);
end.writeUInt32LE(offset, 16);
const bytes = Buffer.concat([...local, centralBytes, end]),
  dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const filename = name + '.zip';
fs.writeFileSync(path.join(dist, filename), bytes);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(dist, filename + '.sha256'), sha + '  ' + filename + '\n');
console.log(
  `Packaged ${unique.length} allowlisted files: dist/${filename} (${bytes.length} bytes)`,
);
console.log('SHA256 ' + sha);
