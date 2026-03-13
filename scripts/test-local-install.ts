#!/usr/bin/env tsx

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

// Read package.json to get package info
const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));
const packageName = packageJson.name;
const version = packageJson.version;

// Expected tarball name
const tarballName = `matthias-hausberger-beige-${version}.tgz`;

console.log(`📦 Testing local installation of ${packageName}@${version}`);
console.log('');

// Check if tarball exists
if (!existsSync(tarballName)) {
  console.error('❌ Tarball not found. Run "pnpm run package" first.');
  process.exit(1);
}

console.log(`✅ Found tarball: ${tarballName}`);
console.log('');

// Test global installation
try {
  console.log('🔧 Testing global installation...');
  execSync(`npm install -g ./${tarballName}`, { stdio: 'inherit' });
  
  console.log('');
  console.log('✅ Installation successful!');
  console.log('');
  
  // Test if the CLI is available
  try {
    console.log('🧪 Testing CLI command...');
    const output = execSync('beige --help', { encoding: 'utf-8' });
    console.log('✅ CLI command works!');
    console.log('');
    console.log('Help output:');
    console.log(output.substring(0, 200) + '...');
  } catch (cliError) {
    console.log('⚠️  CLI test failed (this might be expected if not configured):');
    console.log(cliError.message);
  }
  
  console.log('');
  console.log('🎉 Local installation test completed successfully!');
  console.log('');
  console.log('To uninstall:');
  console.log(`  npm uninstall -g ${packageName}`);
  
} catch (error) {
  console.error('❌ Installation failed:', error.message);
  console.error('');
  console.error('This might be due to:');
  console.error('- Missing native modules (try building first)');
  console.error('- Permission issues (try with sudo)');
  console.error('- Conflicting global packages');
  
  process.exit(1);
}