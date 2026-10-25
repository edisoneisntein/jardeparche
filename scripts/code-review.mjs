#!/usr/bin/env node
/**
 * Code Review Script
 * Invokes the code-review skill to analyze changes in the current PR/commit
 */
import { execSync } from 'node:child_process';

async function main() {
  console.log('🔍 Running code review skill...');
  
  try {
    // Get the base commit for comparison (usually main/master)
    const baseRef = process.env.GITHUB_BASE_REF || 'main';
    const headRef = process.env.GITHUB_HEAD_REF || 'HEAD';
    
    // Run the code-review skill using the skills tool
    const result = execSync(`skills code-review "${baseRef}..${headRef}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    console.log('✅ Code review completed:');
    console.log(result);
    
  } catch (error) {
    console.error('❌ Code review failed:');
    console.error(error.message);
    process.exit(1);
  }
}

main();