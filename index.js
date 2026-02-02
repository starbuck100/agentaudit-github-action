const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Config Discovery ---

const CONFIG_CANDIDATES = [
  '.mcp.json',
  'mcp.json',
  '.mcp/config.json',
  'claude_desktop_config.json',
  '.cursor/mcp.json',
];

function findConfig(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      core.setFailed(`Config not found: ${explicit}`);
      process.exit(1);
    }
    return explicit;
  }
  for (const c of CONFIG_CANDIDATES) {
    const p = path.resolve(process.env.GITHUB_WORKSPACE || '.', c);
    if (fs.existsSync(p)) {
      core.info(`Auto-detected config: ${p}`);
      return p;
    }
  }
  return null;
}

// --- Package Extraction ---

function extractPackages(config) {
  const packages = [];
  const servers = config.mcpServers || config.servers || config.mcp_servers || {};

  for (const [name, server] of Object.entries(servers)) {
    const entry = { serverName: name, packages: [] };

    // npx-based servers
    if (server.command === 'npx' || server.command === 'npx.cmd') {
      const args = server.args || [];
      for (const a of args) {
        if (a.startsWith('-')) continue;
        // Strip version specifier: @scope/pkg@1.0 -> @scope/pkg
        const pkg = a.replace(/@[\d^~>=<.*]+$/, '');
        if (pkg) entry.packages.push({ name: pkg, type: 'npm', raw: a });
        break; // first non-flag arg is the package
      }
    }

    // uvx / pip-based servers
    if (server.command === 'uvx' || server.command === 'uv') {
      const args = server.args || [];
      for (const a of args) {
        if (a.startsWith('-') || a === 'run' || a === 'tool') continue;
        entry.packages.push({ name: a.replace(/@[\d^~>=<.*]+$/, ''), type: 'pypi', raw: a });
        break;
      }
    }

    // docker-based
    if (server.command === 'docker') {
      const args = server.args || [];
      const idx = args.indexOf('--image') !== -1 ? args.indexOf('--image') + 1 : -1;
      if (idx > 0 && args[idx]) {
        entry.packages.push({ name: args[idx], type: 'docker', raw: args[idx] });
      } else {
        // look for image name after 'run'
        const runIdx = args.indexOf('run');
        if (runIdx !== -1) {
          for (let i = runIdx + 1; i < args.length; i++) {
            if (!args[i].startsWith('-')) {
              entry.packages.push({ name: args[i], type: 'docker', raw: args[i] });
              break;
            }
          }
        }
      }
    }

    // Generic: if command itself looks like a path or package
    if (entry.packages.length === 0 && server.command) {
      entry.packages.push({ name: server.command, type: 'command', raw: server.command });
    }

    if (entry.packages.length > 0) packages.push(entry);
  }

  return packages;
}

// --- API Check ---

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'agentaudit-github-action/1.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else if (res.statusCode === 404) {
          resolve(null);
        } else {
          reject(new Error(`API ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function checkPackage(apiUrl, pkg) {
  const encodedName = encodeURIComponent(pkg.name);
  // Try lookup by package name
  const url = `${apiUrl}/${encodedName}`;
  try {
    const result = await fetch(url);
    return { ...pkg, audit: result, checked: true };
  } catch (err) {
    core.warning(`API error for ${pkg.name}: ${err.message}`);
    return { ...pkg, audit: null, checked: false, error: err.message };
  }
}

// --- Main ---

async function run() {
  try {
    const configPath = findConfig(core.getInput('config-path'));
    const apiUrl = core.getInput('api-url') || 'https://www.agentaudit.dev/api/skills';
    const failOnRisk = core.getInput('fail-on-risk') !== 'false';

    if (!configPath) {
      core.warning('No MCP config file found. Nothing to check.');
      core.setOutput('total-packages', '0');
      core.setOutput('flagged-packages', '0');
      core.setOutput('report', '[]');
      return;
    }

    const raw = fs.readFileSync(configPath, 'utf8');
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      core.setFailed(`Invalid JSON in ${configPath}`);
      return;
    }

    const entries = extractPackages(config);
    const allPackages = entries.flatMap(e => e.packages.map(p => ({ ...p, server: e.serverName })));

    core.info(`Found ${allPackages.length} package(s) across ${entries.length} server(s)`);

    if (allPackages.length === 0) {
      core.warning('No packages extracted from MCP config.');
      core.setOutput('total-packages', '0');
      core.setOutput('flagged-packages', '0');
      core.setOutput('report', '[]');
      return;
    }

    // Check all packages
    const results = [];
    for (const pkg of allPackages) {
      core.info(`Checking: ${pkg.name} (${pkg.type}) [server: ${pkg.server}]`);
      const result = await checkPackage(apiUrl, pkg);
      results.push(result);
    }

    // Evaluate results
    const flagged = results.filter(r => r.audit && (r.audit.risk || r.audit.flagged || r.audit.malicious));
    const unknown = results.filter(r => r.audit === null && r.checked);

    // Summary
    core.startGroup('AgentAudit Report');
    for (const r of results) {
      const status = !r.checked ? '⚠️ ERROR'
        : r.audit === null ? '❓ UNKNOWN'
        : (r.audit.risk || r.audit.flagged || r.audit.malicious) ? '🚨 FLAGGED'
        : '✅ OK';
      const detail = r.audit ? ` — ${r.audit.description || r.audit.risk_level || 'no details'}` : '';
      core.info(`${status} ${r.name} (${r.type})${detail}`);
    }
    core.endGroup();

    if (flagged.length > 0) {
      const msg = `🚨 ${flagged.length} package(s) flagged: ${flagged.map(f => f.name).join(', ')}`;
      if (failOnRisk) {
        core.setFailed(msg);
      } else {
        core.warning(msg);
      }
    }

    if (unknown.length > 0) {
      core.warning(`${unknown.length} package(s) not found in AgentAudit DB: ${unknown.map(u => u.name).join(', ')}`);
    }

    core.setOutput('total-packages', String(allPackages.length));
    core.setOutput('flagged-packages', String(flagged.length));
    core.setOutput('report', JSON.stringify(results));

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
