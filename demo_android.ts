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

    await agent.aiAct('在猪搜搜索：杭州');

    // 必须调用 destroy() 以完成报告最终化（含 OSS 上传）
    await agent.destroy();
  })(),
);
