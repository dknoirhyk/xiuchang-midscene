import { agentFromAdbDevice } from './packages/android/src';
import 'dotenv/config'; // read environment variables from .env file

const sleep = (ms: number | undefined) => new Promise((r) => setTimeout(r, ms));
Promise.resolve(
  (async () => {
    // 👀 Create agent — auto-detects foreground app and loads knowledge (text + screenshots)
    const agent = await agentFromAdbDevice(undefined, {
      // 👀 Use 'back-first' to avoid ESCAPE key side-effects in WebView / Mobile web pages
      // The default 'esc-first' may close popups or clear input fields in WebView
      keyboardDismissStrategy: 'back-first',
      // imeStrategy: 'clipboard',
      // imeStrategy: 'adb-keyboard',
    });

    await agent.aiAct('去猪搜搜索杭州，结果页不能为空');

    sleep(2000);
  })(),
);
