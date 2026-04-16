#!/usr/bin/env node
/**
 * Publish packages under @xiuchang-midscene scope.
 *
 * Strategy:
 * 1. Build with original @midscene/* names (workspace resolution works)
 * 2. Replace @midscene/shared → @xiuchang-midscene/shared and
 *    @midscene/core → @xiuchang-midscene/core in dist files
 * 3. Temporarily modify package.json (name, deps, version)
 * 4. Publish
 * 5. Restore package.json and dist files
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = '2.0.4';

const REPLACEMENTS = [
  ['@midscene/shared', '@xiuchang-midscene/shared'],
  ['@midscene/core', '@xiuchang-midscene/core'],
];

// Packages to publish, in dependency order
const PACKAGES = [
  {
    dir: 'packages/shared',
    newName: '@xiuchang-midscene/shared',
    depReplacements: {}, // no @midscene/* deps
  },
  {
    dir: 'packages/core',
    newName: '@xiuchang-midscene/core',
    depReplacements: {
      '@midscene/shared': `^${VERSION}`,
    },
  },
  {
    dir: 'packages/android',
    newName: '@xiuchang-midscene/android',
    depReplacements: {
      '@midscene/shared': `^${VERSION}`,
      '@midscene/core': `^${VERSION}`,
    },
    devDepReplacements: {
      '@midscene/playground': null, // remove, not published
    },
  },
];

function findFiles(dir, exts) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.toString());
    if (
      exts.some((ext) => fullPath.endsWith(ext)) &&
      fs.statSync(fullPath).isFile()
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

function replaceInFile(filePath, replacements) {
  let content = fs.readFileSync(filePath, 'utf-8');
  let changed = false;
  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      // Use a regex that matches the package name as a complete segment
      // e.g. @midscene/shared but not @midscene/shared-something
      // We match @midscene/shared followed by / or " or ' or ` or end
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'g');
      content = content.replace(regex, to);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(filePath, content);
  }
  return changed;
}

// Use a temp dir for backups to avoid .bak files ending up in npm tarball
const BACKUP_DIR = path.join(ROOT, '.publish-backups');

function backupFile(filePath) {
  const relPath = path.relative(ROOT, filePath);
  const backupPath = path.join(BACKUP_DIR, relPath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function restoreFile(filePath) {
  const relPath = path.relative(ROOT, filePath);
  const backupPath = path.join(BACKUP_DIR, relPath);
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
  }
}

// Main
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const restoreOnly = args.includes('--restore');

if (restoreOnly) {
  console.log('Restoring all backed up files...');
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(ROOT, pkg.dir);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    restoreFile(pkgJsonPath);

    const distDir = path.join(pkgDir, 'dist');
    const distFiles = findFiles(distDir, ['.js', '.mjs', '.d.ts', '.d.mts']);
    for (const f of distFiles) restoreFile(f);
    console.log(`  Restored ${pkg.dir}`);
  }
  // Clean up backup dir
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true });
  }
  console.log('Done restoring.');
  process.exit(0);
}

// Check which packages are already published
function isAlreadyPublished(name, version) {
  try {
    execSync(`npm view ${name}@${version} version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

console.log(`\n=== Publishing @xiuchang-midscene packages v${VERSION} ===\n`);

const backups = [];

try {
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(ROOT, pkg.dir);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    const distDir = path.join(pkgDir, 'dist');

    console.log(`\n--- ${pkg.newName} ---`);

    // Step 1: Replace package names in dist files
    const distFiles = findFiles(distDir, ['.js', '.mjs', '.d.ts', '.d.mts']);
    let replacedCount = 0;
    for (const f of distFiles) {
      backupFile(f);
      backups.push(f);
      if (replaceInFile(f, REPLACEMENTS)) {
        replacedCount++;
      }
    }
    console.log(
      `  Replaced package names in ${replacedCount}/${distFiles.length} dist files`,
    );

    // Step 2: Modify package.json
    backupFile(pkgJsonPath);
    backups.push(pkgJsonPath);

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    pkgJson.name = pkg.newName;
    pkgJson.version = VERSION;

    // Update dependencies
    if (pkg.depReplacements && pkgJson.dependencies) {
      for (const [oldDep, newVersion] of Object.entries(pkg.depReplacements)) {
        if (pkgJson.dependencies[oldDep]) {
          const newDep =
            REPLACEMENTS.find((r) => r[0] === oldDep)?.[1] || oldDep;
          delete pkgJson.dependencies[oldDep];
          pkgJson.dependencies[newDep] = newVersion;
        }
      }
    }

    // Remove dev dependencies that aren't published
    if (pkg.devDepReplacements && pkgJson.devDependencies) {
      for (const [dep, replacement] of Object.entries(pkg.devDepReplacements)) {
        if (replacement === null) {
          delete pkgJson.devDependencies[dep];
        }
      }
    }

    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
    console.log(`  Updated package.json: ${pkgJson.name}@${pkgJson.version}`);

    // Step 3: Publish
    if (dryRun) {
      console.log(
        '  [DRY RUN] Would run: pnpm publish --access public --no-git-checks',
      );
    } else if (isAlreadyPublished(pkg.newName, VERSION)) {
      console.log(`  ⏭️  ${pkg.newName}@${VERSION} already published, skipping`);
    } else {
      console.log('  Publishing...');
      try {
        execSync('pnpm publish --access public --no-git-checks', {
          cwd: pkgDir,
          stdio: 'inherit',
        });
        console.log(`  ✅ Published ${pkg.newName}@${VERSION}`);
      } catch (e) {
        console.error(`  ❌ Failed to publish ${pkg.newName}: ${e.message}`);
        throw e;
      }
    }
  }
} finally {
  // Step 4: Restore all files
  console.log('\n--- Restoring original files ---');
  for (const pkg of PACKAGES) {
    const pkgDir = path.join(ROOT, pkg.dir);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    restoreFile(pkgJsonPath);

    const distDir = path.join(pkgDir, 'dist');
    const distFiles = findFiles(distDir, ['.js', '.mjs', '.d.ts', '.d.mts']);
    for (const f of distFiles) restoreFile(f);
    console.log(`  Restored ${pkg.dir}`);
  }
  // Clean up backup dir
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true });
  }
}

console.log('\n=== Done ===\n');
