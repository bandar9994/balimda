// Storage backend for desktop: plain files under one directory.

const fs = require('fs/promises');
const path = require('path');

function nodeFsBackend(root) {
  const full = (name) => {
    const p = path.resolve(root, name);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Path escapes data directory');
    return p;
  };
  let tmpCounter = 0;
  return {
    async read(name) {
      try {
        return await fs.readFile(full(name), 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    // Write to a temp file then rename, so a crash never leaves a half-written file.
    async write(name, text) {
      const file = full(name);
      const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, file);
    },
    async remove(name) {
      await fs.rm(full(name), { force: true });
    },
    async list(dir) {
      try {
        return await fs.readdir(full(dir));
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    async mkdir(dir) {
      await fs.mkdir(full(dir), { recursive: true });
    }
  };
}

module.exports = { nodeFsBackend };
