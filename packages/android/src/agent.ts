import type { ActionParam, ActionReturn, DeviceAction } from '@midscene/core';
import { type AgentOpt, Agent as PageAgent } from '@midscene/core/agent';
import { getDebug } from '@midscene/shared/logger';
import { mergeAndNormalizeAppNameMapping } from '@midscene/shared/utils';
import {
  getDefaultPageForPackage,
  getKnowledgeForPackage,
  getPageIdsForPackage,
  getScreenshotsForPage,
} from './app-knowledge';
import { defaultAppNameMapping } from './appNameMapping';
import {
  AndroidDevice,
  type AndroidDeviceOpt,
  type DeviceActionAndroidBackButton,
  type DeviceActionAndroidHomeButton,
  type DeviceActionAndroidRecentAppsButton,
  type DeviceActionLaunch,
  type DeviceActionRunAdbShell,
} from './device';
import { getConnectedDevices } from './utils';

const debugAgent = getDebug('android:agent');

export type AndroidAgentOpt = AgentOpt & {
  /**
   * Custom mapping of app names to package names
   * User-provided mappings will take precedence over default mappings
   */
  appNameMapping?: Record<string, string>;
};

type ActionArgs<T extends DeviceAction> = [ActionParam<T>] extends [undefined]
  ? []
  : [ActionParam<T>];

/**
 * Helper type to convert DeviceAction to wrapped method signature
 */
type WrappedAction<T extends DeviceAction> = (
  ...args: ActionArgs<T>
) => Promise<ActionReturn<T>>;

export class AndroidAgent extends PageAgent<AndroidDevice> {
  /**
   * Trigger the system back operation on Android devices
   */
  back!: WrappedAction<DeviceActionAndroidBackButton>;

  /**
   * Trigger the system home operation on Android devices
   */
  home!: WrappedAction<DeviceActionAndroidHomeButton>;

  /**
   * Trigger the system recent apps operation on Android devices
   */
  recentApps!: WrappedAction<DeviceActionAndroidRecentAppsButton>;

  /**
   * User-provided app name to package name mapping
   */
  private appNameMapping: Record<string, string>;

  /**
   * Cache the last loaded knowledge package name to avoid redundant setAIActContext calls
   */
  private lastKnowledgePackageName: string | undefined;

  constructor(device: AndroidDevice, opts?: AndroidAgentOpt) {
    super(device, opts);
    // Merge user-provided mapping with default mapping
    // Normalize keys to allow flexible matching (case-insensitive, ignore spaces/dashes/underscores)
    // User-provided mapping has higher priority
    this.appNameMapping = mergeAndNormalizeAppNameMapping(
      defaultAppNameMapping,
      opts?.appNameMapping,
    );

    // Set the mapping on the device instance
    device.setAppNameMapping(this.appNameMapping);

    // Inject AI-based verification for IME fallback.
    // When imeStrategy is 'clipboard' or 'adb-keyboard' (or not set), keyboardType
    // will automatically try both strategies in order and use this function to
    // verify whether the input succeeded before falling back to the next strategy.
    device.inputVerifyFn = async (text: string): Promise<boolean> => {
      try {
        return await this.aiBoolean(
          `the currently focused input field (text box) shows "${text}" as its actual typed value — ignore any IME candidate bar, autocomplete dropdown, or search suggestion list below the field; only check the input field itself`,
        );
      } catch {
        return false;
      }
    };

    this.back =
      this.createActionWrapper<DeviceActionAndroidBackButton>(
        'AndroidBackButton',
      );
    this.home =
      this.createActionWrapper<DeviceActionAndroidHomeButton>(
        'AndroidHomeButton',
      );
    this.recentApps =
      this.createActionWrapper<DeviceActionAndroidRecentAppsButton>(
        'AndroidRecentAppsButton',
      );
  }

  /**
   * Launch an Android app or URL
   * @param uri - App package name, URL, or app name to launch
   */
  async launch(uri: string): Promise<void> {
    const action = this.wrapActionInActionSpace<DeviceActionLaunch>('Launch');
    return action({ uri });
  }

  /**
   * Execute ADB shell command on Android device
   * @param command - ADB shell command to execute
   */
  async runAdbShell(command: string): Promise<string> {
    const action =
      this.wrapActionInActionSpace<DeviceActionRunAdbShell>('RunAdbShell');
    return action({ command });
  }

  /**
   * Load app-specific business knowledge for the given package name.
   * If knowledge is found, it will be injected via setAIActContext so that
   * all AI methods (aiAct, aiAssert, aiQuery, aiBoolean, etc.) can use it.
   * Also sets up screenshot knowledge provider for planning-time injection.
   * Skips if the same package knowledge is already loaded.
   * @param packageName - The Android package name (e.g. "com.taobao.trip")
   */
  async loadAppKnowledge(packageName: string): Promise<void> {
    if (this.lastKnowledgePackageName === packageName) {
      debugAgent(
        'knowledge already loaded for package: %s, skipping',
        packageName,
      );
      return;
    }

    const knowledge = await getKnowledgeForPackage(packageName);
    if (knowledge) {
      this.setAIActContext(knowledge);
      debugAgent('loaded app knowledge for package: %s', packageName);
    } else {
      debugAgent('no app knowledge available for package: %s', packageName);
    }

    // Set up screenshot knowledge provider for planning-time injection
    const pageIds = await getPageIdsForPackage(packageName);
    if (pageIds.length > 0) {
      this.availablePageIds = pageIds;
      const defaultPage = await getDefaultPageForPackage(packageName);
      this.referenceScreenshotProvider = async (
        pageId: string | null,
      ): Promise<Array<{ name: string; url: string }>> => {
        // Cold start: use default page when no prediction is available
        const effectivePageId = pageId ?? defaultPage;
        if (!effectivePageId) return [];
        // getScreenshotsForPage returns base64 data URLs from OSS directly
        return getScreenshotsForPage(packageName, effectivePageId);
      };
      debugAgent(
        'screenshot knowledge provider set for package: %s (%d pages)',
        packageName,
        pageIds.length,
      );
    } else {
      this.availablePageIds = undefined;
      this.referenceScreenshotProvider = undefined;
    }

    this.lastKnowledgePackageName = packageName;
  }

  /**
   * Detect the foreground Android app and automatically load its business knowledge.
   * Uses ADB to get the currently resumed activity and extract the package name,
   * then calls loadAppKnowledge() with the detected package name.
   * This is safe to call repeatedly — loadAppKnowledge() skips if already loaded.
   */
  async detectAndLoadAppKnowledge(): Promise<void> {
    try {
      const dumpsysOutput = await this.runAdbShell(
        'dumpsys activity activities | grep -E "mResumedActivity|mTopActivityRecord"',
      );
      const packageName = parseForegroundPackageName(dumpsysOutput);
      if (packageName) {
        await this.loadAppKnowledge(packageName);
      } else {
        debugAgent('could not detect foreground app package name');
      }
    } catch (error) {
      debugAgent(
        'failed to detect foreground app for knowledge injection:',
        error,
      );
    }
  }

  private createActionWrapper<T extends DeviceAction>(
    name: string,
  ): WrappedAction<T> {
    const action = this.wrapActionInActionSpace<T>(name);
    return ((...args: ActionArgs<T>) =>
      action(args[0] as ActionParam<T>)) as WrappedAction<T>;
  }
}

/**
 * Parse the foreground app package name from ADB dumpsys output.
 * Supports both mResumedActivity (older Android) and mTopActivityRecord (newer Android).
 */
function parseForegroundPackageName(dumpsysOutput: string): string | null {
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

export async function agentFromAdbDevice(
  deviceId?: string,
  opts?: AndroidAgentOpt & AndroidDeviceOpt,
) {
  if (!deviceId) {
    const devices = await getConnectedDevices();

    if (devices.length === 0) {
      throw new Error(
        'No Android devices found. Please connect an Android device and ensure ADB is properly configured. Run `adb devices` to verify device connection.',
      );
    }

    deviceId = devices[0].udid;

    debugAgent(
      'deviceId not specified, will use the first device (id = %s)',
      deviceId,
    );
  }

  // Pass all device options to AndroidDevice constructor, ensuring we pass an empty object if opts is undefined
  const device = new AndroidDevice(deviceId, opts || {});

  await device.connect();

  const agent = new AndroidAgent(device, opts);

  // Auto-detect foreground app and load knowledge (text + screenshots)
  await agent.detectAndLoadAppKnowledge();

  return agent;
}
