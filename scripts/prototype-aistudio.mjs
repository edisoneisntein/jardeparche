#!/usr/bin/env node
/**
 * AI Studio Prototype Runner
 * Launches aistudio-prototype skill with JARVIS voice prototype configuration
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log('🧪 Launching AI Studio prototype for JARVIS voice...');
  
  const prototypePath = join(__dirname, '../prototypes/jarvis-voice.yaml');
  
  try {
    // Run the aistudio-prototype skill
    const result = execSync(`skills aistudio-prototype "${prototypePath}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    console.log('✅ Prototype launched:');
    console.log(result);
    
    // If the skill returns a URL, print it prominently
    const urlMatch = result.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      console.log('\n🌐 AI Studio URL:');
      console.log(`   ${urlMatch[0]}`);
    }
    
  } catch (error) {
    console.error('❌ Prototype launch failed:');
    console.error(error.message);
    process.exit(1);
  }
}

main();