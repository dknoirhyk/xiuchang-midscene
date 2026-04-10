import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDebug } from '@midscene/shared/logger';
import { fliggyKnowledge } from './fliggy';

const debug = getDebug('android:app-knowledge');

/**
 * Maximum number of reference screenshots to return per page.
 * Controls token cost when injecting annotated images into planning.
 */
const MAX_SCREENSHOTS_PER_PAGE = 2;

/**
 * Configuration for an App's knowledge base, including text knowledge
 * and screenshot-related settings.
 */
interface AppKnowledgeConfig {
  /** Text knowledge content */
  knowledge: string;
  /** Directory name under screenshots/ for this app */
  screenshotDirName: string;
  /** Default page identifier for the first planning round (cold start) */
  defaultPage: string;
  /** Available page identifiers, dynamically passed to the model */
  pageIds: string[];
}

/**
 * Mapping from Android package names to their full knowledge configuration.
 * Add new entries here when supporting additional apps.
 */
const packageConfigMap: Record<string, AppKnowledgeConfig> = {
  'com.taobao.trip': {
    knowledge: fliggyKnowledge,
    screenshotDirName: 'fliggy',
    defaultPage: 'home',
    pageIds: [
      'home',
      'search-default',
      'search-sug',
      'search-result',
      'fliggy-qwen',
      'ticket-detail',
      'hotel-list',
      'hotel-detail',
      'flight-list',
      'flight-detail',
      'ticket-order',
      'hotel-order',
      'flight-order',
    ],
  },
};

/**
 * Get business knowledge content for a given Android package name.
 * @param packageName - The Android package name (e.g. "com.taobao.trip")
 * @returns The knowledge text if found, or null if no knowledge is registered for this package
 */
export function getKnowledgeForPackage(packageName: string): string | null {
  const config = packageConfigMap[packageName];
  if (config) {
    debug('found knowledge for package: %s', packageName);
    return config.knowledge;
  }
  debug('no knowledge found for package: %s', packageName);
  return null;
}

/**
 * Get annotated screenshot paths for a given package and page.
 * Returns up to MAX_SCREENSHOTS_PER_PAGE images from the page's screenshot directory.
 * @param packageName - The Android package name
 * @param pageId - The page identifier (e.g. "home", "search-result")
 * @returns Array of absolute file paths, empty if no screenshots found
 */
export function getScreenshotsForPage(
  packageName: string,
  pageId: string,
): string[] {
  const config = packageConfigMap[packageName];
  if (!config) {
    debug('no config for package: %s, skipping screenshots', packageName);
    return [];
  }

  const pageDir = path.join(
    __dirname,
    'screenshots',
    config.screenshotDirName,
    pageId,
  );

  if (!fs.existsSync(pageDir)) {
    debug('screenshot directory not found: %s', pageDir);
    return [];
  }

  try {
    const files = fs.readdirSync(pageDir);
    const imageFiles = files
      .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
      .map((f) => path.join(pageDir, f));

    if (imageFiles.length === 0) {
      debug('no image files in directory: %s', pageDir);
      return [];
    }

    const result = imageFiles.slice(0, MAX_SCREENSHOTS_PER_PAGE);
    debug(
      'found %d screenshot(s) for %s/%s (returning %d)',
      imageFiles.length,
      packageName,
      pageId,
      result.length,
    );
    return result;
  } catch (err) {
    debug('error reading screenshot directory %s: %s', pageDir, err);
    return [];
  }
}

/**
 * Get the default starting page identifier for the first planning round.
 * Used for cold-start: when there is no previous prediction, inject this page's screenshots.
 * @param packageName - The Android package name
 * @returns The default page identifier, or null if no config exists
 */
export function getDefaultPageForPackage(packageName: string): string | null {
  const config = packageConfigMap[packageName];
  return config?.defaultPage ?? null;
}

/**
 * Get available page identifiers for a package.
 * These are passed dynamically to the model so it knows which page IDs to predict.
 * @param packageName - The Android package name
 * @returns Array of page identifier strings, empty if no config exists
 */
export function getPageIdsForPackage(packageName: string): string[] {
  const config = packageConfigMap[packageName];
  return config?.pageIds ?? [];
}
