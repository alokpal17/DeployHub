import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import type { ProjectDetectionResult } from '@deployhub/shared';

export class ProjectDetector {
  /**
   * Inspects the repository files and identifies the project structure,
   * runtime requirements, framework, and commands.
   */
  static async detect(repoPath: string): Promise<ProjectDetectionResult> {
    // 1. Existing Dockerfile
    const dockerfilePath = path.join(repoPath, 'Dockerfile');
    if (existsSync(dockerfilePath)) {
      return {
        type: 'dockerfile',
        framework: 'Custom Dockerfile',
        internalPort: 3000,
        hasDockerfile: true,
      };
    }

    const packageJsonPath = path.join(repoPath, 'package.json');
    const hasPackageJson = existsSync(packageJsonPath);
    const hasIndexHtml = existsSync(path.join(repoPath, 'index.html'));

    // 2. Pure Static HTML site (no package.json)
    if (!hasPackageJson && hasIndexHtml) {
      return {
        type: 'static-html',
        framework: 'Static HTML / Vanilla Web',
        internalPort: 3000,
        hasDockerfile: false,
      };
    }

    // 3. Node.js Ecosystem
    if (hasPackageJson) {
      let pkg: Record<string, any> = {};
      try {
        const pkgRaw = await fs.readFile(packageJsonPath, 'utf8');
        pkg = JSON.parse(pkgRaw);
      } catch (err: any) {
        throw new Error(`Failed to parse package.json: ${err.message}`);
      }

      const scripts = pkg.scripts || {};
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      const hasStart = Boolean(scripts.start);
      const hasBuild = Boolean(scripts.build);
      const hasDev = Boolean(scripts.dev);

      // Detect Framework
      let framework = 'Node.js';
      if (deps.vite) framework = 'Vite';
      else if (deps.next) framework = 'Next.js';
      else if (deps['react-scripts']) framework = 'Create React App';
      else if (deps.react) framework = 'React';
      else if (deps.vue) framework = 'Vue';
      else if (deps.svelte || deps['@sveltejs/kit']) framework = 'Svelte';
      else if (deps['@nestjs/core']) framework = 'NestJS';
      else if (deps.express) framework = 'Express';
      else if (deps.fastify) framework = 'Fastify';
      else if (deps.hono) framework = 'Hono';
      else if (deps.koa) framework = 'Koa';

      // Detect SPA vs Backend
      const isSpa = Boolean(
        deps.vite ||
        deps.react ||
        deps['react-scripts'] ||
        deps.vue ||
        deps.svelte ||
        existsSync(path.join(repoPath, 'vite.config.ts')) ||
        existsSync(path.join(repoPath, 'vite.config.js')) ||
        (hasIndexHtml && !hasStart && !deps.express && !deps.fastify && !deps.koa && !deps['@nestjs/core'])
      );

      // Resolve main file / entrypoint
      let mainFile = '';
      if (pkg.main && existsSync(path.join(repoPath, pkg.main))) {
        mainFile = pkg.main;
      } else {
        const candidates = [
          'index.js',
          'server.js',
          'app.js',
          'main.js',
          'src/index.js',
          'src/server.js',
          'src/app.js',
          'src/main.js',
          'dist/index.js',
          'dist/server.js',
          'dist/app.js',
        ];
        for (const candidate of candidates) {
          if (existsSync(path.join(repoPath, candidate))) {
            mainFile = candidate;
            break;
          }
        }
      }

      if (isSpa) {
        return {
          type: 'nodejs-spa',
          framework,
          internalPort: 3000,
          buildCommand: hasBuild ? 'npm run build' : undefined,
          hasDockerfile: false,
        };
      }

      // Backend Node.js
      return {
        type: 'nodejs-backend',
        framework,
        internalPort: 3000,
        buildCommand: hasBuild ? 'npm run build' : undefined,
        startCommand: hasStart ? 'npm start' : mainFile ? `node ${mainFile}` : hasDev ? 'npm run dev' : undefined,
        mainFile: mainFile || undefined,
        hasDockerfile: false,
      };
    }

    // 4. Unsupported / Unknown
    return {
      type: 'unknown',
      internalPort: 3000,
      hasDockerfile: false,
    };
  }
}
