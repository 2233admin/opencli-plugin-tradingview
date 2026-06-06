#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CONFIG_PATH = join(homedir(), '.tradingview-cli', 'config.json');
const DEFAULT_SESSION = 'tv-chart';
const DEFAULT_CDP_CLI = 'C:/Users/Administrator/projects/tradingview-mcp-jackson/src/cli/index.js';

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function printHelp() {
  console.log(`TradingView unified CLI

Usage:
  tv [--backend opencli|cdp|mcp|bbx] [--layout <id>] [--session <name>] <command> [...args]

Config:
  tv config set layout <id>
  tv config get

Common commands:
  tv status
  tv chart NASDAQ:AAPL --interval 1h
  tv readings
  tv watch NASDAQ:AAPL --interval 1h --once
  tv watch NASDAQ:AAPL --interval 1h --every 60
  tv capture --path ./shot.png
  tv indicator list
  tv drawing list
  tv news AAPL
  tv technicals 600519

Backends:
  opencli  Default. Uses OpenCLI + browser cookie session.
  cdp      Uses tradingview-mcp-jackson CLI against localhost:9222.
  mcp      Alias for cdp-compatible CLI commands.
  bbx      Forwards to BBX command (TV_BBX_CMD, default: bbx).

Environment:
  TV_LAYOUT       TradingView layout id for OpenCLI backend.
  TV_SESSION      OpenCLI browser session name (default: tv-chart).
  TV_CDP_CLI      Path to tradingview-mcp-jackson src/cli/index.js.
  TV_BBX_CMD      BBX executable/command (default: bbx).
`);
}

function parseArgs(argv) {
  const options = {
    backend: process.env.TV_BACKEND || 'opencli',
    layout: process.env.TV_LAYOUT,
    session: process.env.TV_SESSION || DEFAULT_SESSION,
    dryRun: false,
  };
  const args = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backend') options.backend = argv[++i];
    else if (arg === '--layout') options.layout = argv[++i];
    else if (arg === '--session') options.session = argv[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else args.push(arg);
  }

  return { options, args };
}

function commandForPlatform(command, args) {
  if (process.platform !== 'win32') return { executable: command, args };
  if (command === 'opencli' || command === 'bbx') {
    return { executable: 'cmd.exe', args: ['/d', '/s', '/c', `${command}.cmd`, ...args] };
  }
  return { executable: command, args };
}

function run(command, args, env, dryRun) {
  const platformCommand = commandForPlatform(command, args);
  if (dryRun) {
    console.log(JSON.stringify({ command: platformCommand.executable, args: platformCommand.args, env }, null, 2));
    return 0;
  }

  const result = spawnSync(platformCommand.executable, platformCommand.args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

function runCapture(command, args, env) {
  const platformCommand = commandForPlatform(command, args);
  const result = spawnSync(platformCommand.executable, platformCommand.args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  if (result.error) {
    return { ok: false, status: 1, stdout: '', stderr: result.error.message };
  }

  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function handleConfig(args) {
  const config = readConfig();
  if (args[0] === 'get' || args.length === 0) {
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }

  if (args[0] === 'set' && args[1] === 'layout' && args[2]) {
    writeConfig({ ...config, layout: args[2] });
    console.log(`Saved layout ${args[2]} to ${CONFIG_PATH}`);
    return 0;
  }

  console.error('Usage: tv config set layout <id> | tv config get');
  return 2;
}

function openCliCommand(command, args, options, config) {
  const layout = options.layout || config.layout;
  const env = layout ? { TV_LAYOUT: layout } : {};

  if (command === 'status') {
    return ['opencli', ['browser', options.session, 'state'], env];
  }

  if (command === 'open') {
    return ['opencli', ['browser', options.session, 'open', args[0] || 'https://www.tradingview.com/chart/'], env];
  }

  return ['opencli', ['tradingview', command, ...args], env];
}

function cdpCommand(command, args) {
  const cliPath = process.env.TV_CDP_CLI || DEFAULT_CDP_CLI;
  return ['node', [cliPath, command, ...args], {}];
}

function bbxCommand(command, args) {
  const bbx = process.env.TV_BBX_CMD || 'bbx';
  return [bbx, ['tv', command, ...args], {}];
}

function readOptionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseWatchArgs(args) {
  const options = {
    symbol: undefined,
    interval: '1h',
    every: 60,
    once: false,
    sources: ['chart', 'readings', 'technicals', 'news', 'financials'],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--symbol') options.symbol = readOptionValue(args, i, arg);
    else if (arg === '--interval') options.interval = readOptionValue(args, i, arg);
    else if (arg === '--every') options.every = Number(readOptionValue(args, i, arg));
    else if (arg === '--once') options.once = true;
    else if (arg === '--sources') options.sources = readOptionValue(args, i, arg).split(',').map((source) => source.trim()).filter(Boolean);
    else if (!options.symbol) options.symbol = arg;
    else throw new Error(`Unexpected argument: ${arg}`);

    if (arg === '--symbol' || arg === '--interval' || arg === '--every' || arg === '--sources') i += 1;
  }

  if (!Number.isFinite(options.every) || options.every < 1) throw new Error('--every must be a positive number');
  if (options.sources.length === 0) throw new Error('--sources must include at least one source');

  return options;
}

function extractRows(text) {
  const rows = [];
  let row = undefined;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      if (row) rows.push(row);
      row = {};
      const [key, ...value] = line.slice(2).split(':');
      row[key.trim()] = value.join(':').trim().replace(/^'|'$/g, '');
    } else if (row && /^\s+[A-Za-z_][^:]*:/.test(line)) {
      const [key, ...value] = line.trim().split(':');
      row[key.trim()] = value.join(':').trim().replace(/^'|'$/g, '');
    }
  }

  if (row) rows.push(row);
  return rows;
}

function summarizeOutput(command, text) {
  const rows = extractRows(text);
  if (command === 'chart') return { rows, state: rows[0] || {} };
  if (command === 'readings') return { count: rows.length, rows };
  if (command === 'technicals') return { rows };
  if (command === 'news') return { count: rows.length, headlines: rows.slice(0, 5) };
  if (command === 'financials') return { count: rows.length, metrics: rows.slice(0, 12) };
  return { count: rows.length, rows: rows.slice(0, 20) };
}

function probeOpenCli(command, args, options, config) {
  const [executable, executableArgs, env] = openCliCommand(command, args, options, config);
  const result = runCapture(executable, executableArgs, env);
  return {
    command,
    ok: result.ok,
    status: result.status,
    data: result.ok ? summarizeOutput(command, result.stdout) : undefined,
    error: result.ok ? undefined : (result.stderr || result.stdout).trim(),
  };
}

function plannedOpenCliProbe(command, args, options, config) {
  const [executable, executableArgs, env] = openCliCommand(command, args, options, config);
  const platformCommand = commandForPlatform(executable, executableArgs);
  return {
    command,
    ok: true,
    dry_run: true,
    executable: platformCommand.executable,
    args: platformCommand.args,
    env,
  };
}

function runWatch(args, options, config) {
  let watch;
  try {
    watch = parseWatchArgs(args);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  if (!watch.symbol) {
    console.error('Usage: tv watch <symbol> [--interval 1h] [--every 60] [--once] [--sources chart,readings,technicals,news,financials]');
    return 2;
  }

  const probes = {
    chart: () => probeOpenCli('chart', [watch.symbol, '--interval', watch.interval], options, config),
    readings: () => probeOpenCli('readings', [], options, config),
    technicals: () => probeOpenCli('technicals', [watch.symbol], options, config),
    news: () => probeOpenCli('news', [watch.symbol], options, config),
    financials: () => probeOpenCli('financials', [watch.symbol], options, config),
    earnings: () => probeOpenCli('earnings', [], options, config),
    'screen-cn': () => probeOpenCli('screen-cn', [], options, config),
    'econ-calendar': () => probeOpenCli('econ-calendar', [], options, config),
  };
  const dryRunProbes = {
    chart: () => plannedOpenCliProbe('chart', [watch.symbol, '--interval', watch.interval], options, config),
    readings: () => plannedOpenCliProbe('readings', [], options, config),
    technicals: () => plannedOpenCliProbe('technicals', [watch.symbol], options, config),
    news: () => plannedOpenCliProbe('news', [watch.symbol], options, config),
    financials: () => plannedOpenCliProbe('financials', [watch.symbol], options, config),
    earnings: () => plannedOpenCliProbe('earnings', [], options, config),
    'screen-cn': () => plannedOpenCliProbe('screen-cn', [], options, config),
    'econ-calendar': () => plannedOpenCliProbe('econ-calendar', [], options, config),
  };
  const sources = options.dryRun ? dryRunProbes : probes;

  while (true) {
    const snapshot = {
      symbol: watch.symbol,
      interval: watch.interval,
      checked_at: new Date().toISOString(),
      sources: Object.fromEntries(watch.sources.map((source) => {
        const probe = sources[source];
        return [source, probe ? probe() : { command: source, ok: false, error: `Unknown source: ${source}` }];
      })),
    };

    console.log(JSON.stringify(snapshot, null, 2));
    if (watch.once) return 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, watch.every) * 1000);
  }
}

function main() {
  const { options, args } = parseArgs(process.argv.slice(2));
  if (options.help || args.length === 0) {
    printHelp();
    return 0;
  }

  const [command, ...rest] = args;
  if (command === 'config') return handleConfig(rest);

  const config = readConfig();
  if (command === 'watch') return runWatch(rest, options, config);

  let executable;
  let executableArgs;
  let env;

  if (options.backend === 'opencli') {
    [executable, executableArgs, env] = openCliCommand(command, rest, options, config);
  } else if (options.backend === 'cdp' || options.backend === 'mcp') {
    [executable, executableArgs, env] = cdpCommand(command, rest);
  } else if (options.backend === 'bbx') {
    [executable, executableArgs, env] = bbxCommand(command, rest);
  } else {
    console.error(`Unknown backend: ${options.backend}`);
    return 2;
  }

  return run(executable, executableArgs, env, options.dryRun);
}

process.exitCode = main();
