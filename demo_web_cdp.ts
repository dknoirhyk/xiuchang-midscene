import puppeteer from 'puppeteer';
import { PuppeteerAgent } from './packages/web-integration/src/puppeteer';
import 'dotenv/config';

const CDP_ENDPOINT = 'ws://127.0.0.1:9222/devtools/browser';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Promise.resolve(
  (async () => {
    // 通过 CDP 连接到已有的 Chrome
    console.log('🔗 正在连接 Chrome...', CDP_ENDPOINT);
    const browser = await puppeteer.connect({
      browserWSEndpoint: CDP_ENDPOINT,
    });

    // 获取已有页面或新建一个
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    // 导航到目标页面
    await page.goto('https://www.bing.com');
    await sleep(3000);

    // 初始化 Midscene Agent
    const agent = new PuppeteerAgent(page);
    console.log('✅ Agent 初始化完成');

    // 执行操作
    await agent.aiAct('在搜索框输入 "杭州天气"，然后按回车');
    await sleep(3000);

    // 提取数据
    const result = await agent.aiQuery(
      '{title: string, content: string}, 获取搜索结果页面的标题和主要内容',
    );
    console.log('📋 查询结果:', result);

    // 断言验证
    await agent.aiAssert('页面上显示了搜索结果');
    console.log('✅ 断言通过');

    // 断开连接（不关闭浏览器）
    browser.disconnect();
    console.log('🔌 已断开连接，浏览器保持运行');
  })(),
).catch((err) => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
