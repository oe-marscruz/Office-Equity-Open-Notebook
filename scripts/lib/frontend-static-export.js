'use strict';

/**
 * frontend-static-export.js
 *
 * Converts the upstream Open Notebook Next.js application (pinned in
 * upstream.lock.json) into a Node-free static export that the native Tauri host
 * can serve directly from `runtime/frontend/static`.
 *
 * The upstream frontend targets a Docker/standalone Node server. Everything that
 * needs that server is rewritten here, deterministically and idempotently:
 *
 *   - `output: "standalone"` -> `output: "export"` (plain HTML/JS/CSS assets)
 *   - `/api/*` rewrites      -> none; the Tauri proxy forwards `/api/*` to the
 *                              bundled FastAPI backend on the same origin
 *   - `src/proxy.ts`         -> removed (middleware needs a Node runtime)
 *   - `src/app/api/**`       -> removed (redundant behind the proxy)
 *   - `src/app/config`       -> replaced by a static `public/config` asset
 *   - server `redirect()`    -> client-side `router.replace()`
 *   - `[id]` route segments  -> one placeholder shell plus a client page that
 *                              reads the real id from `usePathname()`
 *
 * The dynamic-route rewrite is what makes the export work: a static export must
 * enumerate concrete params, but real notebooks and sources are created at
 * runtime. The host serves the single placeholder shell for every unknown path
 * (see `src-tauri/src/static_server.rs`), and the client page resolves the live
 * id from the browser pathname.
 */

const fs = require('fs');
const path = require('path');

const UPSTREAM_FRONTEND_DIR = 'frontend';

const NEXT_CONFIG_SOURCE = `import type { NextConfig } from "next";

// Desktop build: a Node-free static export consumed by the native Tauri host,
// which serves these assets and proxies /api/* to the bundled FastAPI backend.
// The upstream config (output: "standalone", /api rewrites, /settings/api-keys
// redirect) requires a Node server and is deliberately not used here.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
`;

const CLIENT_REDIRECT_PAGE = (componentName) => `'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

// A static export forbids server-side redirect(), so redirect after hydration.
export default function ${componentName}() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/notebooks')
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <LoadingSpinner size="lg" />
    </div>
  )
}
`;

const DYNAMIC_ROUTES = [
  {
    group: 'notebooks',
    segment: 'notebook-page',
    clientName: 'NotebookPageClient',
    pageName: 'NotebookPage',
    idName: 'notebookId',
  },
  {
    group: 'sources',
    segment: 'source-page',
    clientName: 'SourcePageClient',
    pageName: 'SourceDetailPage',
    idName: 'sourceId',
  },
];

class FrontendPatchError extends Error {}

function assertContains(source, needle, description) {
  if (!source.includes(needle)) {
    throw new FrontendPatchError(
      `Upstream frontend changed: expected ${description} (${JSON.stringify(needle)}) was not found. ` +
        'Update scripts/lib/frontend-static-export.js for the new upstream revision.',
    );
  }
}

/**
 * Resets `src/` and `public/` inside `buildDir` to the pinned upstream sources so
 * the patch step can be re-run any number of times with an identical result.
 */
function resetFromUpstream(upstreamFrontend, buildDir) {
  for (const sub of ['src', 'public']) {
    const source = path.join(upstreamFrontend, sub);
    if (!fs.existsSync(source)) {
      throw new FrontendPatchError(`Upstream frontend is missing ${sub}/: ${source}`);
    }
    const target = path.join(buildDir, sub);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
  }
}

function splitDynamicRoute(buildDir, config) {
  const { group, segment, clientName, pageName } = config;
  const pageRel = `src/app/(dashboard)/${group}/[id]/page.tsx`;
  const clientRel = `src/app/(dashboard)/${group}/[id]/${segment}-client.tsx`;
  const pageAbs = path.join(buildDir, pageRel);

  let body = fs.readFileSync(pageAbs, 'utf8');

  const marker = `export default function ${pageName}()`;
  assertContains(body, marker, `the ${group} route component`);
  body = body.replace(marker, `export default function ${clientName}()`);

  const useParamsLine = '  const params = useParams()';
  assertContains(body, useParamsLine, `the ${group} route params hook`);
  body = body.replace(
    useParamsLine,
    `${useParamsLine}\n  const pathname = usePathname()\n  const routeId = pathname?.split('/')[2] ?? ''`,
  );

  const navImport = body.match(/import \{([^}]*)\} from 'next\/navigation'/);
  if (!navImport) {
    throw new FrontendPatchError(`Upstream frontend changed: no next/navigation import in ${pageRel}.`);
  }
  if (!navImport[1].includes('usePathname')) {
    body = body.replace(navImport[0], `import {${navImport[1]}, usePathname } from 'next/navigation'`);
  }

  const bakedId = new RegExp(
    `  const ${config.idName} = params\\?\\.id \\? decodeURIComponent\\(params\\.id as string\\) : ''`,
  );
  if (!bakedId.test(body)) {
    throw new FrontendPatchError(
      `Upstream frontend changed: ${pageRel} no longer derives the route id the expected way.`,
    );
  }
  body = body.replace(
    bakedId,
    `  const ${config.idName} = decodeURIComponent(routeId || ((params?.id as string) ?? ''))`,
  );

  body = body.replace(/^(?:'use client'\n)+/, '');
  fs.writeFileSync(path.join(buildDir, clientRel), `'use client'\n\n${body}`);

  // The original route module also exported shared types that other modules
  // import from this path. Re-export them from the shell so those imports keep
  // resolving.
  const typeNames = new Set();
  for (const match of body.matchAll(/^export type \{([^}]*)\}\s*$/gm)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed) typeNames.add(trimmed);
    }
  }
  for (const match of body.matchAll(/^export (?:interface|type) (\w+)/gm)) {
    typeNames.add(match[1]);
  }
  const typeReExport =
    typeNames.size > 0
      ? `\nexport type { ${[...typeNames].join(', ')} } from './${segment}-client'\n`
      : '';

  fs.writeFileSync(
    pageAbs,
    `import ${clientName} from './${segment}-client'
${typeReExport}
// A static export needs concrete params. The native host routes every real id to
// this one shell, and ${clientName} reads the live id from the pathname.
export function generateStaticParams() {
  return [{ id: '_' }]
}

export default function ${pageName}Shell() {
  return <${clientName} />
}
`,
  );
}

/**
 * Applies every source rewrite to a copy of the upstream frontend.
 *
 * @param {object} options
 * @param {string} options.upstreamFrontend Absolute path to `<repo>/frontend`.
 * @param {string} options.buildDir         Absolute path to the scratch build dir.
 * @returns {string[]} Human-readable list of applied transformations.
 */
function patchFrontendForStaticExport({ upstreamFrontend, buildDir }) {
  resetFromUpstream(upstreamFrontend, buildDir);

  const applied = [];

  // Node-free static export instead of a standalone Node server.
  fs.writeFileSync(path.join(buildDir, 'next.config.ts'), NEXT_CONFIG_SOURCE);
  applied.push('next.config.ts: output=export, trailingSlash, unoptimized images');

  // Middleware requires a Node server; the native host is same-origin.
  for (const middlewareFile of ['src/proxy.ts', 'src/middleware.ts']) {
    const abs = path.join(buildDir, middlewareFile);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
      applied.push(`${middlewareFile}: removed (needs a Node runtime)`);
    }
  }

  // /api/* is forwarded to FastAPI by the Tauri proxy, so the Next route
  // handlers are dead weight on the desktop host. /config ships as a static
  // asset; apiUrl "" means "same origin", i.e. through the proxy.
  fs.rmSync(path.join(buildDir, 'src/app/api'), { recursive: true, force: true });
  fs.rmSync(path.join(buildDir, 'src/app/config'), { recursive: true, force: true });
  fs.mkdirSync(path.join(buildDir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'public/config'), '{"apiUrl":""}\n');
  applied.push('src/app/api + src/app/config: replaced by static public/config');

  // Server redirect() is forbidden in a static export.
  for (const [rel, componentName] of [
    ['src/app/page.tsx', 'HomePage'],
    ['src/app/(dashboard)/page.tsx', 'DashboardPage'],
  ]) {
    fs.writeFileSync(path.join(buildDir, rel), CLIENT_REDIRECT_PAGE(componentName));
    applied.push(`${rel}: server redirect replaced with client redirect`);
  }

  for (const dynamicRoute of DYNAMIC_ROUTES) {
    splitDynamicRoute(buildDir, dynamicRoute);
    applied.push(
      `src/app/(dashboard)/${dynamicRoute.group}/[id]: split into static shell + pathname-driven client`,
    );
  }

  return applied;
}

/**
 * Reads and validates the produced static export.
 *
 * @param {string} outDir Absolute path to the Next.js `out/` directory.
 * @returns {{ fileCount: number, totalBytes: number, hasIndexHtml: boolean, dynamicShells: object[] }}
 */
function inspectStaticExport(outDir) {
  if (!fs.existsSync(outDir)) {
    throw new FrontendPatchError(`Static export produced no output directory: ${outDir}`);
  }

  let fileCount = 0;
  let totalBytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += fs.statSync(full).size;
      }
    }
  };
  walk(outDir);

  const hasIndexHtml = fs.existsSync(path.join(outDir, 'index.html'));
  if (!hasIndexHtml) {
    throw new FrontendPatchError(
      'Static export has no index.html. The native host relies on it as the SPA fallback shell.',
    );
  }

  const nextAssets = path.join(outDir, '_next');
  if (!fs.existsSync(nextAssets)) {
    throw new FrontendPatchError('Static export has no _next/ asset directory.');
  }

  const dynamicShells = DYNAMIC_ROUTES.map(({ group }) => {
    const shell = path.join(outDir, group, '_', 'index.html');
    return { group, shell: `${group}/_/index.html`, present: fs.existsSync(shell) };
  });
  const missingShell = dynamicShells.filter((shell) => !shell.present);
  if (missingShell.length > 0) {
    throw new FrontendPatchError(
      `Static export is missing dynamic route shells: ${missingShell.map((s) => s.shell).join(', ')}`,
    );
  }

  const configAsset = path.join(outDir, 'config');
  if (!fs.existsSync(configAsset)) {
    throw new FrontendPatchError('Static export is missing the /config runtime-config asset.');
  }

  return { fileCount, totalBytes, hasIndexHtml, dynamicShells };
}

module.exports = {
  DYNAMIC_ROUTES,
  FrontendPatchError,
  UPSTREAM_FRONTEND_DIR,
  inspectStaticExport,
  patchFrontendForStaticExport,
};
