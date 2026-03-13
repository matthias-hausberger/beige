#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { argv } from 'process';

// Get version from command line or use current version
const versionArg = argv[2];

// Read package.json
const packageJsonPath = './package.json';
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

if (versionArg) {
  // Update version
  packageJson.version = versionArg;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Updated version to ${versionArg}`);
}

console.log(`Current version: ${packageJson.version}`);
console.log(`Package name: ${packageJson.name}`);

// Run the packaging commands
try {
  console.log('Installing dependencies...');
  execSync('pnpm install --frozen-lockfile', { stdio: 'inherit' });
  
  console.log('Building project...');
  execSync('pnpm run build', { stdio: 'inherit' });
  
  console.log('Creating package...');
  const packOutput = execSync('pnpm pack', { encoding: 'utf-8' });
  const packageName = packOutput.trim();
  
  console.log(`✅ Package created: ${packageName}`);
  console.log('');
  console.log('To test locally:');
  console.log(`  npm install -g ./${packageName}`);
  console.log('');
  console.log('To publish:');
  console.log(`  npm publish ${packageName}`);
  
} catch (error) {
  console.error('❌ Error during packaging:', error.message);
  process.exit(1);
}