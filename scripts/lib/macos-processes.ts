import { execFile, execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { HostProcess } from './host-processes.ts';

function processLine(line: string): HostProcess | undefined {
  const fields =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
      line,
    );
  if (!fields) return undefined;
  return {
    pid: Number(fields[1]),
    parent: Number(fields[2]),
    group: Number(fields[3]),
    uid: Number(fields[4]),
    started: fields[5],
    name: basename(fields[6].trim()),
    home: '',
    run: '',
  };
}

const processArguments = ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,comm='];
const processOptions = {
  env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  encoding: 'utf8' as const,
  timeout: 5000,
  maxBuffer: 16 * 1024 * 1024,
};

function processes(output: string) {
  // No argument or environment text enters this observation boundary.
  return output
    .split('\n')
    .map(processLine)
    .filter((item): item is HostProcess => item !== undefined);
}

// Spawn registration must capture identity before the fixture can be reparented.
export function macProcessesSync(): HostProcess[] {
  try {
    return processes(execFileSync('/bin/ps', processArguments, processOptions));
  } catch {
    throw new Error('Host isolation could not inspect macOS processes.');
  }
}

export async function macProcesses(): Promise<HostProcess[]> {
  const output = await new Promise<string>((accept, reject) => {
    execFile('/bin/ps', processArguments, processOptions, (error, stdout) => {
      if (error)
        reject(new Error('Host isolation could not inspect macOS processes.'));
      else accept(stdout);
    });
  });
  return processes(output);
}
