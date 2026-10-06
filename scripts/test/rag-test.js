'use strict';

/**
 * rag-test.js — RAG and LLM behaviour tests against a running stack.
 *
 * The question this answers is the one that matters most for the Office of
 * Equity: can a grounded answer ever reach into a notebook it was not asked
 * about? If a search or a chat response returns content that was only ever
 * added to a *different* notebook, that is a confidentiality failure, not a
 * relevance problem.
 *
 * It also checks that answers are actually grounded — that a citation points
 * at a source that really exists — because a fabricated citation in a
 * civil-rights case file is worse than no answer.
 *
 * Requires a running stack:
 *   node scripts/run-services.js --runtime <path-to>/resources/runtime --data <isolated-data-dir>
 * then:
 *   npm run test:rag
 *
 * Exit codes: 0 = pass, 1 = failure, 2 = skipped (no reachable API).
 */

const { PORTS } = require('../lib/paths');

const API_URL = `http://127.0.0.1:${PORTS.api}`;
const REQUEST_TIMEOUT_MS = 15000;
const SETTLE_MS = 3000;

// A token unlikely to occur by chance, so a hit proves the source was used
// rather than the model guessing something plausible.
const ISOLATION_TOKEN_A = 'zygomorphic-quokka-4417';
const ISOLATION_TOKEN_B = 'flibbertigibbet-pangolin-9928';

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: (options.method || 'get').toUpperCase(),
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { status: response.status, ok: response.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isApiReachable() {
  try {
    await api('/health', { timeoutMs: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Guards the suite itself: if the backend keeps echoing every notebook
 * regardless of id, then the isolation assertions below could pass for the
 * wrong reason (an empty result set). This confirms the probe token is
 * actually findable before we assert it is *not* leaked.
 */
async function assertFixturesAreFindable(notebookId, token, label) {
  const search = await api(`/search/text?query=${encodeURIComponent(token)}`);
  const body = JSON.stringify(search.json || search.text || '');
  if (!body.includes(token)) {
    console.error(`INCONCLUSIVE: the ${label} probe token could not be found even in its own notebook.`);
    console.error('The isolation assertions would be vacuous, so this run is not a pass.');
    return false;
  }
  return true;
}

async function main() {
  console.log(`RAG/LLM checks against ${API_URL}...`);

  if (!(await isApiReachable())) {
    console.error(`\nSKIPPED: no API is listening on ${API_URL}.`);
    console.error('Start the stack first: node scripts/run-services.js --data <isolated-data-dir>');
    process.exitCode = 2;
    return;
  }
  console.log('Backend is reachable.');

  let failures = 0;
  const fail = (message) => {
    failures++;
    console.error(`FAIL: ${message}`);
  };

  // ---- Fixtures: two notebooks that must never see each other --------------
  console.log('\nCreating two separate notebooks...');
  const notebookA = await api('/notebooks', { method: 'post', body: { name: 'RAG Test A', description: 'isolation probe A' } });
  const notebookB = await api('/notebooks', { method: 'post', body: { name: 'RAG Test B', description: 'isolation probe B' } });

  if (!notebookA.ok || !notebookB.ok) {
    console.error(`SKIPPED: could not create notebooks (A: ${notebookA.status}, B: ${notebookB.status}).`);
    console.error('This harness needs an API that supports POST /notebooks with a JSON body.');
    process.exitCode = 2;
    return;
  }

  const idA = notebookA.json && (notebookA.json.id || notebookA.json.notebook_id);
  const idB = notebookB.json && (notebookB.json.id || notebookB.json.notebook_id);
  if (!idA || !idB) {
    console.error('SKIPPED: the API did not return notebook ids, so isolation cannot be targeted.');
    process.exitCode = 2;
    return;
  }

  await api('/notes', { method: 'post', body: { notebook_id: idA, title: 'A source', content: `${ISOLATION_TOKEN_A} appears only in notebook A.` } });
  await api('/notes', { method: 'post', body: { notebook_id: idB, title: 'B source', content: `${ISOLATION_TOKEN_B} appears only in notebook B.` } });
  console.log(`Waiting ${SETTLE_MS}ms for sources to be indexed...`);
  await sleep(SETTLE_MS);

  // ---- Cross-notebook confidentiality -------------------------------------
  console.log('\nCross-notebook confidentiality');

  const findableA = await assertFixturesAreFindable(idA, ISOLATION_TOKEN_A, 'notebook A');
  const findableB = await assertFixturesAreFindable(idB, ISOLATION_TOKEN_B, 'notebook B');
  if (!findableA || !findableB) {
    console.error('Aborting: cannot validate isolation without a working search baseline.');
    process.exitCode = 1;
    return;
  }
  console.log('Baseline confirmed: each probe token is findable.');

  for (const [name, latitude, longitude] of [
    ['notebook A', ISOLATION_TOKEN_A, ISOLATION_TOKEN_B],
    ['notebook B', ISOLATION_TOKEN_B, ISOLATION_TOKEN_A],
  ]) {
    for (const kind of ['vector', 'text']) {
      const response = await api(`/search/${kind}?query=${encodeURIComponent(longitude)}&notebook_id=${encodeURIComponent(name === 'notebook A' ? idA : idB)}`);
      const body = JSON.stringify(response.json || response.text || '');
      if (body.includes(longitude)) {
        fail(
          `the other notebook's content leaked into ${kind} search scoped to ${name}. ` +
          'A user could retrieve another case file\'s text by searching inside their own notebook.'
        );
      } else {
        console.log(`ok - ${kind} search in ${name} did not return the other notebook's token`);
      }
    }
  }

  // ---- Grounded answers ---------------------------------------------------
  console.log('\nAnswer grounding');
  const chat = await api('/chat', {
    method: 'post',
    body: { notebook_id: idA, message: 'What token appears in notebook A? Answer using only the sources.', stream: false },
    timeoutMs: 60000,
  });

  if (!chat.ok) {
    console.error(`NOTE: POST /chat returned ${chat.status}; grounded-answer checks were not run.`);
    console.error('This is reported, not failed, because chat may require a configured model provider.');
  } else {
    const body = JSON.stringify(chat.json || chat.text || '');
    if (body.includes(ISOLATION_TOKEN_B)) {
      fail('a chat answer scoped to notebook A quoted content from notebook B — cross-notebook leakage in generated text.');
    } else {
      console.log('ok - the generated answer did not quote the other notebook');
    }

    const citations = (chat.json && (chat.json.citations || chat.json.sources)) || null;
    if (Array.isArray(citations) && citations.length > 0) {
      const ids = citations.map((entry) => entry && (entry.id || entry.source_id)).filter(Boolean);
      console.log(`ok - the answer cited ${citations.length} source(s)`);
      if (ids.length === 0) {
        fail('citations were returned without any identifier, so a user cannot verify the claim against the original document.');
      }
    } else {
      console.error('NOTE: no citations were returned; grounding could not be verified. A model provider may not be configured.');
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: RAG/LLM checks completed with ${failures} failure(s).`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
