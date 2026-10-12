import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { completeModel, MODEL_CONNECTION_TIMEOUT_MS, ModelFailure, normalizeModelUrl, type ModelConfig } from './model-client.ts';

const key = 'model_config';
interface StoredModel { enabled: boolean; baseUrl: string; model: string; apiKey: string; revision: number }

export const modelSettingsInput = z.object({
  enabled: z.boolean(), baseUrl: z.string().trim().max(2048), model: z.string().trim().max(160),
  apiKey: z.string().trim().max(8192).optional(), clearApiKey: z.boolean().optional(),
  revision: z.number().int().nonnegative(),
}).strict().refine(value => !(value.apiKey && value.clearApiKey), { message: '清除与替换密钥不能同时进行' });
type ModelInput = z.infer<typeof modelSettingsInput>;

function currentModel(db: DatabaseSync, fallback: ModelConfig): StoredModel {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (row) return JSON.parse(row.value) as StoredModel;
  return { enabled: fallback.enabled !== false && Boolean(fallback.baseUrl && fallback.model), baseUrl: fallback.baseUrl ?? '', model: fallback.model ?? '', apiKey: fallback.apiKey ?? '', revision: 0 };
}

export function modelSettingsView(db: DatabaseSync, fallback: ModelConfig = {}) {
  const current = currentModel(db, fallback);
  return { enabled: current.enabled, baseUrl: current.baseUrl, model: current.model, apiKeyConfigured: Boolean(current.apiKey), revision: current.revision,
    source: current.revision ? 'saved' : (fallback.baseUrl || fallback.model) ? 'environment' : 'none' };
}

export function resolveModelConfig(db: DatabaseSync, fallback: ModelConfig = {}): ModelConfig {
  return { ...fallback, ...currentModel(db, fallback) };
}

function candidate(db: DatabaseSync, fallback: ModelConfig, input: ModelInput, testing = false): StoredModel {
  const current = currentModel(db, fallback);
  if (input.revision !== current.revision) throw new ModelFailure('MODEL_SETTINGS_CHANGED', '模型配置已在其他页面更新，请重新加载后再修改', 409);
  const baseUrl = input.baseUrl ? normalizeModelUrl(input.baseUrl) : '';
  if ((testing || input.enabled) && (!baseUrl || !input.model)) throw new ModelFailure('MODEL_CONFIG_INVALID', '启用或测试模型前，请填写接入地址和模型名称', 400);
  let currentUrl = current.baseUrl;
  try { if (currentUrl) currentUrl = normalizeModelUrl(currentUrl); } catch { /* Allow repairing an invalid legacy deployment value. */ }
  if (baseUrl !== currentUrl && current.apiKey && !input.apiKey && !input.clearApiKey) {
    throw new ModelFailure('MODEL_KEY_REQUIRED', '更换接入地址后请重新填写密钥，或选择清除密钥以使用无需认证的服务', 400);
  }
  return { enabled: input.enabled, baseUrl, model: input.model, apiKey: input.clearApiKey ? '' : input.apiKey || current.apiKey, revision: current.revision + 1 };
}

export function saveModelSettings(db: DatabaseSync, fallback: ModelConfig, input: ModelInput) {
  const next = candidate(db, fallback, input);
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(next));
  return modelSettingsView(db, fallback);
}

export async function testModelSettings(db: DatabaseSync, fallback: ModelConfig, input: ModelInput) {
  const next = candidate(db, fallback, input, true);
  const start = Date.now();
  await completeModel({ ...fallback, ...next, timeoutMs: fallback.timeoutMs ?? MODEL_CONNECTION_TIMEOUT_MS }, [{ role: 'user', content: 'Connection test. Reply only OK.' }]);
  return { ok: true, model: next.model, latencyMs: Date.now() - start };
}
