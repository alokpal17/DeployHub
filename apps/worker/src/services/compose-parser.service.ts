import path from 'path';
import fs from 'fs/promises';
import { existsSync, readdirSync, statSync } from 'fs';
import YAML from 'yaml';
import type {
  ComposeDetectionInfo,
  ComposeServiceInfo,
  ComposeServiceBuildInfo,
  DetectedEnvVar,
} from '@deployhub/shared';

export const COMPOSE_FILE_CANDIDATES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

export class ComposeParser {
  /**
   * Checks if any supported Docker Compose file exists in the repository root.
   */
  static findComposeFile(repoPath: string): string | null {
    for (const candidate of COMPOSE_FILE_CANDIDATES) {
      const fullPath = path.join(repoPath, candidate);
      if (existsSync(fullPath)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Safely parses and validates the Docker Compose file, resolving services,
   * build contexts, Dockerfiles, and environment requirements.
   */
  static async parse(
    repoPath: string,
    composeFileName?: string,
    userProvidedEnv?: Record<string, string>
  ): Promise<ComposeDetectionInfo> {
    const fileName = composeFileName || this.findComposeFile(repoPath);
    if (!fileName) {
      throw new Error(
        'No Docker Compose file found (checked docker-compose.yml, docker-compose.yaml, compose.yml, compose.yaml).'
      );
    }

    const composeFilePath = path.join(repoPath, fileName);
    let rawContent = '';
    try {
      rawContent = await fs.readFile(composeFilePath, 'utf8');
    } catch (err: any) {
      throw new Error(`Failed to read Docker Compose file ${fileName}: ${err.message}`);
    }

    if (!rawContent.trim()) {
      throw new Error(`Docker Compose file ${fileName} is empty.`);
    }

    let parsedDoc: any;
    try {
      parsedDoc = YAML.parse(rawContent);
    } catch (err: any) {
      throw new Error(
        `Invalid Compose YAML syntax in ${fileName}: ${err.message || 'Parsing error'}`
      );
    }

    if (!parsedDoc || typeof parsedDoc !== 'object') {
      throw new Error(
        `Invalid Compose file structure in ${fileName}: Expected a YAML dictionary at root.`
      );
    }

    const servicesRaw = parsedDoc.services;
    if (!servicesRaw || typeof servicesRaw !== 'object' || Object.keys(servicesRaw).length === 0) {
      throw new Error(
        `Invalid Docker Compose file: No services defined in ${fileName}. Please define at least one service.`
      );
    }

    const services: ComposeServiceInfo[] = [];
    const detectedEnvMap = new Map<string, DetectedEnvVar>();

    // 1. Scan variable interpolations in raw compose file (${VAR}, ${VAR:-default}, $VAR)
    this.extractInterpolatedEnvVars(rawContent, detectedEnvMap);

    // 2. Parse individual services
    for (const [serviceName, serviceConfig] of Object.entries(servicesRaw)) {
      if (!serviceConfig || typeof serviceConfig !== 'object') {
        throw new Error(
          `Invalid service configuration for "${serviceName}" in ${fileName}: Must be an object.`
        );
      }

      const cfg = serviceConfig as Record<string, any>;
      const serviceInfo: ComposeServiceInfo = {
        name: serviceName,
        image: typeof cfg.image === 'string' ? cfg.image : undefined,
      };

      // Parse Build config
      if (cfg.build) {
        const buildInfo: ComposeServiceBuildInfo = {};
        if (typeof cfg.build === 'string') {
          buildInfo.context = cfg.build;
          buildInfo.dockerfile = 'Dockerfile';
        } else if (typeof cfg.build === 'object') {
          buildInfo.context = cfg.build.context || '.';
          buildInfo.dockerfile = cfg.build.dockerfile || 'Dockerfile';
          if (cfg.build.args && typeof cfg.build.args === 'object') {
            buildInfo.args = cfg.build.args;
          }
          if (cfg.build.target) {
            buildInfo.target = cfg.build.target;
          }
        }

        // Validate build context directory
        const contextRel = buildInfo.context || '.';
        const resolvedContext = path.resolve(repoPath, contextRel);

        if (!existsSync(resolvedContext)) {
          throw new Error(
            `Compose service "${serviceName}" references non-existent build context directory: "${contextRel}"`
          );
        }

        // Resolve Dockerfile path
        const dockerfileRel = buildInfo.dockerfile || 'Dockerfile';
        const candidatePaths = [
          path.resolve(resolvedContext, dockerfileRel),
          path.resolve(repoPath, dockerfileRel),
        ];

        let foundDockerfile = '';
        for (const cand of candidatePaths) {
          if (existsSync(cand)) {
            foundDockerfile = cand;
            break;
          }
        }

        if (!foundDockerfile) {
          throw new Error(
            `Compose service "${serviceName}" references non-existent Dockerfile: "${dockerfileRel}" in context "${contextRel}"`
          );
        }

        serviceInfo.build = buildInfo;
        serviceInfo.resolvedDockerfile = path.relative(repoPath, foundDockerfile);

        // Scan Dockerfile for ENV and ARG declarations
        await this.extractDockerfileEnvVars(foundDockerfile, detectedEnvMap, serviceName);
      }

      // If no build and no image, invalid service
      if (!cfg.build && !cfg.image) {
        throw new Error(
          `Compose service "${serviceName}" must define either a "build" section or an "image" name.`
        );
      }

      // Parse Ports
      if (cfg.ports && Array.isArray(cfg.ports)) {
        serviceInfo.ports = cfg.ports.map((p: any) => String(p));
      }

      // Parse Environment
      if (cfg.environment) {
        serviceInfo.environment = {};
        if (Array.isArray(cfg.environment)) {
          for (const envItem of cfg.environment) {
            if (typeof envItem === 'string') {
              const eqIdx = envItem.indexOf('=');
              if (eqIdx !== -1) {
                const k = envItem.slice(0, eqIdx).trim();
                const v = envItem.slice(eqIdx + 1).trim();
                serviceInfo.environment[k] = v;
                this.recordEnvVar(detectedEnvMap, k, v, 'compose', false, serviceName);
              } else {
                const k = envItem.trim();
                serviceInfo.environment[k] = '';
                this.recordEnvVar(detectedEnvMap, k, undefined, 'compose', true, serviceName);
              }
            }
          }
        } else if (typeof cfg.environment === 'object') {
          for (const [k, v] of Object.entries(cfg.environment)) {
            const valStr = v !== null && v !== undefined ? String(v) : '';
            serviceInfo.environment[k] = valStr;
            this.recordEnvVar(detectedEnvMap, k, valStr || undefined, 'compose', !valStr, serviceName);
          }
        }
      }

      // Parse env_file references
      if (cfg.env_file) {
        const envFiles: string[] = [];
        if (typeof cfg.env_file === 'string') {
          envFiles.push(cfg.env_file);
        } else if (Array.isArray(cfg.env_file)) {
          for (const ef of cfg.env_file) {
            if (typeof ef === 'string') envFiles.push(ef);
          }
        }
        serviceInfo.envFile = envFiles;

        for (const ef of envFiles) {
          const resolvedEf = path.resolve(repoPath, ef);
          if (existsSync(resolvedEf)) {
            await this.extractEnvFileVars(resolvedEf, detectedEnvMap, serviceName);
          }
          // Also look for sibling .env.example / .env.sample in that folder
          const efDir = path.dirname(resolvedEf);
          for (const exName of ['.env.example', '.env.sample', '.env.template']) {
            const exPath = path.join(efDir, exName);
            if (existsSync(exPath)) {
              await this.extractEnvFileVars(exPath, detectedEnvMap, serviceName);
            }
          }
        }
      }

      // Parse depends_on
      if (cfg.depends_on) {
        if (Array.isArray(cfg.depends_on)) {
          serviceInfo.dependsOn = cfg.depends_on.map((d: any) => String(d));
        } else if (typeof cfg.depends_on === 'object') {
          serviceInfo.dependsOn = Object.keys(cfg.depends_on);
        }
      }

      if (cfg.healthcheck) {
        serviceInfo.healthcheck = cfg.healthcheck;
      }

      services.push(serviceInfo);
    }

    // 3. Scan repository for .env.example / .env.sample / README env blocks
    await this.scanRepositoryEnvTemplates(repoPath, detectedEnvMap, services);

    // 4. Scan source code files for environment variables
    await this.scanSourceCodeForEnvVars(repoPath, detectedEnvMap, services);

    // 5. Check if internal database services exist (e.g. MongoDB, Redis, Postgres)
    const hasInternalMongo = this.hasInternalService(services, 'mongo');
    const hasInternalRedis = this.hasInternalService(services, 'redis');
    const hasInternalPostgres = this.hasInternalService(services, 'postgres');

    // 6. Resolve Primary Service and Port for routing
    const { primaryService, primaryPort, internalPort } = this.resolvePrimaryService(services);

    // 7. Compute missing required environment variables
    const userEnv = userProvidedEnv || {};
    const detectedEnvVars = Array.from(detectedEnvMap.values());
    const missingRequiredEnvVars: string[] = [];

    for (const envVar of detectedEnvVars) {
      // If MongoDB is internal in compose, MONGODB_URI is not a missing required user variable
      if (hasInternalMongo && (envVar.key === 'MONGODB_URI' || envVar.key === 'MONGO_URI')) {
        envVar.isRequired = false;
        envVar.defaultValue = envVar.defaultValue || 'mongodb://mongodb:27017';
        continue;
      }
      // If Redis is internal in compose, REDIS_URL is not missing
      if (hasInternalRedis && (envVar.key === 'REDIS_URL' || envVar.key === 'REDIS_HOST')) {
        envVar.isRequired = false;
        envVar.defaultValue = envVar.defaultValue || 'redis://redis:6379';
        continue;
      }
      // If Postgres is internal in compose, DATABASE_URL / POSTGRES_URL is not missing
      if (hasInternalPostgres && (envVar.key === 'DATABASE_URL' || envVar.key === 'POSTGRES_URL')) {
        envVar.isRequired = false;
        envVar.defaultValue = envVar.defaultValue || 'postgres://postgres@postgres:5432/app';
        continue;
      }

      // Check user provided value
      const userVal = userEnv[envVar.key];
      const hasUserVal = userVal !== undefined && userVal.trim() !== '';
      const hasDefault = envVar.defaultValue !== undefined && envVar.defaultValue.trim() !== '';

      if (envVar.isRequired) {
        if (!hasUserVal && !hasDefault) {
          missingRequiredEnvVars.push(envVar.key);
        }
      }
    }

    return {
      composeFile: fileName,
      services,
      detectedEnvVars,
      missingRequiredEnvVars,
      primaryService,
      primaryPort,
      internalPort,
    };
  }

  /**
   * Helper to check if an internal service of a specific database type is defined in Compose.
   */
  static hasInternalService(
    services: ComposeServiceInfo[],
    type: 'mongo' | 'redis' | 'postgres' | 'mysql'
  ): boolean {
    const regexMap = {
      mongo: /mongo/i,
      redis: /redis/i,
      postgres: /postgres/i,
      mysql: /mysql|mariadb/i,
    };
    const reg = regexMap[type];
    return services.some((s) => reg.test(s.name) || (s.image && reg.test(s.image)));
  }

  /**
   * Helper to extract ${VAR} patterns from YAML string
   */
  private static extractInterpolatedEnvVars(
    content: string,
    map: Map<string, DetectedEnvVar>
  ): void {
    const regex = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+=])([^}]*))?\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const key = match[1];
      const modifier = match[2];
      const defaultVal = match[3];

      const isRequired = modifier === ':?' || modifier === '?' || (!modifier && !defaultVal);
      this.recordEnvVar(map, key, defaultVal, 'compose', isRequired);
    }
  }

  /**
   * Helper to scan Dockerfile for ENV/ARG
   */
  private static async extractDockerfileEnvVars(
    dockerfilePath: string,
    map: Map<string, DetectedEnvVar>,
    serviceName?: string
  ): Promise<void> {
    try {
      const content = await fs.readFile(dockerfilePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('ENV ') || trimmed.startsWith('ARG ')) {
          const parts = trimmed.substring(4).trim().split(/[\s=]+/);
          if (parts.length >= 1 && parts[0]) {
            const key = parts[0].trim();
            const val = parts.slice(1).join(' ').trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
              this.recordEnvVar(map, key, val || undefined, 'dockerfile', !val, serviceName);
            }
          }
        }
      }
    } catch {}
  }

  /**
   * Helper to scan .env.example / .env.sample / .env
   */
  static async extractEnvFileVars(
    filePath: string,
    map: Map<string, DetectedEnvVar>,
    serviceName?: string
  ): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          // Remove surrounding quotes if present
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1).trim();
          }
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            const isPlaceholder =
              !val ||
              val.includes('your_') ||
              val.includes('changeme') ||
              val.includes('example') ||
              val.includes('<') ||
              val === 'xxx' ||
              val === 'null' ||
              val === 'undefined';
            this.recordEnvVar(
              map,
              key,
              isPlaceholder ? undefined : val,
              'env_file',
              isPlaceholder,
              serviceName
            );
          }
        }
      }
    } catch {}
  }

  /**
   * Searches for .env.example / .env.sample / README in repository
   */
  private static async scanRepositoryEnvTemplates(
    repoPath: string,
    map: Map<string, DetectedEnvVar>,
    services?: ComposeServiceInfo[]
  ): Promise<void> {
    const candidateFiles = [
      { path: '.env.example', service: undefined },
      { path: '.env.sample', service: undefined },
      { path: '.env.template', service: undefined },
      { path: '.env.defaults', service: undefined },
      { path: 'BACKEND/.env.example', service: 'backend' },
      { path: 'BACKEND/.env.sample', service: 'backend' },
      { path: 'backend/.env.example', service: 'backend' },
      { path: 'backend/.env.sample', service: 'backend' },
      { path: 'FRONTEND/.env.example', service: 'frontend' },
      { path: 'FRONTEND/.env.sample', service: 'frontend' },
      { path: 'frontend/.env.example', service: 'frontend' },
      { path: 'frontend/.env.sample', service: 'frontend' },
      { path: 'server/.env.example', service: 'server' },
      { path: 'server/.env.sample', service: 'server' },
      { path: 'api/.env.example', service: 'api' },
      { path: 'api/.env.sample', service: 'api' },
      { path: 'client/.env.example', service: 'client' },
      { path: 'client/.env.sample', service: 'client' },
    ];

    for (const cand of candidateFiles) {
      const fullPath = path.join(repoPath, cand.path);
      if (existsSync(fullPath)) {
        await this.extractEnvFileVars(fullPath, map, cand.service);
      }
    }

    // Check README.md for env var examples
    const readmePath = path.join(repoPath, 'README.md');
    if (existsSync(readmePath)) {
      try {
        const readmeContent = await fs.readFile(readmePath, 'utf8');
        
        // Scan for fenced code blocks supporting both LF and CRLF line endings and optional escaped backticks
        const envBlockRegex = /(?:^|\r?\n)(?:\\?`){3}[^\r\n]*\r?\n([\s\S]*?)\r?\n(?:\\?`){3}/g;
        let blockMatch: RegExpExecArray | null;
        while ((blockMatch = envBlockRegex.exec(readmeContent)) !== null) {
          const blockText = blockMatch[1];
          const blockStartIndex = blockMatch.index;
          // Look at 200 chars preceding the block for hints (e.g. Backend, Frontend)
          const precedingText = readmeContent.substring(Math.max(0, blockStartIndex - 200), blockStartIndex).toLowerCase();
          let serviceHint: string | undefined = undefined;
          if (precedingText.includes('backend') || precedingText.includes('server') || precedingText.includes('api')) {
            serviceHint = 'backend';
          } else if (precedingText.includes('frontend') || precedingText.includes('client') || precedingText.includes('ui')) {
            serviceHint = 'frontend';
          }

          if (
            blockText.includes('=') &&
            (blockText.includes('PORT=') ||
              blockText.includes('URI=') ||
              blockText.includes('SECRET=') ||
              blockText.includes('API_KEY=') ||
              blockText.includes('DATABASE_URL=') ||
              blockText.includes('CLOUDINARY_') ||
              blockText.includes('VITE_'))
          ) {
            const lines = blockText.split('\n');
            for (const l of lines) {
              const trimmed = l.trim();
              if (
                trimmed &&
                !trimmed.startsWith('#') &&
                !trimmed.startsWith('$') &&
                !trimmed.startsWith('cd ') &&
                !trimmed.startsWith('npm ') &&
                !trimmed.startsWith('git ')
              ) {
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx !== -1) {
                  const key = trimmed.slice(0, eqIdx).trim();
                  let val = trimmed.slice(eqIdx + 1).trim();
                  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1).trim();
                  }
                  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                    const isPlaceholder =
                      !val ||
                      val.includes('your_') ||
                      val.includes('changeme') ||
                      val.includes('example') ||
                      val.includes('<') ||
                      val === 'xxx';
                    this.recordEnvVar(
                      map,
                      key,
                      isPlaceholder ? undefined : val,
                      'readme',
                      isPlaceholder,
                      serviceHint
                    );
                  }
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  /**
   * Scans source code files in the repo for process.env.XYZ and import.meta.env.XYZ references.
   */
  private static async scanSourceCodeForEnvVars(
    repoPath: string,
    map: Map<string, DetectedEnvVar>,
    services?: ComposeServiceInfo[]
  ): Promise<void> {
    try {
      const sourceExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go']);
      const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage']);

      const scanDir = async (dir: string, depth = 0) => {
        if (depth > 5) return;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }

        for (const entry of entries) {
          if (ignoreDirs.has(entry) || entry.startsWith('.')) continue;
          const fullPath = path.join(dir, entry);
          let stat;
          try {
            stat = statSync(fullPath);
          } catch {
            continue;
          }

          if (stat.isDirectory()) {
            await scanDir(fullPath, depth + 1);
          } else if (stat.isFile()) {
            const ext = path.extname(entry).toLowerCase();
            if (sourceExts.has(ext) && stat.size < 500000) {
              try {
                const content = await fs.readFile(fullPath, 'utf8');
                // Strip single-line and multi-line comments so commented-out code is ignored
                const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
                
                // Determine service association from directory
                let serviceHint: string | undefined = undefined;
                const relPath = path.relative(repoPath, fullPath).toLowerCase();
                if (relPath.includes('backend') || relPath.includes('server') || relPath.includes('api')) {
                  serviceHint = 'backend';
                } else if (relPath.includes('frontend') || relPath.includes('client') || relPath.includes('ui')) {
                  serviceHint = 'frontend';
                }

                // 1. process.env.KEY
                const procEnvRegex = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
                let match: RegExpExecArray | null;
                while ((match = procEnvRegex.exec(cleanContent)) !== null) {
                  const key = match[1];
                  // Common node globals
                  if (key === 'NODE_ENV' || key === 'PATH' || key === 'PWD') continue;
                  this.recordEnvVar(map, key, undefined, 'source_code', false, serviceHint);
                }

                // 2. import.meta.env.KEY
                const viteEnvRegex = /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
                while ((match = viteEnvRegex.exec(cleanContent)) !== null) {
                  const key = match[1];
                  if (key === 'MODE' || key === 'BASE_URL' || key === 'PROD' || key === 'DEV') continue;
                  this.recordEnvVar(map, key, undefined, 'source_code', false, serviceHint || 'frontend');
                }

                // 3. os.environ['KEY'] or os.getenv('KEY') in Python
                const pyEnvRegex = /(?:os\.environ(?:\.get)?|os\.getenv)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
                while ((match = pyEnvRegex.exec(cleanContent)) !== null) {
                  const key = match[1];
                  this.recordEnvVar(map, key, undefined, 'source_code', false, serviceHint);
                }
              } catch {}
            }
          }
        }
      };

      await scanDir(repoPath);
    } catch {}
  }

  /**
   * Helper to add/update detected env var with smart classification.
   */
  static recordEnvVar(
    map: Map<string, DetectedEnvVar>,
    key: string,
    defaultValue?: string,
    source: 'compose' | 'env_file' | 'example_file' | 'dockerfile' | 'readme' | 'source_code' = 'compose',
    isRequired = false,
    service?: string
  ): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;

    // Check if key is a known secret / sensitive credential
    const isSecret = /KEY|SECRET|PASSWORD|PASSWD|TOKEN|AUTH|PRIVATE|CREDENTIAL|CERT|MONGO|POSTGRES|DATABASE|DB_URI|REDIS_URL|API_KEY|CLIENT_SECRET|CLOUDINARY/i.test(
      key
    );

    // Well-known optional variables with standard defaults
    const isWellKnownOptional = /^(PORT|HOST|NODE_ENV|DEBUG|LOG_LEVEL|TZ|APP_ENV|ENVIRONMENT|FAST_REFRESH)$/i.test(
      key
    );

    // Required determination:
    // If it's a secret with no default declared in an explicit configuration source (compose, env_file, example_file, readme, dockerfile)
    // or an explicitly empty variable marked isRequired, or critical DB connection string
    const isExplicitConfig = source !== 'source_code';
    const isCriticalDb = /^(MONGODB_URI|MONGO_URI|DATABASE_URL|POSTGRES_URL)$/i.test(key);

    const determinedRequired =
      !isWellKnownOptional &&
      (isRequired ||
        (isExplicitConfig && isSecret && !defaultValue) ||
        (isCriticalDb && !defaultValue));

    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        defaultValue,
        isSecret,
        isRequired: determinedRequired,
        service: service || this.inferServiceFromKey(key),
        source,
      });
    } else {
      if (defaultValue && !existing.defaultValue) {
        existing.defaultValue = defaultValue;
      }
      if (determinedRequired) {
        existing.isRequired = true;
      }
      if (service && !existing.service) {
        existing.service = service;
      }
      if (source === 'readme' || source === 'example_file' || source === 'env_file') {
        existing.source = source;
      }
    }
  }

  /**
   * Helper to infer service association from variable key (e.g. VITE_ -> frontend).
   */
  private static inferServiceFromKey(key: string): string | undefined {
    if (key.startsWith('VITE_') || key.startsWith('NEXT_PUBLIC_') || key.startsWith('REACT_APP_')) {
      return 'frontend';
    }
    if (
      key.includes('MONGO') ||
      key.includes('DB') ||
      key.includes('DATABASE') ||
      key.includes('TOKEN') ||
      key.includes('JWT') ||
      key.includes('SECRET') ||
      key.includes('CLOUDINARY')
    ) {
      return 'backend';
    }
    return undefined;
  }

  /**
   * Selects the primary user-facing web service (frontend/web/app/gateway) and resolves ports.
   */
  private static resolvePrimaryService(services: ComposeServiceInfo[]): {
    primaryService: string;
    primaryPort: number;
    internalPort: number;
  } {
    if (services.length === 0) {
      return { primaryService: '', primaryPort: 3000, internalPort: 3000 };
    }

    // Ranking priority for public-facing services
    const priorityKeywords = [
      'frontend',
      'web',
      'client',
      'app',
      'ui',
      'gateway',
      'proxy',
      'api',
      'backend',
      'server',
    ];

    let chosenService = services[0];
    let highestScore = -1;

    for (const service of services) {
      let score = 0;
      const lowerName = service.name.toLowerCase();

      // Services with exposed ports get higher priority
      if (service.ports && service.ports.length > 0) {
        score += 10;
      }

      // Keyword matching
      for (let i = 0; i < priorityKeywords.length; i++) {
        if (lowerName.includes(priorityKeywords[i])) {
          score += (priorityKeywords.length - i) * 2;
          break;
        }
      }

      if (score > highestScore) {
        highestScore = score;
        chosenService = service;
      }
    }

    // Extract port from chosen service
    let hostPort = 3000;
    let internalPort = 3000;

    if (chosenService.ports && chosenService.ports.length > 0) {
      const firstPort = chosenService.ports[0];
      const parsed = this.parsePortMapping(firstPort);
      hostPort = parsed.hostPort || 3000;
      internalPort = parsed.containerPort || 3000;
    }

    return {
      primaryService: chosenService.name,
      primaryPort: hostPort,
      internalPort,
    };
  }

  /**
   * Parses various port strings: "8000:8000", "3000:80", "3000", "127.0.0.1:8000:8000"
   */
  static parsePortMapping(portStr: string): { hostPort: number; containerPort: number } {
    const clean = String(portStr).trim();
    const parts = clean.split(':');
    if (parts.length === 1) {
      const p = parseInt(parts[0], 10) || 3000;
      return { hostPort: p, containerPort: p };
    } else if (parts.length === 2) {
      const host = parseInt(parts[0], 10) || 3000;
      const container = parseInt(parts[1], 10) || host;
      return { hostPort: host, containerPort: container };
    } else if (parts.length === 3) {
      const host = parseInt(parts[1], 10) || 3000;
      const container = parseInt(parts[2], 10) || host;
      return { hostPort: host, containerPort: container };
    }
    return { hostPort: 3000, containerPort: 3000 };
  }
}
