import {
  AndroidAgent,
  AndroidDevice,
  getConnectedDevices,
} from './packages/android';
import 'dotenv/config'; // read environment variables from .env file

const sleep = (ms: number | undefined) => new Promise((r) => setTimeout(r, ms));
Promise.resolve(
  (async () => {
    const devices = await getConnectedDevices();
    const page = new AndroidDevice(devices[0].udid, {
      // 👀 Use 'back-first' to avoid ESCAPE key side-effects in WebView / Mobile web pages
      // The default 'esc-first' may close popups or clear input fields in WebView
      keyboardDismissStrategy: 'back-first',
      // imeStrategy: 'clipboard',
      // imeStrategy: 'adb-keyboard',
    });

    // 👀 init Midscene agent
    const agent = new AndroidAgent(page, {
      aiActContext:
        'If any location, permission, user agreement, etc. popup, click agree. If login page pops up, close it.',
    });
    await page.connect();
    await agent.aiAct('输入："杭州"');

    sleep(2000);
  })(),
);
