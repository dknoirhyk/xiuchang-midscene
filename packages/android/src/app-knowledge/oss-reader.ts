import { getDebug } from '@midscene/shared/logger';

const debug = getDebug('android:app-knowledge:oss');

// ========================
// Types
// ========================

export interface AppManifest {
  defaultPage: string;
  pageIds: string[];
  /** Mapping from pageId to screenshot file names in that page's directory */
  screenshots: Record<string, string[]>;
}

// ========================
// OSS URL construction
// ========================

/**
 * Build the OSS knowledge base URL from environment variables.
 * Priority: MIDSCENE_OSS_DOMAIN > bucket + region default URL.
 */
function getOSSKnowledgeBaseUrl(): string {
  const domain = process.env.MIDSCENE_OSS_DOMAIN;
  if (domain) {
    return `${domain.replace(/\/$/, '')}/app-knowledge`;
  }

  const bucket = process.env.MIDSCENE_OSS_BUCKET || 'xrayandroid';
  const region = process.env.MIDSCENE_OSS_REGION || 'oss-cn-beijing';
  return `https://${bucket}.${region}.aliyuncs.com/app-knowledge`;
}

// ========================
// Fetch helpers
// ========================

/**
 * Fetch text content from an OSS URL.
 * Returns null on any network / HTTP error (non-throwing).
 */
async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      debug('HTTP %d for %s', response.status, url);
      return null;
    }
    return await response.text();
  } catch (error: any) {
    debug('fetch failed for %s: %s', url, error.message);
    return null;
  }
}

/**
 * Fetch binary content from an OSS URL and return as a Buffer.
 * Returns null on any network / HTTP error (non-throwing).
 */
async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      debug('HTTP %d for %s', response.status, url);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error: any) {
    debug('fetch failed for %s: %s', url, error.message);
    return null;
  }
}

// ========================
// Public API
// ========================

/**
 * Fetch the app manifest from OSS.
 * The manifest describes available pages, default page, and screenshot file lists.
 *
 * @param appDirName - The app directory name on OSS (e.g. "fliggy")
 * @returns Parsed manifest or null if unavailable
 */
export async function fetchAppManifest(
  appDirName: string,
): Promise<AppManifest | null> {
  const baseUrl = getOSSKnowledgeBaseUrl();
  const url = `${baseUrl}/${appDirName}/manifest.json`;
  debug('fetching manifest from %s', url);

  const text = await fetchText(url);
  if (!text) return null;

  try {
    const manifest = JSON.parse(text) as AppManifest;
    debug(
      'manifest loaded for %s: %d pageIds',
      appDirName,
      manifest.pageIds?.length ?? 0,
    );
    return manifest;
  } catch (error: any) {
    debug('failed to parse manifest for %s: %s', appDirName, error.message);
    return null;
  }
}

/**
 * Fetch text knowledge content from OSS.
 *
 * @param appDirName - The app directory name on OSS (e.g. "fliggy")
 * @returns Text knowledge content or null if unavailable
 */
export async function fetchTextKnowledge(
  appDirName: string,
): Promise<string | null> {
  const baseUrl = getOSSKnowledgeBaseUrl();
  const url = `${baseUrl}/${appDirName}/knowledge.txt`;
  debug('fetching text knowledge from %s', url);

  const text = await fetchText(url);
  if (!text) return null;

  debug('text knowledge loaded for %s (%d chars)', appDirName, text.length);
  return text;
}

/**
 * Fetch a single screenshot from OSS and return it as a base64 data URL.
 * Screenshots are NOT cached (different pages may be requested each planning round,
 * and image payloads are large).
 *
 * @param appDirName - The app directory name on OSS (e.g. "fliggy")
 * @param pageId - The page identifier (e.g. "home", "search-result")
 * @param fileName - The screenshot file name (e.g. "home-page-annotated.jpg")
 * @returns Object with name and base64 data URL, or null if unavailable
 */
export async function fetchScreenshotAsBase64(
  appDirName: string,
  pageId: string,
  fileName: string,
): Promise<{ name: string; url: string } | null> {
  const baseUrl = getOSSKnowledgeBaseUrl();
  const url = `${baseUrl}/${appDirName}/screenshots/annotated/${pageId}/${fileName}`;
  debug('fetching screenshot from %s', url);

  const buffer = await fetchBuffer(url);
  if (!buffer) return null;

  // Determine image MIME type from file extension
  const ext = fileName.split('.').pop()?.toLowerCase() || 'jpeg';
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

  return {
    name: `${pageId}-${fileName}`,
    url: `data:${mimeType};base64,${buffer.toString('base64')}`,
  };
}
