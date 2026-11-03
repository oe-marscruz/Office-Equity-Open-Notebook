'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  runSecurityComplianceAudit,
  validateSecurityComplianceAuditReport,
} = require('../../dist/src/contracts/security-compliance-audit');

const report = runSecurityComplianceAudit();
assert.equal(report.evidenceKind, 'synthetic-contract-fixtures');
assert.equal(report.productionControlsVerified, false);
assert.equal(report.vulnerabilityScanPerformed, false);
assert.equal(report.verdict.fullyCompliant, false);
assert.equal(report.verdict.fixtureChecksPassed, true);
assert.ok(report.limitations.length > 0);
assert.ok(report.redactionTests.length > 0);
for (const check of report.redactionTests) {
  assert.equal(check.passed, true);
  assert.notEqual(check.inputSample, check.redactedOutput);
}
assert.ok(report.secretTraceAudits.length > 0);
assert.ok(report.secretTraceAudits.every(check => !check.passed && !check.isRedacted));
assert.deepEqual(report.dependencyAudits, []);
assert.deepEqual(report.licenseInventory, []);
assert.deepEqual(report.vulnerabilityTriage, []);
assert.ok(report.findings.some(finding => finding.status === 'open'));
assert.equal(validateSecurityComplianceAuditReport(report).valid, true);

const invalidReports = [null, undefined, [], 'report', {},
  { ...report, evidenceKind: undefined },
  { ...report, evidenceKind: 'production' },
  { ...report, productionControlsVerified: true },
  { ...report, vulnerabilityScanPerformed: true },
  { ...report, limitations: [] },
  { ...report, limitations: [''] },
  { ...report, timestamp: 'invalid' },
  { ...report, verdict: null },
  { ...report, verdict: { ...report.verdict, fullyCompliant: true } },
  { ...report, verdict: { ...report.verdict, fixtureChecksPassed: undefined } },
  { ...report, verdict: { ...report.verdict, fixtureChecksPassed: false } },
  { ...report, redactionTests: [] },
  { ...report, redactionTests: [null] },
  { ...report, redactionTests: [{ passed: 'true' }] },
  { ...report, dependencyAudits: null },
  { ...report, findings: null },
  { ...report, secretTraceAudits: [] },
  { ...report, secretTraceAudits: [null] },
  { ...report, secretTraceAudits: [{ ...report.secretTraceAudits[0], passed: true }] },
  { ...report, secretTraceAudits: [{ ...report.secretTraceAudits[0], isRedacted: true }] },
  { ...report, secretTraceAudits: [{ ...report.secretTraceAudits[0], category: 'unknown' }] },
  { ...report, secretTraceAudits: [{ ...report.secretTraceAudits[0], category: ['environment'] }] },
  { ...report, secretTraceAudits: [{ ...report.secretTraceAudits[0], category: { toString: null, valueOf: null } }] },
  { ...report, findings: [{ ...report.findings[0], severity: ['high'] }] },
  { ...report, findings: [{ ...report.findings[0], severity: { toString: null, valueOf: null } }] },
  { ...report, findings: [] },
  { ...report, findings: [null] },
  { ...report, findings: [{ ...report.findings[0], status: 'resolved' }] },
  { ...report, findings: [{ ...report.findings[0], severity: 'unknown' }] },
  { ...report, dependencyAudits: [{ status: 'compliant', vulnerabilitiesFound: 0 }] },
  { ...report, licenseInventory: [null] },
  { ...report, vulnerabilityTriage: [null] },
];
for (const invalid of invalidReports) {
  assert.equal(validateSecurityComplianceAuditReport(invalid).valid, false);
}
const failedFixtures = {
  ...report,
  redactionTests: report.redactionTests.map(check => ({ ...check, passed: false })),
  verdict: { ...report.verdict, fixtureChecksPassed: false },
};
assert.equal(validateSecurityComplianceAuditReport(failedFixtures).valid, true);
assert.equal(failedFixtures.verdict.fullyCompliant, false);

const reportPath = path.resolve(__dirname, '../../.artifacts/reports/l8_2/security_and_compliance_audit.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log('L8.2: synthetic redaction checks passed; unsupported compliance claims rejected.');
console.log('Production controls, dependency scans, licenses, and cloud configuration remain unverified.');
