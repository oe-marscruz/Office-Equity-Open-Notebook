/**
 * Office of Equity Open Notebook — Boundary Contracts & Interfaces
 *
 * Explicit TypeScript definitions for wrapper infrastructure, services,
 * runtimes, problem reports, process handles, and lifecycle boundaries.
 */

// ============================================================================
// Service & Process Boundary Contracts
// ============================================================================

export type ServiceName = 'surrealdb' | 'api' | 'worker' | 'frontend' | (string & {});

export type PortName = 'surreal' | 'api' | 'frontend';

export type ServicePorts = Record<PortName, number>;

export interface ServiceReadinessPolicy {
  type: 'port' | 'http' | 'process' | 'none';
  port?: number | undefined;
  httpUrl?: string | undefined;
  httpStatusExpected?: number | '2xx' | undefined;
  timeoutMs?: number | undefined;
  label?: string | undefined;
}

export interface ServiceDefinition {
  name: ServiceName;
  command: string;
  args: readonly string[];
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  readinessPolicy?: ServiceReadinessPolicy | undefined;
}

export interface ServiceHandle {
  name: ServiceName;
  pid?: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signal?: string | null | undefined;
}

export interface ServiceExitEvent {
  serviceName: ServiceName;
  exitCode: number | null;
  signal: string | null;
  unexpected: boolean;
  timestamp: string;
}

export interface ServiceTable {
  version: string;
  defaultPorts: ServicePorts;
  services: readonly ServiceDefinition[];
}

export interface StartServicesConfig {
  runtimePath: string;
  dataDir: string;
  encryptionKey: string;
  waitReady?: boolean | undefined;
  customPorts?: Partial<ServicePorts> | undefined;
}

export interface StartServicesResult {
  children: readonly ServiceHandle[];
  ports: ServicePorts;
  stop: () => Promise<ShutdownResult>;
}

export interface ShutdownResult {
  success: boolean;
  stoppedServices: readonly ServiceName[];
  errors?: readonly string[] | undefined;
  durationMs?: number | undefined;
}

// ============================================================================
// Process Identity & Resource Management Contracts
// ============================================================================

export interface ProcessIdentity {
  pid: number;
  name: string;
  commandLine?: string | undefined;
  parentPid?: number | undefined;
  startTime?: string | undefined;
}

export type ProcessOwnershipClassification =
  | 'current_app'
  | 'orphaned_app'
  | 'external_process'
  | 'unknown';

export interface ProcessHandle {
  identity: ProcessIdentity;
  ownership: ProcessOwnershipClassification;
}

// ============================================================================
// Runtime & Resolution Contracts
// ============================================================================

export interface RuntimePaths {
  runtimePath: string;
  backendPath: string;
  surrealExe: string;
  frontendDir: string;
  tiktokenCache: string;
  pythonExe: string;
  nodeExe: string;
}

export interface PythonResolution {
  path: string;
  source: 'bundled' | 'system';
  invalidVersion?: string | undefined;
}

export interface NodeResolution {
  path: string;
  source: 'bundled' | 'system';
  invalidVersion?: string | number | undefined;
}

export type ComponentCategory = 'required' | 'optional';

export interface RuntimeComponent {
  name: string;
  path: string;
  version?: string | undefined;
  status: 'present' | 'missing' | 'invalid';
  category?: ComponentCategory | undefined;
  description?: string | undefined;
  relativePaths?: readonly string[] | undefined;
  provenance?: string | undefined;
  fileCount?: number | undefined;
  sizeBytes?: number | undefined;
}

export interface RuntimeManifest {
  upstreamCommit: string;
  wrapperCommit?: string | undefined;
  buildTimestamp?: string | undefined;
  version?: string | undefined;
  targetArchitecture?: string | undefined;
  variant?: 'full' | 'core_minimal' | 'custom' | undefined;
  components?: Record<string, RuntimeComponent> | undefined;
  totalSizeBytes?: number | undefined;
  allowlistPassed?: boolean | undefined;
}

export interface RuntimeVerificationResult {
  valid: boolean;
  missingPaths: readonly string[];
  invalidComponents?: readonly string[] | undefined;
  unallowlistedPaths?: readonly string[] | undefined;
}

export interface AllowlistValidationResult {
  valid: boolean;
  unallowlistedPaths: readonly string[];
}

export interface ModularPackagingGraph {
  upstreamCommit: string;
  wrapperCommit: string;
  buildTimestamp: string;
  targetArchitecture: string;
  variant: 'full' | 'core_minimal' | 'custom';
  components: Record<string, RuntimeComponent>;
  totalSizeBytes: number;
  allowlistPassed: boolean;
  unallowlistedPaths: readonly string[];
}

export interface BackendEnvironment extends Record<string, string | undefined> {
  PYTHONPATH: string;
  PYTHONUNBUFFERED: string;
  PYTHONUTF8: string;
  DATA_FOLDER: string;
  SURREAL_URL: string;
  SURREAL_USER: string;
  SURREAL_PASSWORD: string;
  /**
   * Read by the SurrealDB CLI itself. Always carries the same value as
   * `SURREAL_PASSWORD`.
   */
  SURREAL_PASS: string;
  SURREAL_NAMESPACE: string;
  SURREAL_DATABASE: string;
  OPEN_NOTEBOOK_ENCRYPTION_KEY: string;
  OPEN_NOTEBOOK_ENABLE_DOCLING: string;
  TIKTOKEN_CACHE_DIR: string;
  API_HOST: string;
  API_PORT: string;
}

// ============================================================================
// Credential & Secret Storage Contracts
// ============================================================================

/**
 * Where a resolved database password came from.
 *
 * - `legacy-unmigrated`: a datastore exists but `secrets.json` does not, so
 *   the install predates per-install credentials. No password is returned:
 *   the host has to run the migration instead of quietly connecting as `root`.
 * - `stored`: the password was read back from `secrets.json`.
 * - `generated`: a new random password was created for this install.
 * - `migrated`: this process is the one that just rotated a legacy install
 *   onto a provisioned password. Provenance, not state: the next launch reads
 *   the same password back and reports `stored`.
 */
export type DatabaseCredentialSource =
  | 'legacy-unmigrated'
  | 'stored'
  | 'generated'
  | 'migrated';

/**
 * Stable failure codes for the credential store.
 *
 * Launchers render host-appropriate guidance from these instead of matching on
 * message text, and every host's test suite asserts the same values.
 */
export type DatabaseCredentialErrorCode =
  | 'invalid-secrets-file'
  | 'invalid-secret-value'
  | 'permissions-too-open'
  | 'datastore-unreadable'
  | 'migration-rejected';

export interface DatabaseCredentials {
  /** The SurrealDB root user name. Fixed, because it is not a secret. */
  user: string;
  /**
   * The SurrealDB root password, or null when the install has not been
   * migrated yet. Callers must handle the null case explicitly.
   */
  password: string | null;
  /** True when the install still needs credential migration. */
  migrationRequired: boolean;
  /** Provenance of the resolved password. */
  source: DatabaseCredentialSource;
}

/**
 * The environment variables that carry database credentials to the SurrealDB
 * server and the Python backend.
 *
 * SurrealDB's CLI reads `SURREAL_USER` and `SURREAL_PASS`; the upstream
 * backend reads `SURREAL_USER` and `SURREAL_PASSWORD` and falls back to
 * `SURREAL_PASS`. Both spellings are therefore populated with the same value.
 *
 * The credentials travel through the process environment rather than the
 * command line so they never appear in a process listing.
 */
export interface CredentialEnvironment {
  SURREAL_USER: string;
  SURREAL_PASSWORD: string;
  SURREAL_PASS: string;
}

/** The on-disk artifacts that hold the install's secrets. */
export interface CredentialStoreLayout {
  /** Directory holding the install's user data. */
  dataDir: string;
  /** Path of the obfuscated provider-API-key encryption key. */
  encryptionKeyFile: string;
  /** Path of the obfuscated SurrealDB root password store. */
  secretsFile: string;
}

/** The outcome of a secret-storage operation. */
export interface CredentialStoreResult {
  /** The resolved value. */
  value: string;
  /** True when the value already existed on disk and was reused. */
  persisted: boolean;
  /** True when the stored bytes do not contain the secret in plaintext. */
  obfuscatedAtRest: boolean;
  /** True when the file is provably readable only by the current user. */
  aclRestricted: boolean;
}

// ============================================================================
// Problem Reporting & Diagnostics Contracts
// ============================================================================

export type ProblemSeverity = 'fatal' | 'error' | 'warning' | 'info';

export interface ProblemReport {
  code: string;
  title: string;
  message: string;
  severity: ProblemSeverity;
  timestamp: string;
  details?: Record<string, unknown> | undefined;
  suggestedAction?: string | undefined;
}

// ============================================================================
// Port Conflict & Recovery Contracts
// ============================================================================

export interface PortConflict {
  port: number;
  serviceName: ServiceName;
  occupyingProcess?: ProcessIdentity | undefined;
}

export type PortConflictResolutionStrategy = 'fail' | 'rebind' | 'terminate_orphan';

export interface PortConflictResolutionResult {
  resolved: boolean;
  strategyUsed: PortConflictResolutionStrategy;
  boundPort: number;
  error?: string | undefined;
}

export interface StartupRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

// ============================================================================
// Window Policy & Security Contracts
// ============================================================================

export type NavigationAction = 'allow' | 'deny' | 'external';

export interface NavigationDecision {
  action: NavigationAction;
  targetUrl: string;
  reason?: string | undefined;
}

// ============================================================================
// Compatibility Harness Contracts
// ============================================================================

export interface TestResultDetail {
  id: string;
  category: 'service-table' | 'runtime-manifest' | 'runtime-resolution' | 'window-policy' | 'process-manager' | 'supervision-scenario' | 'property-case';
  description: string;
  passed: boolean;
  error?: string | undefined;
  expected?: unknown;
  actual?: unknown;
}

export interface CompatibilityResult {
  implementation: string;
  suite: string;
  version: string;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  timestamp: string;
  details: readonly TestResultDetail[];
}

// ============================================================================
// Performance Harness Contracts
// ============================================================================

export interface PerformanceBenchmarkEnvironment {
  os: string;
  nodeVersion: string;
  electronVersion: string;
  pythonVersion: string;
  surrealDbVersion: string;
  cpuModel: string;
  totalMemoryBytes: number;
}

export interface ArtifactSizes {
  installerBytes: number;
  installedBytes: number;
  runtimeDirectoryBytes: number;
  electronBytes: number;
  nodeRuntimeBytes: number;
  pythonRuntimeBytes: number;
  pythonSitePackagesBytes: number;
  doclingBytes: number;
  surrealDbBytes: number;
}

export interface RuntimeMetrics {
  idleProcessCount: number;
  idlePrivateWorkingSetRssBytes: number;
  idleTotalWorkingSetBytes: number;
  idleCpuPercent: number;
  coldStartToWindowMs: number;
  coldStartToApiReadyMs: number;
  coldStartToUsableUiMs: number;
  cleanShutdownDurationMs: number;
  restartAfterCrashSuccess: boolean;
}

export interface WorkloadMetrics {
  peakMemoryPdfIngestBytes: number;
  peakMemoryOcrIngestBytes: number;
  searchLatencyP95Ms: number;
  ragResponseLatencyP95Ms: number;
}

export interface PerformanceBenchmarkResult {
  packet: string;
  timestamp: string;
  host: string;
  environment: PerformanceBenchmarkEnvironment;
  artifactSizes: ArtifactSizes;
  runtimeMetrics: RuntimeMetrics;
  workloadMetrics: WorkloadMetrics;
}

export interface MetricComparison {
  metricName: string;
  baselineValue: number;
  candidateValue: number;
  deltaAbsolute: number;
  deltaPercent: number;
  withinNoiseBand: boolean;
  status: 'improved' | 'regressed' | 'unchanged';
}

export interface BenchmarkComparisonReport {
  baselineTimestamp: string;
  candidateTimestamp: string;
  candidateHost: string;
  noiseThresholdPercent: number;
  comparisons: Record<string, MetricComparison>;
  hasRegressions: boolean;
}

// ============================================================================
// API Proxy, Upload, & SSE Streaming Boundary Contracts (L3.2)
// ============================================================================

export interface ProxiedApiFixtureRequest {
  headers?: Record<string, string> | undefined;
  body?: unknown | undefined;
}

export interface ProxiedApiFixtureResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface ProxiedApiFixture {
  id: string;
  route: string;
  method: string;
  description: string;
  request: ProxiedApiFixtureRequest;
  expectedResponse: ProxiedApiFixtureResponse;
}

export interface UploadFilePart {
  fieldName: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadFixtureRequest {
  contentType: string;
  filePart: UploadFilePart | null;
}

export interface UploadFixture {
  id: string;
  route: string;
  method: string;
  description: string;
  maxAllowedSizeBytes: number;
  request: UploadFixtureRequest;
  expectedResponse: ProxiedApiFixtureResponse;
}

export interface SseChunk {
  deltaMs: number;
  raw: string;
}

export interface SseCancellationExpected {
  upstreamHalted: boolean;
  connectionClosedCleanly: boolean;
  memoryLeakDetected: boolean;
}

export interface SseStreamingFixture {
  id: string;
  route: string;
  method: string;
  description: string;
  requiredHeaders: Record<string, string>;
  maxAllowedLatencyMs?: number | undefined;
  maxInterFrameDelayMs?: number | undefined;
  chunks?: readonly SseChunk[] | undefined;
  simulateDisconnectAfterChunkIndex?: number | undefined;
  expectedCancellation?: SseCancellationExpected | undefined;
}

export interface ApiProxyFixtureSet {
  version: string;
  proxyCases: readonly ProxiedApiFixture[];
  uploadCases: readonly UploadFixture[];
  sseCases: readonly SseStreamingFixture[];
}

export interface ApiProxyTestResultDetail {
  id: string;
  category: 'proxy' | 'upload' | 'sse';
  description: string;
  passed: boolean;
  error?: string | undefined;
  expected?: unknown | undefined;
  actual?: unknown | undefined;
}

export interface ApiProxyCompatibilityResult {
  implementation: string;
  suite: string;
  version: string;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  timestamp: string;
  details: readonly ApiProxyTestResultDetail[];
}

export interface StaticClientConfig {
  apiBaseUrl: string;
  proxyBasePath: string;
  spaFallbackRoute: string;
  routes: readonly string[];
  envSource: 'client-runtime-config' | 'server-process-env';
  isStaticExport: boolean;
}

export interface SpaFallbackRule {
  matchPattern: string;
  destination: string;
  route: string;
  isDynamicRoute: boolean;
}

export interface StaticClientRouteCase {
  id: string;
  requestedPath: string;
  expectedRoute: string;
  isDynamic: boolean;
  expectedFallbackToSpa: boolean;
}

export interface StaticClientFixtureSet {
  version: string;
  routes: readonly StaticClientRouteCase[];
  blockers: readonly {
    id: string;
    title: string;
    description: string;
    impact: string;
    mitigation: string;
  }[];
}

export interface StaticClientPocResultDetail {
  id: string;
  category: 'config' | 'routing' | 'fallback' | 'build' | 'proxy-compat';
  description: string;
  passed: boolean;
  error?: string | undefined;
}

export interface StaticClientPocResult {
  implementation: string;
  suite: string;
  version: string;
  buildTarget: string;
  staticRoutesCount: number;
  spaFallbackRulesCount: number;
  apiEndpointConfigured: boolean;
  nextStandalonePreserved: boolean;
  blockersIdentified: readonly string[];
  passed: number;
  failed: number;
  total: number;
  timestamp: string;
  details: readonly StaticClientPocResultDetail[];
}

// ============================================================================
// Native Host Proxy & Serving Contracts (X19)
// ============================================================================

export interface PathTraversalCheckResult {
  path: string;
  isSafe: boolean;
  canonicalPath?: string | undefined;
  error?: string | undefined;
}

export interface NativeProxyConfig {
  bindHost: string;
  bindPort: number;
  backendTargetUrl: string;
  staticRootDir: string;
  maxUploadSizeBytes: number;
  spaFallbackFile: string;
}

export interface NativeProxyResultDetail {
  id: string;
  category: 'static-serving' | 'path-security' | 'api-proxy' | 'upload-limit' | 'sse-streaming';
  description: string;
  passed: boolean;
  error?: string | undefined;
}

export interface NativeProxyCompatibilityResult {
  implementation: string;
  suite: string;
  version: string;
  bindPort: number;
  backendTarget: string;
  staticServingActive: boolean;
  pathTraversalProtected: boolean;
  apiProxyActive: boolean;
  uploadLimitEnforced: boolean;
  sseStreamingUnbuffered: boolean;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  timestamp: string;
  details: readonly NativeProxyResultDetail[];
}

// ============================================================================
// Installer Experiments & Variant Contracts (L5.2)
// ============================================================================

export type InstallerVariantId =
  | 'monolithic_full_nsis'
  | 'core_minimal_nsis_addon'
  | 'web_bootstrapper_stub'
  | 'portable_zip_per_user';

export type InstallerCategory = 'single_binary' | 'modular_light' | 'bootstrapper' | 'portable';

export interface WebView2ProvisioningPolicy {
  systemDetectionRegKey: string;
  detectSystemRuntime: boolean;
  allowOnlineDownload: boolean;
  offlineFallbackInstallerPath?: string | undefined;
  fallbackStrategy: 'prompt_user' | 'silent_bootstrap' | 'fail_closed';
}

export interface InstallerVariantConfig {
  id: InstallerVariantId;
  name: string;
  category: InstallerCategory;
  description: string;
  bundledComponents: readonly string[];
  optionalAddonComponents: readonly string[];
  installerSizeBytes: number;
  installedSizeBytes: number;
  estimatedInstallDurationSec: number;
  requiresAdmin: boolean;
  supportsOfflineInstall: boolean;
  supportsSilentInstall: boolean;
  webView2Policy: WebView2ProvisioningPolicy;
}

export type LifecycleAction =
  | 'clean_install'
  | 'upgrade'
  | 'repair_reinstall'
  | 'uninstall'
  | 'offline_install'
  | 'missing_webview2';

export interface InstallerLifecycleCheck {
  id: string;
  action: LifecycleAction;
  description: string;
  passed: boolean;
  durationMs: number;
  preservedUserData: boolean;
  createdShortcuts: boolean;
  registeredUninstaller: boolean;
  verifiedFileHashes: boolean;
  error?: string | undefined;
}

export interface InstallerExperimentResult {
  variantId: InstallerVariantId;
  name: string;
  category: InstallerCategory;
  installerSizeBytes: number;
  installedSizeBytes: number;
  installDurationSec: number;
  upgradeDurationSec: number;
  repairDurationSec: number;
  uninstallDurationSec: number;
  lifecycleChecksCount: number;
  lifecycleChecksPassed: number;
  offlineSupported: boolean;
  score: number; // 0..100 composite score
  lifecycleChecks: readonly InstallerLifecycleCheck[];
}

export interface InstallerComparisonMatrix {
  timestamp: string;
  variants: Record<InstallerVariantId, InstallerExperimentResult>;
  preferredVariantId: InstallerVariantId;
  preferredVariantName: string;
  decisionReasoning: readonly string[];
  offlinePrivacyCompliant: boolean;
  metrics: {
    maxSizeSavingsPercent: number;
    fastestInstallSec: number;
    mostMaintainableVariant: InstallerVariantId;
  };
}

// ============================================================================
// Clean Machine Installation & Upgrade Validation Contracts (L5.3)
// ============================================================================

export type WindowsEnvironmentId =
  | 'win10_x64_clean'
  | 'win11_x64_clean'
  | 'win11_arm64_prism'
  | 'win_server2022_x64';

export interface WindowsEnvironmentConfig {
  id: WindowsEnvironmentId;
  osName: string;
  version: string;
  architecture: 'x64' | 'arm64';
  isCleanSnapshot: boolean;
  hasWebView2Preinstalled: boolean;
  hasVcRedistPreinstalled: boolean;
  hasNodeOrElectronInstalled: boolean;
}

export type InstallPathCategory =
  | 'standard_per_user'
  | 'custom_program_files_spaces'
  | 'unicode_accented_profile'
  | 'non_default_drive';

export interface InstallPathCase {
  id: InstallPathCategory;
  description: string;
  targetPath: string;
  hasSpaces: boolean;
  hasUnicode: boolean;
  isCustomDrive: boolean;
  requiresAdminElevation: boolean;
  passed: boolean;
  error?: string | undefined;
}

export type PrerequisiteId = 'webview2' | 'vcredist' | 'python_runtime' | 'surrealdb_bin';

export interface PrerequisiteCheckResult {
  prerequisiteId: PrerequisiteId;
  name: string;
  presentInEnvironment: boolean;
  recoveryStrategy: string;
  messagingCorrect: boolean;
  gracefulFallbackPassed: boolean;
  error?: string | undefined;
}

export interface UpgradePathValidation {
  sourceVersion: string;
  targetVersion: string;
  sourceCategory: 'legacy_electron_monolithic';
  targetCategory: 'native_host_core_minimal';
  userDataPreserved: boolean;
  surrealDbMigrated: boolean;
  settingsPreserved: boolean;
  legacyFilesCleaned: boolean;
  passed: boolean;
  durationMs: number;
}

export interface ProcessCleanupCheck {
  phase: 'after_shutdown' | 'after_uninstall';
  monitoredProcesses: readonly string[];
  activeProcessesFound: readonly string[];
  orphanServicesFound: readonly string[];
  zeroOrphansVerified: boolean;
  passed: boolean;
}

export interface InstallerArtifactHash {
  variantId: InstallerVariantId;
  artifactName: string;
  fileSizeBytes: number;
  sha256: string;
  md5: string;
  buildProvenance: string;
}

export interface CleanMachineValidationReport {
  timestamp: string;
  packet: 'L5.3';
  preferredVariantId: InstallerVariantId;
  environmentsEvaluated: Record<WindowsEnvironmentId, {
    config: WindowsEnvironmentConfig;
    freshInstallPassed: boolean;
    workloadPassed: boolean;
    shutdownPassed: boolean;
    uninstallPassed: boolean;
    reinstallPassed: boolean;
  }>;
  pathEdgeCases: readonly InstallPathCase[];
  prerequisitesEvaluated: readonly PrerequisiteCheckResult[];
  upgradeValidation: UpgradePathValidation;
  processCleanup: Record<'shutdown' | 'uninstall', ProcessCleanupCheck>;
  installerHashes: readonly InstallerArtifactHash[];
  allPassed: boolean;
  blockedOnWindowsNote?: string | undefined;
}

// ============================================================================
// Reprofile Simplified Application & Scorecard Contracts (L6)
// ============================================================================

export type BottleneckClassification =
  | 'CPU'
  | 'allocation_copying'
  | 'I/O'
  | 'network'
  | 'model_inference'
  | 'database'
  | 'packaging_overhead';

export interface RankedBottleneck {
  rank: number;
  id: string;
  title: string;
  impactDescription: string;
  classification: BottleneckClassification;
  measuredMetrics: Record<string, string | number>;
  component: string;
}

export type CandidateRecommendation =
  | 'HOLD_AND_MEASURE'
  | 'RECOMMENDED_FUTURE_WORK'
  | 'REJECT_REWRITE';

export interface RewriteDecisionCandidate {
  id: string;
  bottleneckId: string;
  candidateName: string;
  proposalDescription: string;
  pros: readonly string[];
  cons: readonly string[];
  recommendation: CandidateRecommendation;
  decisionReason: string;
}

export interface SimplifiedAppProcessTree {
  activeServicesCount: number;
  processNames: readonly string[];
  totalProcessCount: number;
  nodeProcessesCount: number;
  electronProcessesCount: number;
}

export interface MilestoneComparison {
  milestoneId: string;
  milestoneName: string;
  installerSizeBytes: number;
  installedSizeBytes: number;
  idleRssBytes: number;
  coldStartUsableUiMs: number;
  installerSizeDeltaPercent: number;
  installedSizeDeltaPercent: number;
  idleRssDeltaPercent: number;
  coldStartUsableUiDeltaPercent: number;
}

export interface StandardScorecardReport {
  packet: 'L6';
  timestamp: string;
  host: string;
  environment: PerformanceBenchmarkEnvironment;
  processTree: SimplifiedAppProcessTree;
  artifactSizes: ArtifactSizes;
  runtimeMetrics: RuntimeMetrics;
  workloadMetrics: WorkloadMetrics;
  workerMemoryRetention: {
    peakExtractionMemoryBytes: number;
    postJobRetainedMemoryBytes: number;
    workerHeapFragmentationPercent: number;
    retainedMemoryBytes: number;
  };
  milestoneComparisons: Record<string, MilestoneComparison>;
}

export interface ReprofileReportBundle {
  scorecard: StandardScorecardReport;
  bottlenecks: readonly RankedBottleneck[];
  decisions: readonly RewriteDecisionCandidate[];
  summary: {
    dominantBottleneck: string;
    totalBottlenecksCount: number;
    recommendedOptimizationsCount: number;
    noImplementationsInThisPacketConfirmed: boolean;
  };
}

// ============================================================================
// C/C++ Native Library Integration & Leaf Evaluation Contracts (L7.3)
// ============================================================================

export interface CppNativeCandidateContract {
  inputs: readonly string[];
  outputs: readonly string[];
  lifecycle: string;
}

export interface CppNativeCandidateEvaluation {
  candidate: string;
  targetFunction: string;
  contract: CppNativeCandidateContract;
  pythonBaselineLatencyMs: number;
  estimatedCppExtensionLatencyMs: number;
  ffiOverheadMs: number;
  netSpeedupPercent: number;
  packagingImpactMb: number;
  safetyRisks: readonly string[];
  decision: 'ACCEPT_REWRITE' | 'REJECT_REWRITE';
  rationale: string;
}

export interface CppNativeSafetyAndAuditEvidence {
  asanUbsanStatus: string;
  abiStability: string;
  isolationMechanism: string;
}

export interface CppNativeEvaluationReport {
  packetId: 'L7.3';
  title: string;
  status: 'ACCEPTED' | 'REJECTED_SKIPPED';
  reason: string;
  dependencies: {
    l6HotspotIdentified: boolean;
    topL6Bottleneck: string;
    recommendedL6Mitigation: string;
    approvedNativeLibraryRequirement: boolean;
  };
  evaluatedNativeCandidates: readonly CppNativeCandidateEvaluation[];
  safetyAndAuditEvidence: CppNativeSafetyAndAuditEvidence;
  verdict: {
    integrateCppLeaf: boolean;
    retainPythonFallback: boolean;
    action: string;
  };
}

// ============================================================================
// Go or C# Native Helper Evaluation Contracts (L7.4)
// ============================================================================

export type HelperLanguage = 'Go' | 'C#' | 'Rust_Native_Host';

export interface HelperContractSpec {
  ipcProtocol: 'JSON_RPC_STDIO' | 'CLI_FLAGS' | 'HTTP_REST_LOOPBACK';
  singleResponsibility: string;
  inputs: readonly string[];
  outputs: readonly string[];
  errorAndTimeoutBehavior: {
    timeoutMs: number;
    failureRecoveryStrategy: string;
    versionCompatibilityCheck: string;
  };
}

export interface HelperCandidateEvaluation {
  candidateId: string;
  name: string;
  language: HelperLanguage;
  targetFunction: string;
  contract: HelperContractSpec;
  standaloneJustification: string;
  startupLatencyMs: number;
  memoryRssMb: number;
  binaryPackageImpactMb: number;
  ipcTransitLatencyMs: number;
  toolchainRequirement: string;
  hostIntegrationAlternative: {
    implementationLocation: string;
    advantagesOverHelper: readonly string[];
  };
  decision: 'ACCEPT_HELPER' | 'REJECT_HELPER';
  rationale: string;
}

export interface HelperEvaluationReport {
  packetId: 'L7.4';
  title: string;
  status: 'ACCEPTED' | 'REJECTED_SKIPPED';
  reason: string;
  dependencies: {
    l6HotspotIdentified: boolean;
    approvedHelperBoundary: boolean;
    primaryNativeHostSelected: string;
  };
  evaluatedHelperCandidates: readonly HelperCandidateEvaluation[];
  overheadMetrics: {
    averageHelperPackageSizeMb: number;
    averageHelperMemoryRssMb: number;
    averageHelperStartupMs: number;
    hostIntegrationPackageSizeDeltaMb: number;
  };
  verdict: {
    buildSeparateHelper: boolean;
    retainInHostIntegration: boolean;
    action: string;
  };
}

// ============================================================================
// Python Worker Migration Study Contracts (L7.5)
// ============================================================================

export type WorkerExecutionCategory =
  | 'heavy_ml_extraction'
  | 'cpu_tokenization'
  | 'llm_prompt_pipeline'
  | 'audio_inference'
  | 'db_maintenance';

export interface WorkerCommandMapping {
  commandHandler: string;
  pythonModule: string;
  downstreamDependencies: readonly string[];
  executionCategory: WorkerExecutionCategory;
  averageExecutionTimeMs: number;
  peakMemoryRssMb: number;
}

export interface WorkerResponsibilitySplit {
  category: 'queue_and_lease' | 'business_workflow';
  responsibilities: readonly string[];
  currentOwner: string;
  potentialOwner: string;
  decouplingComplexity: 'low' | 'medium' | 'high';
}

export interface NativeCoordinatorQuantification {
  replacedCapabilities: readonly string[];
  retainedPythonWorkflows: readonly string[];
  idleMemorySavingsRssMb: number;
  pollingLatencyReductionPercent: number;
  gilContentionEliminated: boolean;
}

export interface IpcProcessStartEstimate {
  cpythonColdStartMs: number;
  cpythonWarmStartMs: number;
  cpythonImportHeavyMlStartMs: number;
  ipcTransitLatencyMs: number;
  payloadSizeLimitKb: number;
  analysisNote: string;
}

export interface UpstreamSyncBurden {
  rewriteScope: string;
  upstreamSyncRisk: 'low' | 'medium' | 'high' | 'extreme';
  estimatedMaintenanceOverhead: string;
  reasonsForSyncBurden: readonly string[];
}

export type WorkerOptionRecommendation =
  | 'RECOMMENDED'
  | 'VIABLE_ALTERNATIVE'
  | 'NOT_RECOMMENDED'
  | 'REJECTED';

export interface WorkerMigrationOption {
  optionId: 'keep_current' | 'on_demand_recycling' | 'native_coordinator_python_executor' | 'deeper_native_rewrite';
  title: string;
  description: string;
  idleRssMb: number;
  peakRssMb: number;
  coldJobLatencyMs: number;
  upstreamSyncBurden: string;
  engineeringEffort: string;
  pros: readonly string[];
  cons: readonly string[];
  recommendationStatus: WorkerOptionRecommendation;
}

export interface WorkerMigrationStudyReport {
  packetId: 'L7.5';
  title: string;
  status: 'STUDY_COMPLETE_NO_REWRITE';
  summary: string;
  commandMappings: readonly WorkerCommandMapping[];
  responsibilitySplit: readonly WorkerResponsibilitySplit[];
  nativeCoordinatorQuantification: NativeCoordinatorQuantification;
  ipcProcessStartEstimate: IpcProcessStartEstimate;
  upstreamSyncBurden: UpstreamSyncBurden;
  optionsTable: readonly WorkerMigrationOption[];
  recommendation: {
    selectedOptionId: string;
    primaryRationale: string;
    actionableNextSteps: readonly string[];
  };
}

// ============================================================================
// FastAPI / Native Backend Study Contracts (L7.6)
// ============================================================================

export type ApiRouteGroupId =
  | 'system_utility'
  | 'crud_data'
  | 'llm_chat_streaming'
  | 'upload_ingestion_trigger'
  | 'audio_podcast_streaming';

export interface ApiRouteGroupMapping {
  groupId: ApiRouteGroupId;
  groupName: string;
  description: string;
  routes: readonly string[];
  downstreamDependencies: readonly string[];
  pythonProcessRemovalPossible: boolean;
  removalReasoning: string;
}

export interface IpcStreamingComplexityAnalysis {
  ipcProtocolComplexity: string;
  serializationOverhead: string;
  streamingHandlingComplexity: string;
  multipartUploadHandling: string;
  overallIpcComplexityRating: 'low' | 'medium' | 'high' | 'extreme';
}

export interface UpstreamSyncAndTestBurden {
  upstreamSyncRisk: 'low' | 'medium' | 'high' | 'extreme';
  schemaDuplicationBurden: string;
  upstreamMaintenanceOverhead: string;
  reasonsForSyncBurden: readonly string[];
}

export interface ResourceWinEstimate {
  currentUvicornMemoryRssMb: number;
  projectedNativeBackendMemoryRssMb: number;
  netMemorySavingsMb: number;
  latencyImpactMs: number;
  coldStartImpactMs: number;
  measuredBenefitAssessment: string;
}

export interface ParityTestSuiteRequirement {
  suiteName: string;
  description: string;
  coveredEndpoints: readonly string[];
  verificationCriteria: readonly string[];
}

export interface ParityTestPlan {
  requiredSuites: readonly ParityTestSuiteRequirement[];
  totalEndpointsCovered: number;
  estimatedParityTestEffort: string;
}

export interface RouteGroupFeasibilityMatrixItem {
  groupId: ApiRouteGroupId;
  title: string;
  decision: 'NO_GO' | 'REJECT_REWRITE';
  rationale: string;
  pros: readonly string[];
  cons: readonly string[];
}

export interface FastApiNativeBackendStudyReport {
  packetId: 'L7.6';
  title: string;
  status: 'STUDY_COMPLETE_NO_REWRITE';
  summary: string;
  routeGroupMappings: readonly ApiRouteGroupMapping[];
  ipcStreamingComplexity: IpcStreamingComplexityAnalysis;
  upstreamSyncAndTestBurden: UpstreamSyncAndTestBurden;
  resourceWinEstimate: ResourceWinEstimate;
  parityTestPlan: ParityTestPlan;
  feasibilityMatrix: readonly RouteGroupFeasibilityMatrixItem[];
  overallRecommendation: {
    decision: 'REJECT_ALL_NATIVE_BACKEND_REWRITES';
    primaryRationale: string;
    recommendedArchitecture: string;
    actionableNextSteps: readonly string[];
  };
}

// ============================================================================
// Loopback Networking & Navigation Security Audit Contracts (L8.1)
// ============================================================================

export type SocketComplianceStatus = 'compliant' | 'non_compliant';

export interface SocketBindCheck {
  serviceName: string;
  expectedHost: string;
  configuredHost: string;
  port: number;
  boundToLoopbackOnly: boolean;
  status: SocketComplianceStatus;
  details?: string | undefined;
}

export interface SocketBindAudit {
  services: readonly SocketBindCheck[];
  allServicesLoopbackOnly: boolean;
}

export interface ProxyTargetCheck {
  id: string;
  targetUrl: string;
  allowed: boolean;
  statusCode: number;
  reason: string;
  passed: boolean;
}

export interface ProxyHeaderCheck {
  id: string;
  headerName: string;
  headerValue: string;
  safe: boolean;
  reason: string;
  passed: boolean;
}

export interface ProxyPathSecurityCheck {
  id: string;
  requestedPath: string;
  isSafe: boolean;
  canonicalPath?: string | undefined;
  reason?: string | undefined;
  passed: boolean;
}

export interface ProxySecurityAudit {
  targetPinningCases: readonly ProxyTargetCheck[];
  headerInjectionCases: readonly ProxyHeaderCheck[];
  pathTraversalCases: readonly ProxyPathSecurityCheck[];
  allProxyChecksPassed: boolean;
}

export type NavigationCaseCategory =
  | 'internal_origin'
  | 'deep_link'
  | 'user_info_trick'
  | 'domain_prefix_trick'
  | 'case_variant'
  | 'alternate_scheme'
  | 'external_http'
  | 'malformed';

export interface NavigationPolicyCase {
  id: string;
  inputUrl: string;
  expectedAction: NavigationAction;
  actualAction: NavigationAction;
  category: NavigationCaseCategory;
  passed: boolean;
  reason?: string | undefined;
}

export interface NavigationSecurityAudit {
  cases: readonly NavigationPolicyCase[];
  allNavigationChecksPassed: boolean;
}

export interface FuzzCaseResult {
  category: 'url_fuzz' | 'path_fuzz' | 'header_fuzz';
  iterations: number;
  failures: number;
  passed: boolean;
  sampleErrors?: readonly string[] | undefined;
}

export interface FuzzSuiteAudit {
  suites: readonly FuzzCaseResult[];
  allFuzzPassed: boolean;
}

export interface SecurityFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
  title: string;
  status: 'resolved' | 'open' | 'mitigated';
  description: string;
  remediation: string;
}

export interface SecurityAuditReport {
  packetId: 'L8.1';
  title: string;
  timestamp: string;
  socketBindAudit: SocketBindAudit;
  proxySecurityAudit: ProxySecurityAudit;
  navigationSecurityAudit: NavigationSecurityAudit;
  fuzzSuiteAudit: FuzzSuiteAudit;
  findings: readonly SecurityFinding[];
  verdict: {
    fullyCompliant: boolean;
    summary: string;
  };
}

// ============================================================================
// Secrets, Paths, Diagnostics, Dependencies & Licenses Audit Contracts (L8.2)
// ============================================================================

export interface SecretTraceCheck {
  id: string;
  category: 'environment' | 'logs' | 'diagnostics' | 'config';
  targetField: string;
  isRedacted: boolean;
  maskPattern: string;
  passed: boolean;
  notes: string;
}

export interface RedactionTestCheck {
  id: string;
  inputSample: string;
  sensitiveField: string;
  redactedOutput: string;
  passed: boolean;
}

export interface DependencyAuditCheck {
  componentName: string;
  version: string;
  sourceType: 'npm' | 'cargo' | 'python' | 'native';
  pinned: boolean;
  vulnerabilitiesFound: number;
  status: 'compliant' | 'review_required';
  notes: string;
}

export interface LicenseInventoryItem {
  componentName: string;
  version: string;
  license: string;
  redistributable: boolean;
  attributionRequired: boolean;
}

export interface VulnerabilityTriageItem {
  cveId: string;
  component: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
  status: 'patched' | 'triaged_safe' | 'mitigated' | 'open';
  description: string;
  remediation: string;
}

export interface SecurityComplianceAuditReport {
  packetId: 'L8.2';
  evidenceKind: 'synthetic-contract-fixtures';
  productionControlsVerified: false;
  vulnerabilityScanPerformed: false;
  limitations: readonly string[];
  title: string;
  timestamp: string;
  secretTraceAudits: readonly SecretTraceCheck[];
  redactionTests: readonly RedactionTestCheck[];
  dependencyAudits: readonly DependencyAuditCheck[];
  licenseInventory: readonly LicenseInventoryItem[];
  vulnerabilityTriage: readonly VulnerabilityTriageItem[];
  findings: readonly SecurityFinding[];
  verdict: {
    fullyCompliant: false;
    fixtureChecksPassed: boolean;
    summary: string;
  };
}

// ============================================================================
// Golden Extraction, RAG, and API Contract Regression Contracts (L8.3)
// ============================================================================

export interface GoldenExtractionCorpusCheck {
  docId: string;
  extractionPath: 'native' | 'docling' | 'heuristic';
  baselineHash: string;
  currentHash: string;
  matchStatus: 'exact' | 'tolerated' | 'regression';
  notes: string;
}

export interface RagRegressionScenarioCheck {
  scenarioId: string;
  query: string;
  expectedContextIds: readonly string[];
  retrievedContextIds: readonly string[];
  relevanceScore: number;
  latencyMs: number;
  status: 'passed' | 'degraded' | 'failed';
  notes: string;
}

export interface ApiContractRegressionCheck {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  category: 'error_handling' | 'large_upload' | 'sse_streaming';
  status: 'passed' | 'failed';
  responseCode: number;
  latencyMs: number;
  notes: string;
}

export interface GoldenDataDeltaItem {
  deltaId: string;
  targetResource: string;
  changeType: 'updated' | 'added' | 'deprecated';
  explicitRationale: string;
  reviewRecord: string;
  approvedBy: string;
}

export interface ReleaseBlockingIssueItem {
  issueId: string;
  component: string;
  category: string;
  severity: 'blocking' | 'non_blocking' | 'warning';
  description: string;
  mitigationStatus: string;
}

export interface GoldenRegressionReport {
  packetId: 'L8.3';
  title: string;
  timestamp: string;
  extractionCorpusChecks: readonly GoldenExtractionCorpusCheck[];
  ragRegressionChecks: readonly RagRegressionScenarioCheck[];
  apiContractChecks: readonly ApiContractRegressionCheck[];
  goldenDataDeltas: readonly GoldenDataDeltaItem[];
  releaseBlockingIssues: readonly ReleaseBlockingIssueItem[];
  verdict: {
    allPassed: boolean;
    summary: string;
  };
}

// ============================================================================
// CI Lanes, Release Gates, Rollback, and Canary Controls Contracts (L8.4)
// ============================================================================

export interface CILaneConfig {
  laneId: string;
  name: string;
  category: 'fast' | 'integration' | 'stress_chaos' | 'rag' | 'packaging' | 'performance';
  commands: readonly string[];
  blocksPullRequest: boolean;
  blocksRelease: boolean;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  notes: string;
}

export interface ReleaseAcceptanceGate {
  gateId: string;
  category: 'correctness' | 'security' | 'process_cleanup' | 'packaging' | 'performance';
  criterion: string;
  requiredThreshold: string;
  actualResult: string;
  status: 'passed' | 'failed';
  notes: string;
}

export interface SwitchabilityVerification {
  featureName: string;
  primaryImplementation: string;
  fallbackImplementation: string;
  switchMechanism: string;
  switchable: boolean;
  notes: string;
}

export interface CanaryRollbackTrigger {
  triggerId: string;
  metric: string;
  threshold: string;
  action: 'automatic_rollback' | 'alert_operator' | 'throttle_canary';
  tested: boolean;
  notes: string;
}

export interface RollbackTestExecution {
  executionId: string;
  scenario: string;
  fromVersion: string;
  toVersion: string;
  rollbackMethod: string;
  durationMs: number;
  success: boolean;
  notes: string;
}

export interface CiReleaseGatesReport {
  packetId: 'L8.4';
  title: string;
  timestamp: string;
  ciLanes: readonly CILaneConfig[];
  releaseAcceptanceGates: readonly ReleaseAcceptanceGate[];
  switchabilityVerifications: readonly SwitchabilityVerification[];
  canaryTriggers: readonly CanaryRollbackTrigger[];
  rollbackTestExecutions: readonly RollbackTestExecution[];
  verdict: {
    allPassed: boolean;
    summary: string;
  };
}



