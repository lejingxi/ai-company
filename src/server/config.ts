import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export interface AppConfig {
  port: number; dataDir: string; workspaceRoot: string;
  realExecutionEnabled: boolean; monitoringEnabled: boolean;
  modelCatalogPath?: string;
  builtinModelConfigPath?: string;
  zcode: { electronPath: string; cliPath: string; enabled: boolean; timeoutMs: number; environmentMode?: 'existing-user'; verificationFingerprint?: string; isolationVerified?: boolean; runtimeHome?: string };
  docker: { executable: string; image: string; timeoutMs: number };
}
export function loadConfig(): AppConfig {
  const file = path.join(root, 'config', 'local.json');
  const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const dataDir = path.resolve(process.env.AI_COMPANY_DATA_DIR ?? path.join(root, 'data'));
  const port = Number(process.env.AI_COMPANY_PORT ?? local.port ?? 3180);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本机端口必须为 1024–65535');
  const zcodeRoot = process.env.ZCODE_INSTALL_DIR ?? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'ZCode');
  const cliPath = local.zcode?.cliPath ?? path.join(zcodeRoot, 'resources', 'glm', 'zcode.cjs');
  return {
    port, dataDir, workspaceRoot: path.join(dataDir, 'workspaces'),
    modelCatalogPath: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || path.join(process.env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'v2', 'provider_config.json'),
    builtinModelConfigPath: path.resolve(path.dirname(cliPath), '../config/provider/zcode-builtin.json'),
    // This expresses user intent only; current per-process probe evidence is required at every stage.
    realExecutionEnabled: local.realExecutionEnabled === true,
    monitoringEnabled: local.monitoringEnabled === true,
    zcode: {
      electronPath: local.zcode?.electronPath ?? path.join(zcodeRoot, 'ZCode.exe'),
      cliPath,
      enabled: local.zcode?.enabled === true, environmentMode: 'existing-user',
      timeoutMs: 180_000,
    },
    docker: { executable: local.docker?.executable ?? 'docker', image: local.docker?.image ?? 'node:24-alpine', timeoutMs: 60_000 },
  };
}
