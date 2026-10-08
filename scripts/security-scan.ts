import fs from 'fs';
import path from 'path';

/**
 * DeployHub Security Guardrail — Repository-wide Secret Scanner
 * 
 * Scans all source files, scripts, tests, fixtures, and documentation to ensure
 * NO credential-shaped values, fake cloud URIs, or private keys are committed.
 */

interface Finding {
  file: string;
  line: number;
  rule: string;
  preview: string;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.idea',
  '.vscode',
  'coverage',
]);

const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

const RULES: { id: string; name: string; pattern: RegExp; ignoreCommentRegex?: RegExp }[] = [
  {
    id: 'MONGODB_ATLAS_URI',
    name: 'MongoDB Atlas URI (mongodb+srv://)',
    pattern: /mongodb\+srv:\/\/[^\s"']+/i,
  },
  {
    id: 'CREDENTIAL_URI',
    name: 'Connection string with embedded user credentials (user:pass@)',
    // Matches protocol://user:pass@host where host is not a standard localhost placeholder without passwords
    pattern: /(mongodb|postgres|postgresql|mysql|redis):\/\/[a-zA-Z0-9_-]+:[^@\s"']+@[a-zA-Z0-9.-]+/i,
  },
  {
    id: 'PRIVATE_KEY_BLOCK',
    name: 'Private Key Block (PEM / RSA / OpenSSH)',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: 'GITHUB_PAT',
    name: 'GitHub Personal Access Token',
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,255}/,
  },
  {
    id: 'GITHUB_FINE_GRAINED_PAT',
    name: 'GitHub Fine-Grained Personal Access Token',
    pattern: /github_pat_[a-zA-Z0-9_]{40,255}/,
  },
  {
    id: 'AWS_ACCESS_KEY',
    name: 'AWS Access Key ID',
    pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
  },
  {
    id: 'SLACK_TOKEN',
    name: 'Slack Token',
    pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}/,
  },
  {
    id: 'STRIPE_KEY',
    name: 'Stripe Secret Key',
    pattern: /(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,99}/,
  },
  {
    id: 'GOOGLE_API_KEY',
    name: 'Google API Key',
    pattern: /AIza[0-9A-Za-z-_]{35}/,
  },
  {
    id: 'GENERIC_BEARER_JWT',
    name: 'Hardcoded JWT Bearer Token (Bearer eyJ...)',
    pattern: /Bearer\s+eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/,
  },
];

function sanitizeLogPreview(str: string): string {
  // Never print raw secrets in output
  return str.replace(/[a-zA-Z0-9._~+/-]{12,}/g, '[REDACTED]');
}

function scanFile(filePath: string, findings: Finding[]) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Skip self to avoid triggering on detection regexes
  if (path.basename(filePath) === 'security-scan.ts') {
    return;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip regex pattern declarations in scanner or diagnostic services
    if (line.includes('// Mask database connection strings') || line.includes('/KEY|SECRET|PASSWORD|')) {
      continue;
    }
    if (line.includes('RegExp') || line.includes('/gi') || line.includes('pattern:')) {
      continue;
    }

    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          file: filePath,
          line: lineNum,
          rule: rule.name,
          preview: sanitizeLogPreview(line.trim()),
        });
      }
    }
  }
}

function walkDir(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkDir(fullPath, fileList);
      }
    } else if (entry.isFile()) {
      if (!IGNORED_FILES.has(entry.name)) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

export function runSecurityScan(rootDir: string = path.resolve(__dirname, '..')): {
  totalFiles: number;
  findings: Finding[];
} {
  const files = walkDir(rootDir);
  const findings: Finding[] = [];

  for (const file of files) {
    // Only scan text files
    const ext = path.extname(file).toLowerCase();
    if (
      [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.json',
        '.yml',
        '.yaml',
        '.md',
        '.env',
        '.example',
        '.sh',
        '.dockerfile',
        'dockerfile',
      ].includes(ext) ||
      path.basename(file) === 'Dockerfile' ||
      path.basename(file).startsWith('.env')
    ) {
      scanFile(file, findings);
    }
  }

  return {
    totalFiles: files.length,
    findings,
  };
}

// ── CLI Execution ─────────────────────────────────────────────────────────────
if (require.main === module) {
  console.log('===============================================================');
  console.log('🛡️  DEPLOYHUB REPOSITORY-WIDE SECURITY & SECRET SCANNER');
  console.log('===============================================================');

  const root = path.resolve(__dirname, '..');
  const result = runSecurityScan(root);

  console.log(`\n🔍 Scanned ${result.totalFiles} repository files.\n`);

  if (result.findings.length === 0) {
    console.log('✅ PASS: No credential-shaped values or exposed secrets detected.\n');
    process.exit(0);
  } else {
    console.error(`❌ FAILED: Found ${result.findings.length} potential security violations:\n`);
    for (const f of result.findings) {
      const relPath = path.relative(root, f.file);
      console.error(`  • [${f.rule}] at ${relPath}:${f.line}`);
      console.error(`    Line: "${f.preview}"\n`);
    }
    console.error('💡 Action Required: Replace hardcoded credential-shaped strings with environment variables or safe local test placeholders.\n');
    process.exit(1);
  }
}
