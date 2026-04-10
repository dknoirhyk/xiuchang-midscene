#!/bin/bash
# 一键发布 @xiuchang-midscene/android
# 用法:
#   ./publish.sh          → patch 版本 (2.0.0 → 2.0.1)
#   ./publish.sh minor    → minor 版本 (2.0.0 → 2.1.0)
#   ./publish.sh major    → major 版本 (2.0.0 → 3.0.0)  ⚠️ 需确认

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUMP="${1:-patch}"

cd "$SCRIPT_DIR"

# 读取当前版本
CURRENT_VERSION=$(node -p "require('./package.json').version")

# major 版本升级需二次确认
if [ "$BUMP" = "major" ]; then
  echo "⚠️  即将进行 major 版本升级: $CURRENT_VERSION → ?"
  read -p "确认要升级主版本号吗? (y/N) " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "已取消"
    exit 0
  fi
fi

# 1. 升级版本号 (不创建 git tag 和 commit)
npm version "$BUMP" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "📦 版本: $CURRENT_VERSION → $NEW_VERSION"

# 2. 构建依赖链 (report → core 模板注入 → android)
echo "🔨 构建中..."
cd "$ROOT_DIR"
npx nx build report --skip-nx-cache
npx nx build android --skip-nx-cache

# 3. 发布
echo "🚀 发布 @xiuchang-midscene/android@$NEW_VERSION ..."
cd "$SCRIPT_DIR"
pnpm publish --access public --no-git-checks

echo "✅ 发布成功: @xiuchang-midscene/android@$NEW_VERSION"
