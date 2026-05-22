#!/usr/bin/env node
// Usage:
//   node scripts/bump-version.js 0.2.0   # set explicit version
//   node scripts/bump-version.js patch    # auto-increment patch (0.1.2 → 0.1.3)
//   node scripts/bump-version.js minor    # auto-increment minor (0.1.2 → 0.2.0)
//   node scripts/bump-version.js major    # auto-increment major (0.1.2 → 1.0.0)

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/bump-version.js <version|patch|minor|major>');
  process.exit(1);
}

function bumpVersion(current, part) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  if (part === 'patch') return `${major}.${minor}.${patch + 1}`;
  return null;
}

let nextVersion;
if (['major', 'minor', 'patch'].includes(arg)) {
  nextVersion = bumpVersion(currentVersion, arg);
} else if (/^\d+\.\d+\.\d+$/.test(arg)) {
  nextVersion = arg;
} else {
  console.error(`Invalid argument: "${arg}". Provide a version like 0.2.0 or one of: patch, minor, major`);
  process.exit(1);
}

// Update package.json
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`package.json: ${currentVersion} → ${nextVersion}`);

// Update package-lock.json (root "version" and packages[""].version)
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  let updated = 0;
  if (lock.version) { lock.version = nextVersion; updated++; }
  if (lock.packages?.['']?.version) { lock.packages[''].version = nextVersion; updated++; }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  console.log(`package-lock.json: updated ${updated} occurrence(s)`);
} else {
  console.log('package-lock.json not found, skipped.');
}

console.log(`\nVersion bumped to ${nextVersion}`);
