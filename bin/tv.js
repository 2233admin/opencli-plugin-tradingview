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

function main() {
  const { options, args } = parseArgs(process.argv.slice(2));
  if (options.help || args.length === 0) {
    printHelp();
    return 0;
  }

  const [command, ...rest] = args;
  if (command === 'config') return handleConfig(rest);

  const config = readConfig();
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
