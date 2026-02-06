import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';

/**
 * Check if a process command matches the gateway (not CLI commands)
 */
function isGatewayCommand(command: string): boolean {
  const isGateway = command.includes('start-moltbot.sh') || command.includes('clawdbot gateway');
  const isCli = command.includes('clawdbot devices') || command.includes('clawdbot --version');
  return isGateway && !isCli;
}

/**
 * Find the most recent failed gateway process and extract its logs.
 *
 * This is used as a fallback when process.getLogs() fails on the process object
 * returned by startProcess() — the object may be in a bad state after early exit.
 * Instead, we find the failed process via listProcesses() and get logs from that.
 */
export async function getFailedProcessLogs(sandbox: Sandbox): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const processes = await sandbox.listProcesses();

    // Iterate in reverse to get the most recent failed process
    for (let i = processes.length - 1; i >= 0; i--) {
      const proc = processes[i];
      if (isGatewayCommand(proc.command) && proc.status === 'failed') {
        console.log('[Gateway] Found failed process:', proc.id, 'exitCode:', proc.exitCode);
        try {
          return await proc.getLogs();
        } catch (logErr) {
          console.error('[Gateway] Failed to get logs from failed process:', logErr);
          return null;
        }
      }
    }
  } catch (e) {
    console.error('[Gateway] Error searching for failed processes:', e);
  }
  return null;
}

/**
 * Find an existing Moltbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      if (isGatewayCommand(proc.command)) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Wait for an existing gateway process to become ready, or kill it if it doesn't.
 * Returns the process if ready, null if it was killed and needs restart.
 */
async function waitForExistingProcess(proc: Process): Promise<Process | null> {
  console.log('Found existing Moltbot process:', proc.id, 'status:', proc.status);

  // Always use full startup timeout - a process can be "running" but not ready yet
  // (e.g., just started by another concurrent request). Using a shorter timeout
  // causes race conditions where we kill processes that are still initializing.
  try {
    console.log('Waiting for Moltbot gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
    await proc.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('Moltbot gateway is reachable');
    return proc;
  } catch {
    // Timeout waiting for port - process is likely dead or stuck, kill and restart
    console.log('Existing process not reachable after full timeout, killing and restarting...');
    try {
      await proc.kill();
    } catch (killError) {
      console.log('Failed to kill process:', killError);
    }
    return null;
  }
}

/**
 * Build a startup failure error with logs from the failed process.
 */
async function buildStartupError(sandbox: Sandbox, originalError: unknown): Promise<Error> {
  // Try to get logs via listProcesses() — the process object from startProcess()
  // may be unusable after ProcessExitedBeforeReadyError
  const failedLogs = await getFailedProcessLogs(sandbox);

  if (failedLogs && (failedLogs.stderr || failedLogs.stdout)) {
    console.error('[Gateway] startup failed. Stderr:', failedLogs.stderr);
    console.error('[Gateway] startup failed. Stdout:', failedLogs.stdout);
    return new Error(
      `Moltbot gateway failed to start.\n\nStderr: ${failedLogs.stderr || '(empty)'}\n\nStdout: ${failedLogs.stdout || '(empty)'}`
    );
  }

  // Fallback: include original error message instead of re-throwing opaque error
  console.error('[Gateway] Could not retrieve logs from failed process');
  return new Error(`Moltbot gateway failed to start: ${originalError instanceof Error ? originalError.message : String(originalError)}`);
}

/**
 * Ensure the Moltbot gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // Check if Moltbot is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    const ready = await waitForExistingProcess(existingProcess);
    if (ready) return ready;
  }

  // Start a new Moltbot gateway
  console.log('Starting new Moltbot gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-moltbot.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] Moltbot gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    throw await buildStartupError(sandbox, e);
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');

  return process;
}
