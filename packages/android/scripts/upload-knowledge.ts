/**
 * Upload local app-knowledge content to OSS.
 *
 * Usage:
 *   npx tsx packages/android/scripts/upload-knowledge.ts
 *
 * This script:
 * 1. Reads fliggy.ts text knowledge → uploads as app-knowledge/fliggy/knowledge.txt
 * 2. Scans annotated screenshots → uploads to screenshots/annotated/{pageId}/
 * 3. Scans raw screenshots (originals) → uploads to screenshots/raw/{pageId}/
 * 4. Generates and uploads manifest.json (referencing annotated images only)
 *
 * Directory structure on OSS:
 *   app-knowledge/fliggy/
 *     manifest.json
 *     knowledge.txt
 *     screenshots/
 *       annotated/{pageId}/{name}-annotated.jpg   ← code reads from here
 *       raw/{pageId}/{name}-original.png          ← for human reference only
 *
 * Requires STS credentials (fetched automatically via MIDSCENE_OSS_TOKEN_URL or default token service).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createOSSClient, getOSSConfigFromEnv } from '@midscene/shared/oss';

// ========================
// Configuration
// ========================

const APP_KNOWLEDGE_DIR = path.resolve(__dirname, '../src/app-knowledge');
const SCREENSHOTS_DIR = path.join(APP_KNOWLEDGE_DIR, 'screenshots');
const OSS_ROOT = 'app-knowledge';

interface AppEntry {
  /** OSS directory name (e.g. "fliggy") */
  ossDirName: string;
  /** Path to the .ts file exporting knowledge text */
  knowledgeSourceFile: string;
  /** Name of the exported const in the .ts file */
  exportedConstName: string;
  /** Default page for cold-start */
  defaultPage: string;
  /**
   * Optional external directory containing raw (un-annotated) screenshots.
   * Structure: {rawScreenshotsDir}/screenshots/raw/{pageId}/{fileName}
   * If not set, raw screenshots are skipped.
   */
  rawSourceDir?: string;
}

/** Apps to upload. Add entries here when supporting new apps. */
const APP_ENTRIES: AppEntry[] = [
  {
    ossDirName: 'fliggy',
    knowledgeSourceFile: path.join(APP_KNOWLEDGE_DIR, 'fliggy.ts'),
    exportedConstName: 'fliggyKnowledge',
    defaultPage: 'home',
    rawSourceDir: path.resolve(
      process.env.HOME || '',
      'Desktop/fliggy-knowledge',
    ),
  },
];

// ========================
// Helpers
// ========================

/**
 * Extract the text knowledge string from a .ts source file.
 * Reads the raw file and extracts the template literal content between backticks.
 */
function extractKnowledgeText(filePath: string, constName: string): string {
  const src = fs.readFileSync(filePath, 'utf-8');

  // Match: export const <name> = `...`;
  const regex = new RegExp(
    `export\\s+const\\s+${constName}\\s*=\\s*\`([\\s\\S]*?)\`;`,
  );
  const match = src.match(regex);
  if (!match?.[1]) {
    throw new Error(
      `Could not extract "${constName}" from ${filePath}. Ensure it is exported as a template literal.`,
    );
  }
  return match[1];
}

/**
 * Scan a screenshots directory (either annotated or raw) and return page→files mapping.
 * Only includes directories that contain actual image files (ignoring .gitkeep).
 */
function scanImageDir(baseDir: string): {
  pageIds: string[];
  images: Record<string, string[]>;
} {
  const pageIds: string[] = [];
  const images: Record<string, string[]> = {};

  if (!fs.existsSync(baseDir)) {
    return { pageIds, images };
  }

  const pageDirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const pageDir of pageDirs) {
    const pageId = pageDir.name;
    pageIds.push(pageId);

    const pagePath = path.join(baseDir, pageId);
    const imageFiles = fs
      .readdirSync(pagePath)
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();

    if (imageFiles.length > 0) {
      images[pageId] = imageFiles;
    }
  }

  return { pageIds, images };
}

/**
 * Collect all local files to upload for a single app.
 */
function collectUploadFiles(
  entry: AppEntry,
): Array<{ localPath: string; ossKey: string; content?: string }> {
  const files: Array<{ localPath: string; ossKey: string; content?: string }> =
    [];
  const appScreenshotsDir = path.join(SCREENSHOTS_DIR, entry.ossDirName);

  // 1. Text knowledge
  const knowledgeText = extractKnowledgeText(
    entry.knowledgeSourceFile,
    entry.exportedConstName,
  );
  files.push({
    localPath: entry.knowledgeSourceFile,
    ossKey: `${OSS_ROOT}/${entry.ossDirName}/knowledge.txt`,
    content: knowledgeText,
  });

  // 2. Annotated screenshots → screenshots/annotated/{pageId}/
  const { pageIds, images: annotatedImages } = scanImageDir(appScreenshotsDir);

  for (const [pageId, imageFiles] of Object.entries(annotatedImages)) {
    for (const fileName of imageFiles) {
      const localPath = path.join(appScreenshotsDir, pageId, fileName);
      const ossKey = `${OSS_ROOT}/${entry.ossDirName}/screenshots/annotated/${pageId}/${fileName}`;
      files.push({ localPath, ossKey });
    }
  }

  // Create empty directory placeholders for annotated pages without images
  for (const pageId of pageIds) {
    if (!annotatedImages[pageId]) {
      files.push({
        localPath: '',
        ossKey: `${OSS_ROOT}/${entry.ossDirName}/screenshots/annotated/${pageId}/`,
        content: '',
      });
    }
  }

  // 3. Raw screenshots → screenshots/raw/{pageId}/
  if (entry.rawSourceDir) {
    const rawDir = path.join(entry.rawSourceDir, 'screenshots/raw');
    const { pageIds: rawPageIds, images: rawImages } = scanImageDir(rawDir);

    for (const [pageId, imageFiles] of Object.entries(rawImages)) {
      for (const fileName of imageFiles) {
        const localPath = path.join(rawDir, pageId, fileName);
        const ossKey = `${OSS_ROOT}/${entry.ossDirName}/screenshots/raw/${pageId}/${fileName}`;
        files.push({ localPath, ossKey });
      }
    }

    // Create empty directory placeholders for raw pages without images
    for (const pageId of rawPageIds) {
      if (!rawImages[pageId]) {
        files.push({
          localPath: '',
          ossKey: `${OSS_ROOT}/${entry.ossDirName}/screenshots/raw/${pageId}/`,
          content: '',
        });
      }
    }

    console.log(
      `  Raw screenshots source: ${rawDir} (${Object.keys(rawImages).length} pages with images)`,
    );
  }

  // 4. Manifest (only references annotated screenshots — code reads from annotated/ path)
  const manifest = {
    defaultPage: entry.defaultPage,
    pageIds,
    screenshots: annotatedImages,
  };
  files.push({
    localPath: '',
    ossKey: `${OSS_ROOT}/${entry.ossDirName}/manifest.json`,
    content: JSON.stringify(manifest, null, 2),
  });

  return files;
}

// ========================
// Main
// ========================

async function main() {
  console.log('=== App Knowledge Upload to OSS ===\n');

  // Get OSS config (STS credentials)
  const config = await getOSSConfigFromEnv();
  if (!config) {
    console.error(
      'Failed to obtain OSS config. Check STS token service or set MIDSCENE_OSS_ENABLE=true.',
    );
    process.exit(1);
  }

  const client = createOSSClient(config);

  for (const entry of APP_ENTRIES) {
    console.log(`\n--- Uploading: ${entry.ossDirName} ---`);

    const files = collectUploadFiles(entry);
    console.log(`  Total files to upload: ${files.length}`);

    let uploaded = 0;
    let failed = 0;

    for (const file of files) {
      try {
        if (file.content !== undefined) {
          // Upload from string content
          await client.put(file.ossKey, Buffer.from(file.content, 'utf-8'), {
            headers: inferHeaders(file.ossKey),
          });
        } else {
          // Upload from local file
          await client.put(file.ossKey, file.localPath, {
            headers: inferHeaders(file.ossKey),
          });
        }
        uploaded++;
        console.log(`  ✓ ${file.ossKey}`);
      } catch (error: any) {
        failed++;
        console.error(`  ✗ ${file.ossKey}: ${error.message}`);
      }
    }

    console.log(
      `  Done: ${uploaded} uploaded, ${failed} failed (total ${files.length})`,
    );
  }

  console.log('\n=== Upload complete ===');
}

/**
 * Infer Content-Type headers from the OSS key path.
 */
function inferHeaders(ossKey: string): Record<string, string> {
  const ext = path.extname(ossKey).toLowerCase();
  const contentTypeMap: Record<string, string> = {
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  return {
    'Content-Type': contentTypeMap[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  };
}

main().catch((error) => {
  console.error('Upload failed:', error);
  process.exit(1);
});
