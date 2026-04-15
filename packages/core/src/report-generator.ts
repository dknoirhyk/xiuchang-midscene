import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getMidsceneRunSubDir } from '@midscene/shared/common';
import {
  MIDSCENE_REPORT_QUIET,
  globalConfigManager,
} from '@midscene/shared/env';
import { ifInBrowser, logMsg, uuid } from '@midscene/shared/utils';
import {
  generateDumpScriptTag,
  generateImageScriptTag,
  getBaseUrlFixScript,
} from './dump/html-utils';
import { type ExecutionDump, type GroupMeta, GroupedActionDump } from './types';
import { appendFileSync, getReportTpl } from './utils';

export interface IReportGenerator {
  /**
   * Write or update a single execution.
   * Each call appends a new dump script tag. The frontend deduplicates
   * executions with the same id/name, keeping only the last one.
   *
   * @param execution  Current execution's full data
   * @param groupMeta  Group-level metadata (groupName, sdkVersion, etc.)
   */
  onExecutionUpdate(execution: ExecutionDump, groupMeta: GroupMeta): void;

  /**
   * @deprecated Use onExecutionUpdate instead. Kept for backward compatibility.
   */
  onDumpUpdate?(dump: GroupedActionDump): void;

  /**
   * Wait for all queued write operations to complete.
   */
  flush(): Promise<void>;

  /**
   * Finalize the report. Calls flush() internally.
   */
  finalize(): Promise<string | undefined>;

  getReportPath(): string | undefined;
}

export const nullReportGenerator: IReportGenerator = {
  onExecutionUpdate: () => {},
  flush: async () => {},
  finalize: async () => undefined,
  getReportPath: () => undefined,
};

export class ReportGenerator implements IReportGenerator {
  private reportPath: string;
  private screenshotMode: 'inline' | 'directory';
  private autoPrint: boolean;
  private firstWriteDone = false;

  // Unique identifier for this report stream — used as data-group-id
  private readonly reportStreamId: string;

  // Tracks screenshots already written to disk (by id) to avoid duplicates
  private writtenScreenshots = new Set<string>();
  private initialized = false;

  // Tracks the last execution + groupMeta for re-writing on finalize
  private lastExecution?: ExecutionDump;
  private lastGroupMeta?: GroupMeta;

  // write queue for serial execution
  private writeQueue: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(options: {
    reportPath: string;
    screenshotMode: 'inline' | 'directory';
    autoPrint?: boolean;
  }) {
    this.reportPath = options.reportPath;
    this.screenshotMode = options.screenshotMode;
    this.autoPrint = options.autoPrint ?? true;
    this.reportStreamId = uuid();
    this.printReportPath('will be generated at');
  }

  static create(
    reportFileName: string,
    opts: {
      generateReport?: boolean;
      outputFormat?: 'single-html' | 'html-and-external-assets';
      autoPrintReportMsg?: boolean;
    },
  ): IReportGenerator {
    if (opts.generateReport === false) return nullReportGenerator;

    // In browser environment, file system is not available
    if (ifInBrowser) return nullReportGenerator;

    if (opts.outputFormat === 'html-and-external-assets') {
      const outputDir = join(getMidsceneRunSubDir('report'), reportFileName);
      return new ReportGenerator({
        reportPath: join(outputDir, 'index.html'),
        screenshotMode: 'directory',
        autoPrint: opts.autoPrintReportMsg,
      });
    }

    return new ReportGenerator({
      reportPath: join(
        getMidsceneRunSubDir('report'),
        `${reportFileName}.html`,
      ),
      screenshotMode: 'inline',
      autoPrint: opts.autoPrintReportMsg,
    });
  }

  onExecutionUpdate(execution: ExecutionDump, groupMeta: GroupMeta): void {
    this.lastExecution = execution;
    this.lastGroupMeta = groupMeta;
    this.writeQueue = this.writeQueue.then(() => {
      if (this.destroyed) return;
      this.doWriteExecution(execution, groupMeta);
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async finalize(): Promise<string | undefined> {
    // Re-write the last execution to capture any final state changes
    if (this.lastExecution && this.lastGroupMeta) {
      this.onExecutionUpdate(this.lastExecution, this.lastGroupMeta);
    }
    await this.flush();
    this.destroyed = true;

    if (!this.initialized) {
      // No executions were ever written — no file exists
      return undefined;
    }

    this.printReportPath('finalized');

    // Deduplicate: remove redundant dump tags, keep only the last one
    this.deduplicateDumps();

    // Compress screenshots to JPEG if configured
    await this.compressScreenshots();

    // Upload to OSS if enabled (try-catch: never block main flow)
    await this.uploadToOSSIfEnabled();

    return this.reportPath;
  }

  getReportPath(): string | undefined {
    return this.reportPath;
  }

  private printReportPath(verb: string): void {
    if (!this.autoPrint || !this.reportPath) return;
    if (globalConfigManager.getEnvConfigInBoolean(MIDSCENE_REPORT_QUIET))
      return;

    if (this.screenshotMode === 'directory') {
      logMsg(`report ${verb}: npx serve ${dirname(this.reportPath)}`);
    } else {
      logMsg(`report ${verb}: ${this.reportPath}`);
    }
  }

  /**
   * Remove redundant dump tags from the finalized report.
   * Each onExecutionUpdate appends a full dump tag, but only the last one
   * is needed (the frontend deduplicates anyway). Removing the earlier ones
   * drastically reduces file size — typically saving 50%+ for long sessions.
   */
  private deduplicateDumps(): void {
    if (this.screenshotMode !== 'inline') return;
    if (!this.initialized) return;

    try {
      const content = readFileSync(this.reportPath, 'utf-8');
      const sizeBefore = Buffer.byteLength(content, 'utf-8');

      // Walk through all top-level <script>…</script> pairs to find real
      // dump tags. We cannot simply use indexOf('<script type="midscene_web_dump"')
      // because that pattern may appear INSIDE the escaped JSON content of
      // other dump tags. By scanning tag-by-tag and relying on the fact that
      // </script inside content is always escaped to <\/script, the first
      // literal </script> after an opening <script is always the real
      // closing tag.
      const dumpType = 'midscene_web_dump';
      const positions: Array<{ start: number; end: number }> = [];
      let pos = 0;

      while (pos < content.length) {
        const scriptStart = content.indexOf('<script', pos);
        if (scriptStart === -1) break;

        const openEnd = content.indexOf('>', scriptStart);
        if (openEnd === -1) break;

        const openTag = content.slice(scriptStart, openEnd + 1);

        // Find the matching </script> — always the real closing tag
        // because inner </script is escaped to <\/script by escapeContent()
        const closeIdx = content.indexOf('</script>', openEnd);
        if (closeIdx === -1) break;

        const tagEnd = closeIdx + '</script>'.length;

        if (openTag.includes(`type="${dumpType}"`)) {
          positions.push({ start: scriptStart, end: tagEnd });
        }

        pos = tagEnd;
      }

      // Nothing to deduplicate
      if (positions.length <= 1) return;

      // Rebuild content: keep everything except non-last dump tags
      const parts: string[] = [];
      let lastEnd = 0;

      for (let i = 0; i < positions.length - 1; i++) {
        // Also consume the preceding newline appended by writeInlineExecution
        let start = positions[i].start;
        if (start > 0 && content[start - 1] === '\n') {
          start--;
        }
        parts.push(content.slice(lastEnd, start));
        lastEnd = positions[i].end;
      }
      parts.push(content.slice(lastEnd));

      const newContent = parts.join('');
      writeFileSync(this.reportPath, newContent);

      const sizeAfter = Buffer.byteLength(newContent, 'utf-8');
      const savedMB = (sizeBefore - sizeAfter) / 1024 / 1024;

      if (savedMB > 0.1) {
        logMsg(
          `report optimized: removed ${positions.length - 1} redundant dumps, saved ${savedMB.toFixed(1)} MB`,
        );
      }
    } catch {
      // Optimization failure must never block the main flow
    }
  }

  /**
   * Compress inline screenshots from PNG to JPEG when MIDSCENE_REPORT_JPEG_QUALITY
   * is set (1-100). Runs during finalize(), after dedup and before OSS upload.
   * This only affects the report file — AI model still receives original quality.
   */
  private async compressScreenshots(): Promise<void> {
    if (this.screenshotMode !== 'inline') return;
    if (!this.initialized) return;

    const qualityStr = process.env.MIDSCENE_REPORT_JPEG_QUALITY;
    if (!qualityStr) return;

    const quality = Number.parseInt(qualityStr, 10);
    if (Number.isNaN(quality) || quality < 1 || quality > 100) return;

    try {
      const { convertToJpegBase64 } = await import('@midscene/shared/img');

      let content = readFileSync(this.reportPath, 'utf-8');
      const sizeBefore = Buffer.byteLength(content, 'utf-8');

      // Walk through top-level <script> tags to find image tags
      const imageType = 'midscene-image';
      const replacements: Array<{
        start: number;
        end: number;
        newTag: string;
      }> = [];
      let pos = 0;

      while (pos < content.length) {
        const scriptStart = content.indexOf('<script', pos);
        if (scriptStart === -1) break;

        const openEnd = content.indexOf('>', scriptStart);
        if (openEnd === -1) break;

        const openTag = content.slice(scriptStart, openEnd + 1);
        const closeIdx = content.indexOf('</script>', openEnd);
        if (closeIdx === -1) break;

        const tagEnd = closeIdx + '</script>'.length;

        if (openTag.includes(`type="${imageType}"`)) {
          const base64Content = content.slice(openEnd + 1, closeIdx);
          // Only compress if it's a PNG (not already JPEG)
          if (base64Content.includes('image/png')) {
            replacements.push({
              start: openEnd + 1,
              end: closeIdx,
              newTag: base64Content,
            });
          }
        }

        pos = tagEnd;
      }

      if (replacements.length === 0) return;

      // Convert all PNGs to JPEG in parallel
      const converted = await Promise.all(
        replacements.map(async (r) => {
          // Content is HTML-escaped by escapeContent(); it only escapes </script
          // The base64 data URI itself doesn't contain </script, so it's safe as-is
          const jpegBase64 = await convertToJpegBase64(r.newTag, quality);
          return { ...r, newTag: jpegBase64 };
        }),
      );

      // Rebuild content with compressed images (process in reverse to keep positions valid)
      const sortedDesc = [...converted].sort((a, b) => b.start - a.start);
      for (const { start, end, newTag } of sortedDesc) {
        content = content.slice(0, start) + newTag + content.slice(end);
      }

      writeFileSync(this.reportPath, content);

      const sizeAfter = Buffer.byteLength(content, 'utf-8');
      const savedMB = (sizeBefore - sizeAfter) / 1024 / 1024;

      if (savedMB > 0.1) {
        logMsg(
          `screenshots compressed: ${replacements.length} PNG → JPEG (quality=${quality}), saved ${savedMB.toFixed(1)} MB`,
        );
      }
    } catch {
      // Compression failure must never block the main flow
    }
  }

  private async uploadToOSSIfEnabled(): Promise<void> {
    try {
      // Dynamic import to avoid loading ali-oss when OSS is not enabled
      const { getOSSConfigFromEnv, uploadReportToOSS } = await import(
        '@midscene/shared/oss'
      );
      const ossConfig = await getOSSConfigFromEnv();
      if (!ossConfig) return;

      // Only upload single-html mode reports
      if (this.screenshotMode !== 'inline') return;

      const result = await uploadReportToOSS(this.reportPath, ossConfig);
      if (result.success) {
        logMsg(`online report: ${result.url}`);
      } else {
        logMsg(`OSS upload failed: ${result.error}`);
      }
    } catch {
      // Upload failure must never affect main flow
    }
  }

  private doWriteExecution(
    execution: ExecutionDump,
    groupMeta: GroupMeta,
  ): void {
    if (this.screenshotMode === 'inline') {
      this.writeInlineExecution(execution, groupMeta);
    } else {
      this.writeDirectoryExecution(execution, groupMeta);
    }
    if (!this.firstWriteDone) {
      this.firstWriteDone = true;
      this.printReportPath('generated');
    }
  }

  /**
   * Wrap an ExecutionDump + GroupMeta into a single-execution GroupedActionDump.
   */
  private wrapAsGroupedDump(
    execution: ExecutionDump,
    groupMeta: GroupMeta,
  ): GroupedActionDump {
    return new GroupedActionDump({
      sdkVersion: groupMeta.sdkVersion,
      groupName: groupMeta.groupName,
      groupDescription: groupMeta.groupDescription,
      modelBriefs: groupMeta.modelBriefs,
      deviceType: groupMeta.deviceType,
      executions: [execution],
    });
  }

  /**
   * Append-only inline mode: write new screenshots and a dump tag on every call.
   * The frontend deduplicates executions with the same id/name (keeps last).
   * Duplicate dump JSON is acceptable; only screenshots are deduplicated.
   */
  private writeInlineExecution(
    execution: ExecutionDump,
    groupMeta: GroupMeta,
  ): void {
    const dir = dirname(this.reportPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize: write HTML template once
    if (!this.initialized) {
      writeFileSync(this.reportPath, getReportTpl());
      this.initialized = true;
    }

    // Append new screenshots (skip already-written ones)
    const screenshots = execution.collectScreenshots();
    for (const screenshot of screenshots) {
      if (!this.writtenScreenshots.has(screenshot.id)) {
        appendFileSync(
          this.reportPath,
          `\n${generateImageScriptTag(screenshot.id, screenshot.base64)}`,
        );
        this.writtenScreenshots.add(screenshot.id);
        // Safe to release memory — the image tag is permanent (never truncated)
        screenshot.markPersistedInline(this.reportPath);
      }
    }

    // Append dump tag (always — frontend keeps only last per execution id)
    const singleDump = this.wrapAsGroupedDump(execution, groupMeta);
    const serialized = singleDump.serialize();
    const attributes: Record<string, string> = {
      'data-group-id': this.reportStreamId,
    };
    appendFileSync(
      this.reportPath,
      `\n${generateDumpScriptTag(serialized, attributes)}`,
    );
  }

  private writeDirectoryExecution(
    execution: ExecutionDump,
    groupMeta: GroupMeta,
  ): void {
    const dir = dirname(this.reportPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // create screenshots subdirectory
    const screenshotsDir = join(dir, 'screenshots');
    if (!existsSync(screenshotsDir)) {
      mkdirSync(screenshotsDir, { recursive: true });
    }

    // 1. Write new screenshots and release memory immediately
    const screenshots = execution.collectScreenshots();
    for (const screenshot of screenshots) {
      if (!this.writtenScreenshots.has(screenshot.id)) {
        const ext = screenshot.extension;
        const absolutePath = join(screenshotsDir, `${screenshot.id}.${ext}`);
        const buffer = Buffer.from(screenshot.rawBase64, 'base64');
        writeFileSync(absolutePath, buffer);
        this.writtenScreenshots.add(screenshot.id);
        screenshot.markPersistedToPath(
          `./screenshots/${screenshot.id}.${ext}`,
          absolutePath,
        );
      }
    }

    // 2. Append dump tag (always — frontend keeps only last per execution id)
    const singleDump = this.wrapAsGroupedDump(execution, groupMeta);
    const serialized = singleDump.serialize();
    const dumpAttributes: Record<string, string> = {
      'data-group-id': this.reportStreamId,
    };

    if (!this.initialized) {
      writeFileSync(
        this.reportPath,
        `${getReportTpl()}${getBaseUrlFixScript()}`,
      );
      this.initialized = true;
    }

    appendFileSync(
      this.reportPath,
      `\n${generateDumpScriptTag(serialized, dumpAttributes)}`,
    );
  }
}
