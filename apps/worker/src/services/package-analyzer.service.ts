import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import type { ProjectType, DeploymentMode } from '@deployhub/shared';

export interface PackageAnalysisResult {
  type: ProjectType;
  framework: string;
  runtime: string;
  deploymentMode: DeploymentMode;
  entrypoint?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun';
  installCommand?: string;
  hasLockfile?: boolean;
  hasWorkspaces?: boolean;
  dependencyFile: string;
  detectedPorts: number[];
  evidence: string[];
}

export class PackageAnalyzer {
  /**
   * Deterministically analyzes a directory containing a package.json.
   */
  static async analyze(
    targetDir: string,
    relativePrefix = '.'
  ): Promise<PackageAnalysisResult | null> {
    const pkgPath = path.join(targetDir, 'package.json');
    if (!existsSync(pkgPath)) {
      return null;
    }

    let pkg: Record<string, any> = {};
    try {
      const raw = await fs.readFile(pkgPath, 'utf8');
      pkg = JSON.parse(raw);
    } catch {
      return null;
    }

    const evidence: string[] = [];
    evidence.push(`package.json found at ${relativePrefix}`);

    const scripts: Record<string, string> = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const pkgName = typeof pkg.name === 'string' ? pkg.name.toLowerCase() : '';

    // 1. Detect Package Manager & Lockfile
    let packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' = 'npm';
    let hasLockfile = false;
    let lockfileName = 'none';

    if (typeof pkg.packageManager === 'string') {
      const pmField = pkg.packageManager.toLowerCase();
      if (pmField.startsWith('bun')) {
        packageManager = 'bun';
      } else if (pmField.startsWith('pnpm')) {
        packageManager = 'pnpm';
      } else if (pmField.startsWith('yarn')) {
        packageManager = 'yarn';
      } else if (pmField.startsWith('npm')) {
        packageManager = 'npm';
      }
    }

    if (existsSync(path.join(targetDir, 'bun.lockb')) || existsSync(path.join(targetDir, 'bun.lock'))) {
      packageManager = 'bun';
      hasLockfile = true;
      lockfileName = existsSync(path.join(targetDir, 'bun.lockb')) ? 'bun.lockb' : 'bun.lock';
    } else if (existsSync(path.join(targetDir, 'pnpm-lock.yaml'))) {
      packageManager = 'pnpm';
      hasLockfile = true;
      lockfileName = 'pnpm-lock.yaml';
    } else if (existsSync(path.join(targetDir, 'yarn.lock'))) {
      packageManager = 'yarn';
      hasLockfile = true;
      lockfileName = 'yarn.lock';
    } else if (existsSync(path.join(targetDir, 'package-lock.json'))) {
      packageManager = 'npm';
      hasLockfile = true;
      lockfileName = 'package-lock.json';
    }

    let installCommand = 'npm install';
    if (packageManager === 'npm') {
      installCommand = hasLockfile ? 'npm ci' : 'npm install';
    } else if (packageManager === 'pnpm') {
      installCommand = hasLockfile ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    } else if (packageManager === 'yarn') {
      installCommand = hasLockfile ? 'yarn install --frozen-lockfile' : 'yarn install';
    } else if (packageManager === 'bun') {
      installCommand = hasLockfile ? 'bun install --frozen-lockfile' : 'bun install';
    }

    evidence.push(`Package Manager: ${packageManager}`);
    evidence.push(`Lockfile: ${lockfileName}`);
    evidence.push(`Install Strategy: ${installCommand}`);

    const hasWorkspaces = Boolean(
      pkg.workspaces &&
      (Array.isArray(pkg.workspaces) ? pkg.workspaces.length > 0 : Boolean(pkg.workspaces.packages && pkg.workspaces.packages.length > 0))
    );
    if (hasWorkspaces) {
      evidence.push('Monorepo workspaces detected in package.json');
    }

    // 2. Check Static HTML presence
    const hasRootIndexHtml = existsSync(path.join(targetDir, 'index.html'));
    const hasPublicIndexHtml = existsSync(path.join(targetDir, 'public', 'index.html'));
    const hasSrcIndexHtml = existsSync(path.join(targetDir, 'src', 'index.html'));
    const hasStaticHtml = hasRootIndexHtml || hasPublicIndexHtml || hasSrcIndexHtml;

    // 3. Inspect frameworks in dependencies & files
    const hasVite = Boolean(
      deps.vite ||
      pkgName.includes('vite') ||
      (scripts.build && scripts.build.includes('vite')) ||
      existsSync(path.join(targetDir, 'vite.config.ts')) ||
      existsSync(path.join(targetDir, 'vite.config.js')) ||
      existsSync(path.join(targetDir, 'vite.config.mjs')) ||
      existsSync(path.join(targetDir, 'vite.config.cjs'))
    );

    const hasNext = Boolean(
      deps.next ||
      existsSync(path.join(targetDir, 'next.config.js')) ||
      existsSync(path.join(targetDir, 'next.config.mjs')) ||
      existsSync(path.join(targetDir, 'next.config.ts'))
    );

    const hasReact = Boolean(deps.react || deps['react-dom']);
    const hasVue = Boolean(deps.vue);
    const hasSvelte = Boolean(deps.svelte || deps['@sveltejs/kit']);
    const hasAstro = Boolean(deps.astro);
    const hasRemix = Boolean(deps['@remix-run/node'] || deps['@remix-run/react']);
    const hasNest = Boolean(deps['@nestjs/core']);
    const hasExpress = Boolean(deps.express);
    const hasFastify = Boolean(deps.fastify);
    const hasKoa = Boolean(deps.koa);
    const hasHono = Boolean(deps.hono);
    const hasHapi = Boolean(deps['@hapi/hapi']);
    const hasPolka = Boolean(deps.polka);
    const hasRestify = Boolean(deps.restify);
    const hasMicro = Boolean(deps.micro);
    const hasSocketIo = Boolean(deps['socket.io'] || deps.ws);

    const hasBackendFramework =
      hasExpress ||
      hasFastify ||
      hasKoa ||
      hasNest ||
      hasHono ||
      hasHapi ||
      hasPolka ||
      hasRestify ||
      hasMicro ||
      hasSocketIo;

    // Check for Next.js static export vs SSR server mode
    let nextIsStaticExport = false;
    if (hasNext) {
      for (const cfgName of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
        const cfgPath = path.join(targetDir, cfgName);
        if (existsSync(cfgPath)) {
          try {
            const cfgContent = await fs.readFile(cfgPath, 'utf8');
            if (cfgContent.includes("output: 'export'") || cfgContent.includes('output: "export"')) {
              nextIsStaticExport = true;
              evidence.push(`Next.js static export configured in ${cfgName} (output: 'export')`);
              break;
            }
          } catch {}
        }
      }
      const allScripts = Object.values(scripts).join(' ');
      if (allScripts.includes('next export')) {
        nextIsStaticExport = true;
        evidence.push('Next.js static export script detected ("next export")');
      }
    }

    // Look for dedicated backend server entry files
    const serverFileCandidates = [
      'server.ts',
      'server.js',
      'server.cjs',
      'server.mjs',
      'src/server.ts',
      'src/server.js',
      'src/server.cjs',
      'src/server.mjs',
      'src/app.js',
      'src/app.ts',
      'app.js',
      'app.ts',
    ];

    let foundServerEntry = '';
    for (const cand of serverFileCandidates) {
      if (existsSync(path.join(targetDir, cand))) {
        foundServerEntry = cand;
        break;
      }
    }

    // Generic index/main entry files
    let foundGenericEntry = '';
    for (const cand of ['src/index.js', 'src/index.ts', 'index.js', 'index.ts', 'main.js', 'main.ts', 'src/main.js', 'src/main.ts']) {
      if (existsSync(path.join(targetDir, cand))) {
        foundGenericEntry = cand;
        break;
      }
    }

    // Inspect scripts
    const buildScript = scripts.build;
    const startScript = scripts.start;

    if (buildScript) evidence.push(`Build script: "${buildScript}"`);
    if (startScript) evidence.push(`Start script: "${startScript}"`);

    // Check for build output bundling a server entry
    const buildsServer =
      (buildScript &&
        (buildScript.includes('esbuild') ||
          buildScript.includes('tsc') ||
          buildScript.includes('server') ||
          buildScript.includes('dist/server'))) ||
      (startScript &&
        (startScript.includes('dist/server') ||
          startScript.includes('server.') ||
          startScript.includes('build/server') ||
          startScript.includes('node dist/')));

    const hasExplicitBackendServer =
      hasBackendFramework ||
      Boolean(foundServerEntry && (foundServerEntry.includes('server') || buildsServer || hasBackendFramework)) ||
      (startScript &&
        !startScript.includes('vite preview') &&
        !startScript.includes('serve ') &&
        !startScript.includes('http-server') &&
        !hasNext);

    // Check for explicit full-stack combination (e.g. Vite frontend + Node.js backend server, RevAstra)
    const isFullStack = Boolean(
      (hasVite || hasReact || hasVue || hasSvelte || (hasNext && !nextIsStaticExport) || hasRemix) &&
      (hasExplicitBackendServer || buildsServer || (foundServerEntry && foundServerEntry.includes('server'))) &&
      buildScript &&
      startScript &&
      (startScript.includes('node ') || startScript.includes('server') || startScript.includes('cross-env') || startScript.includes('bun '))
    );

    // Classification determination
    let type: ProjectType = 'node-backend';
    let framework = 'Node.js';
    let deploymentMode: DeploymentMode = 'unsupported';
    let outputDirectory: string | undefined = undefined;
    const runtime = packageManager === 'bun' ? 'Bun (latest)' : 'Node.js 20';
    let finalStartCommand: string | undefined = undefined;

    if (isFullStack) {
      type = 'node-fullstack';
      framework = hasVite ? 'Vite + Node.js' : hasNext ? 'Next.js' : hasRemix ? 'Remix' : 'Full-stack Node.js';
      deploymentMode = 'web';
      outputDirectory = 'dist';
      finalStartCommand = startScript ? (packageManager === 'npm' ? 'npm start' : `${packageManager} start`) : (foundServerEntry ? `node ${foundServerEntry}` : undefined);
      evidence.push(`Full-stack Node.js application (Frontend: ${hasVite ? 'Vite' : 'Web'}, Backend: Node Server)`);
    } else if (hasNext) {
      if (nextIsStaticExport) {
        type = 'node-frontend';
        framework = 'Next.js (Static Export)';
        deploymentMode = 'static';
        outputDirectory = 'out';
        evidence.push('Static Next.js frontend export');
      } else {
        type = 'node-frontend';
        framework = 'Next.js';
        deploymentMode = 'web';
        outputDirectory = '.next';
        finalStartCommand = startScript ? (packageManager === 'npm' ? 'npm start' : `${packageManager} start`) : 'npm start';
        evidence.push('Next.js SSR / Server application (Node.js runtime required)');
      }
    } else if (hasVite || hasAstro || hasReact || hasVue || hasSvelte || (hasStaticHtml && Boolean(buildScript))) {
      type = 'node-frontend';
      framework = hasVite ? 'Vite' : hasAstro ? 'Astro' : hasReact ? 'React' : hasVue ? 'Vue' : hasSvelte ? 'Svelte' : 'Static Web App';
      deploymentMode = 'static';
      outputDirectory = 'dist';
      evidence.push(`Frontend SPA / Static application (${framework})`);
    } else if (hasExplicitBackendServer || (foundServerEntry && (startScript || hasBackendFramework))) {
      type = 'node-backend';
      framework = hasExpress ? 'Express' : hasNest ? 'NestJS' : hasFastify ? 'Fastify' : hasHono ? 'Hono' : hasKoa ? 'Koa' : hasHapi ? 'Hapi' : 'Node.js Backend';
      deploymentMode = 'service';
      outputDirectory = existsSync(path.join(targetDir, 'dist')) ? 'dist' : undefined;

      if (startScript) {
        finalStartCommand = packageManager === 'npm' ? 'npm start' : `${packageManager} start`;
      } else if (foundServerEntry) {
        if (foundServerEntry.endsWith('.ts')) {
          finalStartCommand = packageManager === 'bun' ? `bun ${foundServerEntry}` : `npx tsx ${foundServerEntry}`;
        } else {
          finalStartCommand = packageManager === 'bun' ? `bun ${foundServerEntry}` : `node ${foundServerEntry}`;
        }
      } else if (foundGenericEntry && (hasBackendFramework || buildsServer)) {
        if (foundGenericEntry.endsWith('.ts')) {
          finalStartCommand = packageManager === 'bun' ? `bun ${foundGenericEntry}` : `npx tsx ${foundGenericEntry}`;
        } else {
          finalStartCommand = packageManager === 'bun' ? `bun ${foundGenericEntry}` : `node ${foundGenericEntry}`;
        }
      }

      if (!finalStartCommand) {
        deploymentMode = 'unsupported';
      }
      evidence.push(`Backend Node.js service (${framework})`);
    } else if (foundGenericEntry || buildScript || pkg.main) {
      type = 'node-backend';
      framework = 'Node.js Script / Library';
      deploymentMode = 'job';
      evidence.push('Node.js script or build-only project (No persistent HTTP server detected)');
    } else {
      type = 'node-backend';
      framework = 'Generic Node.js';
      deploymentMode = 'unsupported';
      evidence.push('No web server, static HTML, or executable start command detected');
    }

    // Resolve build command
    let finalBuildCommand: string | undefined = undefined;
    if (buildScript) {
      finalBuildCommand = packageManager === 'npm' ? 'npm run build' : `${packageManager} run build`;
    }

    // Detected ports: Only allocate for web, service, or static deployments
    const detectedPorts: number[] = [];
    if (deploymentMode === 'web' || deploymentMode === 'service' || deploymentMode === 'static') {
      const portRegex = /(?:--port\s+|PORT=|-p\s+)(\d{4,5})/g;
      const allScriptText = Object.values(scripts).join(' ');
      let portMatch: RegExpExecArray | null;
      while ((portMatch = portRegex.exec(allScriptText)) !== null) {
        const p = parseInt(portMatch[1], 10);
        if (p && !detectedPorts.includes(p)) detectedPorts.push(p);
      }
      if (detectedPorts.length === 0) {
        detectedPorts.push(hasVite && !isFullStack && deploymentMode !== 'static' ? 5173 : 3000);
      }
    }

    return {
      type,
      framework,
      runtime,
      deploymentMode,
      entrypoint: (type === 'node-frontend' && deploymentMode === 'static') ? undefined : (foundServerEntry || foundGenericEntry || undefined),
      buildCommand: finalBuildCommand,
      startCommand: finalStartCommand,
      outputDirectory,
      packageManager,
      installCommand,
      hasLockfile,
      hasWorkspaces,
      dependencyFile: path.relative(targetDir, pkgPath) || 'package.json',
      detectedPorts,
      evidence,
    };
  }
}
