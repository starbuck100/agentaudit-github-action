# 🛡️ AgentAudit Security Scan - GitHub Action

Scan AI agent packages and MCP tools for security risks using [AgentAudit](https://www.agentaudit.dev).

## Usage

### Scan specific packages

```yaml
- uses: agentaudit/security-scan@v1
  with:
    packages: 'cursor,windsurf,claude-code'
    fail-on: 'unsafe'
```

### Auto-detect from project files

```yaml
- uses: agentaudit/security-scan@v1
  with:
    scan-config: 'true'
    fail-on: 'caution'
```

### Full example

```yaml
name: Security Scan
on: [push, pull_request]

jobs:
  agentaudit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: AgentAudit Security Scan
        id: scan
        uses: agentaudit/security-scan@v1
        with:
          packages: 'cursor,windsurf'
          scan-config: 'true'
          fail-on: 'unsafe'

      - name: Check results
        if: always()
        run: |
          echo "Has issues: ${{ steps.scan.outputs.has-issues }}"
          echo "Results: ${{ steps.scan.outputs.results }}"
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `packages` | Comma-separated package slugs to check | `''` |
| `scan-config` | Auto-detect packages from package.json/requirements.txt | `'false'` |
| `fail-on` | Risk threshold: `unsafe`, `caution`, or `any` | `'unsafe'` |
| `api-url` | AgentAudit API URL | `https://www.agentaudit.dev` |

## Outputs

| Output | Description |
|--------|-------------|
| `results` | JSON array of scan results |
| `has-issues` | `true` if any package exceeds threshold |

## Risk Levels

- ✅ **safe** — No known issues
- ⚠️ **caution** — Minor concerns, review recommended
- 🚨 **unsafe** — Significant security risks found

## License

MIT
