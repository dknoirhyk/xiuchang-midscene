import { AndroidAgent, AndroidDevice } from './packages/android/src';
import { getConnectedDevices } from './packages/android/src/utils';
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
      aiActContext: '',
    });
    await page.connect();
    await agent.aiAct('去飞猪创建一个酒店订单，酒店是「杭州西溪湿地亚朵酒店」');

    sleep(2000);
  })(),
);
