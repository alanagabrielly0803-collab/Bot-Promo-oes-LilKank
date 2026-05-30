const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function filePath(name) {
  ensureDataDir();
  return path.join(config.dataDir, name);
}

function readJson(name, fallback) {
  try {
    const target = filePath(name);
    if (!fs.existsSync(target)) return fallback;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    console.error(`[Store] Falha lendo ${name}:`, error.message);
    return fallback;
  }
}

function writeJson(name, value) {
  const target = filePath(name);
  fs.writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
}

module.exports = { readJson, writeJson, filePath };
