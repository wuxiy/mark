import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { openDatabase } from '../server/db.ts';
import { completeModel, type ModelConfig } from '../server/model-client.ts';
import { testModelSettings } from '../server/model-settings.ts';

function virtualTime(ctx: TestContext) {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  ctx.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Deadline elapsed', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
}
function delayedResponse(milliseconds: number): NonNullable<ModelConfig['fetcher']> {
  return async (_, options) => new Promise<Response>((resolve, reject) => {
    setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic answer [1]' } }] }))), milliseconds);
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
  });
}
const model: ModelConfig = { baseUrl: 'https://example.invalid/v1', model: 'synthetic', fetcher: delayedResponse(35_000) };
const messages: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: 'Synthetic diagnostic data only' }];

test('generation accepts a valid answer after 25 seconds but still stops at its bounded deadline', async ctx => {
  virtualTime(ctx);
  const pending = completeModel(model, messages).then(answer => ({ answer }), cause => ({ cause }));
  ctx.mock.timers.tick(25_000);
  ctx.mock.timers.tick(10_000);
  assert.deepEqual(await pending, { answer: 'Synthetic answer [1]' });

  const tooSlow = completeModel({ ...model, fetcher: delayedResponse(121_000) }, messages).then(answer => ({ answer }), cause => ({ cause }));
  ctx.mock.timers.tick(120_000);
  const outcome = await tooSlow;
  assert.ok('cause' in outcome);
  assert.equal(outcome.cause.code, 'MODEL_TIMEOUT');
  assert.match(outcome.cause.message, /120 秒/);
});

test('connection testing keeps its 25 second limit and does not persist a draft', async ctx => {
  virtualTime(ctx);
  const root = mkdtempSync(join(tmpdir(), 'mark-model-timeouts-'));
  const db = openDatabase(join(root, 'mark.db'));
  try {
    const pending = testModelSettings(db, model, { enabled: true, baseUrl: model.baseUrl!, model: model.model!, revision: 0 })
      .then(result => ({ result }), cause => ({ cause }));
    ctx.mock.timers.tick(25_000);
    const outcome = await pending;
    assert.ok('cause' in outcome);
    assert.equal(outcome.cause.code, 'MODEL_TIMEOUT');
    assert.match(outcome.cause.message, /25 秒/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM settings WHERE key='model_config'").get()!.count, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
