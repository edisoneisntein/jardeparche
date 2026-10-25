#!/usr/bin/env node
/**
 * Skills Scanner Script
 * Runs find-skills skill to discover available community skills
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log('🔍 Scanning for available skills...');
  
  try {
    // Run the find-skills skill
    const result = execSync('skills find-skills', {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    console.log('✅ Skills scan completed:');
    console.log(result);
    
    // Save catalog to JSON file
    const catalogPath = join(__dirname, '../skills-catalog.json');
    const catalog = {
      timestamp: new Date().toISOString(),
      skills: result.trim().split('\n').filter(line => line.trim()).map(line => {
        const [name, ...desc] = line.split(':');
        return {
          name: name.trim(),
          description: desc.join(':').trim()
        };
      })
    };
    
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    console.log(`\n📁 Catalog saved to: ${catalogPath}`);
    
    // Generate markdown report
    const mdPath = join(__dirname, '../docs/available-skills.md');
    const mdContent = `# Available Skills Catalog

*Generated on: ${new Date().toISOString()}*

## Skills

${catalog.skills.map(s => `- **${s.name}**: ${s.description}`).join('\n')}

---
*Run \`pnpm scan-skills\` to refresh this catalog.*
`;
    
    writeFileSync(mdPath, mdContent);
    console.log(`📄 Markdown report saved to: ${mdPath}`);
    
  } catch (error) {
    console.error('❌ Skills scan failed:');
    console.error(error.message);
    process.exit(1);
  }
}

main();