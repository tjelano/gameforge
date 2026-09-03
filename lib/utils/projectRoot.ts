import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const globalForRoot = globalThis as unknown as {
  projectRoot: string | undefined;
  projectRootVerified: boolean | undefined;
};

// tsx polyfills __dirname/__filename for ESM, but we resolve explicitly
// via import.meta.url so this also works under a plain Node ESM loader
// with no polyfill present.
function currentDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
}

export function getProjectRoot(): string {
  if (!globalForRoot.projectRoot) {
    let dir = currentDir();
    while (dir !== path.parse(dir).root) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        globalForRoot.projectRoot = dir;
        break;
      }
      dir = path.dirname(dir);
    }
    if (!globalForRoot.projectRoot) {
      globalForRoot.projectRoot = process.cwd();
    }
    if (!fs.existsSync(path.join(globalForRoot.projectRoot, 'package.json'))) {
      console.warn('⚠️ Project root not found, falling back to cwd');
      globalForRoot.projectRoot = process.cwd();
    }
  }
  if (!globalForRoot.projectRootVerified) {
    console.log(`📁 Project root: ${globalForRoot.projectRoot}`);
    globalForRoot.projectRootVerified = true;
  }
  return globalForRoot.projectRoot;
}

// Test-only escape hatch: force a specific root (e.g. a temp dir) and
// clear the verified-log flag so a subsequent getProjectRoot() call
// picks it up instead of the cached real-project value.
export function setProjectRootForTests(root: string | undefined): void {
  globalForRoot.projectRoot = root;
  globalForRoot.projectRootVerified = false;
}
