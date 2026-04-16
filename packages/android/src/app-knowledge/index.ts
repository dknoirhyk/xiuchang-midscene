import { getDebug } from '@midscene/shared/logger';
import {
  type AppManifest,
  fetchAppManifest,
  fetchScreenshotAsBase64,
  fetchTextKnowledge,
} from './oss-reader';

const debug = getDebug('android:app-knowledge');

/**
 * Mapping from Android package names to their OSS directory name.
 * Add new entries here when supporting additional apps.
 */
const packageOssDirMap: Record<string, string> = {
  'com.taobao.trip': 'fliggy',
};

/**
 * Resolve the OSS directory name for a given Android package name.
 * @returns The directory name or null if no mapping exists
 */
function getOssDirForPackage(packageName: string): string | null {
  return packageOssDirMap[packageName] ?? null;
}

/**
 * Get business knowledge content for a given Android package name.
 * Fetches text knowledge from OSS (with in-memory cache).
 * @param packageName - The Android package name (e.g. "com.taobao.trip")
 * @returns The knowledge text if found, or null if no knowledge is registered for this package
 */
export async function getKnowledgeForPackage(
  packageName: string,
): Promise<string | null> {
  const ossDirName = getOssDirForPackage(packageName);
  if (!ossDirName) {
    debug('no OSS dir mapping for package: %s', packageName);
    return null;
  }

  const knowledge = await fetchTextKnowledge(ossDirName);
  if (knowledge) {
    debug('loaded OSS text knowledge for package: %s', packageName);
  } else {
    debug('no OSS text knowledge available for package: %s', packageName);
  }
  return knowledge;
}

/**
 * Get annotated screenshots for a given package and page as base64 data URLs.
 * Fetches from OSS using the manifest to determine file names.
 * All screenshots for the page are returned.
 * @param packageName - The Android package name
 * @param pageId - The page identifier (e.g. "home", "search-result")
 * @returns Array of base64 image data objects, empty if no screenshots found
 */
export async function getScreenshotsForPage(
  packageName: string,
  pageId: string,
): Promise<Array<{ name: string; url: string }>> {
  const ossDirName = getOssDirForPackage(packageName);
  if (!ossDirName) {
    debug(
      'no OSS dir mapping for package: %s, skipping screenshots',
      packageName,
    );
    return [];
  }

  const manifest = await fetchAppManifest(ossDirName);
  if (!manifest) {
    debug('no manifest available for %s, skipping screenshots', ossDirName);
    return [];
  }

  const fileNames = manifest.screenshots?.[pageId];
  if (!fileNames?.length) {
    debug('no screenshot files listed for %s/%s', ossDirName, pageId);
    return [];
  }

  const results = await Promise.all(
    fileNames.map((fileName) =>
      fetchScreenshotAsBase64(ossDirName, pageId, fileName),
    ),
  );

  // Filter out nulls (failed fetches)
  const screenshots = results.filter(
    (r): r is { name: string; url: string } => r !== null,
  );

  debug(
    'fetched %d/%d screenshot(s) for %s/%s',
    screenshots.length,
    fileNames.length,
    packageName,
    pageId,
  );
  return screenshots;
}

/**
 * Get the default starting page identifier for the first planning round.
 * Used for cold-start: when there is no previous prediction, inject this page's screenshots.
 * @param packageName - The Android package name
 * @returns The default page identifier, or null if no config exists
 */
export async function getDefaultPageForPackage(
  packageName: string,
): Promise<string | null> {
  const ossDirName = getOssDirForPackage(packageName);
  if (!ossDirName) return null;

  const manifest = await fetchAppManifest(ossDirName);
  return manifest?.defaultPage ?? null;
}

/**
 * Get available page identifiers for a package.
 * These are passed dynamically to the model so it knows which page IDs to predict.
 * @param packageName - The Android package name
 * @returns Array of page identifier strings, empty if no config exists
 */
export async function getPageIdsForPackage(
  packageName: string,
): Promise<string[]> {
  const ossDirName = getOssDirForPackage(packageName);
  if (!ossDirName) return [];

  const manifest = await fetchAppManifest(ossDirName);
  return manifest?.pageIds ?? [];
}
