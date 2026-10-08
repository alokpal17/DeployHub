import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import type { ProjectDetectionResult, DetectedEnvVar } from '@deployhub/shared';
import { ComposeParser } from './compose-parser.service';
import { PackageAnalyzer } from './package-analyzer.service';
import { PythonDetector } from './python-detector.service';
import { ServiceScanner } from './service-scanner.service';

export class ProjectDetector {
  /**
   * Deterministically analyzes the repository files and identifies the project structure,
   * runtime requirements, framework, deployment mode, and commands following strict detection priority.
   *
   * If a selectedServicePath is provided, detection is focused exclusively on that sub-tree.
   */
  static async detect(
    repoPath: string,
    userEnv?: Record<string, string>,
    selectedServicePath?: string
  ): Promise<ProjectDetectionResult> {
    const diagnostics: string[] = [];
    const evidence: string[] = [];
    const repoResolved = path.resolve(repoPath);

    // ── Generic Environment Variable Extraction across Repository ───────────
    const genericEnvMap = new Map<string, DetectedEnvVar>();
    for (const envEx of ['.env.example', '.env.sample', '.env.template', '.env.defaults', '.env.local.example']) {
      const exPath = path.join(repoPath, envEx);
      if (existsSync(exPath)) {
        await ComposeParser.extractEnvFileVars(exPath, genericEnvMap);
      }
    }
    const userMap = userEnv || {};
    const genericDetectedEnvVars = Array.from(genericEnvMap.values());
    const genericMissingRequired = genericDetectedEnvVars
      .filter((v) => v.isRequired && (!userMap[v.key] || userMap[v.key].trim() === '') && !v.defaultValue)
      .map((v) => v.key);

    // ── EXPLICIT SERVICE SELECTION TARGETING ──────────────────────────────────
    if (selectedServicePath && selectedServicePath.trim() !== '' && selectedServicePath !== '.') {
      const cleanServicePath = path.normalize(selectedServicePath).replace(/^(\.\/|\.\\)/, '');
      const targetDir = path.resolve(repoPath, cleanServicePath);

      // Security check: path traversal validation
      if (!targetDir.startsWith(repoResolved)) {
        throw new Error(`Invalid servicePath: Path traversal detected ("${selectedServicePath}")`);
      }

      if (!existsSync(targetDir)) {
        throw new Error(`DEPLOYMENT_CONFIGURATION_ERROR: Selected service path does not exist: "${cleanServicePath}"`);
      }

      diagnostics.push(`✓ Scoped detection to selected service path: "${cleanServicePath}".`);
      evidence.push(`Explicit service path selected: "${cleanServicePath}"`);

      // Check for custom Dockerfile in service directory
      const svcDockerfilePath = path.join(targetDir, 'Dockerfile');
      if (existsSync(svcDockerfilePath)) {
        let exposedPort = 3000;
        try {
          const dockerContent = await fs.readFile(svcDockerfilePath, 'utf8');
          const exposeMatch = dockerContent.match(/EXPOSE\s+(\d+)/i);
          if (exposeMatch) {
            exposedPort = parseInt(exposeMatch[1], 10) || 3000;
          }
        } catch {}

        return {
          type: 'docker',
          framework: 'Custom Dockerfile',
          runtime: 'Docker Container',
          deploymentMode: 'web',
          rootPath: '.',
          servicePath: cleanServicePath,
          buildContext: targetDir,
          confidence: 0.95,
          internalPort: exposedPort,
          detectedPorts: [exposedPort],
          hasDockerfile: true,
          dockerfilePath: path.join(cleanServicePath, 'Dockerfile').replace(/\\/g, '/'),
          detectedEnvVars: genericDetectedEnvVars,
          missingRequiredEnvVars: genericMissingRequired,
          evidence: [...evidence, `Dockerfile found in ${cleanServicePath}`],
          diagnostics,
        };
      }

      // Check for Node.js in service directory
      const nodeRes = await PackageAnalyzer.analyze(targetDir, cleanServicePath);
      if (nodeRes) {
        diagnostics.push(`✓ ${nodeRes.framework} application detected in ${cleanServicePath} (${nodeRes.type}).`);
        return {
          type: nodeRes.type,
          framework: nodeRes.framework,
          runtime: nodeRes.runtime,
          deploymentMode: nodeRes.deploymentMode,
          rootPath: '.',
          servicePath: cleanServicePath,
          buildContext: targetDir,
          outputDirectory: nodeRes.outputDirectory,
          confidence: 0.9,
          entrypoint: nodeRes.entrypoint,
          internalPort: (nodeRes.detectedPorts && nodeRes.detectedPorts[0]) || (nodeRes.deploymentMode === 'static' ? 3000 : 0),
          detectedPorts: nodeRes.detectedPorts,
          buildCommand: nodeRes.buildCommand,
          startCommand: nodeRes.startCommand,
          mainFile: nodeRes.entrypoint,
          packageManager: nodeRes.packageManager,
          installCommand: nodeRes.installCommand,
          hasLockfile: nodeRes.hasLockfile,
          dependencyFile: nodeRes.dependencyFile,
          hasDockerfile: false,
          detectedEnvVars: genericDetectedEnvVars,
          missingRequiredEnvVars: genericMissingRequired,
          evidence: [...evidence, ...nodeRes.evidence],
          diagnostics,
        };
      }

      // Check for Python in service directory
      const pyRes = await PythonDetector.analyze(targetDir, cleanServicePath);
      if (pyRes) {
        diagnostics.push(`✓ Python application detected in ${cleanServicePath} (${pyRes.type} - ${pyRes.framework}).`);
        return {
          type: pyRes.type,
          framework: pyRes.framework,
          runtime: pyRes.runtime,
          deploymentMode: pyRes.deploymentMode,
          rootPath: '.',
          servicePath: cleanServicePath,
          buildContext: targetDir,
          confidence: 0.9,
          entrypoint: pyRes.entrypoint,
          internalPort: (pyRes.detectedPorts && pyRes.detectedPorts[0]) || 8000,
          detectedPorts: pyRes.detectedPorts,
          buildCommand: pyRes.buildCommand,
          startCommand: pyRes.startCommand,
          mainFile: pyRes.entrypoint,
          dependencyFile: pyRes.dependencyFile,
          hasDockerfile: false,
          detectedEnvVars: genericDetectedEnvVars,
          missingRequiredEnvVars: genericMissingRequired,
          evidence: [...evidence, ...pyRes.evidence],
          diagnostics,
        };
      }

      // Check for static HTML in service directory
      if (existsSync(path.join(targetDir, 'index.html'))) {
        return {
          type: 'static',
          framework: 'Static HTML / Vanilla Web',
          runtime: 'Static Web Server',
          deploymentMode: 'static',
          rootPath: '.',
          servicePath: cleanServicePath,
          buildContext: targetDir,
          confidence: 0.8,
          internalPort: 3000,
          detectedPorts: [3000],
          hasDockerfile: false,
          evidence: [...evidence, `index.html found in ${cleanServicePath}`],
          diagnostics,
        };
      }

      throw new Error(`DEPLOYMENT_CONFIGURATION_ERROR: No supported application found in selected service path: "${cleanServicePath}".`);
    }

    // ── PRIORITY 1: Docker Compose ──────────────────────────────────────────
    const composeFile = ComposeParser.findComposeFile(repoPath);
    if (composeFile) {
      try {
        const composeInfo = await ComposeParser.parse(repoPath, composeFile, userEnv);
        diagnostics.push(`✓ ${composeFile} detected with ${composeInfo.services.length} services.`);
        evidence.push(`Docker Compose configuration (${composeFile}) found at root`);
        evidence.push(`Services: ${composeInfo.services.map((s) => s.name).join(', ')}`);
        if (composeInfo.primaryService) {
          evidence.push(`Primary web routing service: "${composeInfo.primaryService}" (Port: ${composeInfo.primaryPort})`);
        }

        return {
          type: 'docker-compose',
          framework: 'Docker Compose',
          runtime: 'Docker Compose',
          deploymentMode: 'multi-service',
          rootPath: '.',
          buildContext: repoResolved,
          confidence: 1.0,
          internalPort: composeInfo.internalPort || 3000,
          detectedPorts: composeInfo.primaryPort ? [composeInfo.primaryPort] : [3000],
          hasDockerfile: composeInfo.services.some((s) => Boolean(s.build)),
          composeInfo,
          detectedEnvVars: composeInfo.detectedEnvVars,
          missingRequiredEnvVars: composeInfo.missingRequiredEnvVars,
          evidence,
          diagnostics,
        };
      } catch (composeErr: any) {
        throw new Error(`Docker Compose validation failed: ${composeErr.message}`);
      }
    }

    // ── PRIORITY 2: Root Dockerfile ─────────────────────────────────────────
    const rootDockerfilePath = path.join(repoPath, 'Dockerfile');
    if (existsSync(rootDockerfilePath)) {
      diagnostics.push('✓ Root Dockerfile detected.');
      evidence.push('Dockerfile found at repository root');

      // Check EXPOSE port in Dockerfile
      let exposedPort = 3000;
      try {
        const dockerContent = await fs.readFile(rootDockerfilePath, 'utf8');
        const exposeMatch = dockerContent.match(/EXPOSE\s+(\d+)/i);
        if (exposeMatch) {
          exposedPort = parseInt(exposeMatch[1], 10) || 3000;
          evidence.push(`Dockerfile EXPOSE port ${exposedPort}`);
        }
      } catch {}

      return {
        type: 'docker',
        framework: 'Custom Dockerfile',
        runtime: 'Docker Container',
        deploymentMode: 'web',
        rootPath: '.',
        buildContext: repoResolved,
        confidence: 0.95,
        internalPort: exposedPort,
        detectedPorts: [exposedPort],
        hasDockerfile: true,
        dockerfilePath: 'Dockerfile',
        detectedEnvVars: genericDetectedEnvVars,
        missingRequiredEnvVars: genericMissingRequired,
        evidence,
        diagnostics,
      };
    }

    // ── PRIORITY 3: Root Application Detection ──────────────────────────────
    // 3A. Node.js Ecosystem (package.json at root)
    const rootPkgResult = await PackageAnalyzer.analyze(repoPath, '.');
    if (rootPkgResult) {
      const isJobOrUnsupported = rootPkgResult.deploymentMode === 'job' || rootPkgResult.deploymentMode === 'unsupported';
      const hasWorkspaces = Boolean(rootPkgResult.hasWorkspaces);

      if (isJobOrUnsupported || hasWorkspaces) {
        // Check if this is a monorepo or wrapper repo with nested deployable services
        const nestedCandidates = await ServiceScanner.scan(repoPath, 3);
        if (nestedCandidates.length > 1) {
          diagnostics.push(`✓ Discovered ${nestedCandidates.length} nested service candidate(s) under root coordinator: ${nestedCandidates.map((c) => c.path).join(', ')}`);
          evidence.push('Root package.json acts as monorepo / workspace coordinator');
          evidence.push(`Discovered ${nestedCandidates.length} deployable nested service candidate(s)`);
          return {
            type: 'monorepo',
            framework: 'Multi-Service Monorepo',
            runtime: 'Multiple Runtimes',
            deploymentMode: 'multi-service',
            rootPath: '.',
            confidence: 0.85,
            internalPort: 0,
            detectedPorts: [],
            hasDockerfile: nestedCandidates.some((c) => Boolean(c.dockerfilePath)),
            candidates: nestedCandidates,
            detectedEnvVars: genericDetectedEnvVars,
            missingRequiredEnvVars: genericMissingRequired,
            evidence: [
              ...evidence,
              ...nestedCandidates.map((c) => `Candidate "${c.name}" at ${c.path} (${c.type} / ${c.framework})`),
            ],
            diagnostics,
          };
        } else if (nestedCandidates.length === 1) {
          const singleCandidate = nestedCandidates[0];
          const singleCandidateContext = path.resolve(repoPath, singleCandidate.path);
          diagnostics.push(`✓ Single nested service candidate "${singleCandidate.name}" resolved at ${singleCandidate.path}.`);
          return {
            type: singleCandidate.type,
            framework: singleCandidate.framework,
            runtime: singleCandidate.runtime,
            deploymentMode: singleCandidate.deploymentMode,
            rootPath: '.',
            servicePath: singleCandidate.path,
            buildContext: singleCandidateContext,
            outputDirectory: singleCandidate.outputDirectory,
            packageManager: singleCandidate.packageManager,
            installCommand: singleCandidate.installCommand,
            hasLockfile: singleCandidate.hasLockfile,
            confidence: 0.85,
            entrypoint: singleCandidate.entrypoint,
            internalPort: (singleCandidate.detectedPorts && singleCandidate.detectedPorts[0]) || (singleCandidate.deploymentMode === 'static' ? 3000 : 0),
            detectedPorts: singleCandidate.detectedPorts,
            buildCommand: singleCandidate.buildCommand,
            startCommand: singleCandidate.startCommand,
            hasDockerfile: Boolean(singleCandidate.dockerfilePath),
            dockerfilePath: singleCandidate.dockerfilePath,
            candidates: nestedCandidates,
            detectedEnvVars: genericDetectedEnvVars,
            missingRequiredEnvVars: genericMissingRequired,
            evidence: singleCandidate.evidence,
            diagnostics,
          };
        }
      }

      diagnostics.push(`✓ Root ${rootPkgResult.framework} application detected (${rootPkgResult.type}).`);
      return {
        type: rootPkgResult.type,
        framework: rootPkgResult.framework,
        runtime: rootPkgResult.runtime,
        deploymentMode: rootPkgResult.deploymentMode,
        rootPath: '.',
        buildContext: repoResolved,
        outputDirectory: rootPkgResult.outputDirectory,
        confidence: 0.9,
        entrypoint: rootPkgResult.entrypoint,
        internalPort: rootPkgResult.detectedPorts[0] || (rootPkgResult.deploymentMode === 'static' ? 3000 : 0),
        detectedPorts: rootPkgResult.detectedPorts,
        buildCommand: rootPkgResult.buildCommand,
        startCommand: rootPkgResult.startCommand,
        mainFile: rootPkgResult.entrypoint,
        packageManager: rootPkgResult.packageManager,
        installCommand: rootPkgResult.installCommand,
        hasLockfile: rootPkgResult.hasLockfile,
        dependencyFile: rootPkgResult.dependencyFile,
        hasDockerfile: false,
        detectedEnvVars: genericDetectedEnvVars,
        missingRequiredEnvVars: genericMissingRequired,
        evidence: rootPkgResult.evidence,
        diagnostics,
      };
    }

    // 3B. Python Ecosystem at root (requirements.txt, pyproject.toml, Pipfile, setup.py)
    const rootPyResult = await PythonDetector.analyze(repoPath, '.');
    if (rootPyResult) {
      if (rootPyResult.deploymentMode === 'job' || rootPyResult.deploymentMode === 'unsupported') {
        const nestedCandidates = await ServiceScanner.scan(repoPath, 3);
        if (nestedCandidates.length > 1) {
          diagnostics.push(`✓ Discovered ${nestedCandidates.length} nested service candidate(s) under root Python coordinator: ${nestedCandidates.map((c) => c.path).join(', ')}`);
          evidence.push('Root Python environment acts as monorepo / project coordinator');
          evidence.push(`Discovered ${nestedCandidates.length} deployable nested service candidate(s)`);
          return {
            type: 'monorepo',
            framework: 'Multi-Service Monorepo',
            runtime: 'Multiple Runtimes',
            deploymentMode: 'multi-service',
            rootPath: '.',
            confidence: 0.85,
            internalPort: 0,
            detectedPorts: [],
            hasDockerfile: nestedCandidates.some((c) => Boolean(c.dockerfilePath)),
            candidates: nestedCandidates,
            detectedEnvVars: genericDetectedEnvVars,
            missingRequiredEnvVars: genericMissingRequired,
            evidence: [
              ...evidence,
              ...nestedCandidates.map((c) => `Candidate "${c.name}" at ${c.path} (${c.type} / ${c.framework})`),
            ],
            diagnostics,
          };
        } else if (nestedCandidates.length === 1) {
          const singleCandidate = nestedCandidates[0];
          const singleCandidateContext = path.resolve(repoPath, singleCandidate.path);
          diagnostics.push(`✓ Single nested service candidate "${singleCandidate.name}" resolved at ${singleCandidate.path}.`);
          return {
            type: singleCandidate.type,
            framework: singleCandidate.framework,
            runtime: singleCandidate.runtime,
            deploymentMode: singleCandidate.deploymentMode,
            rootPath: '.',
            servicePath: singleCandidate.path,
            buildContext: singleCandidateContext,
            outputDirectory: singleCandidate.outputDirectory,
            packageManager: singleCandidate.packageManager,
            installCommand: singleCandidate.installCommand,
            hasLockfile: singleCandidate.hasLockfile,
            confidence: 0.85,
            entrypoint: singleCandidate.entrypoint,
            internalPort: (singleCandidate.detectedPorts && singleCandidate.detectedPorts[0]) || (singleCandidate.deploymentMode === 'static' ? 3000 : 0),
            detectedPorts: singleCandidate.detectedPorts,
            buildCommand: singleCandidate.buildCommand,
            startCommand: singleCandidate.startCommand,
            hasDockerfile: Boolean(singleCandidate.dockerfilePath),
            dockerfilePath: singleCandidate.dockerfilePath,
            candidates: nestedCandidates,
            detectedEnvVars: genericDetectedEnvVars,
            missingRequiredEnvVars: genericMissingRequired,
            evidence: singleCandidate.evidence,
            diagnostics,
          };
        }
      }

      diagnostics.push(`✓ Root Python application detected (${rootPyResult.type} - ${rootPyResult.framework}).`);
      return {
        type: rootPyResult.type,
        framework: rootPyResult.framework,
        runtime: rootPyResult.runtime,
        deploymentMode: rootPyResult.deploymentMode,
        rootPath: '.',
        buildContext: repoResolved,
        confidence: 0.9,
        entrypoint: rootPyResult.entrypoint,
        internalPort: (rootPyResult.detectedPorts && rootPyResult.detectedPorts[0]) || (rootPyResult.deploymentMode === 'job' ? 0 : 8000),
        detectedPorts: rootPyResult.detectedPorts,
        buildCommand: rootPyResult.buildCommand,
        startCommand: rootPyResult.startCommand,
        mainFile: rootPyResult.entrypoint,
        dependencyFile: rootPyResult.dependencyFile,
        hasDockerfile: false,
        detectedEnvVars: genericDetectedEnvVars,
        missingRequiredEnvVars: genericMissingRequired,
        evidence: rootPyResult.evidence,
        diagnostics,
      };
    }

    // ── PRIORITY 4: Nested Service & Monorepo Discovery ─────────────────────
    const nestedCandidates = await ServiceScanner.scan(repoPath, 3);
    if (nestedCandidates.length > 0) {
      diagnostics.push(`✓ Discovered ${nestedCandidates.length} nested service candidate(s): ${nestedCandidates.map((c) => c.path).join(', ')}`);
      evidence.push(`Discovered ${nestedCandidates.length} deployable nested service candidate(s)`);

      // If multiple candidates exist (e.g. Speak-AI with backend/ and frontend/)
      if (nestedCandidates.length > 1) {
        return {
          type: 'monorepo',
          framework: 'Multi-Service Monorepo',
          runtime: 'Multiple Runtimes',
          deploymentMode: 'multi-service',
          rootPath: '.',
          confidence: 0.85,
          internalPort: 0,
          detectedPorts: [], // Never assign a misleading global port before service selection
          hasDockerfile: nestedCandidates.some((c) => Boolean(c.dockerfilePath)),
          candidates: nestedCandidates,
          detectedEnvVars: genericDetectedEnvVars,
          missingRequiredEnvVars: genericMissingRequired,
          evidence: [
            ...evidence,
            ...nestedCandidates.map((c) => `Candidate "${c.name}" at ${c.path} (${c.type} / ${c.framework})`),
          ],
          diagnostics,
        };
      }

      // Exactly 1 nested candidate found (e.g. single nested app in frontend/ or app/)
      const singleCandidate = nestedCandidates[0];
      const singleCandidateContext = path.resolve(repoPath, singleCandidate.path);
      return {
        type: singleCandidate.type,
        framework: singleCandidate.framework,
        runtime: singleCandidate.runtime,
        deploymentMode: singleCandidate.deploymentMode,
        rootPath: '.',
        servicePath: singleCandidate.path,
        buildContext: singleCandidateContext,
        outputDirectory: singleCandidate.outputDirectory,
        packageManager: singleCandidate.packageManager,
        installCommand: singleCandidate.installCommand,
        hasLockfile: singleCandidate.hasLockfile,
        confidence: 0.85,
        entrypoint: singleCandidate.entrypoint,
        internalPort: (singleCandidate.detectedPorts && singleCandidate.detectedPorts[0]) || (singleCandidate.deploymentMode === 'static' ? 3000 : 0),
        detectedPorts: singleCandidate.detectedPorts,
        buildCommand: singleCandidate.buildCommand,
        startCommand: singleCandidate.startCommand,
        hasDockerfile: Boolean(singleCandidate.dockerfilePath),
        dockerfilePath: singleCandidate.dockerfilePath,
        candidates: nestedCandidates,
        detectedEnvVars: genericDetectedEnvVars,
        missingRequiredEnvVars: genericMissingRequired,
        evidence: singleCandidate.evidence,
        diagnostics,
      };
    }

    // ── PRIORITY 5: Pure Static HTML / Web ──────────────────────────────────
    const hasIndexHtml = existsSync(path.join(repoPath, 'index.html'));
    if (hasIndexHtml) {
      diagnostics.push('✓ Static HTML site detected (index.html found at root).');
      evidence.push('index.html found at root with no package.json build tool');
      return {
        type: 'static',
        framework: 'Static HTML / Vanilla Web',
        runtime: 'Static Web Server',
        deploymentMode: 'static',
        rootPath: '.',
        buildContext: repoResolved,
        confidence: 0.8,
        internalPort: 3000,
        detectedPorts: [3000],
        hasDockerfile: false,
        evidence,
        diagnostics,
      };
    }

    // ── PRIORITY 6: Unknown / Unsupported ───────────────────────────────────
    diagnostics.push('❌ No supported application structure or configuration detected.');
    evidence.push('Checked for Docker Compose, Dockerfile, package.json, requirements.txt, pyproject.toml, nested services, and index.html');

    return {
      type: 'unknown',
      runtime: 'Unknown',
      deploymentMode: 'unsupported',
      rootPath: '.',
      confidence: 0.0,
      internalPort: 0,
      detectedPorts: [],
      hasDockerfile: false,
      evidence,
      diagnostics,
    };
  }
}
