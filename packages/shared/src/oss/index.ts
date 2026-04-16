import path from 'node:path';
import OSS from 'ali-oss';

// ========================
// 类型定义
// ========================

export interface OSSUploadConfig {
  accessKeyId: string;
  accessKeySecret: string;
  stsToken: string;
  region: string; // e.g. 'oss-cn-beijing'
  bucket: string; // e.g. 'xrayandroid'
  endpoint?: string; // e.g. 'oss-cn-beijing.aliyuncs.com'
  prefix?: string; // e.g. 'midscene-reports/'
  customDomain?: string; // e.g. 'https://your-domain.com'
}

export interface OSSUploadResult {
  success: boolean;
  url?: string; // 在线访问 URL
  ossPath?: string; // OSS 上的完整路径
  error?: string;
}

/** Token Service 返回的凭证字段 */
interface STSTokenResponse {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  region?: string;
}

// ========================
// STS 凭证获取
// ========================

/**
 * 从 Token Service 获取 STS 临时凭证
 * 兼容两种响应格式：
 *   - { "resultObj": { accessKeyId, accessKeySecret, securityToken } }
 *   - { "data": { accessKeyId, accessKeySecret, securityToken, region } }
 */
async function fetchSTSToken(
  tokenUrl: string,
  responsePath: string,
): Promise<{
  accessKeyId: string;
  accessKeySecret: string;
  stsToken: string;
  region?: string;
} | null> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: Date.now() }),
    });

    if (!response.ok) {
      console.warn(
        `[Midscene OSS] Token service returned HTTP ${response.status}`,
      );
      return null;
    }

    const json = await response.json();
    const tokenData = json[responsePath] as STSTokenResponse | undefined;

    if (
      !tokenData?.accessKeyId ||
      !tokenData?.accessKeySecret ||
      !tokenData?.securityToken
    ) {
      console.warn(
        `[Midscene OSS] Token service response missing required fields at "${responsePath}"`,
      );
      return null;
    }

    return {
      accessKeyId: tokenData.accessKeyId,
      accessKeySecret: tokenData.accessKeySecret,
      stsToken: tokenData.securityToken,
      region: tokenData.region,
    };
  } catch (error: any) {
    console.warn(`[Midscene OSS] Failed to fetch STS token: ${error.message}`);
    return null;
  }
}

/** 默认 Token Service 地址 */
const DEFAULT_TOKEN_URL =
  'https://ufo2.alitrip.com/api/multiappAutoJob/getOssToken.json';

/**
 * 从环境变量获取 OSS 配置并动态获取 STS 凭证
 *
 * 默认启用上传，可通过 MIDSCENE_OSS_ENABLE=false 显式关闭。
 * 返回 null 表示已关闭或凭证获取失败（凭证失败不影响主流程）。
 */
export async function getOSSConfigFromEnv(): Promise<OSSUploadConfig | null> {
  if (process.env.MIDSCENE_OSS_ENABLE === 'false') return null;

  const tokenUrl = process.env.MIDSCENE_OSS_TOKEN_URL || DEFAULT_TOKEN_URL;

  const responsePath =
    process.env.MIDSCENE_OSS_TOKEN_RESPONSE_PATH || 'resultObj';
  const stsResult = await fetchSTSToken(tokenUrl, responsePath);
  if (!stsResult) return null;

  return {
    accessKeyId: stsResult.accessKeyId,
    accessKeySecret: stsResult.accessKeySecret,
    stsToken: stsResult.stsToken,
    region:
      process.env.MIDSCENE_OSS_REGION || stsResult.region || 'oss-cn-beijing',
    bucket: process.env.MIDSCENE_OSS_BUCKET || 'xrayandroid',
    endpoint: process.env.MIDSCENE_OSS_ENDPOINT,
    prefix: process.env.MIDSCENE_OSS_PREFIX || 'report/',
    customDomain: process.env.MIDSCENE_OSS_DOMAIN,
  };
}

// ========================
// 上传
// ========================

/**
 * 创建 OSS 客户端实例
 */
export function createOSSClient(config: OSSUploadConfig): OSS {
  return new OSS({
    region: config.region,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    stsToken: config.stsToken,
    bucket: config.bucket,
    endpoint: config.endpoint ? `https://${config.endpoint}` : undefined,
  });
}

/**
 * 上传单个 HTML 报告文件到 OSS
 *
 * 关于 HTML 预览：
 * - 2017-10-01 之后创建的 Bucket，使用 OSS 默认域名访问 .html 文件时，
 *   OSS 会自动添加 x-oss-force-download: true 和 Content-Disposition: attachment，
 *   导致浏览器强制下载而非预览。
 * - 解决方案：使用签名 URL（signatureUrl）并通过 response 参数覆盖响应头，
 *   或配置自定义域名绕过此限制。
 */
export async function uploadReportToOSS(
  localFilePath: string,
  config: OSSUploadConfig,
): Promise<OSSUploadResult> {
  try {
    const client = new OSS({
      region: config.region,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      stsToken: config.stsToken,
      bucket: config.bucket,
      endpoint: config.endpoint ? `https://${config.endpoint}` : undefined,
    });

    const fileName = path.basename(localFilePath);

    // OSS 默认域名对路径以 .htm/.html 结尾的文件强制下载
    // (添加 x-oss-force-download: true 和 Content-Disposition: attachment)
    // 解决方案：去掉文件后缀，通过 Content-Type 告诉浏览器按 HTML 渲染
    let ossPath: string;
    if (config.customDomain) {
      // 自定义域名不受强制下载限制，保留原始文件名
      ossPath = `${config.prefix}${fileName}`;
    } else {
      // 默认域名：去掉 .html/.htm 后缀以绕过强制下载策略
      const nameWithoutExt = fileName.replace(/\.html?$/i, '');
      ossPath = `${config.prefix}${nameWithoutExt}`;
    }

    // 上传并设置元数据
    await client.put(ossPath, localFilePath, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-cache',
      },
    });

    // 拼接访问 URL
    const url = config.customDomain
      ? `${config.customDomain.replace(/\/$/, '')}/${ossPath}`
      : `https://${config.bucket}.${config.region}.aliyuncs.com/${ossPath}`;

    return { success: true, url, ossPath };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}
