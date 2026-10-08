import path from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import type { ServiceCandidate, ProjectType, DeploymentMode } from '@deployhub/shared';
import { PackageAnalyzer } from './package-analyzer.service';
import { PythonDetector } from './python-detector.service';

export class ServiceScanner {
  private static readonly IGNORE_DIRS = new Set([
    '.git',
    '.github',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    'target',
    'vendor',
    '.next',
    '.nuxt',
    '.svelte-kit',
    'out',
    'public',
    'tmp',
    'temp',
  ]);

  /**
   * Performs bounded discovery of nested services and monorepo packages.
   */
  static async scan(repoPath: string, maxDepth = 3): Promise<ServiceCandidate[]> {
    const candidates: ServiceCandidate[] = [];

    const scanDirectory = async (currentDir: string, depth: number) => {
      if (depth > maxDepth) return;

      let entries: string[] = [];
      try {
        entries = readdirSync(currentDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (this.IGNORE_DIRS.has(entry) || entry.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(currentDir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          const relPath = path.relative(repoPath, fullPath).replace(/\\/g, '/');

          // Check for application markers inside this subdirectory
          const candidate = await this.inspectDirectory(fullPath, relPath);
          if (candidate) {
            candidates.push(candidate);
          }

          // Continue scanning subdirectories if depth allows
          await scanDirectory(fullPath, depth + 1);
        }
      }
    };

    await scanDirectory(repoPath, 1);
    return candidates;
  }

  /**
   * Inspects a directory to see if it represents a deployable application/service candidate.
   */
  private static async inspectDirectory(
    dirPath: string,
    relPath: string
  ): Promise<ServiceCandidate | null> {
    const hasPkg = existsSync(path.join(dirPath, 'package.json'));
    const hasReq = existsSync(path.join(dirPath, 'requirements.txt'));
    const hasPyproject = existsSync(path.join(dirPath, 'pyproject.toml'));
    const hasDockerfile = existsSync(path.join(dirPath, 'Dockerfile'));
    const hasPom = existsSync(path.join(dirPath, 'pom.xml'));
    const hasGradle = existsSync(path.join(dirPath, 'build.gradle')) || existsSync(path.join(dirPath, 'build.gradle.kts'));
    const hasGoMod = existsSync(path.join(dirPath, 'go.mod'));

    if (!hasPkg && !hasReq && !hasPyproject && !hasDockerfile && !hasPom && !hasGradle && !hasGoMod) {
      return null;
    }

    const name = path.basename(relPath);
    const evidence: string[] = [];

    // 1. Check Dockerfile
    if (hasDockerfile) {
      evidence.push(`Dockerfile found in ${relPath}`);
    }

    // 2. Check Node.js
    if (hasPkg) {
      const nodeRes = await PackageAnalyzer.analyze(dirPath, relPath);
      if (nodeRes) {
        return {
          name,
          path: relPath,
          buildContext: dirPath,
          type: nodeRes.type,
          framework: nodeRes.framework,
          runtime: nodeRes.runtime,
          deploymentMode: nodeRes.deploymentMode,
          entrypoint: nodeRes.entrypoint,
          buildCommand: nodeRes.buildCommand,
          startCommand: nodeRes.startCommand,
          outputDirectory: nodeRes.outputDirectory,
          packageManager: nodeRes.packageManager,
          installCommand: nodeRes.installCommand,
          hasLockfile: nodeRes.hasLockfile,
          dockerfilePath: hasDockerfile ? path.join(relPath, 'Dockerfile').replace(/\\/g, '/') : undefined,
          detectedPorts: nodeRes.detectedPorts,
          evidence: [...evidence, ...nodeRes.evidence],
        };
      }
    }

    // 3. Check Python
    if (hasReq || hasPyproject) {
      const pyRes = await PythonDetector.analyze(dirPath, relPath);
      if (pyRes) {
        return {
          name,
          path: relPath,
          buildContext: dirPath,
          type: pyRes.type,
          framework: pyRes.framework,
          runtime: pyRes.runtime,
          deploymentMode: pyRes.deploymentMode,
          entrypoint: pyRes.entrypoint,
          buildCommand: pyRes.buildCommand,
          startCommand: pyRes.startCommand,
          dockerfilePath: hasDockerfile ? path.join(relPath, 'Dockerfile').replace(/\\/g, '/') : undefined,
          detectedPorts: pyRes.detectedPorts,
          evidence: [...evidence, ...pyRes.evidence],
        };
      }
    }

    // 4. Check Java
    if (hasPom || hasGradle) {
      const buildTool = hasPom ? 'Maven (pom.xml)' : 'Gradle (build.gradle)';
      return {
        name,
        path: relPath,
        type: 'java',
        framework: 'Java',
        runtime: 'Java 17/21',
        deploymentMode: 'service',
        buildCommand: hasPom ? 'mvn clean package -DskipTests' : './gradlew build',
        startCommand: 'java -jar target/*.jar',
        dockerfilePath: hasDockerfile ? path.join(relPath, 'Dockerfile').replace(/\\/g, '/') : undefined,
        detectedPorts: [8080],
        evidence: [...evidence, `${buildTool} detected in ${relPath}`],
      };
    }

    // 5. Check Go
    if (hasGoMod) {
      return {
        name,
        path: relPath,
        type: 'go',
        framework: 'Go',
        runtime: 'Go 1.21',
        deploymentMode: 'service',
        buildCommand: 'go build -o server .',
        startCommand: './server',
        dockerfilePath: hasDockerfile ? path.join(relPath, 'Dockerfile').replace(/\\/g, '/') : undefined,
        detectedPorts: [8080],
        evidence: [...evidence, `go.mod detected in ${relPath}`],
      };
    }

    // 6. Generic Dockerfile in directory
    if (hasDockerfile) {
      return {
        name,
        path: relPath,
        type: 'docker',
        framework: 'Dockerfile',
        runtime: 'Docker',
        deploymentMode: 'service',
        dockerfilePath: path.join(relPath, 'Dockerfile').replace(/\\/g, '/'),
        detectedPorts: [3000],
        evidence,
      };
    }

    return null;
  }
}
