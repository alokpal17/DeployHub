import { exec } from 'child_process';
import { promisify } from 'util';
import type { RuntimeDiagnosticResult, StartupFailureType } from '@deployhub/shared';
import { DockerService } from './docker.service';

const execAsync = promisify(exec);

export class RuntimeDiagnosticsService {
  /**
   * Deterministically diagnoses container startup and runtime failures.
   */
  static async diagnoseContainerCrash(
    containerIdOrName: string,
    rawLogs?: string,
    envVars?: Record<string, string>
  ): Promise<RuntimeDiagnosticResult> {
    let exitCode: number | undefined = undefined;
    let oomKilled = false;
    let containerStatus = '';
    let inspectError = '';

    // 1. Inspect container state via docker inspect
    try {
      const { stdout } = await execAsync(`docker inspect ${containerIdOrName}`);
      const inspectData = JSON.parse(stdout);
      if (Array.isArray(inspectData) && inspectData.length > 0) {
        const state = inspectData[0].State || {};
        exitCode = state.ExitCode;
        oomKilled = Boolean(state.OOMKilled);
        containerStatus = state.Status || '';
        inspectError = state.Error || '';
      }
    } catch {}

    // 2. Fetch tail logs if not supplied (capture stdout & stderr)
    let logContent = rawLogs || '';
    if (!logContent) {
      try {
        const { stdout, stderr } = await execAsync(`docker logs --tail 200 ${containerIdOrName}`).catch(() => ({ stdout: '', stderr: '' }));
        logContent = `${stdout || ''}\n${stderr || ''}`.trim();
      } catch {}
    }

    // Mask secrets in logs
    const maskedLogs = DockerService.maskSecrets(logContent, envVars);
    const logLines = maskedLogs.split('\n').map((l) => l.trimEnd()).filter(Boolean);

    // 3. Classify error type and extract stack trace
    let failureType: StartupFailureType = 'APPLICATION_CRASH';
    let classification = 'Application startup failure';
    let rootCauseMessage = `Container exited with code ${exitCode ?? 1}.`;
    let suggestedFix: string | undefined = undefined;
    let rawError: string | undefined = undefined;
    let stackTrace: string | undefined = undefined;

    // Extract stack trace block from logs
    const stackTraceLines: string[] = [];
    let isCapturingStack = false;

    for (let i = 0; i < logLines.length; i++) {
      const line = logLines[i];
      if (
        line.includes('Error:') ||
        line.includes('Exception:') ||
        line.includes('TypeError:') ||
        line.includes('ReferenceError:') ||
        line.includes('SyntaxError:') ||
        line.includes('MongoServerError:') ||
        line.includes('Traceback (most recent call last):')
      ) {
        rawError = line;
        isCapturingStack = true;
        stackTraceLines.push(line);
      } else if (isCapturingStack) {
        if (line.startsWith('at ') || line.startsWith('    at ') || line.startsWith('  File ') || line.startsWith('    ')) {
          stackTraceLines.push(line);
        } else if (stackTraceLines.length > 1) {
          isCapturingStack = false;
        }
      }
    }

    if (stackTraceLines.length > 0) {
      stackTrace = stackTraceLines.join('\n');
    }

    // 4. Deterministic pattern recognition
    if (oomKilled || maskedLogs.includes('JavaScript heap out of memory') || maskedLogs.includes('MemoryError')) {
      failureType = 'OOM_KILLED';
      classification = 'Container exceeded memory limit (Out of Memory)';
      rootCauseMessage = 'The container exceeded its allocated memory quota and was terminated by the Docker daemon OOM killer.';
      suggestedFix = 'Increase container memory quota in project settings or optimize application memory consumption.';
    } else if (
      /missing.*(?:api_key|secret|token|uri|database|env|variable)/i.test(maskedLogs) ||
      /Cannot read properties of undefined \(reading ['"](endsWith|split|slice|trim|replace)['"]\)/i.test(maskedLogs) ||
      /process\.env\.[A-Za-z0-9_]+ is undefined/i.test(maskedLogs) ||
      /KeyError: ['"][A-Z0-9_]+['"]/i.test(maskedLogs)
    ) {
      failureType = 'MISSING_ENV_VAR';
      classification = 'Missing required environment variable';
      
      // Extract specific missing variable name if present
      const envMatch = maskedLogs.match(/(?:Missing|undefined|KeyError:)\s*['"]?([A-Z0-9_]{3,})['"]?/i);
      const missingVarName = envMatch ? envMatch[1] : undefined;
      
      rootCauseMessage = missingVarName
        ? `Application crashed during startup due to missing environment variable: "${missingVarName}".`
        : 'Application crashed during startup because a required environment variable was undefined.';
      suggestedFix = 'Configure the required environment variables in Project Settings -> Environment Variables and redeploy.';
    } else if (/Missing script: ['"]start['"]/i.test(maskedLogs) || /missing script: start/i.test(maskedLogs)) {
      failureType = 'DEPLOYMENT_CONFIGURATION_ERROR';
      classification = 'Missing start script in package.json';
      rootCauseMessage = 'Process tried to execute "npm start", but no "start" script was defined in package.json.';
      suggestedFix = 'Add a "start" script to package.json or specify the production server entrypoint.';
    } else if (/EADDRINUSE/i.test(maskedLogs) || /address already in use/i.test(maskedLogs) || /port is already allocated/i.test(maskedLogs)) {
      failureType = 'PORT_BIND_FAILURE';
      classification = 'Port binding failure (EADDRINUSE)';
      rootCauseMessage = 'The application failed to bind to the network port because it was already occupied by another process.';
      suggestedFix = 'Ensure the application listens on the dynamically allocated PORT environment variable ($PORT) and binds to 0.0.0.0.';
    } else if (
      /MODULE_NOT_FOUND/i.test(maskedLogs) ||
      /Cannot find module/i.test(maskedLogs) ||
      /No module named/i.test(maskedLogs) ||
      /ImportError:/i.test(maskedLogs)
    ) {
      failureType = 'MISSING_DEPENDENCY';
      classification = 'Missing runtime dependency / module';
      const modMatch = maskedLogs.match(/Cannot find module ['"]([^'"]+)['"]/i) || maskedLogs.match(/No module named ['"]([^'"]+)['"]/i);
      const modName = modMatch ? modMatch[1] : undefined;
      rootCauseMessage = modName
        ? `Application failed to locate required dependency: "${modName}".`
        : 'Application failed to start due to missing package dependencies.';
      suggestedFix = 'Ensure all dependencies are declared in package.json / requirements.txt and included in the build output.';
    } else if (
      /MONGODB connection FAILED/i.test(maskedLogs) ||
      /MongoServerError/i.test(maskedLogs) ||
      /MongooseServerSelectionError/i.test(maskedLogs) ||
      /ECONNREFUSED/i.test(maskedLogs) ||
      /ConnectionRefusedError/i.test(maskedLogs)
    ) {
      failureType = 'DATABASE_FAILURE';
      classification = 'Database connection failure';
      rootCauseMessage = 'The application failed to establish a connection to the database instance.';
      suggestedFix = 'Verify database credentials, host reachability, IP allowlist (0.0.0.0/0 on cloud databases), and MONGODB_URI in Project Settings.';
    } else if (/SyntaxError:/i.test(maskedLogs) || /Unexpected token/i.test(maskedLogs)) {
      failureType = 'SYNTAX_ERROR';
      classification = 'Syntax error during execution';
      rootCauseMessage = rawError || 'Application encountered a SyntaxError during initialization.';
      suggestedFix = 'Review application source files for syntax errors or unsupported JavaScript/TypeScript runtime features.';
    } else if (
      /(?:bun|pnpm|yarn|node|python|sh|bash|uvicorn|gunicorn|flask|streamlit|esbuild|tsc|next|vite):\s*(?:not found|command not found|cannot be found)/i.test(maskedLogs) ||
      /exec:.*executable file not found/i.test(maskedLogs) ||
      /env: ['"][^'"]+['"]: No such file or directory/i.test(maskedLogs)
    ) {
      failureType = 'RUNTIME_TOOLCHAIN_MISSING';
      classification = 'Missing runtime toolchain or binary in container';
      const toolMatch = maskedLogs.match(/(bun|pnpm|yarn|node|python|sh|bash|uvicorn|gunicorn|flask|streamlit|esbuild|tsc|next|vite):\s*(?:not found|command not found)/i);
      const toolName = toolMatch ? toolMatch[1] : 'required tool';
      rootCauseMessage = `Runtime toolchain "${toolName}" was not found in the container environment.`;
      suggestedFix = 'Ensure the project packageManager is correctly specified or build toolchain is provisioned in the container image.';
    } else if (/DEPLOYMENT_CONFIGURATION_ERROR/i.test(maskedLogs)) {
      failureType = 'DEPLOYMENT_CONFIGURATION_ERROR';
      classification = 'Deployment configuration error';
      rootCauseMessage = rawError || 'Invalid deployment configuration or missing service context.';
      suggestedFix = 'Verify the selected service path and ensure build dependencies (e.g. package.json, requirements.txt) exist in the build context.';
    } else if (/EACCES/i.test(maskedLogs) || /permission denied/i.test(maskedLogs)) {
      failureType = 'PERMISSION_FAILURE';
      classification = 'Permission / File access error';
      rootCauseMessage = 'The application failed to access a file or socket due to insufficient process permissions.';
      suggestedFix = 'Check container file permissions and avoid running non-root operations on protected paths.';
    } else {
      failureType = 'APPLICATION_CRASH';
      classification = 'Application startup crash';
      rootCauseMessage = rawError || `Application process exited unexpectedly with code ${exitCode ?? 1}.`;
      suggestedFix = 'Review the runtime container logs below to diagnose the application exception.';
    }

    return {
      failureType,
      classification,
      exitCode,
      oomKilled,
      rawError,
      stackTrace,
      rootCauseMessage,
      suggestedFix,
      tailLogs: logLines.slice(-100),
    };
  }
}
