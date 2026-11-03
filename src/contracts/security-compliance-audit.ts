/**
 * Office of Equity Open Notebook — Secrets, Paths, Diagnostics, Dependencies & Licenses Audit Contract (L8.2)
 *
 * Runs isolated synthetic redaction examples and records unverified production checks.
 * This module does not inspect production logging, scan dependencies, or assess a cloud deployment.
 */

import {
  SecretTraceCheck,
  RedactionTestCheck,
  DependencyAuditCheck,
  LicenseInventoryItem,
  VulnerabilityTriageItem,
  SecurityComplianceAuditReport,
} from '../types';

/**
 * Sample redaction helper. Production logging does not currently call this function.
 */
export function sanitizeSensitiveData(input: string): string {
  if (typeof input !== 'string') return input;
  let sanitized = input;

  // 1. Redact Anthropic/OpenAI API keys (sk-ant-*, sk-*)
  sanitized = sanitized.replace(/sk-(ant-)?[a-zA-Z0-9\-_]{20,}/g, '[API_KEY_REDACTED]');

  // 2. Redact Bearer tokens & authorization headers
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9\-_.]+/gi, 'Bearer [TOKEN_REDACTED]');

  // 3. Redact password / secret assignment in logs or config strings
  sanitized = sanitized.replace(/(password|secret|api_key|token|auth_token)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi, '$1=[REDACTED]');

  // 4. Redact absolute user home paths (e.g., /home/mars/... or C:\Users\...)
  sanitized = sanitized.replace(/\/home\/[a-zA-Z0-9_\-\.]+/g, '/home/[USER_REDACTED]');
  sanitized = sanitized.replace(/[C|c]:\\Users\\[a-zA-Z0-9_\-\.]+/g, 'C:\\Users\\[USER_REDACTED]');

  return sanitized;
}

/**
 * Lists production evidence still required for secret handling and diagnostics.
 */
export function traceSecretsAndDiagnostics(): readonly SecretTraceCheck[] {
  return [
    {
      id: 'TRACE_ENV_1',
      category: 'environment',
      targetField: 'SURREAL_PASSWORD',
      isRedacted: false,
      maskPattern: 'SURREAL_PASSWORD=[REDACTED]',
      passed: false,
      notes: 'Unverified: trace database credentials through the actual launcher environment and log sinks.',
    },
    {
      id: 'TRACE_ENV_2',
      category: 'environment',
      targetField: 'ANTHROPIC_API_KEY',
      isRedacted: false,
      maskPattern: 'sk-ant-[REDACTED]',
      passed: false,
      notes: 'Unverified: inspect the actual key store and demonstrate no API key leakage in service output.',
    },
    {
      id: 'TRACE_LOGS_1',
      category: 'logs',
      targetField: 'Application Request Headers',
      isRedacted: false,
      maskPattern: 'Authorization: Bearer [TOKEN_REDACTED]',
      passed: false,
      notes: 'Unverified: backend middleware is absent from this checkout; request-header filtering is unknown.',
    },
    {
      id: 'TRACE_DIAG_1',
      category: 'diagnostics',
      targetField: 'Crash Dump & Diagnostic Payloads',
      isRedacted: false,
      maskPattern: '/home/[USER_REDACTED]/...',
      passed: false,
      notes: 'Unverified: native and JavaScript launchers currently capture raw service output.',
    },
    {
      id: 'TRACE_CONFIG_1',
      category: 'config',
      targetField: 'Database Connection String',
      isRedacted: false,
      maskPattern: 'surreal://user:[REDACTED]@127.0.0.1:8000',
      passed: false,
      notes: 'Unverified: exercise real connection errors and exported diagnostics with synthetic credentials.',
    },
  ];
}

/**
 * Runs redaction property tests across sensitive sample inputs.
 */
export function runRedactionTests(): readonly RedactionTestCheck[] {
  const testCases = [
    {
      id: 'REDACT_1',
      inputSample: 'Error connecting with key sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      sensitiveField: 'API Key',
      expectedSubstr: '[API_KEY_REDACTED]',
    },
    {
      id: 'REDACT_2',
      inputSample: 'Authorization: Bearer secret_jwt_token_xyz987',
      sensitiveField: 'Bearer Token',
      expectedSubstr: 'Bearer [TOKEN_REDACTED]',
    },
    {
      id: 'REDACT_3',
      inputSample: 'database password="super_secret_db_password_123" established',
      sensitiveField: 'Database Password',
      expectedSubstr: 'password=[REDACTED]',
    },
    {
      id: 'REDACT_4',
      inputSample: 'Config loaded from /home/mars/StudioProjects/Office-Equity-Open-Notebook/config.json',
      sensitiveField: 'Absolute Path',
      expectedSubstr: '/home/[USER_REDACTED]/StudioProjects/Office-Equity-Open-Notebook/config.json',
    },
    {
      id: 'REDACT_5',
      inputSample: 'User home directory is C:\\Users\\Administrator\\.office-equity',
      sensitiveField: 'Windows Path',
      expectedSubstr: 'C:\\Users\\[USER_REDACTED]\\.office-equity',
    },
  ];

  return testCases.map((tc) => {
    const redactedOutput = sanitizeSensitiveData(tc.inputSample);
    const passed = redactedOutput.includes(tc.expectedSubstr);
    return {
      id: tc.id,
      inputSample: tc.inputSample,
      sensitiveField: tc.sensitiveField,
      redactedOutput,
      passed,
    };
  });
}

/** No production dependency scan or license review has been performed here. */
export function auditDependencies(): readonly DependencyAuditCheck[] {
  return [];
}

export function generateLicenseInventory(): readonly LicenseInventoryItem[] {
  return [];
}

export function triageVulnerabilities(): readonly VulnerabilityTriageItem[] {
  return [];
}

/** Runs sample redaction checks without granting production compliance. */
export function runSecurityComplianceAudit(): SecurityComplianceAuditReport {
  const redactionTests = runRedactionTests();
  return {
    packetId: 'L8.2',
    evidenceKind: 'synthetic-contract-fixtures',
    productionControlsVerified: false,
    vulnerabilityScanPerformed: false,
    title: 'L8.2 synthetic redaction checks and outstanding security evidence',
    timestamp: new Date().toISOString(),
    limitations: [
      'Only synthetic redaction examples were executed; the helper is not integrated into production log sinks.',
      'Secret handling, request middleware, diagnostics exports, and backend authorization are unverified.',
      'No dependency vulnerability scan, resolved runtime inventory, or redistribution license review was performed.',
      'No Azure tenant, deployed resources, data governance review, or FERPA compliance assessment was performed.',
    ],
    secretTraceAudits: traceSecretsAndDiagnostics(),
    redactionTests,
    dependencyAudits: auditDependencies(),
    licenseInventory: generateLicenseInventory(),
    vulnerabilityTriage: triageVulnerabilities(),
    findings: [{
      id: 'FINDING_L8_2_01',
      severity: 'high',
      title: 'Production diagnostic redaction remains unverified',
      status: 'open',
      description: 'Passing isolated redaction examples does not prove protection of service logs or diagnostic bundles.',
      remediation: 'Minimize production diagnostic content and verify all actual sinks using synthetic credentials and record content.',
    }],
    verdict: {
      fullyCompliant: false,
      fixtureChecksPassed: redactionTests.length > 0 && redactionTests.every(check => check.passed),
      summary: 'Synthetic redaction examples only. Production security and cloud controls remain unverified; this report cannot authorize a release or use of education records.',
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects legacy or malformed reports that omit evidence scope or claim compliance. */
export function validateSecurityComplianceAuditReport(
  report: unknown
): { valid: boolean; errors: readonly string[] } {
  if (!isRecord(report)) {
    return { valid: false, errors: ['Report must be a non-null object'] };
  }
  const errors: string[] = [];
  if (report['packetId'] !== 'L8.2') errors.push('Invalid packetId');
  if (report['evidenceKind'] !== 'synthetic-contract-fixtures') errors.push('Missing or invalid evidence scope');
  if (report['productionControlsVerified'] !== false) errors.push('Production controls must remain unverified');
  if (report['vulnerabilityScanPerformed'] !== false) errors.push('No vulnerability scan was performed');
  if (typeof report['title'] !== 'string' || !report['title'].trim()) errors.push('Missing title');
  if (typeof report['timestamp'] !== 'string' || !Number.isFinite(Date.parse(report['timestamp']))) errors.push('Invalid timestamp');
  const limitations = report['limitations'];
  if (!Array.isArray(limitations) || limitations.length === 0 ||
      !limitations.every(item => typeof item === 'string' && item.trim().length > 0)) {
    errors.push('Missing assessment limitations');
  }
  for (const key of ['secretTraceAudits', 'redactionTests', 'dependencyAudits', 'licenseInventory', 'vulnerabilityTriage', 'findings']) {
    if (!Array.isArray(report[key])) errors.push(`Missing or invalid ${key}`);
  }
  for (const key of ['dependencyAudits', 'licenseInventory', 'vulnerabilityTriage']) {
    const entries = report[key];
    if (Array.isArray(entries) && entries.length !== 0) errors.push(`${key} contains evidence that was not collected`);
  }
  const hasTextFields = (value: Record<string, unknown>, keys: readonly string[]) =>
    keys.every(key => typeof value[key] === 'string' && (value[key] as string).trim().length > 0);
  const traces = report['secretTraceAudits'];
  if (!Array.isArray(traces) || traces.length === 0 || !traces.every(trace =>
      isRecord(trace) && trace['passed'] === false && trace['isRedacted'] === false &&
      typeof trace['category'] === 'string' &&
      ['environment', 'logs', 'diagnostics', 'config'].includes(trace['category']) &&
      hasTextFields(trace, ['id', 'targetField', 'maskPattern', 'notes']))) {
    errors.push('Missing or invalid unverified secret traces');
  }
  const findings = report['findings'];
  if (!Array.isArray(findings) || findings.length === 0 || !findings.every(finding =>
      isRecord(finding) && finding['status'] === 'open' &&
      typeof finding['severity'] === 'string' &&
      ['critical', 'high', 'medium', 'low', 'none'].includes(finding['severity']) &&
      hasTextFields(finding, ['id', 'title', 'description', 'remediation']))) {
    errors.push('Missing or invalid outstanding findings');
  }
  const checks = report['redactionTests'];
  const validChecks = Array.isArray(checks) && checks.length > 0 && checks.every(check =>
    isRecord(check) && typeof check['passed'] === 'boolean' &&
    typeof check['id'] === 'string' && typeof check['sensitiveField'] === 'string' &&
    typeof check['inputSample'] === 'string' && typeof check['redactedOutput'] === 'string');
  if (!validChecks) errors.push('Missing or invalid synthetic redaction checks');
  const verdict = report['verdict'];
  if (!isRecord(verdict)) {
    errors.push('Missing verdict');
  } else {
    if (verdict['fullyCompliant'] !== false) errors.push('Fixture evidence cannot establish production compliance');
    if (typeof verdict['fixtureChecksPassed'] !== 'boolean') errors.push('Invalid fixture verdict');
    if (typeof verdict['summary'] !== 'string' || !verdict['summary'].trim()) errors.push('Missing verdict summary');
    if (validChecks && verdict['fixtureChecksPassed'] !== checks.every(check => check['passed'])) {
      errors.push('Fixture verdict does not match the redaction checks');
    }
  }
  return { valid: errors.length === 0, errors };
}
