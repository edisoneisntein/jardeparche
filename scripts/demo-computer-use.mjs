#!/usr/bin/env node
/**
 * Computer Use Demo Script
 * Demonstrates the computer.use tool via the computer-use skill
 */
import { execSync } from 'node:child_process';

async function main() {
  console.log('🖥️  Running computer-use skill demo...');
  
  // Demo actions to perform
  const actions = [
    'open calculator',
    'type "2+2"',
    'press Enter',
    'screenshot',
    'ocr'
  ];
  
  try {
    for (const action of actions) {
      console.log(`\n▶️  Executing: ${action}`);
      const result = execSync(`skills computer-use "${action}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      console.log(`✅ Result: ${result.trim()}`);
    }
    
    console.log('\n🎉 Computer use demo completed successfully!');
    
  } catch (error) {
    console.error('❌ Computer use demo failed:');
    console.error(error.message);
    process.exit(1);
  }
}

main();