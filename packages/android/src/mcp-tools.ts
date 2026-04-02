import { z } from '@midscene/core';
import { getDebug } from '@midscene/shared/logger';
import { BaseMidsceneTools, type ToolDefinition } from '@midscene/shared/mcp';
import { type AndroidAgent, agentFromAdbDevice } from './agent';
import { AndroidDevice } from './device';

const debug = getDebug('mcp:android-tools');

/**
 * Parse the foreground app package name from ADB dumpsys output.
 * Supports both mResumedActivity (older Android) and mTopActivityRecord (newer Android).
 */
function parseForegroundPackageName(dumpsysOutput: string): string | null {
  // Match patterns like: mResumedActivity: ActivityRecord{...  com.taobao.trip/.xxx}
  // or: mTopActivityRecord=ActivityRecord{...  com.taobao.trip/.xxx}
  const patterns = [
    /mResumedActivity.*?\s([a-zA-Z][a-zA-Z0-9_.]*)\//,
    /mTopActivityRecord.*?\s([a-zA-Z][a-zA-Z0-9_.]*)\//,
  ];
  for (const pattern of patterns) {
    const match = dumpsysOutput.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Android-specific tools manager
 * Extends BaseMidsceneTools to provide Android ADB device connection tools
 */
export class AndroidMidsceneTools extends BaseMidsceneTools<AndroidAgent> {
  protected createTemporaryDevice() {
    // Create minimal temporary instance without connecting to device
    // The constructor doesn't establish ADB connection
    return new AndroidDevice('temp-for-action-space', {});
  }

  protected async ensureAgent(deviceId?: string): Promise<AndroidAgent> {
    if (this.agent && deviceId) {
      // If a specific deviceId is requested and we have an agent,
      // destroy it to create a new one with the new device
      try {
        await this.agent.destroy?.();
      } catch (error) {
        debug('Failed to destroy agent during cleanup:', error);
      }
      this.agent = undefined;
    }

    if (this.agent) {
      // Agent already exists, try to detect foreground app and load knowledge
      await this.detectAndLoadAppKnowledge(this.agent);
      return this.agent;
    }

    debug('Creating Android agent with deviceId:', deviceId || 'auto-detect');
    const agent = await agentFromAdbDevice(deviceId, {
      autoDismissKeyboard: false,
    });
    this.agent = agent;

    // Detect foreground app and load knowledge for the new agent
    await this.detectAndLoadAppKnowledge(agent);

    return agent;
  }

  /**
   * Detect the foreground Android app and load its business knowledge.
   * Uses ADB to get the currently resumed activity and extract the package name.
   */
  private async detectAndLoadAppKnowledge(agent: AndroidAgent): Promise<void> {
    try {
      const dumpsysOutput = await agent.runAdbShell(
        'dumpsys activity activities | grep -E "mResumedActivity|mTopActivityRecord"',
      );
      const packageName = parseForegroundPackageName(dumpsysOutput);
      if (packageName) {
        agent.loadAppKnowledge(packageName);
      } else {
        debug('could not detect foreground app package name');
      }
    } catch (error) {
      debug('failed to detect foreground app for knowledge injection:', error);
    }
  }

  /**
   * Provide Android-specific platform tools
   */
  protected preparePlatformTools(): ToolDefinition[] {
    return [
      {
        name: 'android_connect',
        description:
          'Connect to Android device via ADB. If deviceId not provided, uses the first available device.',
        schema: {
          deviceId: z
            .string()
            .optional()
            .describe('Android device ID (from adb devices)'),
        },
        handler: async ({ deviceId }: { deviceId?: string }) => {
          const agent = await this.ensureAgent(deviceId);
          const screenshot = await agent.page.screenshotBase64();

          return {
            content: [
              {
                type: 'text',
                text: `Connected to Android device${deviceId ? `: ${deviceId}` : ' (auto-detected)'}`,
              },
              ...this.buildScreenshotContent(screenshot),
            ],
            isError: false,
          };
        },
      },
      {
        name: 'android_disconnect',
        description:
          'Disconnect from current Android device and release ADB resources',
        schema: {},
        handler: this.createDisconnectHandler('Android device'),
      },
    ];
  }
}
