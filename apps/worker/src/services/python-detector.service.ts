import path from 'path';
import fs from 'fs/promises';
import { existsSync, readdirSync, statSync } from 'fs';
import type { ProjectType, DeploymentMode } from '@deployhub/shared';

export interface PythonAnalysisResult {
  type: ProjectType;
  framework: string;
  runtime: string;
  deploymentMode: DeploymentMode;
  entrypoint?: string;
  buildCommand?: string;
  startCommand?: string;
  dependencyFile?: string;
  detectedPorts: number[];
  evidence: string[];
}

export class PythonDetector {
  /**
   * Deterministically analyzes a directory for Python applications, frameworks, jobs, and ML projects.
   */
  static async analyze(
    targetDir: string,
    relativePrefix = '.'
  ): Promise<PythonAnalysisResult | null> {
    const hasReq = existsSync(path.join(targetDir, 'requirements.txt'));
    const hasPyproject = existsSync(path.join(targetDir, 'pyproject.toml'));
    const hasPipfile = existsSync(path.join(targetDir, 'Pipfile'));
    const hasSetupPy = existsSync(path.join(targetDir, 'setup.py'));
    const hasEnvironmentYml = existsSync(path.join(targetDir, 'environment.yml'));

    // Check for any .py files in root or src/
    let hasPyFiles = false;
    let mainPyFile = '';
    const pyEntryCandidates = [
      'main.py',
      'app.py',
      'server.py',
      'index.py',
      'api.py',
      'wsgi.py',
      'asgi.py',
      'src/main.py',
      'src/app.py',
      'src/server.py',
      'src/index.py',
      'train.py',
      'predict.py',
      'run.py',
      'worker.py',
    ];

    for (const cand of pyEntryCandidates) {
      if (existsSync(path.join(targetDir, cand))) {
        hasPyFiles = true;
        mainPyFile = cand;
        break;
      }
    }

    if (!hasPyFiles) {
      try {
        const files = readdirSync(targetDir);
        for (const f of files) {
          if (f.endsWith('.py')) {
            hasPyFiles = true;
            if (!mainPyFile) mainPyFile = f;
            break;
          }
        }
      } catch {}
    }

    if (!hasReq && !hasPyproject && !hasPipfile && !hasSetupPy && !hasEnvironmentYml && !hasPyFiles) {
      return null;
    }

    const evidence: string[] = [];
    let dependencyFile = '';
    let depContent = '';

    if (hasReq) {
      dependencyFile = 'requirements.txt';
      evidence.push(`requirements.txt found at ${relativePrefix}`);
      try {
        depContent += '\n' + (await fs.readFile(path.join(targetDir, 'requirements.txt'), 'utf8'));
      } catch {}
    }
    if (hasPyproject) {
      if (!dependencyFile) dependencyFile = 'pyproject.toml';
      evidence.push(`pyproject.toml found at ${relativePrefix}`);
      try {
        depContent += '\n' + (await fs.readFile(path.join(targetDir, 'pyproject.toml'), 'utf8'));
      } catch {}
    }
    if (hasPipfile) {
      if (!dependencyFile) dependencyFile = 'Pipfile';
      evidence.push(`Pipfile found at ${relativePrefix}`);
      try {
        depContent += '\n' + (await fs.readFile(path.join(targetDir, 'Pipfile'), 'utf8'));
      } catch {}
    }
    if (hasSetupPy) {
      if (!dependencyFile) dependencyFile = 'setup.py';
      evidence.push(`setup.py found at ${relativePrefix}`);
    }

    const depLower = depContent.toLowerCase();

    // 1. Detect Web Frameworks
    const isFastAPI = /fastapi/i.test(depLower);
    const isFlask = /flask/i.test(depLower);
    const isDjango = /django/i.test(depLower);
    const isStreamlit = /streamlit/i.test(depLower);
    const isTornado = /tornado/i.test(depLower);
    const isSanic = /sanic/i.test(depLower);
    const isUvicorn = /uvicorn/i.test(depLower);
    const isGunicorn = /gunicorn/i.test(depLower);

    // 2. Detect ML / Data Science Markers
    // NOTE: do NOT infer ML from pandas or numpy alone; require ML libraries or serialized model artifacts
    const hasScikit = /scikit-learn|sklearn/i.test(depLower);
    const hasTorch = /torch|pytorch|torchvision/i.test(depLower);
    const hasTensorflow = /tensorflow|keras/i.test(depLower);
    const hasXGBoost = /xgboost|lightgbm|catboost/i.test(depLower);
    const hasTransformers = /transformers|huggingface/i.test(depLower);

    // Look for serialized model artifacts
    let hasModelArtifacts = false;
    try {
      const scanModelFiles = (dir: string, depth = 0) => {
        if (depth > 2) return;
        const entries = readdirSync(dir);
        for (const e of entries) {
          if (e === '.git' || e === 'node_modules' || e === '__pycache__' || e === '.venv') continue;
          const full = path.join(dir, e);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            scanModelFiles(full, depth + 1);
          } else if (stat.isFile()) {
            if (/\.(pkl|joblib|pt|pth|onnx|h5|model|bin)$/i.test(e)) {
              hasModelArtifacts = true;
              evidence.push(`Model artifact detected: ${path.relative(targetDir, full)}`);
              return;
            }
          }
        }
      };
      scanModelFiles(targetDir);
    } catch {}

    const isMLProject = hasScikit || hasTorch || hasTensorflow || hasXGBoost || hasTransformers || hasModelArtifacts;

    // Classification Decision
    let type: ProjectType = 'python-web';
    let framework = 'Python';
    let deploymentMode: DeploymentMode = 'web';
    let startCommand = '';
    const detectedPorts: number[] = [];

    if (isFastAPI) {
      type = 'python-web';
      framework = 'FastAPI';
      deploymentMode = 'web';
      detectedPorts.push(8000);
      const entryModule = mainPyFile ? mainPyFile.replace(/\.py$/, '').replace(/\//g, '.') : 'main';
      startCommand = `uvicorn ${entryModule}:app --host 0.0.0.0 --port $PORT`;
      evidence.push('FastAPI web framework detected');
    } else if (isFlask) {
      type = 'python-web';
      framework = 'Flask';
      deploymentMode = 'web';
      detectedPorts.push(5000);
      const entryModule = mainPyFile ? mainPyFile.replace(/\.py$/, '').replace(/\//g, '.') : 'app';
      startCommand = `gunicorn ${entryModule}:app -b 0.0.0.0:$PORT`;
      evidence.push('Flask web framework detected');
    } else if (isDjango) {
      type = 'python-web';
      framework = 'Django';
      deploymentMode = 'web';
      detectedPorts.push(8000);
      startCommand = 'python manage.py runserver 0.0.0.0:$PORT';
      evidence.push('Django web framework detected');
    } else if (isStreamlit) {
      type = 'python-web';
      framework = 'Streamlit';
      deploymentMode = 'web';
      detectedPorts.push(8501);
      startCommand = `streamlit run ${mainPyFile || 'app.py'} --server.port $PORT --server.address 0.0.0.0`;
      evidence.push('Streamlit application detected');
    } else if (isMLProject) {
      type = 'python-ml';
      framework = hasScikit ? 'Scikit-Learn' : hasTorch ? 'PyTorch' : hasTensorflow ? 'TensorFlow' : 'Python ML';
      deploymentMode = 'job';
      startCommand = mainPyFile ? `python ${mainPyFile}` : 'python main.py';
      evidence.push(`Machine Learning project (${framework})`);
      // Pure ML job has no HTTP ports
    } else {
      type = 'python-job';
      framework = 'Python Script / Job';
      deploymentMode = 'job';
      startCommand = mainPyFile ? `python ${mainPyFile}` : 'python main.py';
      evidence.push('Python standalone job/script detected (no web framework)');
      // Pure job has no HTTP ports
    }

    const buildCommand = dependencyFile ? `pip install -r ${dependencyFile}` : undefined;

    return {
      type,
      framework,
      runtime: 'Python 3.11',
      deploymentMode,
      entrypoint: mainPyFile || undefined,
      buildCommand,
      startCommand,
      dependencyFile,
      detectedPorts, // Empty for jobs, [8000]/[5000]/[8501] for web
      evidence,
    };
  }
}
