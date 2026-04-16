/**
 * Create empty directory placeholders on OSS for pages that have no screenshots yet.
 * OSS uses zero-byte objects with trailing "/" as directory markers.
 *
 * Usage:
 *   npx tsx packages/android/scripts/create-oss-dirs.ts
 */

import { createOSSClient, getOSSConfigFromEnv } from '@midscene/shared/oss';

const OSS_ROOT = 'app-knowledge';

/** Pages that need directory placeholders (no screenshots yet) */
const EMPTY_PAGE_DIRS = [
  'fliggy-qwen',
  'flight-detail',
  'flight-list',
  'flight-order',
  'hotel-detail',
  'hotel-list',
  'hotel-order',
  'ticket-detail',
  'ticket-order',
];

async function main() {
  const config = await getOSSConfigFromEnv();
  if (!config) {
    console.error('Failed to obtain OSS config.');
    process.exit(1);
  }

  const client = createOSSClient(config);
  const appDir = 'fliggy';

  console.log('Creating empty directory placeholders on OSS...\n');

  for (const pageId of EMPTY_PAGE_DIRS) {
    const ossKey = `${OSS_ROOT}/${appDir}/screenshots/${pageId}/`;
    try {
      // Upload zero-byte object with trailing "/" to create directory marker
      await client.put(ossKey, Buffer.alloc(0));
      console.log(`  ✓ ${ossKey}`);
    } catch (error: any) {
      console.error(`  ✗ ${ossKey}: ${error.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch((error) => {
  console.error('Failed:', error);
  process.exit(1);
});
