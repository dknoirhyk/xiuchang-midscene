/**
 * OSS 上传独立测试 Demo
 *
 * 运行方式：
 *   MIDSCENE_OSS_TOKEN_URL=https://ufo2.alitrip.com/api/multiappAutoJob/getOssToken.json \
 *   npx tsx packages/shared/src/oss/demo.ts [本地HTML文件路径]
 *
 * 说明：
 *   此脚本不依赖 Midscene 任何模块，仅用于独立验证 OSS 上传全链路：
 *   1. STS 凭证获取
 *   2. 文件上传
 *   3. 在线 URL 可预览
 */
import { existsSync } from 'node:fs';
import { getOSSConfigFromEnv, uploadReportToOSS } from './index';

async function main() {
  const filePath = process.argv[2];

  if (!filePath || !existsSync(filePath)) {
    console.error(
      '用法: npx tsx packages/shared/src/oss/demo.ts <本地HTML文件路径>',
    );
    console.error(
      '示例: npx tsx packages/shared/src/oss/demo.ts ./midscene_run/report/xxx.html',
    );
    process.exit(1);
  }

  // 默认启用上传，Token URL 已有默认值，无需额外配置

  console.log('1. 获取 STS 凭证...');
  const config = await getOSSConfigFromEnv();
  if (!config) {
    console.error(
      '   获取 OSS 配置失败，请检查 MIDSCENE_OSS_TOKEN_URL 环境变量及网络连通性',
    );
    process.exit(1);
  }
  console.log(
    `   ✓ 凭证获取成功 (region=${config.region}, bucket=${config.bucket})`,
  );

  console.log(`2. 上传文件: ${filePath}`);
  const result = await uploadReportToOSS(filePath, config);

  if (result.success) {
    console.log('   ✓ 上传成功!');
    console.log(`   OSS 路径: ${result.ossPath}`);
    console.log(`   在线地址: ${result.url}`);
    console.log('');
    console.log(
      '3. 请在浏览器中打开以上链接，验证是否可以直接预览（而非下载）',
    );
  } else {
    console.error(`   ✗ 上传失败: ${result.error}`);
    process.exit(1);
  }
}

main();
