import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findExistingMoltbotProcess, getFailedProcessLogs, ensureMoltbotGateway } from './process';
import type { Sandbox, Process } from '@cloudflare/sandbox';
import { createMockSandbox, createMockEnv, suppressConsole } from '../test-utils';

// Helper to create a full mock process (with methods needed for process tests)
function createFullMockProcess(overrides: Partial<Process> = {}): Process {
  return {
    id: 'test-id',
    command: 'clawdbot gateway',
    status: 'running',
    startTime: new Date(),
    endTime: undefined,
    exitCode: undefined,
    waitForPort: vi.fn(),
    kill: vi.fn(),
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    ...overrides,
  } as Process;
}

describe('findExistingMoltbotProcess', () => {
  it('returns null when no processes exist', async () => {
    const { sandbox } = createMockSandbox({ processes: [] });
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns null when only CLI commands are running', async () => {
    const processes = [
      createFullMockProcess({ command: 'clawdbot devices list --json', status: 'running' }),
      createFullMockProcess({ command: 'clawdbot --version', status: 'completed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('returns gateway process when running', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: 'clawdbot gateway --port 18789', 
      status: 'running' 
    });
    const processes = [
      createFullMockProcess({ command: 'clawdbot devices list', status: 'completed' }),
      gatewayProcess,
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns gateway process when starting', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh', 
      status: 'starting' 
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('ignores completed gateway processes', async () => {
    const processes = [
      createFullMockProcess({ command: 'clawdbot gateway', status: 'completed' }),
      createFullMockProcess({ command: 'start-moltbot.sh', status: 'failed' }),
    ];
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue(processes);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('handles listProcesses errors gracefully', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as Sandbox;
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBeNull();
  });

  it('matches start-moltbot.sh command', async () => {
    const gatewayProcess = createFullMockProcess({ 
      id: 'gateway-1',
      command: '/usr/local/bin/start-moltbot.sh', 
      status: 'running' 
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([gatewayProcess]);
    
    const result = await findExistingMoltbotProcess(sandbox);
    expect(result).toBe(gatewayProcess);
  });

  it('returns first matching gateway process', async () => {
    const firstGateway = createFullMockProcess({
      id: 'gateway-1',
      command: 'clawdbot gateway',
      status: 'running'
    });
    const secondGateway = createFullMockProcess({
      id: 'gateway-2',
      command: 'start-moltbot.sh',
      status: 'starting'
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([firstGateway, secondGateway]);

    const result = await findExistingMoltbotProcess(sandbox);
    expect(result?.id).toBe('gateway-1');
  });
});

describe('getFailedProcessLogs', () => {
  beforeEach(() => suppressConsole());

  it('returns logs from most recent failed gateway process', async () => {
    const failedProcess = createFullMockProcess({
      id: 'failed-gateway',
      command: '/usr/local/bin/start-moltbot.sh',
      status: 'failed',
      exitCode: 1,
      getLogs: vi.fn().mockResolvedValue({
        stdout: 'Starting gateway...',
        stderr: 'Error: Config validation failed',
      }),
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([failedProcess]);

    const result = await getFailedProcessLogs(sandbox);
    expect(result).not.toBeNull();
    expect(result?.stderr).toBe('Error: Config validation failed');
    expect(result?.stdout).toBe('Starting gateway...');
  });

  it('returns most recent when multiple failed processes exist', async () => {
    const oldFailed = createFullMockProcess({
      id: 'old-failed',
      command: 'start-moltbot.sh',
      status: 'failed',
      exitCode: 1,
      getLogs: vi.fn().mockResolvedValue({ stdout: 'old', stderr: 'old error' }),
    });
    const newFailed = createFullMockProcess({
      id: 'new-failed',
      command: 'start-moltbot.sh',
      status: 'failed',
      exitCode: 1,
      getLogs: vi.fn().mockResolvedValue({ stdout: 'new', stderr: 'new error' }),
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([oldFailed, newFailed]);

    const result = await getFailedProcessLogs(sandbox);
    expect(result?.stderr).toBe('new error');
    expect(newFailed.getLogs).toHaveBeenCalled();
  });

  it('returns null when no failed gateway processes exist', async () => {
    const runningProcess = createFullMockProcess({
      command: 'clawdbot gateway',
      status: 'running',
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([runningProcess]);

    const result = await getFailedProcessLogs(sandbox);
    expect(result).toBeNull();
  });

  it('returns null when getLogs fails on the failed process', async () => {
    const failedProcess = createFullMockProcess({
      command: 'start-moltbot.sh',
      status: 'failed',
      exitCode: 1,
      getLogs: vi.fn().mockRejectedValue(new Error('Process object invalid')),
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([failedProcess]);

    const result = await getFailedProcessLogs(sandbox);
    expect(result).toBeNull();
  });

  it('ignores failed CLI commands', async () => {
    const failedCli = createFullMockProcess({
      command: 'clawdbot devices list --json',
      status: 'failed',
      exitCode: 1,
    });
    const { sandbox, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([failedCli]);

    const result = await getFailedProcessLogs(sandbox);
    expect(result).toBeNull();
  });

  it('returns null when listProcesses errors', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as Sandbox;

    const result = await getFailedProcessLogs(sandbox);
    expect(result).toBeNull();
  });
});

// Mock the R2 mount module so ensureMoltbotGateway doesn't try to mount storage
vi.mock('./r2', () => ({
  mountR2Storage: vi.fn().mockResolvedValue(undefined),
}));

describe('ensureMoltbotGateway error handling', () => {
  beforeEach(() => suppressConsole());

  it('includes stderr from failed process when waitForPort throws', async () => {
    const startedProcess = createFullMockProcess({
      id: 'test-process',
      command: '/usr/local/bin/start-moltbot.sh',
      status: 'failed',
      exitCode: 1,
      waitForPort: vi.fn().mockRejectedValue(
        new Error('ProcessExitedBeforeReadyError: Process exited with code 1')
      ),
    });

    // The failed process found via listProcesses has logs
    const failedWithLogs = createFullMockProcess({
      id: 'test-process',
      command: '/usr/local/bin/start-moltbot.sh',
      status: 'failed',
      exitCode: 1,
      getLogs: vi.fn().mockResolvedValue({
        stdout: 'Starting Moltbot Gateway...',
        stderr: 'Error: ANTHROPIC_API_KEY is not set',
      }),
    });

    const { sandbox, startProcessMock, listProcessesMock } = createMockSandbox();
    // First call: findExistingMoltbotProcess (no running process)
    // Second call: getFailedProcessLogs (finds failed process with logs)
    listProcessesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([failedWithLogs]);
    startProcessMock.mockResolvedValue(startedProcess);

    const env = createMockEnv({ ANTHROPIC_API_KEY: 'test-key' });

    await expect(ensureMoltbotGateway(sandbox, env)).rejects.toThrow(
      'ANTHROPIC_API_KEY is not set'
    );
  });

  it('includes original error message when no failed process logs available', async () => {
    const startedProcess = createFullMockProcess({
      id: 'test-process',
      command: '/usr/local/bin/start-moltbot.sh',
      status: 'failed',
      exitCode: 1,
      waitForPort: vi.fn().mockRejectedValue(
        new Error('ProcessExitedBeforeReadyError: Process exited with code 1')
      ),
    });

    const { sandbox, startProcessMock, listProcessesMock } = createMockSandbox();
    listProcessesMock.mockResolvedValue([]);
    startProcessMock.mockResolvedValue(startedProcess);

    const env = createMockEnv({ ANTHROPIC_API_KEY: 'test-key' });

    await expect(ensureMoltbotGateway(sandbox, env)).rejects.toThrow(
      'ProcessExitedBeforeReadyError'
    );
  });
});
