#!/usr/bin/env node
/**
 * Orchestration Runner Script
 * Executes the orchestration skill with the voice pipeline definition
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log('🎭 Running orchestration skill with voice pipeline...');
  
  const pipelinePath = join(__dirname, '../orchestration/voice-pipeline.yaml');
  
  try {
    // Run the orchestration skill
    const result = execSync(`skills orchestration "${pipelinePath}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    console.log('✅ Orchestration completed:');
    console.log(result);
    
  } catch (error) {
    console.error('❌ Orchestration failed:');
    console.error(error.message);
    process.exit(1);
  }
}

main();