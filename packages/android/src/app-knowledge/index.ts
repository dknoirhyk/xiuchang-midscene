import { getDebug } from '@midscene/shared/logger';
import { fliggyKnowledge } from './fliggy';

const debug = getDebug('android:app-knowledge');

/**
 * Mapping from Android package names to their business knowledge content.
 * Add new entries here when supporting additional apps.
 */
const packageKnowledgeMap: Record<string, string> = {
  'com.taobao.trip': fliggyKnowledge,
};

/**
 * Get business knowledge content for a given Android package name.
 * @param packageName - The Android package name (e.g. "com.taobao.trip")
 * @returns The knowledge text if found, or null if no knowledge is registered for this package
 */
export function getKnowledgeForPackage(packageName: string): string | null {
  const knowledge = packageKnowledgeMap[packageName];
  if (knowledge) {
    debug('found knowledge for package: %s', packageName);
    return knowledge;
  }
  debug('no knowledge found for package: %s', packageName);
  return null;
}
