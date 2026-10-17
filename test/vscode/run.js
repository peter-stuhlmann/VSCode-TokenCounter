// Startet ein echtes, isoliertes VS Code (eigenes Profil, keine anderen Extensions,
// temporäres ~/.claude) und führt darin test/vscode/suite.js aus.
// Aufruf: npm run test:vscode

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

// Aus einem VS-Code-Terminal gestartet, ist diese Variable gesetzt und würde
// das Test-VS-Code als reines Node starten statt als Editor.
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const root = path.join(__dirname, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-vscode-'));
  const claudeDir = path.join(tmp, 'claude');
  const workspace = path.join(tmp, 'REA');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(workspace);
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--user-data-dir',
        path.join(tmp, 'user-data'),
        '--extensions-dir',
        path.join(tmp, 'extensions'),
      ],
      extensionTestsEnv: { CLAUDE_CONFIG_DIR: claudeDir, TT_WORKSPACE: workspace },
    });
  } catch (e) {
    console.error('VS-Code-Tests fehlgeschlagen:', e.message || e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
})();
